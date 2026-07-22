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
