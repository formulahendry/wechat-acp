import assert from "node:assert/strict";
import { test } from "node:test";

import { spawnAgent } from "../src/acp/agent-manager.js";
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
