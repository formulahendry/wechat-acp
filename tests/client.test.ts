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
  log?: (msg: string) => void;
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
    log: opts.log ?? (() => {}),
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

/** Copilot CLI shape: image only in rawOutput.binaryResultsForLlm, no content blocks. */
async function emitToolCallRawOutputImage(
  client: WeChatAcpClient,
  rawOutput: unknown,
  content?: unknown[],
): Promise<void> {
  await client.sessionUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-raw-1",
      status: "completed",
      ...(content ? { content } : {}),
      rawOutput,
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
   * Scenario: chunk A is flushed at boundary-1, then chunk B arrives and is
   * flushed at boundary-2 while A's send is still awaiting. The notification
   * queue must ensure A completes before B starts, so WeChat always receives
   * A before B. Notifications are deliberately not awaited between emits,
   * mirroring the ACP SDK's fire-and-forget dispatch.
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
  // chunk B and boundary-2 queue up behind A's in-flight send
  const p2 = emitMessageChunk(client, "chunk B");
  const p3 = emitToolCall(client);

  // Let A's send start, then release it
  await new Promise((r) => setTimeout(r, 10));
  releaseA();
  await Promise.all([p1, p2, p3]);

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

test("Copilot CLI shape: image only in rawOutput.binaryResultsForLlm is delivered", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallRawOutputImage(client, {
    content: "Viewed image file successfully.",
    detailedContent: "Viewed image file at path /tmp/white.png",
    binaryResultsForLlm: [
      {
        type: "image",
        data: PNG_BASE64,
        mimeType: "image/png",
        description: "Image file at path /tmp/white.png",
      },
    ],
  });

  assert.equal(images.length, 1);
  assert.equal(images[0].data, PNG_BASE64);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(client.hasProducedMessage, true, "fallback image counts as produced output");
});

test("rawOutput mimeType with surrounding whitespace is normalized and delivered", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallRawOutputImage(client, {
    binaryResultsForLlm: [{ type: "image", data: PNG_BASE64, mimeType: " image/png " }],
  });

  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png", "delivered MIME type must be trimmed");
});

test("content-block mimeType with surrounding whitespace is normalized and delivered", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallImage(client, { data: PNG_BASE64, mimeType: " image/PNG " });

  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/PNG", "delivered MIME type must be trimmed");
});

test("rawOutput fallback is skipped when a standard image content block is present", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallRawOutputImage(
    client,
    { binaryResultsForLlm: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] },
    [{ type: "content", content: { type: "image", data: PNG_BASE64, mimeType: "image/png" } }],
  );

  assert.equal(images.length, 1, "image must be delivered exactly once, not per source");
});

test("malformed rawOutput shapes are ignored without throwing", async () => {
  const images: AgentImage[] = [];
  const logs: string[] = [];
  const client = makeClient({
    onImageFlush: async (img) => { images.push(img); },
    log: (m) => { logs.push(m); },
  });
  client.newTurn();

  await emitToolCallRawOutputImage(client, "not an object");
  await emitToolCallRawOutputImage(client, null);
  await emitToolCallRawOutputImage(client, { binaryResultsForLlm: "not an array" });
  await emitToolCallRawOutputImage(client, {
    binaryResultsForLlm: [
      null,
      "string entry",
      { type: "text", text: "not an image" },
      { type: "image", data: 123, mimeType: "image/png" },
      { type: "image", data: PNG_BASE64 },
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", data: PNG_BASE64, mimeType: "" },
      { type: "image", data: PNG_BASE64, mimeType: "   " },
    ],
  });

  assert.equal(images.length, 0);
  const imageNotes = logs.filter((l) => l.includes("[images:"));
  assert.deepEqual(imageNotes, [], "malformed entries must not be counted as images");
});

test("[tool] log line reports image source: content block vs rawOutput fallback", async () => {
  const logs: string[] = [];
  const client = makeClient({
    onImageFlush: async () => {},
    log: (m) => { logs.push(m); },
  });
  client.newTurn();

  await emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });
  await emitToolCallRawOutputImage(client, {
    binaryResultsForLlm: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
  });
  await emitToolCallRawOutputImage(client, { content: "plain text result" });

  const toolLogs = logs.filter((l) => l.startsWith("[tool] tc-"));
  assert.equal(toolLogs.length, 3);
  assert.match(toolLogs[0], /\[images: 1 content block\]$/);
  assert.match(toolLogs[1], /\[images: 1 rawOutput fallback\]$/);
  assert.match(toolLogs[2], /completed$/, "no image note when the tool produced no image");
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

