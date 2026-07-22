/**
 * ACP Client implementation for WeChat.
 *
 * Implements the acp.Client interface: handles session updates (accumulates
 * text chunks), auto-allows all permission requests, and provides filesystem
 * access for the agent.
 */

import fs from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";
import {
  type AgentFile,
  type AgentResourceLink,
  MAX_AGENT_FILE_BYTES,
} from "../artifacts/types.js";
import { TEXT_CHUNK_LIMIT } from "../weixin/send.js";

export type { AgentFile } from "../artifacts/types.js";

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

/**
 * Budget for a rendered text-resource block: one WeChat segment, the same
 * {@link TEXT_CHUNK_LIMIT} that `deliverReply()` in bridge.ts segments
 * against. The whole block (header, fences, language hint, body,
 * truncation tail) must fit, so `splitText()` never has to split
 * mid-fence; the body budget is derived from this after subtracting the
 * rendered overhead.
 */
const MAX_RESOURCE_BLOCK_CHARS = TEXT_CHUNK_LIMIT;

/** Fence language hints by MIME type; extensions fill the gaps. */
const RESOURCE_MIME_LANGUAGES: Readonly<Record<string, string>> = {
  "application/json": "json",
  "application/javascript": "javascript",
  "text/javascript": "javascript",
  "text/x-python": "python",
  "text/html": "html",
  "text/css": "css",
  "text/xml": "xml",
  "application/xml": "xml",
  "text/markdown": "markdown",
  "text/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/x-sh": "bash",
  "text/x-shellscript": "bash",
};

/** Fence language hints by file extension of the resource name. */
const RESOURCE_EXT_LANGUAGES: Readonly<Record<string, string>> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  ps1: "powershell",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  toml: "toml",
  ini: "ini",
};

/** Cap on sanitized inline labels so a crafted URI cannot flood a header line. */
const MAX_LABEL_CHARS = 120;

/**
 * Collapse agent-controlled label text (resource names, MIME notes) to one
 * safe line before it is interpolated into `📎` headers, placeholders, or
 * logs. URIs percent-decode and MIME types arrive raw off the wire, so
 * either can carry newlines or control characters that would break the
 * one-line format and inject extra lines into the chat transcript.
 */
function sanitizeInlineLabel(value: string): string {
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cap includes the ellipsis so the documented bound holds exactly.
  return collapsed.length > MAX_LABEL_CHARS
    ? `${collapsed.slice(0, MAX_LABEL_CHARS - 3)}...`
    : collapsed;
}

function decodedBase64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Human-readable name for a resource: the last path segment of its URI,
 * percent-decoded and sanitized to a single line. Falls back to the full
 * URI when there is no useful path segment (e.g. `untitled:Untitled-1`,
 * an authority with no path like `https://example.com`, or an empty URI),
 * and to `resource` when nothing printable survives sanitization.
 */
