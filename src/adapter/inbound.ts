/**
 * Inbound adapter: convert WeChat messages to ACP ContentBlock[].
 */

import fs from "node:fs";
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

    return { type: "text", text: buildBinaryFileText(fileName, buffer, inboxDir, log) };
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
function buildBinaryFileText(
  fileName: string,
  buffer: Buffer,
  inboxDir: string | null,
  log: (msg: string) => void,
): string {
  if (!inboxDir) {
    return `[Received file: ${fileName}, ${buffer.length} bytes]`;
  }
  try {
    const savedPath = saveToInbox(buffer, fileName, inboxDir);
    return `[Received file: ${fileName} (${buffer.length} bytes) \u2014 saved to: ${savedPath}]`;
  } catch (err) {
    log(`Failed to save received file "${fileName}" to inbox: ${String(err)}`);
    return `[Received file: ${fileName}, ${buffer.length} bytes]`;
  }
}

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
 */
export function saveToInbox(
  buffer: Buffer,
  fileName: string,
  inboxDir: string,
): string {
  fs.mkdirSync(inboxDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeBase = sanitizeFilename(fileName);
  const target = path.resolve(inboxDir, `${stamp}-${safeBase}`);
  fs.writeFileSync(target, buffer);
  return target;
}

function sanitizeFilename(name: string): string {
  // Drop any path separators a remote sender might have included.
  const tail = name.split(/[\\/]/).pop() ?? "";
  // Replace control chars and reserved chars; leave Unicode alone.
  const cleaned = tail.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned : "file";
}
