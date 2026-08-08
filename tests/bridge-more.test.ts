import assert from "node:assert/strict";
import { test } from "node:test";

import { WeChatAcpBridge } from "../src/bridge.js";
import { BRIDGE_COMMANDS, defaultConfig } from "../src/config.js";
import { MessageType, type WeixinMessage } from "../src/weixin/types.js";

class TestBridge extends WeChatAcpBridge {
  readonly enqueued: string[] = [];
  readonly sent: Array<{ contextToken: string; segment: string }> = [];
  sendBehavior: (
    contextToken: string,
    segment: string,
  ) => boolean | Promise<boolean> = () => true;

  protected override async enqueueMessage(
    _msg: WeixinMessage,
    _userId: string,
    contextToken: string,
  ): Promise<void> {
    this.enqueued.push(contextToken);
  }

  protected override async sendTextSegment(
    _userId: string,
    contextToken: string,
    segment: string,
  ): Promise<boolean> {
    this.sent.push({ contextToken, segment });
    return this.sendBehavior(contextToken, segment);
  }

  beginPrompt(contextToken: string): void {
    this.beginAgentPrompt("user", contextToken);
  }

  queueAgentReply(contextToken: string, text: string): Promise<void> {
    return this.sendAgentReply("user", contextToken, text);
  }
}

function textMessage(text: string, contextToken: string): WeixinMessage {
  return {
    from_user_id: "user",
    context_token: contextToken,
    message_type: MessageType.USER,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function makeBridge(): TestBridge {
  const config = defaultConfig();
  config.storage.stateFile = undefined;
  config.commandAliases = {
    [BRIDGE_COMMANDS.acpMore]: ["/acp-fetch-msg", "."],
  };
  return new TestBridge(config, () => {});
}

test("acp-more is intercepted without enqueueing an ACP turn", async () => {
  const bridge = makeBridge();

  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-more"));

  assert.deepEqual(bridge.enqueued, []);
  assert.deepEqual(bridge.sent, [
    { contextToken: "context-more", segment: "No pending messages right now." },
  ]);
});

test("bare dot alias is intercepted only as the complete message", async () => {
  const bridge = makeBridge();

  await bridge.handleMessage(textMessage(".", "context-dot"));
  assert.deepEqual(bridge.enqueued, []);
  await bridge.handleMessage(textMessage(". keep this prompt", "context-prompt"));

  assert.deepEqual(bridge.sent, [
    { contextToken: "context-dot", segment: "No pending messages right now." },
  ]);
  assert.deepEqual(bridge.enqueued, ["context-prompt"]);
});

test("normal delivery retains only failed segments and still attempts later segments", async () => {
  const bridge = makeBridge();
  const first = "a".repeat(4000);
  const second = "later segment";
  bridge.beginPrompt("context-agent");
  bridge.sendBehavior = (contextToken, segment) =>
    contextToken !== "context-agent" || segment !== first;

  await bridge.queueAgentReply("context-agent", `${first}\n${second}`);
  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-more"));

  assert.deepEqual(bridge.sent, [
    { contextToken: "context-agent", segment: first },
    { contextToken: "context-agent", segment: second },
    { contextToken: "context-more", segment: first },
  ]);
  assert.deepEqual(bridge.enqueued, []);
});

test("queued old reply cannot restore pending output after a newer prompt", async () => {
  const bridge = makeBridge();
  let releaseBlocker!: () => void;
  let blockerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    blockerStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  bridge.sendBehavior = async (contextToken) => {
    if (contextToken === "context-blocker") {
      blockerStarted();
      await blocked;
      return true;
    }
    return contextToken !== "context-old";
  };

  bridge.beginPrompt("context-old");
  const blocker = bridge.handleMessage(
    textMessage(BRIDGE_COMMANDS.acpMore, "context-blocker"),
  );
  await started;
  const oldReply = bridge.queueAgentReply("context-old", "stale output");
  bridge.beginPrompt("context-new");
  releaseBlocker();
  await blocker;
  await oldReply;
  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-fetch"));

  assert.deepEqual(bridge.sent, [
    { contextToken: "context-blocker", segment: "No pending messages right now." },
    { contextToken: "context-old", segment: "stale output" },
    { contextToken: "context-fetch", segment: "No pending messages right now." },
  ]);
});
