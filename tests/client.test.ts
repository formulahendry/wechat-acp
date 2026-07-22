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
import {
  WeChatAcpClient,
  type AgentImage,
  type AgentAudio,
  type AgentFile,
} from "../src/acp/client.js";
import {
  MAX_AGENT_FILE_BYTES,
  type AgentResourceLink,
} from "../src/artifacts/types.js";
import { splitText } from "../src/weixin/send.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WeChatAcpClient with controllable callbacks. */
function makeClient(opts: {
  onMessageFlush?: (text: string) => Promise<void>;
  onThoughtFlush?: (text: string) => Promise<void>;
  onImageFlush?: (image: AgentImage) => Promise<void>;
  onAudioFlush?: (audio: AgentAudio) => Promise<void>;
  onFileFlush?: (file: AgentFile) => Promise<void>;
  resolveResourceLink?: (link: AgentResourceLink) => Promise<AgentFile | null>;
  showImages?: boolean;
  showAudio?: boolean;
  showResources?: boolean;
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
    onAudioFlush: opts.onAudioFlush,
    onFileFlush: opts.onFileFlush,
    resolveResourceLink: opts.resolveResourceLink,
    log: opts.log ?? (() => {}),
    showThoughts: false,
    showImages: opts.showImages,
    showAudio: opts.showAudio,
    showResources: opts.showResources,
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
const MP3_BASE64 = Buffer.from("fake-mp3-bytes").toString("base64");

async function emitToolCallAudio(
  client: WeChatAcpClient,
  audio: { data: string; mimeType: string },
): Promise<void> {
  await client.sessionUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-audio-1",
      status: "completed",
      content: [{ type: "content", content: { type: "audio", ...audio } }],
    },
  } as never);
}

async function emitMessageChunkAudio(
  client: WeChatAcpClient,
  audio: { data: string; mimeType: string },
): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "agent_message_chunk", content: { type: "audio", ...audio } },
  } as never);
}

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

type ResourceContents =
  | { uri: string; text: string; mimeType?: string }
  | { uri: string; blob: string; mimeType?: string };

async function emitToolCallResource(
  client: WeChatAcpClient,
  resource: ResourceContents,
): Promise<void> {
  await client.sessionUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-res-1",
      status: "completed",
      content: [{ type: "content", content: { type: "resource", resource } }],
    },
  } as never);
}

async function emitMessageChunkResource(
  client: WeChatAcpClient,
  resource: ResourceContents,
): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "agent_message_chunk", content: { type: "resource", resource } },
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
  await emitToolCallRawOutputImage(client, {
    contents: [
      {
        type: "resource",
        resource: {
          uri: "file:///workspace/raw-output-resource.png",
          blob: PNG_BASE64,
          mimeType: "image/png",
        },
      },
    ],
  });
  await emitToolCallRawOutputImage(client, { content: "plain text result" });

  const toolLogs = logs.filter((l) => l.startsWith("[tool] tc-"));
  assert.equal(toolLogs.length, 4);
  assert.match(toolLogs[0], /\[images: 1 content block\]$/);
  assert.match(toolLogs[1], /\[images: 1 rawOutput fallback\]$/);
  assert.match(toolLogs[2], /\[images: 1 rawOutput fallback\] \[resources: 1 rawOutput fallback\]$/);
  assert.match(toolLogs[3], /completed$/, "no image note when the tool produced no image");
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
// Embedded resource content blocks (issue 59)
// ---------------------------------------------------------------------------

test("text resource in completed tool_call_update renders as a fenced block with header", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallResource(client, {
    uri: "file:///home/user/script.py",
    mimeType: "text/x-python",
    text: "def hello():\n    print('Hello, world!')",
  });

  const text = await client.flush();
  assert.match(text, /📎 script\.py \(text\/x-python\)/);
  assert.match(text, /```python\n/);
  assert.match(text, /def hello\(\):/);
  assert.match(text, /```\n/);
  assert.equal(client.hasProducedMessage, true, "resource-only turn counts as produced output");
});

