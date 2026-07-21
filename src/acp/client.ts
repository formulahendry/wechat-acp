/**
 * ACP Client implementation for WeChat.
 *
 * Implements the acp.Client interface: handles session updates (accumulates
 * text chunks), auto-allows all permission requests, and provides filesystem
 * access for the agent.
 */

import fs from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

/** An image content block produced by the agent, ready for outbound delivery. */
export interface AgentImage {
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
}

/** Raster formats WeChat can render as native image messages. */
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/** Sanity cap on decoded image size (10 MiB). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface WeChatAcpClientOpts {
  sendTyping: () => Promise<void>;
  onThoughtFlush: (text: string) => Promise<void>;
  onMessageFlush: (text: string) => Promise<void>;
  onImageFlush?: (image: AgentImage) => Promise<void>;
  onConfigOptionsUpdate?: (configOptions: acp.SessionConfigOption[]) => void;
  log: (msg: string) => void;
  showThoughts: boolean;
  showDiffs?: boolean;
  showImages?: boolean;
}

export class WeChatAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private opts: WeChatAcpClientOpts;
  private lastTypingAt = 0;
  private producedMessageThisTurn = false;
  // FIFO task queue serializing all session-notification handling and flush()
  // reads. The ACP SDK dispatches notifications without awaiting handlers, so
  // without this two sessionUpdate calls interleave at their first await:
  // sends can reorder, and flush() can read the buffer while an image send is
  // still in flight. Slots are reserved synchronously at call time, so queue
  // order always matches stream order.
  private taskChain: Promise<void> = Promise.resolve();
  private static readonly TYPING_INTERVAL_MS = 5_000;
  private static readonly SEND_MAX_ATTEMPTS = 3;
  private static readonly SEND_RETRY_BASE_MS = 300;

  /** Whether the agent emitted any non-empty message content during the current turn. */
  get hasProducedMessage(): boolean {
    return this.producedMessageThisTurn;
  }

  /** Reset per-turn delivery state. Called by beginTurn; exposed for tests. */
  newTurn(): void {
    this.producedMessageThisTurn = false;
  }

  constructor(opts: WeChatAcpClientOpts) {
    this.opts = opts;
  }

  /**
   * Start a new turn: rebind delivery callbacks to the new turn's context and
   * reset per-turn state. Runs as a task on the notification queue, so every
   * task from the previous turn (including ones left queued when a failed
   * `prompt()` rejected early) finishes delivering with its own turn's
   * callbacks before the swap; a notification can never deliver with the next
   * turn's binding (issue 54). Residual undelivered buffers (text the final
   * flush never read, trailing thoughts) are discarded at the boundary
   * instead of leaking into the new turn. Await this before sending the next
   * prompt.
   */
  async beginTurn(callbacks: {
    sendTyping: () => Promise<void>;
    onThoughtFlush: (text: string) => Promise<void>;
    onMessageFlush: (text: string) => Promise<void>;
    onImageFlush?: (image: AgentImage) => Promise<void>;
  }): Promise<void> {
    return this.enqueue(async () => {
      this.opts = {
        ...this.opts,
        sendTyping: callbacks.sendTyping,
        onThoughtFlush: callbacks.onThoughtFlush,
        onMessageFlush: callbacks.onMessageFlush,
        ...(callbacks.onImageFlush ? { onImageFlush: callbacks.onImageFlush } : {}),
      };
      const staleText = this.chunks.join("");
      const staleThoughts = this.thoughtChunks.join("");
      if (staleText.trim() || staleThoughts.trim()) {
        this.opts.log(
          `[turn] discarding residue from previous turn (${staleText.length} chars text, ${staleThoughts.length} chars thoughts)`,
        );
      }
      this.chunks = [];
      this.thoughtChunks = [];
      this.lastTypingAt = 0;
      this.newTurn();
    });
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-allow: find first "allow" option
    const allowOpt = params.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? "allow";

    this.opts.log(`[permission] auto-allowed: ${params.toolCall?.title ?? "unknown"} → ${optionId}`);

    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  /** Run `task` after all previously enqueued tasks. The slot is reserved
   * synchronously, before the first await, so callers racing into this method
   * are ordered by call time and nothing can jump the queue. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.taskChain.then(task);
    this.taskChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    // Bind the notification to the callbacks active at arrival time. A task
    // can sit queued across a turn boundary (beginTurn's swap is enqueued
    // behind it), and a straggler can even arrive while the previous turn's
    // residue is still draining; capturing here guarantees it delivers with
    // the binding of the turn it belongs to, never the next turn's (issue 54).
    const opts = this.opts;
    return this.enqueue(() => this.handleSessionUpdate(params, opts));
  }

  private async handleSessionUpdate(
    params: acp.SessionNotification,
    opts: WeChatAcpClientOpts,
  ): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.maybeFlushThoughts(opts);
        if (update.content.type === "text") {
          this.chunks.push(update.content.text);
          if (update.content.text.trim()) {
            this.producedMessageThisTurn = true;
          }
        } else if (update.content.type === "image") {
          await this.maybeSendImage(update.content, opts);
        }
        // Throttle typing indicators
        await this.maybeSendTyping(opts);
        break;

      case "tool_call":
        await this.maybeFlushThoughts(opts);
        await this.maybeFlushMessage(opts);
        opts.log(`[tool] ${update.title} (${update.status})`);
        await this.maybeSendTyping(opts);
        break;

      case "agent_thought_chunk":
        await this.maybeFlushMessage(opts);
        if (update.content.type === "text") {
          const text = update.content.text;
          opts.log(`[thought] ${text.length > 80 ? text.substring(0, 80) + "..." : text}`);
          if (opts.showThoughts) {
            this.thoughtChunks.push(text);
          }
        }
        await this.maybeSendTyping(opts);
        break;

      case "tool_call_update": {
        let imageContentBlocks = 0;
        if (update.status === "completed" && update.content) {
          for (const c of update.content) {
            if (c.type === "diff") {
              if (opts.showDiffs === false) {
                continue;
              }
              const diff = c as acp.Diff;
              const header = `--- ${diff.path}`;
              const lines: string[] = [header];
              if (diff.oldText != null) {
                for (const l of diff.oldText.split("\n")) lines.push(`- ${l}`);
              }
              if (diff.newText != null) {
                for (const l of diff.newText.split("\n")) lines.push(`+ ${l}`);
              }
              this.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
              this.producedMessageThisTurn = true;
            } else if (c.type === "content" && c.content.type === "image") {
              imageContentBlocks++;
              await this.maybeSendImage(c.content, opts);
            }
          }
        }
        // Copilot CLI compatibility: the CLI emits tool-result images only in
        // rawOutput.binaryResultsForLlm and never as ACP image content blocks
        // (formulahendry/wechat-acp issue 55). Fall back to rawOutput only
        // when the standard path produced no image, so an agent that one day
        // populates both fields never delivers the same image twice.
        let rawOutputImages = 0;
        if (update.status === "completed" && imageContentBlocks === 0) {
          rawOutputImages = await this.maybeSendRawOutputImages(update.rawOutput, opts);
        }
        if (update.status) {
          // Surface where images came from so field issues like issue 55
          // (image present but in a non-standard location) show up in logs.
          const imageNote =
            imageContentBlocks > 0
              ? ` [images: ${imageContentBlocks} content block]`
              : rawOutputImages > 0
                ? ` [images: ${rawOutputImages} rawOutput fallback]`
                : "";
          opts.log(`[tool] ${update.toolCallId} → ${update.status}${imageNote}`);
        }
        await this.maybeSendTyping(opts);
        break;
      }

      case "plan":
        // Log plan entries
        if (update.entries) {
          const items = update.entries
            .map((e: acp.PlanEntry, i: number) => `  ${i + 1}. [${e.status}] ${e.content}`)
            .join("\n");
          opts.log(`[plan]\n${items}`);
        }
        await this.maybeSendTyping(opts);
        break;

      case "config_option_update":
        opts.onConfigOptionsUpdate?.(update.configOptions);
        opts.log(`[config] ${update.configOptions.length} option(s) updated`);
        break;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    try {
      const content = await fs.promises.readFile(params.path, "utf-8");
      return { content };
    } catch (err) {
      throw new Error(`Failed to read file ${params.path}: ${String(err)}`);
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    try {
      await fs.promises.writeFile(params.path, params.content, "utf-8");
      return {};
    } catch (err) {
      throw new Error(`Failed to write file ${params.path}: ${String(err)}`);
    }
  }

  /** Get accumulated text and reset the buffer. Also flushes any remaining thoughts. */
  async flush(): Promise<string> {
    // Joins the task queue so any in-flight notification work (a pending text
    // send, an image upload) completes before the buffer is read. This also
    // guarantees hasProducedMessage is final when flush() resolves, so an
    // image-only turn is never mistaken for an empty one. Captures the
    // callbacks at call time for the same reason sessionUpdate does.
    const opts = this.opts;
    return this.enqueue(async () => {
      await this.maybeFlushThoughts(opts);
      const text = this.chunks.join("");
      this.chunks = [];
      this.lastTypingAt = 0;
      return text;
    });
  }

  /**
   * Compatibility fallback for agents that emit tool-result images only in
   * `rawOutput` instead of ACP image content blocks. GitHub Copilot CLI puts
   * them in `rawOutput.binaryResultsForLlm[]` as `{type: "image", data,
   * mimeType}` and leaves `update.content` unset (issue 55). The spec types
   * `rawOutput` as `unknown`, so every field is validated before use and
   * anything malformed is ignored. Returns the number of valid image entries
   * handed to `maybeSendImage`, so the caller can log the delivery source.
   */
  private async maybeSendRawOutputImages(
    rawOutput: unknown,
    opts: WeChatAcpClientOpts,
  ): Promise<number> {
    if (typeof rawOutput !== "object" || rawOutput === null) {
      return 0;
    }
    const bin = (rawOutput as { binaryResultsForLlm?: unknown }).binaryResultsForLlm;
    if (!Array.isArray(bin)) {
      return 0;
    }
    let images = 0;
    for (const entry of bin) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const { type, data, mimeType } = entry as {
        type?: unknown;
        data?: unknown;
        mimeType?: unknown;
      };
      // maybeSendImage normalizes the MIME type; here just require it to be
      // non-blank so blank entries are not counted or logged as images.
      if (
        type === "image" &&
        typeof data === "string" &&
        data &&
        typeof mimeType === "string" &&
        mimeType.trim()
      ) {
        images++;
        await this.maybeSendImage({ data, mimeType }, opts);
      }
    }
    return images;
  }

  /**
   * Deliver an agent-produced image content block as a native WeChat image
   * message, preserving stream order: buffered text preceding the image is
   * flushed first, then the image is sent. Runs entirely within one task on
   * the notification queue, so no other notification or flush() can observe
   * or mutate state mid-delivery. Unsupported MIME types are logged and
   * skipped; an oversized payload is logged and replaced with a placeholder
   * in the text stream, as is a failed delivery, so the turn never silently
   * loses content.
   */
  private async maybeSendImage(
    image: { data: string; mimeType: string },
    opts: WeChatAcpClientOpts,
  ): Promise<void> {
    // Trim once here so every image path (content block, message chunk,
    // rawOutput fallback) validates and delivers the same normalized value.
    const mimeType = image.mimeType.trim();
    if (opts.showImages === false) {
      opts.log(`[image] skipped (showImages=false, ${mimeType})`);
      return;
    }
    if (!opts.onImageFlush) {
      opts.log(`[image] skipped (no image sink configured, ${mimeType})`);
      return;
    }
    const mime = mimeType.toLowerCase();
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mime)) {
      opts.log(`[image] skipped unsupported type: ${mimeType}`);
      return;
    }
    // ceil(base64Len / 4) * 3 over-estimates by at most 2 bytes; fine for a cap.
    const approxBytes = Math.ceil(image.data.length / 4) * 3;
    if (approxBytes > MAX_IMAGE_BYTES) {
      opts.log(`[image] skipped oversized image (~${approxBytes} bytes > ${MAX_IMAGE_BYTES})`);
      this.chunks.push("\n⚠️ [image too large to deliver]\n");
      this.producedMessageThisTurn = true;
      return;
    }

    // Flush any text buffered before this image so ordering is preserved.
    // Degraded mode: if that flush fails after its retries, the text is
    // re-buffered for the final flush() and the image is still delivered
    // now. Strict ordering is knowingly traded for content preservation
    // here; dropping or deferring a deliverable image because a text
    // segment hit a transient send failure would lose more than it saves.
    await this.maybeFlushMessage(opts);

    try {
      // Single attempt here: the bridge-side sink owns retries (with a stable
      // client_id for gateway de-duplication), so retrying again at this layer
      // would multiply CDN uploads.
      await opts.onImageFlush({ data: image.data, mimeType });
      opts.log(`[image] sent (${mimeType}, ~${approxBytes} bytes)`);
      this.producedMessageThisTurn = true;
    } catch (err) {
      opts.log(`[image] delivery failed: ${String(err)}`);
      // Queue serialization means no later text has been buffered yet, so the
      // placeholder lands exactly where the image belonged in the stream.
      this.chunks.push("\n⚠️ [image could not be delivered]\n");
      this.producedMessageThisTurn = true;
    }
  }

  private async maybeFlushThoughts(opts: WeChatAcpClientOpts): Promise<void> {
    if (this.thoughtChunks.length === 0) return;
    const thoughtText = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    if (!thoughtText.trim()) return;
    const ok = await this.sendWithRetry(
      () => opts.onThoughtFlush(`💭 [Thinking]\n${thoughtText}`),
      "thought",
      opts,
    );
    if (!ok) {
      opts.log(`[flush] dropping ${thoughtText.length} chars of thought after retries`);
    }
  }

  /**
   * Stream the buffered agent message (and any embedded diffs) as its own
   * WeChat reply. Called at thought/tool_call boundaries so multi-step turns
   * surface narrative segments in order; the final segment is still returned
   * by `flush()` so the caller can append stop-reason suffixes. Always runs
   * within a task on the notification queue, which guarantees FIFO send
   * order without needing its own mutex.
   */
  private async maybeFlushMessage(opts: WeChatAcpClientOpts): Promise<void> {
    if (this.chunks.length === 0) return;
    const text = this.chunks.join("");
    this.chunks = [];
    if (!text.trim()) {
      return;
    }

    const ok = await this.sendWithRetry(() => opts.onMessageFlush(text), "message", opts);
    if (!ok) {
      // Send failed after all retries. Prepend the unsent text back so the
      // final flush() returns it and session.ts re-attempts via onReply (which
      // surfaces failure to the user).
      this.chunks = [text, ...this.chunks];
      opts.log(
        `[flush] message send failed after retries; retaining ${text.length} chars for final flush`,
      );
    }
  }

  /**
   * Send with bounded retries and linear backoff (`SEND_RETRY_BASE_MS *
   * attempt`). Returns true on success, false if all attempts failed
   * (logging each failure so transient WeChat send errors are surfaced
   * instead of silently swallowed).
   */
  private async sendWithRetry(
    send: () => Promise<void>,
    label: string,
    opts: WeChatAcpClientOpts,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= WeChatAcpClient.SEND_MAX_ATTEMPTS; attempt++) {
      try {
        await send();
        return true;
      } catch (err) {
        opts.log(
          `[flush] ${label} send failed (attempt ${attempt}/${WeChatAcpClient.SEND_MAX_ATTEMPTS}): ${String(err)}`,
        );
        if (attempt < WeChatAcpClient.SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, WeChatAcpClient.SEND_RETRY_BASE_MS * attempt));
        }
      }
    }
    return false;
  }

  private async maybeSendTyping(opts: WeChatAcpClientOpts): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < WeChatAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    try {
      await opts.sendTyping();
    } catch {
      // typing is best-effort
    }
  }
}
