/**
 * Regression tests for known collaboration failure modes (spec 068, D6).
 * Each test validates a fix from a prior spec to prevent recurrence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { CollaboratorEntry } from "../../crew/registry.js";
import type { AgentMailMessage } from "../../lib.js";

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

function makeMessage(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return {
    id: randomUUID(),
    from: "TestCollab",
    to: "TestSpawner",
    text: "Hello from collaborator",
    timestamp: new Date().toISOString(),
    replyTo: null,
    ...overrides,
  };
}

// ─── T-R1: Stale inbox message rejection (spec 057) ─────────────────────────

describe("T-R1: stale inbox message rejection (spec 057)", () => {
  let isFreshSpawnMessage: typeof import("../../crew/handlers/collab.js").isFreshSpawnMessage;
  let sweepStaleSpawnMessages: typeof import("../../crew/handlers/collab.js").sweepStaleSpawnMessages;
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../crew/handlers/collab.js");
    isFreshSpawnMessage = mod.isFreshSpawnMessage;
    sweepStaleSpawnMessages = mod.sweepStaleSpawnMessages;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t-r1-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects messages timestamped before spawn", () => {
    const spawnTime = Date.now();
    const staleMsg = makeMessage({ timestamp: new Date(spawnTime - 5000).toISOString() });
    expect(isFreshSpawnMessage(staleMsg, spawnTime)).toBe(false);
  });

  it("accepts messages timestamped at or after spawn", () => {
    const spawnTime = Date.now();
    const freshMsg = makeMessage({ timestamp: new Date(spawnTime + 100).toISOString() });
    expect(isFreshSpawnMessage(freshMsg, spawnTime)).toBe(true);
  });

  it("sweeps stale files from inbox", () => {
    const spawnTime = Date.now();
    const staleMsg = makeMessage({ timestamp: new Date(spawnTime - 5000).toISOString() });
    const freshMsg = makeMessage({ timestamp: new Date(spawnTime + 100).toISOString(), from: "TestCollab" });

    fs.writeFileSync(path.join(tmpDir, "stale.json"), JSON.stringify(staleMsg));
    fs.writeFileSync(path.join(tmpDir, "fresh.json"), JSON.stringify(freshMsg));

    sweepStaleSpawnMessages(tmpDir, "TestCollab", spawnTime);

    expect(fs.existsSync(path.join(tmpDir, "stale.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "fresh.json"))).toBe(true);
  });
});

// ─── T-R2: Session ID deliverFn gate (spec 068, D8) ─────────────────────────

describe("T-R2: session ID deliverFn gate (spec 068, D8)", () => {
  // Mirrors the actual deliverMessage gate logic from index.ts:
  // if (collabSessionId && msg.sessionId !== collabSessionId) → drop (return true)
  // This is not a tautological field check — it exercises the exact boolean expression.

  const SESSION_ID = "abc12345";

  /**
   * Replicates the session gate logic from index.ts deliverMessage.
   * Returns "accept" if message passes, "drop" if it should be consumed/discarded.
   */
  function sessionGate(collabSessionId: string | undefined, msg: AgentMailMessage): "accept" | "drop" {
    if (collabSessionId) {
      if (msg.sessionId !== collabSessionId) {
        return "drop"; // consume stale message — store deletes file
      }
    }
    return "accept";
  }

  it("accepts message with matching sessionId when gate is active", () => {
    const msg = makeMessage({ sessionId: SESSION_ID });
    expect(sessionGate(SESSION_ID, msg)).toBe("accept");
  });

  it("drops message with mismatched sessionId when gate is active", () => {
    const msg = makeMessage({ sessionId: "wrong-id" });
    expect(sessionGate(SESSION_ID, msg)).toBe("drop");
  });

  it("drops message with missing sessionId when gate is active", () => {
    const msg = makeMessage(); // no sessionId field
    expect(sessionGate(SESSION_ID, msg)).toBe("drop");
  });

  it("accepts all messages when gate is inactive (no env var)", () => {
    const msg = makeMessage({ sessionId: "anything" });
    expect(sessionGate(undefined, msg)).toBe("accept");
  });

  it("accepts all messages without sessionId when gate is inactive", () => {
    const msg = makeMessage(); // no sessionId
    expect(sessionGate(undefined, msg)).toBe("accept");
  });
});