test("text resource in agent_message_chunk renders in stream order with surrounding text", async () => {
  const flushed: string[] = [];
  const client = makeClient({ onMessageFlush: async (t) => { flushed.push(t); } });

  await emitMessageChunk(client, "config file below:");
  await emitMessageChunkResource(client, {
    uri: "file:///app/config.json",
    mimeType: "application/json",
    text: '{"a": 1}',
  });
  await emitToolCall(client); // boundary forces a flush

  assert.equal(flushed.length, 1);
  const at = { text: flushed[0].indexOf("config file below:"), res: flushed[0].indexOf("📎 config.json") };
  assert.ok(at.text >= 0 && at.res >= 0, "both parts present in one flush");
  assert.ok(at.text < at.res, "text precedes resource in the same segment");
  assert.match(flushed[0], /```json\n/);
});

test("resource name falls back to the full URI when there is no path segment", async () => {
  const client = makeClient({});

  await emitToolCallResource(client, { uri: "untitled:Untitled-1", text: "notes" });

  const text = await client.flush();
  assert.match(text, /📎 untitled:Untitled-1\n/);
});

test("resource fence language falls back to the file extension when MIME is absent", async () => {
  const client = makeClient({});

  await emitToolCallResource(client, { uri: "file:///src/main.ts", text: "export {};" });

  const text = await client.flush();
  assert.match(text, /📎 main\.ts\n/);
  assert.match(text, /```typescript\n/);
});

test("oversized text resource truncates with an explicit tail inside the fence", async () => {
  const client = makeClient({});

  const body = "x".repeat(4000 + 1234);
  await emitToolCallResource(client, { uri: "file:///big.txt", text: body });

  const text = await client.flush();
  assert.match(text, /\.\.\. \[truncated, \d+ more chars\]/);
  assert.ok(text.length <= 4000, `rendered block fits one WeChat segment (got ${text.length})`);
  assert.equal(splitText(text, 4000).length, 1, "block is never split across messages");
  assert.ok(text.trimEnd().endsWith("```"), "closing fence survives truncation");
});

test("oversized resource with long name and MIME still fits one segment", async () => {
  const client = makeClient({});

  const name = "a".repeat(300) + ".txt";
  await emitToolCallResource(client, {
    uri: `file:///${name}`,
    mimeType: "text/plain; " + "p".repeat(200),
    text: "y".repeat(10_000),
  });

  const text = await client.flush();
  assert.ok(text.length <= 4000, `worst-case overhead stays in budget (got ${text.length})`);
  assert.equal(splitText(text, 4000).length, 1, "block is never split across messages");
  const header = text.split("\n").find((l) => l.includes("📎"));
  const labels = header?.match(/^📎 (.+) \((.+)\)$/);
  assert.ok(labels, "header carries name and MIME note");
  assert.ok(labels[1].length <= 120, `name label capped including ellipsis (got ${labels[1].length})`);
  assert.ok(labels[2].length <= 120, `mime label capped including ellipsis (got ${labels[2].length})`);
});

test("buffered narrative is flushed first when it would push the resource block past one segment", async () => {
  const messages: string[] = [];
  const client = makeClient({ onMessageFlush: async (t) => { messages.push(t); } });
  client.newTurn();

  const narrative = "line\n".repeat(780); // ~3900 chars buffered ahead of the resource
  await emitMessageChunk(client, narrative);
  await emitToolCallResource(client, { uri: "file:///notes.txt", text: "note ".repeat(100) });

  assert.equal(messages.length, 1, "narrative must flush before the block is appended");
  assert.equal(messages[0], narrative);
  const text = await client.flush();
  assert.match(text, /^\n📎 notes\.txt\n/, "block starts its own segment");
  assert.equal(splitText(text, 4000).length, 1, "block is never split across messages");
});

test("small narrative and resource block share one segment without an early flush", async () => {
  const messages: string[] = [];
  const client = makeClient({ onMessageFlush: async (t) => { messages.push(t); } });
  client.newTurn();

  await emitMessageChunk(client, "before\n");
  await emitToolCallResource(client, { uri: "file:///small.txt", text: "tiny" });

  assert.equal(messages.length, 0, "no premature flush when everything fits one segment");
  const text = await client.flush();
  assert.match(text, /^before\n/);
  assert.match(text, /📎 small\.txt\n/);
  assert.equal(splitText(text, 4000).length, 1);
});

test("text resource containing triple backticks gets a longer fence", async () => {
  const client = makeClient({});

  await emitToolCallResource(client, {
    uri: "file:///doc.md",
    mimeType: "text/markdown",
    text: "example:\n```js\ncode\n```\ndone",
  });

  const text = await client.flush();
  assert.match(text, /````markdown\n/, "fence is longer than the inner backtick run");
  const closingAt = text.lastIndexOf("````");
  assert.ok(closingAt > text.indexOf("````markdown"), "closing fence matches");
});

test("image blob resource is delivered through the image pipeline exactly once", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallResource(client, {
    uri: "file:///chart.png",
    mimeType: "image/png",
    blob: PNG_BASE64,
  });

  assert.equal(images.length, 1);
  assert.equal(images[0].data, PNG_BASE64);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(client.hasProducedMessage, true);
  assert.equal(await client.flush(), "", "no text residue for a delivered image blob");
});

