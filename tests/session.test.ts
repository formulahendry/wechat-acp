import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  SessionManager,
  type UserSession,
} from "../src/acp/session.js";

test("concurrent session creation reserves maxConcurrentUsers capacity", async () => {
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    killAgentProcess: async () => {},
    showThoughts: false,
    log: () => {},
    onReply: async () => {},
    sendTyping: async () => {},
  });
  const createdUsers: string[] = [];
  const internal = manager as unknown as {
    createSession(userId: string, contextToken: string): Promise<UserSession>;
    getOrCreateSession(userId: string, contextToken: string): Promise<UserSession>;
  };
  internal.createSession = async (userId, contextToken) => {
    createdUsers.push(userId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      userId,
      contextToken,
      client: {} as never,
      agentInfo: {
        process: {
          killed: false,
          exitCode: null,
          signalCode: null,
        } as never,
        connection: {} as never,
        sessionId: userId,
        configOptions: [],
        sessionOutcome: "new",
      },
      configOptions: [],
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
  };

  const first = internal
    .getOrCreateSession("user-1", "context-1")
    .then((session) => {
      session.processing = true;
      return session;
    });
  const second = assert.rejects(
    internal.getOrCreateSession("user-2", "context-2"),
    /Maximum concurrent sessions reached/,
  );

  assert.equal((await first).userId, "user-1");
  await second;
  assert.deepEqual(createdUsers, ["user-1"]);
  await manager.stop();
});

test("SessionManager.stop waits for every MCP lease before reporting failures", async () => {
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 2,
    killAgentProcess: async () => {},
    showThoughts: false,
    log: () => {},
    onReply: async () => {},
    sendTyping: async () => {},
  });

  const events: string[] = [];
  const sessions = (
    manager as unknown as { sessions: Map<string, UserSession> }
  ).sessions;
  const makeSession = (
    userId: string,
    close: () => Promise<void>,
  ): UserSession => ({
    userId,
    contextToken: `${userId}-context`,
    client: {} as never,
    agentInfo: {
      process: {
        killed: false,
        exitCode: null,
        signalCode: null,
      } as never,
      connection: {} as never,
      sessionId: userId,
      configOptions: [],
      sessionOutcome: "new",
    },
    mcpLease: { mcpServer: {} as never, close },
    configOptions: [],
    queue: [],
    processing: false,
    lastActivity: Date.now(),
    createdAt: Date.now(),
  });
  sessions.set(
    "user-1",
    makeSession("user-1", async () => {
      events.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push("first-failed");
      throw new Error("first close failed");
    }),
  );
  sessions.set(
    "user-2",
    makeSession("user-2", async () => {
      events.push("second-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("second-finished");
    }),
  );

  await assert.rejects(manager.stop(), AggregateError);
  assert.deepEqual(events, [
    "first-start",
    "second-start",
    "first-failed",
    "second-finished",
  ]);
});

test("session creation failures are surfaced to the WeChat user", async () => {
  const replies: string[] = [];
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    showThoughts: false,
    log: () => {},
    onReply: async (_userId, _contextToken, text) => {
      replies.push(text);
    },
    sendTyping: async () => {},
  });
  const internal = manager as unknown as {
    createSession(userId: string, contextToken: string): Promise<UserSession>;
  };
  internal.createSession = async () => {
    throw new Error("persisted session could not be loaded");
  };

  await assert.rejects(
    manager.enqueue("user-1", { prompt: [], contextToken: "context-1" }),
    /persisted session could not be loaded/,
  );
  assert.deepEqual(replies, [
    "⚠️ Agent session error: persisted session could not be loaded",
  ]);
});