test("flush() waits for an unawaited in-flight image before reading the buffer", async () => {
  /**
   * The ACP SDK dispatches notifications without awaiting handlers, so the
   * final flush() can race an image that is still uploading. Regression:
   * before serialization, flush() resolved while the image was in flight,
   * hasProducedMessage was still false, and session.ts sent the empty-turn
   * fallback notice on an image-only turn.
   */
  let releaseImage!: () => void;
  const images: AgentImage[] = [];
  const client = makeClient({
    onImageFlush: async (img) => {
      await new Promise<void>((r) => {
        releaseImage = r;
      });
      images.push(img);
    },
  });
  client.newTurn();

  // Fire-and-forget the image notification, then immediately flush.
  const notification = emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });
  const flushed = client.flush();

  // Let the image send start, then complete it.
  await new Promise((r) => setTimeout(r, 10));
  releaseImage();

  const text = await flushed;
  await notification;

  assert.equal(images.length, 1, "image must be delivered before flush() resolves");
  assert.equal(text, "");
  assert.equal(client.hasProducedMessage, true, "image-only turn must count as produced output");
});

test("text arriving during an image send cannot overtake it", async () => {
  let releaseImage!: () => void;
  const order: string[] = [];
  const client = makeClient({
    onMessageFlush: async (t) => {
      order.push(`text:${t}`);
    },
    onImageFlush: async () => {
      await new Promise<void>((r) => {
        releaseImage = r;
      });
      order.push("image");
    },
  });

  const p1 = emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });
  const p2 = emitMessageChunk(client, "after-image");
  const p3 = emitToolCall(client); // boundary flushes the buffered text

  await new Promise((r) => setTimeout(r, 10));
  releaseImage();
  await Promise.all([p1, p2, p3]);

  assert.deepEqual(order, ["image", "text:after-image"]);
});

test("failure placeholder keeps stream position when text arrives during the image send", async () => {
  /**
   * Regression: the failure placeholder used to be appended after any text
   * that arrived while onImageFlush was pending, reversing the original
   * image -> text order. Serialized handling buffers later text only after
   * the image task settles, so the placeholder lands in the image's slot.
   */
  let failImage!: (err: Error) => void;
  const client = makeClient({
    onImageFlush: async () => {
      await new Promise<void>((_, reject) => {
        failImage = reject;
      });
    },
  });
  client.newTurn();

  const p1 = emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });
  const p2 = emitMessageChunk(client, "after-image");

  await new Promise((r) => setTimeout(r, 10));
  failImage(new Error("CDN upload failed"));
  await Promise.all([p1, p2]);

  const text = await client.flush();
  const placeholderAt = text.indexOf("[image could not be delivered]");
  const textAt = text.indexOf("after-image");
  assert.ok(placeholderAt >= 0, "placeholder must be present");
  assert.ok(textAt >= 0, "later text must be preserved");
  assert.ok(placeholderAt < textAt, `placeholder must precede later text, got: ${JSON.stringify(text)}`);
});

// ---------------------------------------------------------------------------
// Cross-turn callback binding (issue 54)
// ---------------------------------------------------------------------------

function turnCallbacks(sinks: {
  messages?: string[];
  images?: AgentImage[];
  onImageFlush?: (img: AgentImage) => Promise<void>;
}) {
  return {
    sendTyping: async () => {},
    onThoughtFlush: async () => {},
    onMessageFlush: async (t: string) => {
      sinks.messages?.push(t);
    },
    onImageFlush:
      sinks.onImageFlush ??
      (async (img: AgentImage) => {
        sinks.images?.push(img);
      }),
  };
}