test("resource image suppresses the rawOutput fallback so the image is not delivered twice", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallRawOutputImage(
    client,
    { binaryResultsForLlm: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] },
    [
      {
        type: "content",
        content: {
          type: "resource",
          resource: { uri: "file:///chart.png", mimeType: "image/png", blob: PNG_BASE64 },
        },
      },
    ],
  );

  assert.equal(images.length, 1, "image must be delivered exactly once, not per source");
});

test("non-image blob resource surfaces as a one-line placeholder", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  const blob = Buffer.from("binary-data-here").toString("base64");
  await emitToolCallResource(client, {
    uri: "file:///data.bin",
    mimeType: "application/octet-stream",
    blob,
  });

  assert.equal(images.length, 0, "binary blob must not hit the image sink");
  const text = await client.flush();
  assert.match(text, /📎 \[resource: data\.bin \(application\/octet-stream, ~\d+ bytes\) - binary content not rendered\]/);
  assert.equal(client.hasProducedMessage, true);
});

test("blob resource without a MIME type reports unknown type in the placeholder", async () => {
  const client = makeClient({});

  await emitToolCallResource(client, { uri: "file:///mystery", blob: PNG_BASE64 });

  const text = await client.flush();
  assert.match(text, /📎 \[resource: mystery \(unknown type, ~\d+ bytes\) - binary content not rendered\]/);
});

test("non-image blob resource is delivered through the generic file pipeline", async () => {
  const files: AgentFile[] = [];
  const blob = Buffer.from("binary-data-here").toString("base64");
  const client = makeClient({
    onFileFlush: async (file) => {
      files.push(file);
    },
  });

  await emitToolCallResource(client, {
    uri: "file:///report.pdf",
    mimeType: "application/pdf",
    blob,
  });

  assert.deepEqual(files, [
    { data: blob, name: "report.pdf", mimeType: "application/pdf" },
  ]);
  assert.equal(await client.flush(), "");
  assert.equal(client.hasProducedMessage, true);
});

test("file exactly at the decoded size limit is delivered despite base64 padding", async () => {
  let delivered = false;
  const encodedLength = 4 * Math.ceil(MAX_AGENT_FILE_BYTES / 3);
  const data = `${"A".repeat(encodedLength - 2)}==`;
  const client = makeClient({
    onFileFlush: async () => {
      delivered = true;
    },
  });

  await emitToolCallResource(client, {
    uri: "file:///limit.bin",
    mimeType: "application/octet-stream",
    blob: data,
  });

  assert.equal(delivered, true);
  assert.equal(await client.flush(), "");
});

test("resource_link in agent_message_chunk resolves and delivers a file", async () => {
  const files: AgentFile[] = [];
  const seen: AgentResourceLink[] = [];
  const client = makeClient({
    resolveResourceLink: async (link) => {
      seen.push(link);
      return {
        data: Buffer.from("attachment").toString("base64"),
        name: "result.zip",
        mimeType: "application/zip",
      };
    },
    onFileFlush: async (file) => {
      files.push(file);
    },
  });

  await client.sessionUpdate({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "wechat-acp://artifact/123",
        name: "result.zip",
        mimeType: "application/zip",
      },
    },
  } as never);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].uri, "wechat-acp://artifact/123");
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "result.zip");
});

test("image resource_link resolves and delivers through the native image pipeline", async () => {
  const images: AgentImage[] = [];
  const files: AgentFile[] = [];
  const client = makeClient({
    resolveResourceLink: async () => ({
      data: PNG_BASE64,
      name: "screenshot.jpg",
      mimeType: "image/jpeg",
    }),
    onImageFlush: async (image) => {
      images.push(image);
    },
    onFileFlush: async (file) => {
      files.push(file);
    },
  });

  await client.sessionUpdate({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "wechat-acp://artifact/screenshot",
        name: "screenshot.jpg",
        mimeType: "image/jpeg",
      },
    },
  } as never);

  assert.deepEqual(images, [{ data: PNG_BASE64, mimeType: "image/jpeg" }]);
  assert.equal(files.length, 0);
  assert.equal(await client.flush(), "");
});

test("image resource_link falls back to file delivery when images are hidden", async () => {
  const images: AgentImage[] = [];
  const files: AgentFile[] = [];
  const client = makeClient({
    showImages: false,
    resolveResourceLink: async () => ({
      data: PNG_BASE64,
      name: "hidden-image.jpg",
      mimeType: "image/jpeg",
    }),
    onImageFlush: async (image) => {
      images.push(image);
    },
    onFileFlush: async (file) => {
      files.push(file);
    },
  });

  await client.sessionUpdate({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "wechat-acp://artifact/hidden-image",
        name: "hidden-image.jpg",
        mimeType: "image/jpeg",
      },
    },
  } as never);

  assert.equal(images.length, 0);
  assert.deepEqual(files, [
    { data: PNG_BASE64, name: "hidden-image.jpg", mimeType: "image/jpeg" },
  ]);
});