function resourceDisplayName(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return "resource";
  const stripped = trimmed.replace(/[?#].*$/, "");
  const schemeMatch = stripped.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/);
  const rest = schemeMatch ? stripped.slice(schemeMatch[0].length) : stripped;
  let path = rest;
  if (rest.startsWith("//")) {
    // Hierarchical URI: drop the authority so a bare host is never
    // mistaken for a path segment (https://example.com has no path).
    const slash = rest.indexOf("/", 2);
    path = slash >= 0 ? rest.slice(slash) : "";
  } else if (schemeMatch && !rest.includes("/")) {
    // Opaque URI (untitled:Untitled-1): no path to extract.
    path = "";
  }
  const segments = path.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  let name: string;
  if (!last) {
    name = trimmed;
  } else {
    try {
      name = decodeURIComponent(last);
    } catch {
      name = last;
    }
  }
  return sanitizeInlineLabel(name) || "resource";
}

function resourceFenceLanguage(name: string, mimeType?: string | null): string {
  // Strip MIME parameters (application/json; charset=utf-8) before the
  // lookup, matching the base-type normalization in the blob path.
  const mime = mimeType?.split(";")[0].trim().toLowerCase() ?? "";
  // Object.hasOwn, not `in`: prototype-chain keys like "toString" must not
  // resolve to a language.
  if (mime && Object.hasOwn(RESOURCE_MIME_LANGUAGES, mime)) {
    return RESOURCE_MIME_LANGUAGES[mime];
  }
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (ext && Object.hasOwn(RESOURCE_EXT_LANGUAGES, ext)) {
    return RESOURCE_EXT_LANGUAGES[ext];
  }
  return "";
}

/**
 * Cap on the rendered fence length. Inner backtick runs of this length or
 * longer are squeezed to one tick shorter so the fence still contains the
 * body; without the cap, an adversarial run of backticks would force a
 * fence thousands of characters long, blowing the one-segment bound and
 * risking a mid-fence split downstream.
 */
const MAX_FENCE_TICKS = 8;

/**
 * Render a text resource as a fenced code block with a one-line header
 * naming it. The fence is longer than any backtick run inside the body so
 * the content cannot break out, capped at {@link MAX_FENCE_TICKS} (longer
 * inner runs are squeezed to fit). The whole rendered block is budgeted
 * against {@link MAX_RESOURCE_BLOCK_CHARS}: the body budget subtracts the
 * header, fences, and language hint, and oversized bodies are truncated
 * with an explicit tail line inside the fence, so the block always fits a
 * single WeChat segment and is never split mid-fence downstream.
 */
function renderTextResource(name: string, mimeType: string | null | undefined, text: string): string {
  const lang = resourceFenceLanguage(name, mimeType);
  const mime = mimeType ? sanitizeInlineLabel(mimeType) : "";
  const mimeNote = mime ? ` (${mime})` : "";
  const header = `\n📎 ${name}${mimeNote}\n`;
  // Worst-case fence length keeps the budget single-pass: the fence is
  // computed from the final body below but never exceeds MAX_FENCE_TICKS.
  const fixedOverhead = header.length + MAX_FENCE_TICKS + lang.length + 1 + 1 + MAX_FENCE_TICKS + 1;
  let body = text
    .replace(/(\r\n|\n|\r)$/, "")
    .replace(new RegExp("`{" + MAX_FENCE_TICKS + ",}", "g"), "`".repeat(MAX_FENCE_TICKS - 1));
  const budget = MAX_RESOURCE_BLOCK_CHARS - fixedOverhead;
  if (body.length > budget) {
    // Reserve tail space using the full body length's digit count; the
    // actual dropped count is never longer, so the block stays in budget.
    const tailReserve = `\n... [truncated, ${body.length} more chars]`.length;
    const keep = Math.max(0, budget - tailReserve);
    body = `${body.slice(0, keep)}\n... [truncated, ${body.length - keep} more chars]`;
  }
  const longestRun = body.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, Math.min(longestRun + 1, MAX_FENCE_TICKS)));
  return `${header}${fence}${lang}\n${body}\n${fence}\n`;
}

/** An audio content block produced by the agent, ready for outbound delivery. */
export interface AgentAudio {
  /** Base64-encoded audio bytes. */
  data: string;
  mimeType: string;
}

/**
 * Audio formats forwarded to WeChat, mapped to the file extension used in
 * the generated file name. Audio is delivered as a file message rather
 * than a voice bubble (voice items require SILK-encoded payloads with a
 * computed play time); the extension is what lets the WeChat client open
 * the file card with an audio player.
 */
export const AUDIO_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "webm",
};

/** Sanity cap on decoded audio size (25 MiB). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface WeChatAcpClientOpts {
  sendTyping: () => Promise<void>;
  onThoughtFlush: (text: string) => Promise<void>;
  onMessageFlush: (text: string) => Promise<void>;
  onImageFlush?: (image: AgentImage) => Promise<void>;
  onAudioFlush?: (audio: AgentAudio) => Promise<void>;
  onFileFlush?: (file: AgentFile) => Promise<void>;
  resolveResourceLink?: (link: AgentResourceLink) => Promise<AgentFile | null>;
  onConfigOptionsUpdate?: (configOptions: acp.SessionConfigOption[]) => void;
  log: (msg: string) => void;
  showThoughts: boolean;
  showDiffs?: boolean;
  showImages?: boolean;
  showAudio?: boolean;
  showResources?: boolean;
}

/**
 * All mutable state scoped to a single prompt turn: the delivery callbacks
 * plus the text/thought buffers and per-turn delivery flags. Notifications
 * capture the turn object at arrival time, so a task that runs after the
 * turn ended (queued behind `beginTurn`, or delayed by a stalled chain)
 * reads and writes its own closed turn's state, which the next turn's
 * `flush()` can never observe (issue 54).
 */
interface TurnState {
  opts: WeChatAcpClientOpts;
  chunks: string[];
  thoughtChunks: string[];
  producedMessage: boolean;
  lastTypingAt: number;
  deliveredResourceLinks: Set<string>;
}

function freshTurn(opts: WeChatAcpClientOpts): TurnState {
  return {
    opts,
    chunks: [],
    thoughtChunks: [],
    producedMessage: false,
    lastTypingAt: 0,
    deliveredResourceLinks: new Set(),
  };
}