test("runtime bridge settings are scoped to a session and applied at the next turn", async () => {
  const appliedSettings: unknown[] = [];
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    showThoughts: true,
    showDiffs: false,
    showImages: true,
    showAudio: true,
    showResources: true,
    log: () => {},
    onReply: async () => {},
    sendTyping: async () => {},
  });
  const session = makeTurnSession({
    flushText: "",
    producedMessage: true,
    events: [],
  });
  session.client.beginTurn = async (_callbacks, settings) => {
    appliedSettings.push(settings);
  };
  const internal = manager as unknown as {
    sessions: Map<string, UserSession>;
    processQueue(session: UserSession): Promise<void>;
  };
  internal.sessions.set(session.userId, session);

  assert.deepEqual(manager.getRuntimeBridgeSettings(session.userId), {
    thoughts: true,
    diffs: false,
    images: true,
    audio: true,
    resources: true,
  });
  manager.setRuntimeBridgeSetting(session.userId, "thoughts", false);
  manager.setRuntimeBridgeSetting(session.userId, "diffs", true);
  manager.setRuntimeBridgeSetting(session.userId, "images", false);
  manager.setRuntimeBridgeSetting(session.userId, "audio", false);
  manager.setRuntimeBridgeSetting(session.userId, "resources", false);

  await internal.processQueue(session);

  assert.deepEqual(appliedSettings, [{
    showThoughts: false,
    showDiffs: true,
    showImages: false,
    showAudio: false,
    showResources: false,
  }]);

  const replacementSession = makeTurnSession({
    flushText: "",
    producedMessage: true,
    events: [],
  });
  internal.sessions.set(session.userId, replacementSession);
  assert.deepEqual(manager.getRuntimeBridgeSettings(session.userId), {
    thoughts: true,
    diffs: false,
    images: true,
    audio: true,
    resources: true,
  });
  assert.equal(manager.getRuntimeBridgeSettings("other-user"), undefined);
});

function makeTurnSession(opts: {
  flushText: string;
  producedMessage: boolean;
  events: string[];
  stopReason?: "end_turn" | "cancelled" | "refusal";
  completion?: {
    resolve: () => void;
    reject: (err: unknown) => void;
  };
}): UserSession {
  const agentProcess = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperties(agentProcess, {
    killed: { value: false, writable: true },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  return {
    userId: "user-1",
    contextToken: "initial-context",
    client: {
      beginTurn: async () => {
        opts.events.push("begin");
      },
      flush: async () => {
        opts.events.push("flush");
        return opts.flushText;
      },
      hasProducedMessage: opts.producedMessage,
    } as never,
    agentInfo: {
      process: agentProcess,
      connection: {
        closed: new Promise<void>(() => {}),
        prompt: async () => {
          opts.events.push("prompt");
          return { stopReason: opts.stopReason ?? "end_turn" };
        },
      } as never,
      sessionId: "session-1",
      configOptions: [],
      sessionOutcome: "new",
    },
    configOptions: [],
    queue: [{
      prompt: [],
      contextToken: "turn-context",
      completion: opts.completion,
    }],
    processing: true,
    lastActivity: Date.now(),
    createdAt: Date.now(),
  };
}

async function processTurn(
  manager: SessionManager,
  session: UserSession,
): Promise<void> {
  const internal = manager as unknown as {
    sessions: Map<string, UserSession>;
    processQueue(session: UserSession): Promise<void>;
  };
  internal.sessions.set(session.userId, session);
  await internal.processQueue(session);
}

test("configured turn end message is sent standalone after final buffered text", async () => {
  const events: string[] = [];
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    turnEndMessage: "✅ Turn complete",
    showThoughts: false,
    log: () => {},
    onReply: async (_userId, _contextToken, text) => {
      events.push(`reply:${text}`);
    },
    sendTyping: async () => {},
  });
  const session = makeTurnSession({
    flushText: "Final answer",
    producedMessage: true,
    events,
  });

  await processTurn(manager, session);

  assert.deepEqual(events, [
    "begin",
    "prompt",
    "flush",
    "reply:Final answer",
    "reply:✅ Turn complete",
  ]);
});

test("configured turn end message is sent when all agent text was already streamed", async () => {
  const replies: string[] = [];
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    turnEndMessage: "Done",
    showThoughts: false,
    log: () => {},
    onReply: async (_userId, _contextToken, text) => {
      replies.push(text);
    },
    sendTyping: async () => {},
  });
  const session = makeTurnSession({
    flushText: "",
    producedMessage: true,
    events: [],
  });

  await processTurn(manager, session);

  assert.deepEqual(replies, ["Done"]);
});