test("completed tool_call resource_link is delivered for Codex-style output", async () => {
  const files: AgentFile[] = [];
  const client = makeClient({
    resolveResourceLink: async () => ({
      data: Buffer.from("codex-file").toString("base64"),
      name: "codex.txt",
      mimeType: "text/plain",
    }),
    onFileFlush: async (file) => {
      files.push(file);
    },
  });

  await client.sessionUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-codex-link",
      title: "Create file",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "resource_link",
            uri: "file:///workspace/codex.txt",
            name: "codex.txt",
          },
        },
      ],
    },
  } as never);

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "codex.txt");
});

test("resource_link in tool_call_update preserves text-before-file ordering", async () => {
  const order: string[] = [];
  const client = makeClient({
    onMessageFlush: async (text) => {
      order.push(`text:${text}`);
    },
    resolveResourceLink: async () => ({
      data: Buffer.from("file").toString("base64"),
      name: "output.txt",
      mimeType: "text/plain",
    }),
    onFileFlush: async (file) => {
      order.push(`file:${file.name}`);
    },
  });
  await emitMessageChunk(client, "before");

  await client.sessionUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-link",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "resource_link",
            uri: "wechat-acp://artifact/output",
            name: "output.txt",
          },
        },
      ],
    },
  } as never);

  assert.deepEqual(order, ["text:before", "file:output.txt"]);
});

test("showResources=false does not resolve or deliver resource links", async () => {
  let resolverCalls = 0;
  const files: AgentFile[] = [];
  const client = makeClient({
    showResources: false,
    resolveResourceLink: async () => {
      resolverCalls++;
      return {
        data: Buffer.from("hidden").toString("base64"),
        name: "hidden.txt",
        mimeType: "text/plain",
      };
    },
    onFileFlush: async (file) => {
      files.push(file);
    },
  });

  await client.sessionUpdate({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "wechat-acp://artifact/hidden",
        name: "hidden.txt",
      },
    },
  } as never);

  assert.equal(resolverCalls, 0);
  assert.equal(files.length, 0);
  assert.equal(await client.flush(), "");
});

test("showResources=false drops resources without rendering", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({
    onImageFlush: async (img) => { images.push(img); },
    showResources: false,
  });
  client.newTurn();

  await emitToolCallResource(client, { uri: "file:///a.txt", text: "hello" });
  await emitToolCallResource(client, { uri: "file:///b.png", mimeType: "image/png", blob: PNG_BASE64 });

  assert.equal(images.length, 0);
  assert.equal(client.hasProducedMessage, false);
  assert.equal(await client.flush(), "", "no output for intentionally hidden resources");
});

test("empty text resource is skipped without rendering an empty fence", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallResource(client, { uri: "file:///empty.txt", text: "   \n" });

  assert.equal(client.hasProducedMessage, false);
  assert.equal(await client.flush(), "");
});

test("resource name with encoded newlines and control chars stays a single line", async () => {
  const client = makeClient({});
  client.newTurn();

  // %0A / %0D decode to LF / CR; %1B is ESC. None may survive into the header.
  await emitToolCallResource(client, {
    uri: "file:///tmp/evil%0Ainjected%0D%1Bline.txt",
    text: "payload",
  });

  const text = await client.flush();
  const header = text.split("\n").find((l) => l.startsWith("📎 "));
  assert.ok(header, "header line present");
  assert.match(header, /📎 evil injected line\.txt/);
  assert.ok(!text.includes("\u001b"), "no escape chars in the rendered output");
});

test("mime type with newlines is sanitized in the text-resource header", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallResource(client, {
    uri: "file:///notes.txt",
    mimeType: "text/plain\nFAKE: injected",
    text: "hello",
  });

  const text = await client.flush();
  assert.match(text, /📎 notes\.txt \(text\/plain FAKE: injected\)\n/);
});

test("mime type with newlines is sanitized in the blob placeholder", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  const blob = Buffer.from("bytes").toString("base64");
  await emitToolCallResource(client, {
    uri: "file:///data.bin",
    mimeType: "application/x-thing\r\nFAKE: injected",
    blob,
  });

  assert.equal(images.length, 0);
  const text = await client.flush();
  assert.match(
    text,
    /📎 \[resource: data\.bin \(application\/x-thing FAKE: injected, ~\d+ bytes\) - binary content not rendered\]/,
  );
});

test("overlong resource name is capped in the header", async () => {
  const client = makeClient({});
  client.newTurn();

  const longName = "a".repeat(400) + ".txt";
  await emitToolCallResource(client, { uri: `file:///tmp/${longName}`, text: "body" });

  const text = await client.flush();
  const header = text.split("\n").find((l) => l.startsWith("📎 "));
  assert.ok(header, "header line present");
  assert.ok(header.length < 200, `header stays bounded, got ${header.length}`);
  assert.match(header, /\.\.\.$/);
});