export class WeChatAcpClient implements acp.Client {
  // Per-turn mutable state (callbacks, buffers, flags). Swapped wholesale by
  // beginTurn; queued tasks operate on the turn object captured at arrival.
  private turn: TurnState;
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
    return this.turn.producedMessage;
  }

  /** Reset the produced-message flag on the current turn. Exposed for tests;
   * production code starts turns via beginTurn, which creates fresh state. */
  newTurn(): void {
    this.turn.producedMessage = false;
  }

  constructor(opts: WeChatAcpClientOpts) {
    this.turn = freshTurn(opts);
  }

  /**
   * Start a new turn: swap in a fresh per-turn state object (buffers, flags)
   * bound to the new turn's delivery callbacks. Runs as a task on the
   * notification queue, so every task from the previous turn that is already
   * queued finishes delivering with its own turn's state before the swap.
   * Tasks that run after the swap (a late notification queued behind this
   * boundary while the chain was stalled) still write into the previous
   * turn's captured state object, which the new turn's flush() can never
   * observe; buffered residue they produce is dropped with the closed turn
   * (issue 54). Residual undelivered buffers present at the boundary are
   * logged and discarded. Await this before sending the next prompt.
   */
  async beginTurn(callbacks: {
    sendTyping: () => Promise<void>;
    onThoughtFlush: (text: string) => Promise<void>;
    onMessageFlush: (text: string) => Promise<void>;
    onImageFlush?: (image: AgentImage) => Promise<void>;
    onAudioFlush?: (audio: AgentAudio) => Promise<void>;
    onFileFlush?: (file: AgentFile) => Promise<void>;
  }): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.turn;
      const opts: WeChatAcpClientOpts = {
        ...previous.opts,
        sendTyping: callbacks.sendTyping,
        onThoughtFlush: callbacks.onThoughtFlush,
        onMessageFlush: callbacks.onMessageFlush,
        ...(callbacks.onImageFlush ? { onImageFlush: callbacks.onImageFlush } : {}),
        ...(callbacks.onAudioFlush ? { onAudioFlush: callbacks.onAudioFlush } : {}),
        ...(callbacks.onFileFlush ? { onFileFlush: callbacks.onFileFlush } : {}),
      };
      const staleText = previous.chunks.join("");
      const staleThoughts = previous.thoughtChunks.join("");
      if (staleText.trim() || staleThoughts.trim()) {
        opts.log(
          `[turn] discarding residue from previous turn (${staleText.length} chars text, ${staleThoughts.length} chars thoughts)`,
        );
      }
      this.turn = freshTurn(opts);
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

    this.turn.opts.log(
      `[permission] auto-allowed: ${params.toolCall?.title ?? "unknown"} → ${optionId}`,
    );

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
    // Bind the notification to the turn state active at arrival time. A task
    // can sit queued across a turn boundary (beginTurn's swap is enqueued
    // behind it), or even end up queued after the boundary task when a
    // stalled chain delays the swap; operating on the captured turn object
    // guarantees it reads and writes the state of the turn it belongs to,
    // never the next turn's buffers or callbacks (issue 54).
    const turn = this.turn;
    return this.enqueue(() => this.handleSessionUpdate(params, turn));
  }

  private async handleSessionUpdate(
    params: acp.SessionNotification,
    turn: TurnState,
  ): Promise<void> {
    const update = params.update;
    const opts = turn.opts;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.maybeFlushThoughts(turn);
        if (update.content.type === "text") {
          turn.chunks.push(update.content.text);
          if (update.content.text.trim()) {
            turn.producedMessage = true;
          }
        } else if (update.content.type === "image") {
          await this.maybeSendImage(update.content, turn);
        } else if (update.content.type === "audio") {
          await this.maybeSendAudio(update.content, turn);
        } else if (update.content.type === "resource") {
          await this.maybeRenderResource(update.content.resource, turn);
        } else if (update.content.type === "resource_link") {
          await this.maybeSendResourceLink(update.content, turn);
        }
        // Throttle typing indicators
        await this.maybeSendTyping(turn);
        break;

      case "tool_call":
        await this.maybeFlushThoughts(turn);
        await this.maybeFlushMessage(turn);
        if (update.status === "completed" && update.content) {
          for (const content of update.content) {
            if (content.type === "content" && content.content.type === "resource_link") {
              await this.maybeSendResourceLink(content.content, turn);
            }
          }
        }
        opts.log(`[tool] ${update.title} (${update.status})`);
        await this.maybeSendTyping(turn);
        break;

      case "agent_thought_chunk":
        await this.maybeFlushMessage(turn);
        if (update.content.type === "text") {
          const text = update.content.text;
          opts.log(`[thought] ${text.length > 80 ? text.substring(0, 80) + "..." : text}`);
          if (opts.showThoughts) {
            turn.thoughtChunks.push(text);
          }
        }
        await this.maybeSendTyping(turn);
        break;

      case "tool_call_update": {
        let imageContentBlocks = 0;
        let resourceContentBlocks = 0;
        let resourceLinkContentBlocks = 0;
        let resourceImages = 0;
        let resourceLinkImages = 0;
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
              turn.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
              turn.producedMessage = true;
            } else if (c.type === "content" && c.content.type === "image") {
              imageContentBlocks++;
              await this.maybeSendImage(c.content, turn);
            } else if (c.type === "content" && c.content.type === "audio") {
              await this.maybeSendAudio(c.content, turn);
            } else if (c.type === "content" && c.content.type === "resource") {
              resourceContentBlocks++;
              if (await this.maybeRenderResource(c.content.resource, turn)) {
                resourceImages++;
              }
            } else if (c.type === "content" && c.content.type === "resource_link") {
              resourceLinkContentBlocks++;
              if (await this.maybeSendResourceLink(c.content, turn)) {
                resourceLinkImages++;
              }
            }
          }
        }
        // Copilot CLI compatibility: the CLI emits tool-result resources only
        // in rawOutput (full resource in rawOutput.contents, a URI-less blob
        // copy in rawOutput.binaryResultsForLlm) and never as ACP resource
        // content blocks (issue 62). Parse rawOutput only when the standard
        // path saw no resource block, so an agent that one day populates both
        // never renders the same resource twice. Runs before the image
        // fallback below: a resource routed into the image pipeline here
        // counts into rawOutputResourceImages and suppresses the image
        // fallback, which would otherwise re-deliver the same payload from a
        // matching binaryResultsForLlm image entry.
        let rawOutputResources = 0;
        let rawOutputResourceImages = 0;
        if (update.status === "completed" && resourceContentBlocks === 0) {
          const viaRawOutput = await this.maybeRenderRawOutputResources(update.rawOutput, turn);
          rawOutputResources = viaRawOutput.resources;
          rawOutputResourceImages = viaRawOutput.images;
        }
        let rawOutputResourceLinks = 0;
        let rawOutputResourceLinkImages = 0;
        if (update.status === "completed" && resourceLinkContentBlocks === 0) {
          const viaRawOutput = await this.maybeSendRawOutputResourceLinks(
            update.rawOutput,
            turn,
          );
          rawOutputResourceLinks = viaRawOutput.links;
          rawOutputResourceLinkImages = viaRawOutput.images;
        }
        // Copilot CLI compatibility: the CLI emits tool-result images only in
        // rawOutput.binaryResultsForLlm and never as ACP image content blocks
        // (formulahendry/wechat-acp issue 55). Fall back to rawOutput only
        // when the standard path (image content blocks or image resources)
        // produced no image, so an agent that one day populates both fields
        // never delivers the same image twice.
        let rawOutputImages = 0;
        if (
          update.status === "completed" &&
          imageContentBlocks === 0 &&
          resourceImages === 0 &&
          rawOutputResourceImages === 0 &&
          resourceLinkImages === 0 &&
          rawOutputResourceLinkImages === 0
        ) {
          rawOutputImages = await this.maybeSendRawOutputImages(update.rawOutput, turn);
        }
        if (update.status) {
          // Surface where images came from so field issues like issue 55
          // (image present but in a non-standard location) show up in logs.
          const imageNote =
            imageContentBlocks + resourceImages + resourceLinkImages > 0
              ? ` [images: ${imageContentBlocks + resourceImages + resourceLinkImages} content block]`
              : rawOutputImages + rawOutputResourceLinkImages > 0
                ? ` [images: ${rawOutputImages + rawOutputResourceLinkImages} rawOutput fallback]`
                : "";
          const resourceNote =
            rawOutputResources > 0 ? ` [resources: ${rawOutputResources} rawOutput fallback]` : "";
          const linkNote =
            rawOutputResourceLinks > 0
              ? ` [resource link entries: ${rawOutputResourceLinks} rawOutput fallback]`
              : "";
          opts.log(
            `[tool] ${update.toolCallId} → ${update.status}${imageNote}${resourceNote}${linkNote}`,
          );
        }
        await this.maybeSendTyping(turn);
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
        await this.maybeSendTyping(turn);
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
    // image-only turn is never mistaken for an empty one. Captures the turn
    // state at call time for the same reason sessionUpdate does.
    const turn = this.turn;
    return this.enqueue(async () => {
      await this.maybeFlushThoughts(turn);
      const text = turn.chunks.join("");
      turn.chunks = [];
      turn.lastTypingAt = 0;
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
  private async maybeSendRawOutputImages(rawOutput: unknown, turn: TurnState): Promise<number> {
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
        await this.maybeSendImage({ data, mimeType }, turn);
      }
    }
    return images;
  }

  /**
   * Compatibility fallback for agents that emit tool-result resources only in
   * `rawOutput` instead of ACP embedded resource content blocks. GitHub
   * Copilot CLI puts the full resource (`uri`, `mimeType`, `text` or `blob`)
   * in `rawOutput.contents[]` and a URI-less blob copy in
   * `rawOutput.binaryResultsForLlm[]` as `{type: "resource", data, mimeType}`,
   * while `update.content` carries only an empty text block (issue 62).
   * `rawOutput.contents[]` is the primary source since it covers text and
   * blob resources and preserves the URI for naming. Entries from
   * `binaryResultsForLlm[]` are parsed only when `contents[]` yields no
   * resource entry, which both de-duplicates the blob copy the CLI writes
   * into both fields and keeps the richer shape authoritative. The spec types
   * `rawOutput` as `unknown`, so every field is validated before use and
   * anything malformed is ignored. Valid entries reuse the standard
   * `maybeRenderResource` pipeline. Returns the number of resource entries
   * handed to the pipeline plus how many of them belong to the image
   * pipeline, so the caller can suppress the rawOutput image fallback for
   * payloads that would otherwise deliver twice.
   */
  private async maybeRenderRawOutputResources(
    rawOutput: unknown,
    turn: TurnState,
  ): Promise<{ resources: number; images: number }> {
    const none = { resources: 0, images: 0 };
    if (typeof rawOutput !== "object" || rawOutput === null) {
      return none;
    }
    const { contents, binaryResultsForLlm } = rawOutput as {
      contents?: unknown;
      binaryResultsForLlm?: unknown;
    };
    let resources = 0;
    let images = 0;
    if (Array.isArray(contents)) {
      for (const entry of contents) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }
        const { type, resource } = entry as { type?: unknown; resource?: unknown };
        if (type !== "resource" || typeof resource !== "object" || resource === null) {
          continue;
        }
        const { uri, mimeType, text, blob } = resource as {
          uri?: unknown;
          mimeType?: unknown;
          text?: unknown;
          blob?: unknown;
        };
        // Rebuild a clean resource object instead of forwarding the raw one,
        // so a text resource is exactly TextResourceContents (the render
        // path discriminates on `"text" in resource`) and junk fields or a
        // non-string mimeType never reach the pipeline. Blank text does not
        // count as a resource entry: maybeRenderResource skips it without
        // rendering, and counting it would suppress the binaryResultsForLlm
        // fallback and drop a blob that exists only there.
        const name = typeof uri === "string" ? uri : "";
        const mime = typeof mimeType === "string" ? { mimeType } : {};
        let clean: acp.EmbeddedResource["resource"];
        if (typeof text === "string" && text.trim()) {
          clean = { uri: name, text, ...mime };
        } else if (typeof blob === "string" && blob) {
          clean = { uri: name, blob, ...mime };
        } else {
          continue;
        }
        resources++;
        if (await this.maybeRenderResource(clean, turn)) {
          images++;
        }
      }
    }
    if (resources > 0 || !Array.isArray(binaryResultsForLlm)) {
      return { resources, images };
    }
    for (const entry of binaryResultsForLlm) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const { type, data, mimeType } = entry as {
        type?: unknown;
        data?: unknown;
        mimeType?: unknown;
      };
      if (type !== "resource" || typeof data !== "string" || !data) {
        continue;
      }
      // No URI in this shape; resourceDisplayName falls back to "resource".
      resources++;
      const clean: acp.EmbeddedResource["resource"] = {
        uri: "",
        blob: data,
        ...(typeof mimeType === "string" ? { mimeType } : {}),
      };
      if (await this.maybeRenderResource(clean, turn)) {
        images++;
      }
    }
    return { resources, images };
  }

  /**
   * Copilot CLI keeps MCP resource links in rawOutput.contents rather than
   * promoting them to ACP content blocks. Parse only the documented fields
   * needed by the normal resource-link delivery path.
   */
  private async maybeSendRawOutputResourceLinks(
    rawOutput: unknown,
    turn: TurnState,
  ): Promise<{ links: number; images: number }> {
    if (typeof rawOutput !== "object" || rawOutput === null) return { links: 0, images: 0 };
    const { contents } = rawOutput as { contents?: unknown };
    if (!Array.isArray(contents)) return { links: 0, images: 0 };

    let links = 0;
    let images = 0;
    for (const entry of contents) {
      if (typeof entry !== "object" || entry === null) continue;
      const { type, uri, name, mimeType, size } = entry as {
        type?: unknown;
        uri?: unknown;
        name?: unknown;
        mimeType?: unknown;
        size?: unknown;
      };
      if (type !== "resource_link" || typeof uri !== "string" || !uri) continue;
      links++;
      if (await this.maybeSendResourceLink(
        {
          uri,
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof mimeType === "string" ? { mimeType } : {}),
          ...(typeof size === "number" ? { size } : {}),
        },
        turn,
      )) {
        images++;
      }
    }
    return { links, images };
  }

  private async maybeSendResourceLink(
    link: AgentResourceLink,
    turn: TurnState,
  ): Promise<boolean> {
    const opts = turn.opts;
    const name = sanitizeInlineLabel(link.name ?? resourceDisplayName(link.uri));
    if (opts.showResources === false) {
      opts.log(`[resource-link] skipped (showResources=false, ${name})`);
      return false;
    }
    if (turn.deliveredResourceLinks.has(link.uri)) {
      opts.log(`[resource-link] skipped duplicate: ${name}`);
      return false;
    }
    turn.deliveredResourceLinks.add(link.uri);

    if (!opts.resolveResourceLink) {
      turn.chunks.push(`\n📎 [resource link: ${name} - file resolver unavailable]\n`);
      turn.producedMessage = true;
      opts.log(`[resource-link] resolver unavailable: ${name}`);
      return false;
    }

    try {
      const file = await opts.resolveResourceLink(link);
      if (!file) {
        turn.chunks.push(`\n📎 [resource link: ${name} - file unavailable]\n`);
        turn.producedMessage = true;
        opts.log(`[resource-link] unavailable: ${name}`);
        return false;
      }
      return await this.maybeSendFile(file, turn);
    } catch (err) {
      turn.chunks.push(`\n⚠️ [file ${name} could not be resolved]\n`);
      turn.producedMessage = true;
      opts.log(`[resource-link] resolve failed for ${name}: ${String(err)}`);
      return false;
    }
  }

  private async maybeSendFile(file: AgentFile, turn: TurnState): Promise<boolean> {
    const opts = turn.opts;
    const name = sanitizeInlineLabel(file.name) || "artifact";
    const mimeType =
      sanitizeInlineLabel(file.mimeType).split(";")[0].trim().toLowerCase() ||
      "application/octet-stream";
    const decodedBytes = decodedBase64ByteLength(file.data);
    if (
      opts.showImages !== false &&
      opts.onImageFlush &&
      SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) &&
      decodedBytes <= MAX_IMAGE_BYTES
    ) {
      opts.log(`[file] routing image file ${name} through image pipeline (${mimeType}, ${decodedBytes} bytes)`);
      await this.maybeSendImage({ data: file.data, mimeType }, turn);
      return true;
    }

    if (!opts.onFileFlush) {
      turn.chunks.push(`\n📎 [file: ${name} (${mimeType}) - delivery unavailable]\n`);
      turn.producedMessage = true;
      opts.log(`[file] skipped (no file sink configured, ${name})`);
      return false;
    }

    if (decodedBytes > MAX_AGENT_FILE_BYTES) {
      turn.chunks.push(`\n⚠️ [file ${name} is too large to deliver]\n`);
      turn.producedMessage = true;
      opts.log(
        `[file] skipped oversized file ${name} (${decodedBytes} bytes > ${MAX_AGENT_FILE_BYTES})`,
      );
      return false;
    }

    await this.maybeFlushMessage(turn);
    try {
      await opts.onFileFlush({ data: file.data, name, mimeType });
      opts.log(`[file] sent ${name} (${mimeType}, ${decodedBytes} bytes)`);
      turn.producedMessage = true;
      return false;
    } catch (err) {
      turn.chunks.push(`\n⚠️ [file ${name} could not be delivered]\n`);
      turn.producedMessage = true;
      opts.log(`[file] delivery failed for ${name}: ${String(err)}`);
      return false;
    }
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
    turn: TurnState,
  ): Promise<void> {
    const opts = turn.opts;
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
      turn.chunks.push("\n⚠️ [image too large to deliver]\n");
      turn.producedMessage = true;
      return;
    }

    // Flush any text buffered before this image so ordering is preserved.
    // Degraded mode: if that flush fails after its retries, the text is
    // re-buffered for the final flush() and the image is still delivered
    // now. Strict ordering is knowingly traded for content preservation
    // here; dropping or deferring a deliverable image because a text
    // segment hit a transient send failure would lose more than it saves.
    await this.maybeFlushMessage(turn);

    try {
      // Single attempt here: the bridge-side sink owns retries (with a stable
      // client_id for gateway de-duplication), so retrying again at this layer
      // would multiply CDN uploads.
      await opts.onImageFlush({ data: image.data, mimeType });
      opts.log(`[image] sent (${mimeType}, ~${approxBytes} bytes)`);
      turn.producedMessage = true;
    } catch (err) {
      opts.log(`[image] delivery failed: ${String(err)}`);
      // Queue serialization means no later text has been buffered yet, so the
      // placeholder lands exactly where the image belonged in the stream.
      turn.chunks.push("\n⚠️ [image could not be delivered]\n");
      turn.producedMessage = true;
    }
  }

  /**
   * Deliver an agent-produced audio content block as a WeChat file message,
   * mirroring the {@link maybeSendImage} pipeline: buffered text preceding
   * the audio is flushed first, the sink gets exactly one attempt (the
   * bridge owns retries with a stable client_id), and an oversized payload
   * or a failed delivery is replaced with a placeholder in the text stream
   * so the turn never silently loses content.
   */
  private async maybeSendAudio(
    audio: { data: string; mimeType: string },
    turn: TurnState,
  ): Promise<void> {
    const opts = turn.opts;
    const mimeType = audio.mimeType.trim();
    if (opts.showAudio === false) {
      opts.log(`[audio] skipped (showAudio=false, ${mimeType})`);
      return;
    }
    if (!opts.onAudioFlush) {
      opts.log(`[audio] skipped (no audio sink configured, ${mimeType})`);
      return;
    }
    // Object.hasOwn, not `in`: a hostile mimeType like "toString" must not
    // pass the gate via the prototype chain.
    if (!Object.hasOwn(AUDIO_MIME_EXTENSIONS, mimeType.toLowerCase())) {
      opts.log(`[audio] skipped unsupported type: ${mimeType}`);
      return;
    }
    // ceil(base64Len / 4) * 3 over-estimates by at most 2 bytes; fine for a cap.
    const approxBytes = Math.ceil(audio.data.length / 4) * 3;
    if (approxBytes > MAX_AUDIO_BYTES) {
      opts.log(`[audio] skipped oversized audio (~${approxBytes} bytes > ${MAX_AUDIO_BYTES})`);
      turn.chunks.push("\n⚠️ [audio too large to deliver]\n");
      turn.producedMessage = true;
      return;
    }

    // Flush any text buffered before this audio so ordering is preserved.
    // Same degraded mode as images: content preservation over strict order.
    await this.maybeFlushMessage(turn);

    try {
      await opts.onAudioFlush({ data: audio.data, mimeType });
      opts.log(`[audio] sent (${mimeType}, ~${approxBytes} bytes)`);
      turn.producedMessage = true;
    } catch (err) {
      opts.log(`[audio] delivery failed: ${String(err)}`);
      turn.chunks.push("\n⚠️ [audio could not be delivered]\n");
      turn.producedMessage = true;
    }
  }

  /**
   * Render an agent-produced embedded resource content block (issue 59).
   * Text resources are appended to the text stream as a fenced code block
   * with a naming header, so they flush in order with the surrounding
   * narrative through the existing buffer machinery. Blob resources with
   * an image MIME type reuse the image delivery pipeline (allow-list,
   * size cap, ordering, placeholders); other blobs are delivered through the
   * generic file pipeline. Returns true when the
   * resource belongs to the image pipeline (an allow-listed image blob with
   * images enabled and a sink configured), whether or not it was rendered:
   * a resource skipped by showResources=false still returns true so the
   * caller counts it against the rawOutput image compatibility fallback,
   * otherwise the fallback would re-deliver the hidden resource from a
   * mirrored binaryResultsForLlm image entry and bypass the setting.
   */
  private async maybeRenderResource(
    resource: acp.EmbeddedResource["resource"],
    turn: TurnState,
  ): Promise<boolean> {
    const opts = turn.opts;
    const name = resourceDisplayName(resource.uri);
    // Classify before any early return so the image-pipeline verdict is
    // consistent whether or not the resource is actually rendered. Routing
    // requires an exact allow-listed base type (parameters stripped),
    // images enabled, and a sink configured; every miss path in
    // maybeSendImage other than the oversized/failure placeholders is
    // log-and-skip, which is fine for image content blocks but would
    // silently drop a resource (and a resource-only turn would then
    // trigger the empty-turn notice), so anything not deliverable falls
    // through to the visible placeholder instead.
    const mime = sanitizeInlineLabel(resource.mimeType ?? "");
    const baseMime = mime.split(";")[0].trim().toLowerCase();
    const routesToImagePipeline =
      !("text" in resource) &&
      SUPPORTED_IMAGE_MIME_TYPES.has(baseMime) &&
      opts.showImages !== false &&
      Boolean(opts.onImageFlush);
    if (opts.showResources === false) {
      opts.log(`[resource] skipped (showResources=false, ${name})`);
      return routesToImagePipeline;
    }

    if ("text" in resource) {
      if (!resource.text.trim()) {
        opts.log(`[resource] skipped empty text resource: ${name}`);
        return false;
      }
      const rendered = renderTextResource(name, resource.mimeType, resource.text);
      // The block itself fits one segment by construction, but narrative
      // already buffered ahead of it could push the combined text past the
      // segment limit and make splitText() cut inside the fence. Flush the
      // buffer first so the block starts a fresh segment. If the flush
      // fails it re-buffers (content preservation over the no-split
      // guarantee in that degraded path), matching image/audio behavior.
      const buffered = turn.chunks.reduce((sum, c) => sum + c.length, 0);
      if (buffered > 0 && buffered + rendered.length > TEXT_CHUNK_LIMIT) {
        await this.maybeFlushMessage(turn);
      }
      turn.chunks.push(rendered);
      turn.producedMessage = true;
      opts.log(`[resource] rendered text resource ${name} (${resource.text.length} chars)`);
      return false;
    }

    // Sanitized once above: the label feeds the placeholder, the logs, and
    // the value forwarded to the image pipeline.
    if (routesToImagePipeline) {
      // Route through the image pipeline so an image handed back as an
      // embedded resource behaves exactly like an image content block.
      await this.maybeSendImage({ data: resource.blob, mimeType: baseMime }, turn);
      return true;
    }

    if (!opts.onFileFlush) {
      const approxBytes = Math.ceil(resource.blob.length / 4) * 3;
      turn.chunks.push(
        `\n📎 [resource: ${name} (${mime || "unknown type"}, ~${approxBytes} bytes) - binary content not rendered]\n`,
      );
      turn.producedMessage = true;
      opts.log(
        `[resource] blob resource ${name} not rendered (${mime || "unknown type"}, ~${approxBytes} bytes)`,
      );
      return false;
    }

    await this.maybeSendFile(
      {
        data: resource.blob,
        name,
        mimeType: baseMime || "application/octet-stream",
      },
      turn,
    );
    return false;
  }

  private async maybeFlushThoughts(turn: TurnState): Promise<void> {
    if (turn.thoughtChunks.length === 0) return;
    const thoughtText = turn.thoughtChunks.join("");
    turn.thoughtChunks = [];
    if (!thoughtText.trim()) return;
    const ok = await this.sendWithRetry(
      () => turn.opts.onThoughtFlush(`💭 [Thinking]\n${thoughtText}`),
      "thought",
      turn,
    );
    if (!ok) {
      turn.opts.log(`[flush] dropping ${thoughtText.length} chars of thought after retries`);
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
  private async maybeFlushMessage(turn: TurnState): Promise<void> {
    if (turn.chunks.length === 0) return;
    const text = turn.chunks.join("");
    turn.chunks = [];
    if (!text.trim()) {
      return;
    }

    const ok = await this.sendWithRetry(() => turn.opts.onMessageFlush(text), "message", turn);
    if (!ok) {
      // Send failed after all retries. Prepend the unsent text back so the
      // final flush() returns it and session.ts re-attempts via onReply (which
      // surfaces failure to the user).
      turn.chunks = [text, ...turn.chunks];
      turn.opts.log(
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
    turn: TurnState,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= WeChatAcpClient.SEND_MAX_ATTEMPTS; attempt++) {
      try {
        await send();
        return true;
      } catch (err) {
        turn.opts.log(
          `[flush] ${label} send failed (attempt ${attempt}/${WeChatAcpClient.SEND_MAX_ATTEMPTS}): ${String(err)}`,
        );
        if (attempt < WeChatAcpClient.SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, WeChatAcpClient.SEND_RETRY_BASE_MS * attempt));
        }
      }
    }
    return false;
  }

  private async maybeSendTyping(turn: TurnState): Promise<void> {
    const now = Date.now();
    if (now - turn.lastTypingAt < WeChatAcpClient.TYPING_INTERVAL_MS) return;
    turn.lastTypingAt = now;
    try {
      await turn.opts.sendTyping();
    } catch {
      // typing is best-effort
    }
  }
}
