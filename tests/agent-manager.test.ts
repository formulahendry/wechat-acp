import assert from "node:assert/strict";
import { test } from "node:test";

import { spawnAgent } from "../src/acp/agent-manager.js";
import { killAgent } from "../src/acp/agent-manager.js";
import { WeChatAcpClient } from "../src/acp/client.js";

test("spawnAgent aborts an agent stuck during ACP initialization", async () => {
  const client = new WeChatAcpClient({
    sendTyping: async () => {},
    onThoughtFlush: async () => {},
    onMessageFlush: async () => {},
    log: () => {},
    showThoughts: false,
  });
  const controller = new AbortController();
  const spawning = spawnAgent({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    client,
    signal: controller.signal,
    log: () => {},
  });
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(spawning);
});

function fakeAgentScript(opts: {
  loadSession: boolean;
  loadErrorCode?: number;
}): string {
  return `
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    rl.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: ${opts.loadSession} },
          },
        });
      } else if (request.method === "session/load") {
        ${
          opts.loadErrorCode === undefined
            ? `
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: request.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "historical reply" },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: { configOptions: [] },
        });`
            : `
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: ${opts.loadErrorCode}, message: "load failed" },
        });`
        }
      } else if (request.method === "session/new") {
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: { sessionId: "new-session", configOptions: [] },
        });
      }
    });
  `;
}

function makeClient(messages: string[]): WeChatAcpClient {
  return new WeChatAcpClient({
    sendTyping: async () => {},
    onThoughtFlush: async () => {},
    onMessageFlush: async (text) => {
      messages.push(text);
    },
    log: () => {},
    showThoughts: false,
  });
}

test("spawnAgent loads a supported persisted session without forwarding replay", async () => {
  const messages: string[] = [];
  const info = await spawnAgent({
    command: process.execPath,
    args: ["-e", fakeAgentScript({ loadSession: true })],
    cwd: process.cwd(),
    client: makeClient(messages),
    resumePolicy: "auto",
    persistedSessionId: "saved-session",
    log: () => {},
  });

  try {
    assert.equal(info.sessionId, "saved-session");
    assert.equal(info.sessionOutcome, "loaded");
    assert.deepEqual(messages, []);
  } finally {
    killAgent(info.process);
  }
});

test("spawnAgent auto mode creates a session when loading is unsupported", async () => {
  const info = await spawnAgent({
    command: process.execPath,
    args: ["-e", fakeAgentScript({ loadSession: false })],
    cwd: process.cwd(),
    client: makeClient([]),
    resumePolicy: "auto",
    persistedSessionId: "saved-session",
    log: () => {},
  });

  try {
    assert.equal(info.sessionId, "new-session");
    assert.equal(info.sessionOutcome, "unsupported");
  } finally {
    killAgent(info.process);
  }
});

test("spawnAgent auto mode only falls back for resource-not-found", async () => {
  const notFound = await spawnAgent({
    command: process.execPath,
    args: ["-e", fakeAgentScript({ loadSession: true, loadErrorCode: -32002 })],
    cwd: process.cwd(),
    client: makeClient([]),
    resumePolicy: "auto",
    persistedSessionId: "missing-session",
    log: () => {},
  });
  try {
    assert.equal(notFound.sessionOutcome, "not_found");
    assert.equal(notFound.sessionId, "new-session");
  } finally {
    killAgent(notFound.process);
  }

  await assert.rejects(
    spawnAgent({
      command: process.execPath,
      args: ["-e", fakeAgentScript({ loadSession: true, loadErrorCode: -32603 })],
      cwd: process.cwd(),
      client: makeClient([]),
      resumePolicy: "auto",
      persistedSessionId: "broken-session",
      log: () => {},
    }),
    /load failed/,
  );
});

test("spawnAgent required mode rejects an agent without session loading", async () => {
  await assert.rejects(
    spawnAgent({
      command: process.execPath,
      args: ["-e", fakeAgentScript({ loadSession: false })],
      cwd: process.cwd(),
      client: makeClient([]),
      resumePolicy: "required",
      persistedSessionId: "saved-session",
      log: () => {},
    }),
    /does not support loading persisted ACP session/,
  );
});

test("spawnAgent required mode allows a user's first session", async () => {
  const info = await spawnAgent({
    command: process.execPath,
    args: ["-e", fakeAgentScript({ loadSession: false })],
    cwd: process.cwd(),
    client: makeClient([]),
    resumePolicy: "required",
    log: () => {},
  });
  try {
    assert.equal(info.sessionId, "new-session");
    assert.equal(info.sessionOutcome, "new");
  } finally {
    killAgent(info.process);
  }
});

test("spawnAgent off mode ignores a persisted session", async () => {
  const info = await spawnAgent({
    command: process.execPath,
    args: ["-e", fakeAgentScript({ loadSession: true })],
    cwd: process.cwd(),
    client: makeClient([]),
    resumePolicy: "off",
    persistedSessionId: "saved-session",
    log: () => {},
  });
  try {
    assert.equal(info.sessionId, "new-session");
    assert.equal(info.sessionOutcome, "new");
  } finally {
    killAgent(info.process);
  }
});