test("image blob resource with MIME parameters is routed with the base type", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallResource(client, {
    uri: "file:///chart.png",
    mimeType: "image/PNG; charset=binary",
    blob: PNG_BASE64,
  });

  assert.equal(images.length, 1, "parameterized image MIME still delivers as an image");
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(await client.flush(), "", "no placeholder for a delivered image");
});

test("unsupported image blob resource falls back to the placeholder instead of vanishing", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallResource(client, {
    uri: "file:///scan.tiff",
    mimeType: "image/tiff",
    blob: PNG_BASE64,
  });

  assert.equal(images.length, 0, "unsupported image type must not hit the image sink");
  const text = await client.flush();
  assert.match(text, /📎 \[resource: scan\.tiff \(image\/tiff, ~\d+ bytes\) - binary content not rendered\]/);
});

test("image blob resource with showImages=false surfaces as a placeholder, not a silent drop", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({
    onImageFlush: async (img) => { images.push(img); },
    showImages: false,
  });
  client.newTurn();

  await emitToolCallResource(client, {
    uri: "file:///chart.png",
    mimeType: "image/png",
    blob: PNG_BASE64,
  });

  assert.equal(images.length, 0, "hidden images must not hit the image sink");
  assert.equal(client.hasProducedMessage, true, "resource-only turn still counts as produced output");
  const text = await client.flush();
  assert.match(text, /📎 \[resource: chart\.png \(image\/png, ~\d+ bytes\) - binary content not rendered\]/);
});

test("image blob resource without an image sink surfaces as a placeholder", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallResource(client, {
    uri: "file:///chart.png",
    mimeType: "image/png",
    blob: PNG_BASE64,
  });

  assert.equal(client.hasProducedMessage, true);
  const text = await client.flush();
  assert.match(text, /📎 \[resource: chart\.png \(image\/png, ~\d+ bytes\) - binary content not rendered\]/);
});

test("text resource ending with CRLF renders without a stray carriage return", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallResource(client, { uri: "file:///win.txt", text: "line1\r\nline2\r\n" });

  const text = await client.flush();
  assert.match(text, /line2\n```/, "closing fence sits directly after the last line");
  assert.ok(!/\r\n```/.test(text), "no stray CR before the closing fence");
});

test("authority-only URI falls back to the full URI instead of the bare host", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallResource(client, { uri: "https://example.com", text: "hello" });
  await emitToolCallResource(client, { uri: "https://example.org/", text: "hello" });

  const text = await client.flush();
  assert.match(text, /📎 https:\/\/example\.com\n/);
  assert.match(text, /📎 https:\/\/example\.org\/\n/);
  assert.ok(!/📎 example\.com/.test(text), "bare host must not be shown as the name");
});

