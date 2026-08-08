import assert from "node:assert/strict";
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
        process: { killed: true } as never,
        connection: {} as never,
        sessionId: userId,
        configOptions: [],
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
  const second = internal.getOrCreateSession("user-2", "context-2");

  assert.equal((await first).userId, "user-1");
  await assert.rejects(second, /Maximum concurrent sessions reached/);
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
      process: { killed: true } as never,
      connection: {} as never,
      sessionId: userId,
      configOptions: [],
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

function makeTurnSession(opts: {
  flushText: string;
  producedMessage: boolean;
  events: string[];
  stopReason?: "end_turn" | "cancelled" | "refusal";
}): UserSession {
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
      process: { killed: false, exitCode: null } as never,
      connection: {
        prompt: async () => {
          opts.events.push("prompt");
          return { stopReason: opts.stopReason ?? "end_turn" };
        },
      } as never,
      sessionId: "session-1",
      configOptions: [],
    },
    configOptions: [],
    queue: [{ prompt: [], contextToken: "turn-context" }],
    processing: true,
    lastActivity: Date.now(),
    createdAt: Date.now(),
  };
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

  await (
    manager as unknown as { processQueue(session: UserSession): Promise<void> }
  ).processQueue(session);

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

  await (
    manager as unknown as { processQueue(session: UserSession): Promise<void> }
  ).processQueue(session);

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

  await (
    manager as unknown as { processQueue(session: UserSession): Promise<void> }
  ).processQueue(session);

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

    await (
      manager as unknown as { processQueue(session: UserSession): Promise<void> }
    ).processQueue(session);

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

  await (
    manager as unknown as { processQueue(session: UserSession): Promise<void> }
  ).processQueue(session);

  assert.deepEqual(replies, [
    "ℹ️ The agent finished without sending a reply. Try rephrasing your request.",
    "Done",
  ]);
});