test("notification queued across a turn boundary delivers with its own turn's callbacks", async () => {
  /**
   * Regression for issue 54: a failed prompt() leaves notification tasks
   * queued; the old code rebound callbacks via plain mutation, so a queued
   * image task delivered into the NEXT turn's context token. Now
   * sessionUpdate captures the callbacks at arrival time and beginTurn's
   * swap is itself a queued task, so the straggler lands in turn 1's sink.
   */
  const turn1Images: AgentImage[] = [];
  const turn2Images: AgentImage[] = [];
  let releaseImage!: () => void;

  const client = makeClient({});
  await client.beginTurn(
    turnCallbacks({
      onImageFlush: async (img) => {
        await new Promise<void>((r) => { releaseImage = r; });
        turn1Images.push(img);
      },
    }),
  );

  // Straggler notification from turn 1; prompt() has already rejected, so
  // the session loop advances to turn 2 without draining the queue.
  const straggler = emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });

  // Turn 2 rebinding queues up behind the straggler.
  const turn2 = client.beginTurn(turnCallbacks({ images: turn2Images }));

  await new Promise((r) => setTimeout(r, 10));
  releaseImage();
  await Promise.all([straggler, turn2]);

  assert.equal(turn1Images.length, 1, "straggler image must deliver to its own turn's sink");
  assert.equal(turn2Images.length, 0, "next turn's sink must not receive the previous turn's image");
});

test("text flushed by a straggler boundary event goes to its own turn's sink", async () => {
  const turn1Messages: string[] = [];
  const turn2Messages: string[] = [];

  const client = makeClient({});
  await client.beginTurn(turnCallbacks({ messages: turn1Messages }));

  // Turn 1 buffers text; the boundary event that flushes it is still queued
  // when turn 2 begins.
  await emitMessageChunk(client, "turn-1 status");
  const straggler = emitToolCall(client);
  const turn2 = client.beginTurn(turnCallbacks({ messages: turn2Messages }));
  await Promise.all([straggler, turn2]);

  assert.deepEqual(turn1Messages, ["turn-1 status"], "flush must use turn 1's binding");
  assert.deepEqual(turn2Messages, [], "turn 2 must not receive turn 1's text");
});

test("beginTurn discards residual undelivered text instead of leaking it into the new turn", async () => {
  const client = makeClient({});
  await client.beginTurn(turnCallbacks({}));

  // Turn 1 buffers text but no boundary event flushes it and no final
  // flush() runs (the failed-prompt path).
  await emitMessageChunk(client, "undelivered turn-1 text");

  await client.beginTurn(turnCallbacks({}));

  const text = await client.flush();
  assert.equal(text, "", "turn-1 residue must not surface in turn 2's flush");
  assert.equal(client.hasProducedMessage, false, "beginTurn must reset per-turn state");
});

test("late old-turn notification queued after beginTurn cannot leak into the new turn", async () => {
  /**
   * Maintainer repro on PR 57: block a turn-1 image task so the chain
   * stalls, enqueue turn-2 beginTurn, then let a turn-1 text notification
   * arrive. It captures turn-1 state at arrival but runs after the boundary
   * task. With buffers shared on the client it wrote into the freshly reset
   * fields and turn 2's flush() returned turn-1 text under the new context;
   * with per-turn state it writes into the closed turn's object instead.
   */
  const turn2Messages: string[] = [];
  let releaseImage!: () => void;

  const client = makeClient({});
  await client.beginTurn(
    turnCallbacks({
      onImageFlush: async () => {
        await new Promise<void>((r) => { releaseImage = r; });
      },
    }),
  );

  // Turn-1 image task blocks the chain.
  const blocked = emitToolCallImage(client, { data: PNG_BASE64, mimeType: "image/png" });
  // Turn-2 boundary task queues behind it.
  const turn2 = client.beginTurn(turnCallbacks({ messages: turn2Messages }));
  // Late turn-1 text arrives after beginTurn was enqueued: it must bind to
  // turn-1 state even though it runs after the swap.
  const lateText = emitMessageChunk(client, "stale turn-1 text");

  await new Promise((r) => setTimeout(r, 10));
  releaseImage();
  await Promise.all([blocked, turn2, lateText]);

  const text = await client.flush();
  assert.equal(text, "", "turn-2 flush must not return turn-1 text");
  assert.equal(
    client.hasProducedMessage,
    false,
    "late turn-1 text must not mark turn 2 as having produced output",
  );
  assert.deepEqual(turn2Messages, [], "turn 2 sinks must stay untouched");
});