test("MIME parameters do not defeat the fence language hint", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallResource(client, {
    uri: "file:///data",
    mimeType: "application/json; charset=utf-8",
    text: '{"a": 1}',
  });

  const text = await client.flush();
  assert.match(text, /```json\n/);
});

test("adversarial backtick run keeps the fence bounded and contained", async () => {
  const client = makeClient({});
  client.newTurn();

  const body = "start\n" + "`".repeat(3000) + "\nend";
  await emitToolCallResource(client, { uri: "file:///ticks.txt", text: body });

  const text = await client.flush();
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  assert.equal(longest, 8, "fence is capped at 8 ticks");
  const fenceLines = text.split("\n").filter((l) => /^`{8}/.test(l));
  assert.equal(fenceLines.length, 2, "opening and closing fences present");
  assert.ok(text.length < 300, `render stays bounded, got ${text.length}`);
});

// ---------------------------------------------------------------------------
// Audio content blocks (issue 58)
// ---------------------------------------------------------------------------

test("audio in completed tool_call_update is delivered exactly once with data intact", async () => {
  const audios: AgentAudio[] = [];
  const client = makeClient({ onAudioFlush: async (a) => { audios.push(a); } });
  client.newTurn();

  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "audio/mpeg" });

  assert.equal(audios.length, 1);
  assert.equal(audios[0].data, MP3_BASE64);
  assert.equal(audios[0].mimeType, "audio/mpeg");
  assert.equal(client.hasProducedMessage, true, "audio-only turn counts as produced output");
});

test("audio in agent_message_chunk is delivered", async () => {
  const audios: AgentAudio[] = [];
  const client = makeClient({ onAudioFlush: async (a) => { audios.push(a); } });

  await emitMessageChunkAudio(client, { data: MP3_BASE64, mimeType: "audio/wav" });

  assert.equal(audios.length, 1);
  assert.equal(audios[0].mimeType, "audio/wav");
});

test("audio mimeType with surrounding whitespace is normalized and delivered", async () => {
  const audios: AgentAudio[] = [];
  const client = makeClient({ onAudioFlush: async (a) => { audios.push(a); } });

  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "  audio/mpeg\n" });

  assert.equal(audios.length, 1);
  assert.equal(audios[0].mimeType, "audio/mpeg");
});

test("text before audio is flushed first so ordering is preserved", async () => {
  const order: string[] = [];
  const client = makeClient({
    onMessageFlush: async (t) => { order.push(`text:${t}`); },
    onAudioFlush: async () => { order.push("audio"); },
  });

  await emitMessageChunk(client, "here is the recording:");
  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "audio/mpeg" });
  await emitMessageChunk(client, "anything else?");
  const tail = await client.flush();

  assert.deepEqual(order, ["text:here is the recording:", "audio"]);
  assert.equal(tail, "anything else?");
});

test("showAudio=false drops audio without calling the sink", async () => {
  const audios: AgentAudio[] = [];
  const client = makeClient({
    onAudioFlush: async (a) => { audios.push(a); },
    showAudio: false,
  });
  client.newTurn();

  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "audio/mpeg" });

  assert.equal(audios.length, 0);
  assert.equal(client.hasProducedMessage, false);
  assert.equal(await client.flush(), "", "no placeholder for intentionally hidden audio");
});

test("unsupported audio mime type is skipped silently", async () => {
  const audios: AgentAudio[] = [];
  const client = makeClient({ onAudioFlush: async (a) => { audios.push(a); } });

  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "audio/midi" });

  assert.equal(audios.length, 0);
  assert.equal(await client.flush(), "");
});

test("prototype-chain mime keys do not pass the audio allow-list gate", async () => {
  // `"toString" in AUDIO_MIME_EXTENSIONS` would be true via the prototype
  // chain; the gate must use an own-property check.
  const audios: AgentAudio[] = [];
  const client = makeClient({ onAudioFlush: async (a) => { audios.push(a); } });

  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "toString" });
  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "constructor" });

  assert.equal(audios.length, 0);
  assert.equal(await client.flush(), "");
});

test("oversized audio is skipped with a placeholder instead of uploading", async () => {
  const audios: AgentAudio[] = [];
  const client = makeClient({ onAudioFlush: async (a) => { audios.push(a); } });

  // ~27 MiB decoded > 25 MiB cap
  const oversized = "A".repeat(36 * 1024 * 1024);
  await emitToolCallAudio(client, { data: oversized, mimeType: "audio/mpeg" });

  assert.equal(audios.length, 0);
  const text = await client.flush();
  assert.match(text, /audio too large/);
});

test("failed audio delivery appends a placeholder to the text stream", async () => {
  const client = makeClient({
    onAudioFlush: async () => { throw new Error("CDN upload failed"); },
  });
  client.newTurn();

  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "audio/mpeg" });

  const text = await client.flush();
  assert.match(text, /audio could not be delivered/);
  assert.equal(client.hasProducedMessage, true);
});

test("audio without a configured sink is skipped without throwing", async () => {
  const client = makeClient({});
  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "audio/mpeg" });
  assert.equal(await client.flush(), "");
});

test("beginTurn rebinds the audio sink to the new turn's callbacks", async () => {
  const firstTurn: AgentAudio[] = [];
  const secondTurn: AgentAudio[] = [];
  const client = makeClient({ onAudioFlush: async (a) => { firstTurn.push(a); } });

  await client.beginTurn({
    sendTyping: async () => {},
    onThoughtFlush: async () => {},
    onMessageFlush: async () => {},
    onAudioFlush: async (a: AgentAudio) => { secondTurn.push(a); },
  });
  await emitToolCallAudio(client, { data: MP3_BASE64, mimeType: "audio/mpeg" });

  assert.equal(firstTurn.length, 0, "old turn's sink must not receive the audio");
  assert.equal(secondTurn.length, 1);
});

test("beginTurn rebinds the file sink to the new turn's callbacks", async () => {
  const firstTurn: AgentFile[] = [];
  const secondTurn: AgentFile[] = [];
  const client = makeClient({
    onFileFlush: async (file) => {
      firstTurn.push(file);
    },
  });

  await client.beginTurn({
    sendTyping: async () => {},
    onThoughtFlush: async () => {},
    onMessageFlush: async () => {},
    onFileFlush: async (file) => {
      secondTurn.push(file);
    },
  });
  await emitToolCallResource(client, {
    uri: "file:///result.bin",
    mimeType: "application/octet-stream",
    blob: Buffer.from("result").toString("base64"),
  });

  assert.equal(firstTurn.length, 0);
  assert.equal(secondTurn.length, 1);
  assert.equal(secondTurn[0].name, "result.bin");
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

// ---------------------------------------------------------------------------
// Copilot CLI rawOutput resources (issue 62)
// ---------------------------------------------------------------------------

const BLOB_BASE64 = Buffer.from("COPILOT_RESOURCE_SENTINEL").toString("base64");

test("Copilot CLI rawOutput resource_link resolves and delivers a file", async () => {
  const files: AgentFile[] = [];
  const logs: string[] = [];
  const client = makeClient({
    resolveResourceLink: async (link) => ({
      data: Buffer.from(`resolved:${link.uri}`).toString("base64"),
      name: link.name ?? "artifact.txt",
      mimeType: link.mimeType ?? "application/octet-stream",
    }),
    onFileFlush: async (file) => {
      files.push(file);
    },
    log: (message) => {
      logs.push(message);
    },
  });

  await emitToolCallRawOutputImage(
    client,
    {
      content: "",
      detailedContent: "",
      contents: [
        {
          type: "resource_link",
          uri: "file:///workspace/artifact.txt",
          name: "artifact.txt",
          description: "Copilot ACP resource-link probe artifact",
          mimeType: "text/plain",
          size: 31,
        },
      ],
    },
    [{ type: "content", content: { type: "text", text: "" } }],
  );

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "artifact.txt");
  assert.equal(files[0].mimeType, "text/plain");
  assert.ok(
    logs.some((message) =>
      message.includes("[resource link entries: 1 rawOutput fallback]"),
    ),
  );
});

test("Copilot CLI rawOutput image resource_link resolves and delivers a native image", async () => {
  const images: AgentImage[] = [];
  const files: AgentFile[] = [];
  const client = makeClient({
    resolveResourceLink: async (link) => ({
      data: PNG_BASE64,
      name: link.name ?? "screenshot.jpg",
      mimeType: link.mimeType ?? "image/jpeg",
    }),
    onImageFlush: async (image) => {
      images.push(image);
    },
    onFileFlush: async (file) => {
      files.push(file);
    },
  });

  await emitToolCallRawOutputImage(
    client,
    {
      content: "",
      detailedContent: "",
      contents: [
        {
          type: "resource_link",
          uri: "file:///workspace/screenshot.jpg",
          name: "screenshot.jpg",
          mimeType: "image/jpeg",
          size: 128,
        },
      ],
    },
    [{ type: "content", content: { type: "text", text: "" } }],
  );

  assert.deepEqual(images, [{ data: PNG_BASE64, mimeType: "image/jpeg" }]);
  assert.equal(files.length, 0);
});

test("standard resource_link suppresses the mirrored rawOutput link", async () => {
  const files: AgentFile[] = [];
  const client = makeClient({
    resolveResourceLink: async (link) => ({
      data: Buffer.from("one-file").toString("base64"),
      name: link.name ?? "artifact.txt",
      mimeType: "text/plain",
    }),
    onFileFlush: async (file) => {
      files.push(file);
    },
  });

  const link = {
    type: "resource_link",
    uri: "wechat-acp://artifact/duplicate",
    name: "artifact.txt",
    mimeType: "text/plain",
  };
  await emitToolCallRawOutputImage(
    client,
    { contents: [link] },
    [{ type: "content", content: link }],
  );

  assert.equal(files.length, 1, "the standard and rawOutput copies must deliver once");
});

test("Copilot CLI shape: resource only in rawOutput renders exactly once", async () => {
  // Exact captured payload shape from Copilot CLI 1.0.73: an empty text
  // content block, the full resource in rawOutput.contents, and a URI-less
  // blob copy in rawOutput.binaryResultsForLlm.
  const client = makeClient({});
  client.newTurn();

  await emitToolCallRawOutputImage(
    client,
    {
      content: "",
      detailedContent: "",
      contents: [
        {
          type: "resource",
          resource: {
            uri: "memory://copilot-resource-probe/payload.bin",
            mimeType: "application/octet-stream",
            blob: BLOB_BASE64,
          },
        },
      ],
      binaryResultsForLlm: [
        { type: "resource", data: BLOB_BASE64, mimeType: "application/octet-stream" },
      ],
    },
    [{ type: "content", content: { type: "text", text: "" } }],
  );

  const text = await client.flush();
  const placeholders = text.match(/📎 \[resource: payload\.bin/g) ?? [];
  assert.equal(placeholders.length, 1, "resource present in both rawOutput fields must render once");
  assert.match(text, /application\/octet-stream, ~\d+ bytes\) - binary content not rendered\]/);
  assert.equal(client.hasProducedMessage, true);
});

test("text resource in rawOutput.contents renders as a fenced block with its URI name", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallRawOutputImage(client, {
    contents: [
      {
        type: "resource",
        resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# hi" },
      },
    ],
  });

  const text = await client.flush();
  assert.match(text, /📎 notes\.md \(text\/markdown\)/);
  assert.match(text, /```markdown\n# hi\n```/);
});

test("image resource in rawOutput.contents is delivered once despite a binaryResultsForLlm image copy", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallRawOutputImage(client, {
    contents: [
      {
        type: "resource",
        resource: { uri: "file:///chart.png", mimeType: "image/png", blob: PNG_BASE64 },
      },
    ],
    binaryResultsForLlm: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
  });

  assert.equal(images.length, 1, "image must be delivered exactly once, not per rawOutput field");
  assert.equal(images[0].data, PNG_BASE64);
});