test("turn end message remains disabled when it is not configured", async () => {
  const replies: string[] = [];
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    showThoughts: false,
    log: () => {},
    onReply: async (_userId, _contextToken, text) => {
      replies.push(text);
    },
    sendTyping: async () => {},
  });
  const session = makeTurnSession({
    flushText: "Final answer",
    producedMessage: true,
    events: [],
  });

  await processTurn(manager, session);

  assert.deepEqual(replies, ["Final answer"]);
});

for (const { stopReason, expectedReply } of [
  {
    stopReason: "cancelled" as const,
    expectedReply: "Partial answer\n[cancelled]",
  },
  {
    stopReason: "refusal" as const,
    expectedReply: "Partial answer\n[agent refused to continue]",
  },
]) {
  test(`configured turn end message follows the ${stopReason} notice`, async () => {
    const replies: string[] = [];
    const manager = new SessionManager({
      agentCommand: "unused",
      agentArgs: [],
      agentCwd: process.cwd(),
      idleTimeoutMs: 0,
      maxConcurrentUsers: 1,
      turnEndMessage: "Done",
      showThoughts: false,
      log: () => {},
      onReply: async (_userId, _contextToken, text) => {
        replies.push(text);
      },
      sendTyping: async () => {},
    });
    const session = makeTurnSession({
      flushText: "Partial answer",
      producedMessage: true,
      events: [],
      stopReason,
    });

    await processTurn(manager, session);

    assert.deepEqual(replies, [expectedReply, "Done"]);
  });
}

test("configured turn end message follows the empty-turn notice", async () => {
  const replies: string[] = [];
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    turnEndMessage: "Done",
    showThoughts: false,
    log: () => {},
    onReply: async (_userId, _contextToken, text) => {
      replies.push(text);
    },
    sendTyping: async () => {},
  });
  const session = makeTurnSession({
    flushText: "",
    producedMessage: false,
    events: [],
  });

  await processTurn(manager, session);

  assert.deepEqual(replies, [
    "ℹ️ The agent finished without sending a reply. Try rephrasing your request.",
    "Done",
  ]);
});

test("turn end message delivery failure does not fail a completed prompt", async () => {
  const replies: string[] = [];
  const logs: string[] = [];
  const completions: string[] = [];
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    turnEndMessage: "Done",
    showThoughts: false,
    log: (message) => {
      logs.push(message);
    },
    onReply: async (_userId, _contextToken, text) => {
      replies.push(text);
      if (text === "Done") {
        throw new Error("marker delivery failed");
      }
    },
    sendTyping: async () => {},
  });

  const session = makeTurnSession({
    flushText: "Final answer",
    producedMessage: true,
    events: [],
    completion: {
      resolve: () => {
        completions.push("resolved");
      },
      reject: () => {
        completions.push("rejected");
      },
    },
  });

  await processTurn(manager, session);

  assert.deepEqual(replies, ["Final answer", "Done"]);
  assert.deepEqual(completions, ["resolved"]);
  assert.ok(
    logs.some((message) =>
      message.includes("Failed to send turn end message: Error: marker delivery failed")
    ),
  );
  assert.equal(
    logs.some((message) => message.includes("Agent prompt error")),
    false,
  );
});

test("a new ACP session is persisted after its first completed prompt", async () => {
  const persisted: string[] = [];
  const manager = new SessionManager({
    agentCommand: "unused",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    resumePolicy: "auto",
    persistSessionId: async (userId, sessionId) => {
      persisted.push(`${userId}:${sessionId}`);
    },
    showThoughts: false,
    log: () => {},
    onReply: async () => {},
    sendTyping: async () => {},
  });
  const session = makeTurnSession({
    flushText: "Done",
    producedMessage: true,
    events: [],
  });

  await processTurn(manager, session);

  assert.deepEqual(persisted, ["user-1:session-1"]);
  assert.equal(session.sessionIdPersisted, true);
});