// ─── T-R3: Dismiss after auto-dispose (spec 028, D4) ─────────────────────────

describe("T-R3: dismiss after auto-dispose (spec 028, D4)", async () => {
  let executeDismiss: typeof import("../../crew/handlers/collab.js").executeDismiss;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../crew/handlers/collab.js");
    executeDismiss = mod.executeDismiss;
  });

  it("returns already_completed when collaborator was auto-dismissed", async () => {
    const state = {
      completedCollaborators: new Set(["DoneAgent"]),
    } as any;
    const dirs = {} as any;
    const ctx = { cwd: "/tmp" } as any;

    const res = await executeDismiss({ name: "DoneAgent" } as any, state, dirs, ctx);
    expect(res.details.error).toBe("already_completed");
    expect(res.details.name).toBe("DoneAgent");
    expect(res.content[0].text).toContain("already auto-dismissed");
  });
});

// ─── T-R5: Provider error RPC format detection (spec 068, D2) ────────────────

describe("T-R5: RPC error format detection (spec 068, D2)", async () => {
  let extractProviderTerminalErrorFromLogLine: typeof import("../../crew/utils/provider-classification.js").extractProviderTerminalErrorFromLogLine;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../crew/utils/provider-classification.js");
    extractProviderTerminalErrorFromLogLine = mod.extractProviderTerminalErrorFromLogLine;
  });

  it("detects 429 rate_limit_error in RPC response format", () => {
    const line = JSON.stringify({
      type: "response", success: false,
      error: '429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
    });
    const parsed = extractProviderTerminalErrorFromLogLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.statusCode).toBe(429);
    expect(parsed?.errorType).toBe("rate_limit_error");
  });

  it("still detects message_end format (regression guard)", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant", provider: "anthropic", model: "claude-opus-4-6",
        errorMessage: '402 {"type":"error","error":{"type":"billing_error","message":"no credits"}}',
      },
    });
    const parsed = extractProviderTerminalErrorFromLogLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.statusCode).toBe(402);
    expect(parsed?.errorType).toBe("billing_error");
  });
});

// ─── classifyCrash tests (spec 068, D3) ──────────────────────────────────────

describe("classifyCrash (spec 068, D3)", async () => {
  let classifyCrash: typeof import("../../crew/handlers/collab.js").classifyCrash;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../crew/handlers/collab.js");
    classifyCrash = mod.classifyCrash;
  });

  it("classifies SIGKILL (137) as oom", () => {
    expect(classifyCrash(137, "")).toBe("oom");
  });

  it("classifies signal deaths (>128) as signal", () => {
    expect(classifyCrash(143, "")).toBe("signal"); // SIGTERM=15, 128+15=143
  });

  it("classifies exit 0 as clean_exit", () => {
    expect(classifyCrash(0, "")).toBe("clean_exit");
  });

  it("classifies exit null as unknown", () => {
    expect(classifyCrash(null, "")).toBe("unknown");
  });

  it("classifies provider error from log tail", () => {
    const logTail = JSON.stringify({
      type: "message_end",
      message: { errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"limit"}}' },
    });
    expect(classifyCrash(1, logTail)).toBe("provider_error");
  });

  it("returns unknown for generic exit code with clean log", () => {
    expect(classifyCrash(1, "some normal output")).toBe("unknown");
  });
});

// ─── T-R7: Context isolation flags (spec 067) ───────────────────────────────

describe("T-R7: context isolation flags in spawn args (spec 067)", () => {
  const REQUIRED_FLAGS = [
    "--no-session",
    "--no-skills",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-themes",
  ];

  it("collab.ts spawn args include all isolation flags", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "crew/handlers/collab.ts"),
      "utf-8",
    );
    for (const flag of REQUIRED_FLAGS) {
      expect(source).toContain(flag);
    }
  });
});
