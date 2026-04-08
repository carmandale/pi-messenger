/**
 * Integration tests for the collaboration pipeline (spec 068, D5).
 *
 * These tests exercise pollForCollaboratorMessage with real filesystem
 * operations (inbox files, log files) against mock collaborator behaviors.
 * No actual Pi process is spawned — we simulate the artifacts a collaborator
 * would produce and verify the poll loop detects them correctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { CollaboratorEntry } from "../../crew/registry.js";
import type { AgentMailMessage, MessengerState } from "../../lib.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeProc(alive = true) {
  return {
    exitCode: alive ? null : 0,
    killed: false,
    pid: Math.floor(Math.random() * 100000),
    kill: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: null,
    stderr: null,
  } as unknown as import("node:child_process").ChildProcess;
}

function makeCollabEntry(overrides: Partial<CollaboratorEntry> = {}): CollaboratorEntry {
  return {
    type: "collaborator",
    name: "TestCollab",
    cwd: "/tmp/test",
    proc: makeFakeProc(),
    taskId: "__collab-test__",
    spawnedBy: process.pid,
    startedAt: Date.now(),
    promptTmpDir: null,
    logFile: null,
    lifecycle: "active",
    ...overrides,
  };
}

function makeMinimalState(overrides: Partial<MessengerState> = {}): MessengerState {
  return {
    agentName: "TestSpawner",
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "test",
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    registrationContextSent: false,
    blockingCollaborators: new Set(),
    completedCollaborators: new Set(),
    ...overrides,
  } as MessengerState;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("collab-integration: poll loop with real filesystem", () => {
  let pollForCollaboratorMessage: typeof import("../../crew/handlers/collab.js").pollForCollaboratorMessage;
  let tmpDir: string;
  let inboxDir: string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../crew/handlers/collab.js");
    pollForCollaboratorMessage = mod.pollForCollaboratorMessage;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-integ-"));
    inboxDir = path.join(tmpDir, "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("happy path: detects message in inbox", async () => {
    const entry = makeCollabEntry({ lifecycle: "spawning" });
    const state = makeMinimalState();
    const spawnTime = Date.now();

    // Simulate collaborator writing a reply after a short delay
    setTimeout(() => {
      const msg: AgentMailMessage = {
        id: randomUUID(),
        from: "TestCollab",
        to: "TestSpawner",
        text: "Hello from collaborator",
        timestamp: new Date().toISOString(),
        replyTo: null,
      };
      fs.writeFileSync(
        path.join(inboxDir, `${Date.now()}-reply.json`),
        JSON.stringify(msg),
      );
    }, 200);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      sendTimestamp: spawnTime,
      entry,
      stallThresholdMs: 5000,
      pollTimeoutMs: 10000,
      hardCeilingMs: 30000,
      state,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.text).toBe("Hello from collaborator");
      expect(entry.lifecycle).toBe("active");
    }
  });

  it("detects phase:complete and sets peerTerminal + lifecycle", async () => {
    const entry = makeCollabEntry({ lifecycle: "active" });
    const state = makeMinimalState();

    setTimeout(() => {
      const msg: AgentMailMessage = {
        id: randomUUID(),
        from: "TestCollab",
        to: "TestSpawner",
        text: "[COMPLETE] Done.",
        timestamp: new Date().toISOString(),
        replyTo: null,
        phase: "complete",
      };
      fs.writeFileSync(
        path.join(inboxDir, `${Date.now()}-complete.json`),
        JSON.stringify(msg),
      );
    }, 200);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      sendTimestamp: Date.now(),
      entry,
      stallThresholdMs: 5000,
      pollTimeoutMs: 10000,
      hardCeilingMs: 30000,
      state,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peerComplete).toBe(true);
      expect(entry.peerTerminal).toBe(true);
      expect(entry.lifecycle).toBe("completing");
    }
  });

  it("detects provider error in RPC format from log", async () => {
    const logFile = path.join(tmpDir, "collab.log");
    fs.writeFileSync(logFile, "");
    const entry = makeCollabEntry({ logFile, lifecycle: "spawning" });
    const state = makeMinimalState();

    // Write RPC error to log after short delay
    setTimeout(() => {
      fs.appendFileSync(logFile,
        JSON.stringify({
          type: "response",
          command: "prompt",
          success: false,
          error: '429 {"type":"error","error":{"type":"rate_limit_error","message":"limit"}}',
        }) + "\n",
      );
    }, 200);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      sendTimestamp: Date.now(),
      entry,
      stallThresholdMs: 5000,
      pollTimeoutMs: 10000,
      hardCeilingMs: 30000,
      state,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("provider_error");
      expect(entry.lifecycle).toBe("error");
    }
  });

  it("detects provider error in message_end format from log", async () => {
    const logFile = path.join(tmpDir, "collab.log");
    fs.writeFileSync(logFile, "");
    const entry = makeCollabEntry({ logFile, lifecycle: "spawning" });
    const state = makeMinimalState();

    setTimeout(() => {
      fs.appendFileSync(logFile,
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-opus-4-6",
            errorMessage: '402 {"type":"error","error":{"type":"billing_error","message":"no credits"}}',
          },
        }) + "\n",
      );
    }, 200);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      sendTimestamp: Date.now(),
      entry,
      stallThresholdMs: 5000,
      pollTimeoutMs: 10000,
      hardCeilingMs: 30000,
      state,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("provider_error");
    }
  });

  it("detects crash (process exit)", async () => {
    const proc = makeFakeProc(true);
    const entry = makeCollabEntry({ proc, lifecycle: "spawning" });
    const state = makeMinimalState();

    // Simulate crash after delay
    setTimeout(() => {
      (proc as any).exitCode = 1;
    }, 200);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      sendTimestamp: Date.now(),
      entry,
      stallThresholdMs: 5000,
      pollTimeoutMs: 10000,
      hardCeilingMs: 30000,
      state,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("crashed");
      expect(entry.lifecycle).toBe("error");
    }
  });

  it("detects stall (no activity within threshold)", async () => {
    // Use very short stall threshold to trigger quickly
    const entry = makeCollabEntry({ lifecycle: "spawning", startedAt: Date.now() - 60000 });
    const state = makeMinimalState();

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      sendTimestamp: Date.now(),
      entry,
      stallThresholdMs: 100,     // Very short — triggers immediately
      pollTimeoutMs: 500,
      hardCeilingMs: 1000,
      state,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("stalled");
      expect(entry.lifecycle).toBe("error");
    }
  });
});