test("binaryResultsForLlm resource entries are a fallback when rawOutput.contents is absent", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallRawOutputImage(client, {
    binaryResultsForLlm: [
      { type: "resource", data: BLOB_BASE64, mimeType: "application/octet-stream" },
    ],
  });

  const text = await client.flush();
  assert.match(
    text,
    /📎 \[resource: resource \(application\/octet-stream, ~\d+ bytes\) - binary content not rendered\]/,
    "URI-less fallback entries render under the generic name",
  );
});

test("standard resource content block suppresses rawOutput resource parsing", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallRawOutputImage(
    client,
    {
      contents: [
        {
          type: "resource",
          resource: { uri: "file:///dup.txt", mimeType: "text/plain", text: "from rawOutput" },
        },
      ],
    },
    [
      {
        type: "content",
        content: {
          type: "resource",
          resource: { uri: "file:///real.txt", mimeType: "text/plain", text: "from content block" },
        },
      },
    ],
  );

  const text = await client.flush();
  assert.match(text, /from content block/);
  assert.doesNotMatch(text, /from rawOutput/, "rawOutput copy must not render when a standard block exists");
});

test("malformed rawOutput resource entries are ignored safely", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallRawOutputImage(client, {
    contents: [
      null,
      "resource",
      42,
      { type: "resource" },
      { type: "resource", resource: null },
      { type: "resource", resource: { uri: 5 } },
      { type: "resource", resource: { uri: "file:///x.bin", blob: "" } },
      { type: "other", resource: { uri: "file:///y.txt", text: "nope" } },
    ],
    binaryResultsForLlm: [
      { type: "resource" },
      { type: "resource", data: "" },
      { type: "resource", data: 7, mimeType: "application/octet-stream" },
    ],
  });

  const text = await client.flush();
  assert.equal(text, "", "no malformed entry may render anything");
  assert.equal(images.length, 0);
  assert.equal(client.hasProducedMessage, false);
});

