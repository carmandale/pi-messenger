import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRegistration, Dirs, MessengerState } from "../lib.js";
import { getActiveAgents, invalidateAgentsCache, sendMessageToAgent } from "../store.js";

const roots = new Set<string>();
const initialCwd = process.cwd();
const initialCollabSessionId = process.env.PI_COLLAB_SESSION_ID;

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-store-test-"));
  roots.add(root);
  return root;
}

function createDirs(root: string): Dirs {
  const base = path.join(root, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function createState(scopeToFolder: boolean): MessengerState {
  return {
    agentName: "Self",
    scopeToFolder,
  } as MessengerState;
}

function writeRegistration(registryDir: string, name: string, cwd: string): void {
  const registration: AgentRegistration = {
    name,
    pid: process.pid,
    sessionId: "session-1",
    cwd,
    model: "test-model",
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(registration));
}

afterEach(() => {
  invalidateAgentsCache();
  process.chdir(initialCwd);
  if (initialCollabSessionId === undefined) {
    delete process.env.PI_COLLAB_SESSION_ID;
  } else {
    process.env.PI_COLLAB_SESSION_ID = initialCollabSessionId;
  }
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe("store model field in registrations", () => {
  it("registration JSON includes model field from ctx.model.id", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const projectDir = path.join(root, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    // Simulate registration with a specific model
    const reg: AgentRegistration = {
      name: "ModelTestAgent",
      pid: process.pid,
      sessionId: "session-model",
      cwd: projectDir,
      model: "claude-opus-4-6",
      startedAt: new Date().toISOString(),
      isHuman: false,
      session: { toolCalls: 0, tokens: 0, filesModified: [] },
      activity: { lastActivityAt: new Date().toISOString() },
    };
    fs.writeFileSync(path.join(dirs.registry, "ModelTestAgent.json"), JSON.stringify(reg));

    // Read back and verify model survives round-trip
    const raw = JSON.parse(fs.readFileSync(path.join(dirs.registry, "ModelTestAgent.json"), "utf-8"));
    expect(raw.model).toBe("claude-opus-4-6");

    // Verify getActiveAgents returns the model field
    process.chdir(projectDir);
    const agents = getActiveAgents(createState(false), dirs);
    const found = agents.find(a => a.name === "ModelTestAgent");
    expect(found).toBeDefined();
    expect(found!.model).toBe("claude-opus-4-6");
  });
});

describe("store.getActiveAgents cwd scoping", () => {
  it("matches scoped agents using canonical cwd", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const actualProject = path.join(root, "project");
    const aliasProject = path.join(root, "project-alias");

    fs.mkdirSync(actualProject, { recursive: true });
    fs.symlinkSync(actualProject, aliasProject, "dir");

    writeRegistration(dirs.registry, "Peer", actualProject);

    process.chdir(aliasProject);
    const agents = getActiveAgents(createState(true), dirs);

    expect(agents.map(agent => agent.name)).toEqual(["Peer"]);
  });
});

describe("store.sendMessageToAgent collaborator session propagation", () => {
  it("inherits PI_COLLAB_SESSION_ID when a spawned collaborator sends a reply", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    process.env.PI_COLLAB_SESSION_ID = "collab-session-123";

    sendMessageToAgent(createState(false), dirs, "Peer", "reply text");

    const inboxFiles = fs.readdirSync(path.join(dirs.inbox, "Peer"));
    expect(inboxFiles).toHaveLength(1);

    const message = JSON.parse(
      fs.readFileSync(path.join(dirs.inbox, "Peer", inboxFiles[0]), "utf-8"),
    );
    expect(message.sessionId).toBe("collab-session-123");
  });

  it("prefers an explicit sessionId over PI_COLLAB_SESSION_ID", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    process.env.PI_COLLAB_SESSION_ID = "env-session";

    sendMessageToAgent(createState(false), dirs, "Peer", "reply text", undefined, undefined, "explicit-session");

    const inboxFiles = fs.readdirSync(path.join(dirs.inbox, "Peer"));
    expect(inboxFiles).toHaveLength(1);

    const message = JSON.parse(
      fs.readFileSync(path.join(dirs.inbox, "Peer", inboxFiles[0]), "utf-8"),
    );
    expect(message.sessionId).toBe("explicit-session");
  });
});
