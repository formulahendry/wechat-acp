/**
 * Inbound adapter: convert WeChat messages to ACP ContentBlock[].
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { WeixinMessage, MessageItem } from "../weixin/types.js";
import { MessageItemType } from "../weixin/types.js";
import { parseAesKey, downloadAndDecrypt } from "../weixin/media.js";

/**
 * Extract text body from a WeChat message's item_list.
 */
function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Build quoted context
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item?.text_item?.text) parts.push(ref.message_item.text_item.text);
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // Voice transcription
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/**
 * Find the first media item in a message.
 */
function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  if (!itemList) return undefined;
  return (
    itemList.find((i) => i.type === MessageItemType.IMAGE && i.image_item?.media?.encrypt_query_param) ??
    itemList.find((i) => i.type === MessageItemType.VIDEO && i.video_item?.media?.encrypt_query_param) ??
    itemList.find((i) => i.type === MessageItemType.FILE && i.file_item?.media?.encrypt_query_param) ??
    itemList.find(
      (i) => i.type === MessageItemType.VOICE && i.voice_item?.media?.encrypt_query_param && !i.voice_item.text,
    )
  );
}

/**
 * Convert a WeChat message to ACP ContentBlock[] for use in session/prompt.
 */
export async function weixinMessageToPrompt(
  msg: WeixinMessage,
  cdnBaseUrl: string,
  log: (msg: string) => void,
  inboxDir?: string | null,
): Promise<acp.ContentBlock[]> {
  const blocks: acp.ContentBlock[] = [];

  // Extract text
  const text = extractText(msg.item_list);
  if (text) {
    blocks.push({ type: "text", text });
  }

  // Try to download and attach media
  const mediaItem = findMediaItem(msg.item_list);
  if (mediaItem) {
    try {
      const attached = await convertMediaItem(mediaItem, cdnBaseUrl, log, inboxDir ?? null);
      if (attached) blocks.push(attached);
    } catch (err) {
      log(`Media download failed, skipping: ${String(err)}`);
      // Add a text note about the media
      const mediaType = mediaItem.type === MessageItemType.IMAGE ? "image"
        : mediaItem.type === MessageItemType.VIDEO ? "video"
        : mediaItem.type === MessageItemType.FILE ? `file (${mediaItem.file_item?.file_name ?? "unknown"})`
        : mediaItem.type === MessageItemType.VOICE ? "voice"
        : "media";
      blocks.push({ type: "text", text: `[Received ${mediaType} - download failed]` });
    }
  }

  // Fallback: always have at least one content block
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "[empty message]" });
  }

  return blocks;
}

async function convertMediaItem(
  item: MessageItem,
  cdnBaseUrl: string,
  log: (msg: string) => void,
  inboxDir: string | null,
): Promise<acp.ContentBlock | null> {
  if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
    const media = item.image_item.media;
    const aesKey = parseAesKey(media);
    if (!aesKey || !media.encrypt_query_param) return null;

    log("Downloading image from CDN...");
    const buffer = await downloadAndDecrypt(media.encrypt_query_param, aesKey, cdnBaseUrl);
    const base64 = buffer.toString("base64");

    return {
      type: "image",
      data: base64,
      mimeType: "image/jpeg",
    } as acp.ContentBlock;
  }

  if (item.type === MessageItemType.FILE && item.file_item?.media) {
    const media = item.file_item.media;
    const aesKey = parseAesKey(media);
    if (!aesKey || !media.encrypt_query_param) return null;

    log(`Downloading file "${item.file_item.file_name}" from CDN...`);
    const buffer = await downloadAndDecrypt(media.encrypt_query_param, aesKey, cdnBaseUrl);

    // For text-like files, send as resource; for binary, describe it
    const fileName = item.file_item.file_name ?? "file";
    if (isTextFile(fileName)) {
      const content = buffer.toString("utf-8");
      return {
        type: "resource",
        resource: {
          uri: `file:///${fileName}`,
          mimeType: guessMimeType(fileName),
          text: content,
        },
      } as acp.ContentBlock;
    }

    return { type: "text", text: await buildBinaryFileText(fileName, buffer, inboxDir, log) };
  }

  if (item.type === MessageItemType.VOICE && item.voice_item?.media) {
    // If there's a transcription, it was already handled in extractText
    // Otherwise, note we received voice
    return { type: "text", text: "[Received voice message - no transcription available]" };
  }

  if (item.type === MessageItemType.VIDEO) {
    return { type: "text", text: "[Received video message]" };
  }

  return null;
}

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return [
    "txt", "md", "json", "js", "ts", "py", "java", "c", "cpp", "h",
    "css", "html", "xml", "yaml", "yml", "toml", "ini", "cfg", "sh",
    "bash", "rs", "go", "rb", "php", "sql", "csv", "log", "env",
  ].includes(ext);
}

function guessMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", json: "application/json",
    js: "text/javascript", ts: "text/typescript", py: "text/x-python",
    html: "text/html", css: "text/css", xml: "text/xml",
    yaml: "text/yaml", yml: "text/yaml", csv: "text/csv",
  };
  return map[ext] ?? "text/plain";
}

/**
 * Build the text block describing a received binary file.
 *
 * When `inboxDir` is set, the buffer is persisted to disk so the agent
 * can read it by path. On any save failure we silently fall back to the
 * legacy size-only notice (with a log line for diagnostics) — the agent
 * still gets *something* and the message poll loop is not blocked.
 */
async function buildBinaryFileText(
  fileName: string,
  buffer: Buffer,
  inboxDir: string | null,
  log: (msg: string) => void,
): Promise<string> {
  if (!inboxDir) {
    return `[Received file: ${fileName}, ${buffer.length} bytes]`;
  }
  try {
    const savedPath = await saveToInbox(buffer, fileName, inboxDir);
    return `[Received file: ${fileName} (${buffer.length} bytes) \u2014 saved to: ${savedPath}]`;
  } catch (err) {
    log(`Failed to save received file "${fileName}" to inbox: ${String(err)}`);
    return `[Received file: ${fileName}, ${buffer.length} bytes]`;
  }
}

// Permissions: 0o600 on the file and 0o700 on the inbox dir so that on
// multi-user POSIX systems received files (which often contain personal
// info: IDs, contracts, photos…) aren't readable by other local users.
// Ignored by Windows but harmless there.
const INBOX_DIR_MODE = 0o700;
const INBOX_FILE_MODE = 0o600;
// Safety cap on the EEXIST retry loop. Each retry uses a new millisecond
// timestamp, so colliding past this count is essentially impossible — the
// cap is just a belt-and-braces guard against an unforeseen infinite loop.
const INBOX_MAX_COLLISION_RETRIES = 100;

/**
 * Write `buffer` into `inboxDir` and return the absolute path.
 *
 * Filename convention: `${ISO-timestamp}-${safeName}`, where
 *   - the timestamp uses ISO 8601 with colons replaced by dashes so the
 *     name is valid on Windows/macOS/Linux,
 *   - `safeName` replaces filesystem-unsafe characters (`/`, `\`, ASCII
 *     control chars, leading dots) with `_`, while preserving Unicode
 *     (so Chinese filenames stay readable),
 *   - if the sanitized name is empty, it falls back to `"file"`.
 *
 * Writes use the `wx` flag (fail-if-exists) so a same-millisecond
 * collision — e.g. two bridge instances writing into a shared inbox, or
 * a user re-sending the same file twice in quick succession — never
 * silently overwrites an existing file. On `EEXIST` we re-stamp and
 * retry with a fresh timestamp.
 */
export async function saveToInbox(
  buffer: Buffer,
  fileName: string,
  inboxDir: string,
): Promise<string> {
  await fsp.mkdir(inboxDir, { recursive: true, mode: INBOX_DIR_MODE });
  const safeBase = sanitizeFilename(fileName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (let attempt = 0; attempt < INBOX_MAX_COLLISION_RETRIES; attempt++) {
    // attempt 0 → "stamp-name"; subsequent retries → "stamp-N-name".
    // Putting the counter ahead of the user-supplied name keeps the file
    // extension at the tail (so OS open-by-extension still works) and
    // guarantees a fresh path even when the wall clock hasn't ticked
    // between retries (super-fast disk, stubbed time, etc.).
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const target = path.resolve(inboxDir, `${stamp}${suffix}-${safeBase}`);
    try {
      await fsp.writeFile(target, buffer, { flag: "wx", mode: INBOX_FILE_MODE });
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Yield to the event loop between retries so we don't starve the
      // bridge's poll loop on a pathological hot loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new Error(
    `saveToInbox: exhausted ${INBOX_MAX_COLLISION_RETRIES} collision retries for ${safeBase}`,
  );
}

function sanitizeFilename(name: string): string {
  // Drop any path separators a remote sender might have included.
  const tail = name.split(/[\\/]/).pop() ?? "";
  // Replace control chars and reserved chars; leave Unicode alone.
  const cleaned = tail.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned : "file";
}