test("blank text entry in rawOutput.contents does not suppress the binaryResultsForLlm fallback", async () => {
  const client = makeClient({});
  client.newTurn();

  await emitToolCallRawOutputImage(client, {
    contents: [
      { type: "resource", resource: { uri: "file:///empty.txt", mimeType: "text/plain", text: "  \n" } },
    ],
    binaryResultsForLlm: [
      { type: "resource", data: BLOB_BASE64, mimeType: "application/octet-stream" },
    ],
  });

  const text = await client.flush();
  assert.match(
    text,
    /📎 \[resource: resource \(application\/octet-stream, ~\d+ bytes\) - binary content not rendered\]/,
    "blob present only in binaryResultsForLlm must still render",
  );
});

test("hidden image resource in rawOutput.contents suppresses the image fallback (no hide-resources bypass)", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ showResources: false, onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallRawOutputImage(client, {
    contents: [
      {
        type: "resource",
        resource: { uri: "file:///chart.png", mimeType: "image/png", blob: PNG_BASE64 },
      },
    ],
    binaryResultsForLlm: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
  });

  assert.equal(images.length, 0, "hidden resource must not leak through the image fallback");
  const text = await client.flush();
  assert.equal(text, "");
});

test("hidden image resource content block suppresses the image fallback (no hide-resources bypass)", async () => {
  const images: AgentImage[] = [];
  const client = makeClient({ showResources: false, onImageFlush: async (img) => { images.push(img); } });
  client.newTurn();

  await emitToolCallRawOutputImage(
    client,
    { binaryResultsForLlm: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] },
    [
      {
        type: "content",
        content: {
          type: "resource",
          resource: { uri: "file:///chart.png", mimeType: "image/png", blob: PNG_BASE64 },
        },
      },
    ],
  );

  assert.equal(images.length, 0, "hidden resource must not leak through the image fallback");
  const text = await client.flush();
  assert.equal(text, "");
});
