/**
 * Tests for WeChatAcpClient message-flush behaviour.
 *
 * Verifies that intermediate status messages (flushed at tool_call /
 * thought boundaries) are delivered exactly once even when multiple
 * sessionUpdate notifications arrive concurrently – which happens because
 * the ACP SDK fires notification handlers without awaiting them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WeChatAcpClient, type AgentImage } from "../src/acp/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WeChatAcpClient with controllable callbacks. */
function makeClient(opts: {
  onMessageFlush?: (text: string) => Promise<void>;
  onThoughtFlush?: (text: string) => Promise<void>;
  onImageFlush?: (image: AgentImage) => Promise<void>;
  showImages?: boolean;
  sendDelay?: number;
}): WeChatAcpClient {
  const { sendDelay = 0 } = opts;
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  return new WeChatAcpClient({
    sendTyping: async () => {},
    onThoughtFlush:
      opts.onThoughtFlush ??
      (async () => {
        if (sendDelay) await delay(sendDelay);
      }),
    onMessageFlush:
      opts.onMessageFlush ??
      (async () => {
        if (sendDelay) await delay(sendDelay);
      }),
    onImageFlush: opts.onImageFlush,
    log: () => {},
    showThoughts: false,
    showImages: opts.showImages,
  });
}

async function emitMessageChunk(client: WeChatAcpClient, text: string): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  } as never);
}

async function emitToolCall(client: WeChatAcpClient): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "tool_call", title: "test-tool", status: "started" },
  } as never);
}

async function emitThoughtChunk(client: WeChatAcpClient, text = "thinking…"): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
  } as never);
}

const PNG_BASE64 = Buffer.from("fake-png-bytes").toString("base64");

async function emitToolCallImage(
  client: WeChatAcpClient,
  image: { data: string; mimeType: string },
): Promise<void> {
  await client.sessionUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      content: [{ type: "content", content: { type: "image", ...image } }],
    },
  } as never);
}

async function emitMessageChunkImage(
  client: WeChatAcpClient,
  image: { data: string; mimeType: string },
): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "agent_message_chunk", content: { type: "image", ...image } },
  } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("single intermediate message is flushed exactly once (sequential)", async () => {
  const calls: string[] = [];
  const client = makeClient({ onMessageFlush: async (t) => { calls.push(t); } });

  await emitMessageChunk(client, "status update");
  await emitToolCall(client);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], "status update");
});

test("concurrent tool_call events send the buffered message exactly once", async () => {
  /**
   * The ACP SDK fires notification handlers without awaiting them, so two
   * tool_call notifications can both reach maybeFlushMessage while the first
   * send is still in-progress. Regression: before the fix, both would see
   * non-empty chunks and each would trigger an independent send (triple-send).
   */
  const calls: string[] = [];
  const client = makeClient({
    onMessageFlush: async (text) => {
      calls.push(text);
      await new Promise<void>((r) => setTimeout(r, 20));
    },
  });

  await emitMessageChunk(client, "intermediate status");

  // Fire two concurrent boundary events without awaiting between them.
  const flush1 = emitToolCall(client);
  const flush2 = emitToolCall(client);
  await Promise.all([flush1, flush2]);

  assert.equal(calls.length, 1, `expected 1 send, got ${calls.length}: ${JSON.stringify(calls)}`);
  assert.equal(calls[0], "intermediate status");
});

test("three concurrent boundary events send the message exactly once", async () => {
  const calls: string[] = [];
  const client = makeClient({
    onMessageFlush: async (text) => {
      calls.push(text);
      await new Promise<void>((r) => setTimeout(r, 30));
    },
  });

  await emitMessageChunk(client, "部分搜索结果像是媒体汇总和平台片单混在一起");

  const p1 = emitToolCall(client);
  const p2 = emitThoughtChunk(client, "thinking");
  const p3 = emitToolCall(client);
  await Promise.all([p1, p2, p3]);

  assert.equal(
    calls.length,
    1,
    `intermediate status message sent ${calls.length}x instead of once`,
  );
});

