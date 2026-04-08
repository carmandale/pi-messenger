#!/usr/bin/env -S npx tsx
/**
 * Mock collaborator process for integration tests (spec 068, D5).
 *
 * Simulates Pi's --mode rpc behavior:
 * 1. Writes registry JSON + heartbeat (so pollUntilReady succeeds)
 * 2. Reads {type: "prompt"} from stdin
 * 3. Behaves according to MOCK_BEHAVIOR env var
 *
 * Env vars:
 *   PI_AGENT_NAME        — collaborator name (required)
 *   MOCK_BEHAVIOR        — happy|stall|crash|provider_error_rpc|provider_error_message_end|slow
 *   MOCK_REGISTRY_DIR    — where to write registry JSON + heartbeat
 *   MOCK_SPAWNER_INBOX   — where to write reply message (for happy/slow)
 *   MOCK_SPAWNER_NAME    — spawner's name (for reply message addressing)
 *   MOCK_DELAY_MS        — delay before reply (for slow behavior)
 *   MOCK_SESSION_ID      — session ID to include in reply messages
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const name = process.env.PI_AGENT_NAME ?? "MockCollab";
const behavior = process.env.MOCK_BEHAVIOR ?? "happy";
const registryDir = process.env.MOCK_REGISTRY_DIR;
const spawnerInbox = process.env.MOCK_SPAWNER_INBOX;
const spawnerName = process.env.MOCK_SPAWNER_NAME ?? "TestSpawner";
const delayMs = parseInt(process.env.MOCK_DELAY_MS ?? "0", 10);
const sessionId = process.env.MOCK_SESSION_ID;

// Step 1: Write registry JSON (so pollUntilReady can succeed)
if (registryDir) {
  const registryFile = path.join(registryDir, `${name}.json`);
  fs.writeFileSync(registryFile, JSON.stringify({
    name,
    pid: process.pid,
    sessionId: randomUUID(),
    cwd: process.cwd(),
    model: "mock-model",
    startedAt: new Date().toISOString(),
    gitBranch: "test",
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: "mock collaborator",
  }));

  // Write initial heartbeat
  const hbFile = path.join(registryDir, `${name}.heartbeat`);
  fs.writeFileSync(hbFile, String(Date.now()));

  // Keep heartbeat fresh
  const hbInterval = setInterval(() => {
    try { fs.writeFileSync(hbFile, String(Date.now())); } catch {}
  }, 1000);
  process.on("exit", () => { clearInterval(hbInterval); });
}

// Step 2: Read prompt from stdin
let promptData = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  promptData += chunk;
  // Check if we have a complete JSON line
  if (promptData.includes("\n")) {
    handlePrompt();
  }
});
process.stdin.on("end", () => {
  // stdin closed — exit cleanly
  process.exit(0);
});

function writeReply() {
  if (!spawnerInbox) return;
  fs.mkdirSync(spawnerInbox, { recursive: true });
  const msg = {
    id: randomUUID(),
    from: name,
    to: spawnerName,
    text: `Mock reply from ${name} (behavior: ${behavior})`,
    timestamp: new Date().toISOString(),
    replyTo: null,
    ...(sessionId ? { sessionId } : {}),
  };
  const msgFile = path.join(spawnerInbox, `${Date.now()}-mock.json`);
  fs.writeFileSync(msgFile, JSON.stringify(msg, null, 2));
}

function handlePrompt() {
  switch (behavior) {
    case "happy":
      writeReply();
      break;

    case "slow":
      setTimeout(() => writeReply(), delayMs || 2000);
      break;

    case "stall":
      // Do nothing — let stall detection fire
      break;

    case "crash":
      process.exit(1);
      break;

    case "provider_error_rpc":
      // Write RPC error format to stdout (goes to log file)
      process.stdout.write(JSON.stringify({
        type: "response",
        command: "prompt",
        success: false,
        error: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"},"request_id":"req_mock"}',
      }) + "\n");
      // Stay alive (process doesn't crash on provider error)
      break;

    case "provider_error_message_end":
      // Write message_end format to stdout
      process.stdout.write(JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "mock",
          model: "mock-model",
          errorMessage: '402 {"type":"error","error":{"type":"billing_error","message":"No credits"},"request_id":"req_mock_billing"}',
        },
      }) + "\n");
      break;

    default:
      process.stderr.write(`Unknown MOCK_BEHAVIOR: ${behavior}\n`);
      process.exit(2);
  }
}