test("final answer is delivered after intermediate flush clears the buffer", async () => {
  const messageCalls: string[] = [];
  const client = makeClient({
    onMessageFlush: async (t) => { messageCalls.push(t); },
  });
  client.newTurn();

  await emitMessageChunk(client, "searching…");
  await emitToolCall(client); // flushes "searching…"

  await emitMessageChunk(client, "here is the answer");
  const replyText = await client.flush();

  assert.equal(messageCalls.length, 1);
  assert.equal(messageCalls[0], "searching…");
  assert.equal(replyText, "here is the answer");
});

test("failed send retains buffer so final flush delivers the message", async () => {
  const client = makeClient({
    onMessageFlush: async () => { throw new Error("WeChat API error"); },
  });

  await emitMessageChunk(client, "status");
  await emitToolCall(client); // will fail; buffer should be retained

  const replyText = await client.flush();
  assert.equal(replyText, "status");
});

test("two sequential flushes are delivered in order (second waits for first)", async () => {
  /**
   * Scenario: chunk A is flushed at boundary-1, then chunk B is flushed at
   * boundary-2 while A's send is still awaiting. The mutex chain must ensure
   * A completes before B starts, so WeChat always receives A before B.
   */
  const order: string[] = [];
  let releaseA!: () => void;
  const client = makeClient({
    onMessageFlush: async (text) => {
      if (text === "chunk A") {
        // Simulate a slow first send
        await new Promise<void>((r) => {
          releaseA = r;
        });
      }
      order.push(text);
    },
  });

  await emitMessageChunk(client, "chunk A");
  // Fire boundary-1 without awaiting so it blocks on the slow send
  const p1 = emitToolCall(client);

  await emitMessageChunk(client, "chunk B");
  // Fire boundary-2 — must queue behind A
  const p2 = emitToolCall(client);

  // Release A's send
  releaseA();
  await Promise.all([p1, p2]);

  assert.deepEqual(order, ["chunk A", "chunk B"], "second message must arrive after first");
});

// ---------------------------------------------------------------------------
// Image content blocks
// ---------------------------------------------------------------------------

test("image in completed tool_call_update is delivered exactly once with data intact", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });

  assert.equal(images.length, 1);
  assert.equal(images[0].data, PNG_BASE64);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(client.hasProducedMessage, true, "image counts as produced output");
});

test("image in agent_message_chunk is delivered", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });

  await emitMessageChunkImage(client, { data: PNG_BASE64, mimeType: "image/jpeg" });

  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/jpeg");
});

test("text before an image is flushed first so ordering is preserved", async () => {
  const order: string[] = [];
  const client = makeClient({
    onMessageFlush: async (t) => { order.push(`text:${t}`); },
    onImageFlush: async () => { order.push("image"); },
  });

  await emitMessageChunk(client, "here is your chart:");
  await emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });
  await emitMessageChunk(client, "anything else?");
  const tail = await client.flush();

  assert.deepEqual(order, ["text:here is your chart:", "image"]);
  assert.equal(tail, "anything else?");
});

test("showImages=false drops images without calling the sink", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({
    onImageFlush: async (img) => { images.push(img); },
    showImages: false,
  });
  client.newTurn();

  await emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });

  assert.equal(images.length, 0);
  assert.equal(client.hasProducedMessage, false);
  assert.equal(await client.flush(), "", "no placeholder for intentionally hidden images");
});

test("unsupported mime type is skipped silently", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });

  await emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/svg+xml" });

  assert.equal(images.length, 0);
  assert.equal(await client.flush(), "");
});

test("oversized image is skipped with a placeholder instead of uploading", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });

  // ~12 MiB decoded > 10 MiB cap
  const oversized = "A".repeat(16 * 1024 * 1024);
  await emitToolCallImage(client, { data: oversized, mimeType: "image/png" });

  assert.equal(images.length, 0);
  const text = await client.flush();
  assert.match(text, /image too large/);
});

test("failed image delivery appends a placeholder to the text stream", async () => {
  const client = makeClient({
    onImageFlush: async () => { throw new Error("CDN upload failed"); },
  });
  client.newTurn();

  await emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });

  const text = await client.flush();
  assert.match(text, /image could not be delivered/);
  assert.equal(client.hasProducedMessage, true);
});

test("image without a configured sink is skipped without throwing", async () => {
  const client = makeClient({});
  await emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });
  assert.equal(await client.flush(), "");
});
