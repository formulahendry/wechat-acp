/**
 * Send messages via WeChat iLink API.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { sendMessage, getUploadUrl } from "./api.js";
import { MessageType, MessageState, MessageItemType, UploadMediaType } from "./types.js";
import type { MessageItem } from "./types.js";
import type { UploadedFileInfo } from "./upload.js";
import { encryptAesEcb, aesEcbPaddedSize } from "./media.js";

export interface WeixinSendOpts {
  baseUrl: string;
  token?: string;
  contextToken?: string;
}

export async function sendTextMessage(
  to: string,
  text: string,
  opts: WeixinSendOpts,
  clientId?: string,
  sendFn: typeof sendMessage = sendMessage,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  // Generate a stable idempotency key for this logical send. Callers that
  // retry should pass the same clientId so the iLink gateway de-duplicates
  // repeated deliveries of the same message segment.
  const id = clientId ?? `wechat-acp-${crypto.randomUUID()}`;
  await sendFn({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: id,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: opts.contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
  });
  return id;
}

/**
 * Split text into segments of max length, respecting line breaks where possible.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      segments.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = maxLen;

    segments.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n/, "");
  }

  return segments;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex).toString("base64");
}

function buildSendReq(params: {
  to: string;
  contextToken?: string;
  clientId: string;
  itemList: MessageItem[];
}): { msg: Record<string, unknown> } {
  return {
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: params.clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: params.contextToken,
      item_list: params.itemList,
    },
  };
}

async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinSendOpts;
  sendFn?: typeof sendMessage;
}): Promise<string> {
  if (!params.opts.contextToken) {
    throw new Error("contextToken is required to send a media message");
  }

  const clientId = `wechat-acp-${crypto.randomUUID()}`;
  const itemList: MessageItem[] = [];

  if (params.text) {
    itemList.push({ type: MessageItemType.TEXT, text_item: { text: params.text } });
  }
  itemList.push(params.mediaItem);

  const send = params.sendFn ?? sendMessage;
  await send({
    baseUrl: params.opts.baseUrl,
    token: params.opts.token,
    body: buildSendReq({
      to: params.to,
      contextToken: params.opts.contextToken,
      clientId,
      itemList,
    }) as unknown as { msg?: import("./types.js").WeixinMessage },
  });

  return clientId;
}

export async function sendImageMessage(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinSendOpts;
  sendFn?: typeof sendMessage;
}): Promise<string> {
  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
        aes_key: hexToBase64(params.uploaded.aeskey),
        encrypt_type: 1,
      },
      mid_size: params.uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to: params.to, text: params.text, mediaItem: imageItem, opts: params.opts, sendFn: params.sendFn });
}

export async function sendVideoMessage(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinSendOpts;
  sendFn?: typeof sendMessage;
}): Promise<string> {
  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
        aes_key: hexToBase64(params.uploaded.aeskey),
        encrypt_type: 1,
      },
      video_size: params.uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to: params.to, text: params.text, mediaItem: videoItem, opts: params.opts, sendFn: params.sendFn });
}

export async function sendFileMessage(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinSendOpts;
  sendFn?: typeof sendMessage;
}): Promise<string> {
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
        aes_key: hexToBase64(params.uploaded.aeskey),
        encrypt_type: 1,
      },
      file_name: params.fileName,
      len: String(params.uploaded.fileSize),
    },
  };

  return sendMediaItems({ to: params.to, text: params.text, mediaItem: fileItem, opts: params.opts, sendFn: params.sendFn });
}

const SEND_BUFFER_UPLOAD_MAX_RETRIES = 3;

async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
}): Promise<string> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);

  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  } else {
    throw new Error("CDN upload URL missing");
  }

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= SEND_BUFFER_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${errMsg}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt >= SEND_BUFFER_UPLOAD_MAX_RETRIES) throw lastError;
    }
  }

  if (!downloadParam) throw new Error(`CDN upload failed after ${SEND_BUFFER_UPLOAD_MAX_RETRIES} attempts`);
  return downloadParam;
}

/**
 * Upload a Buffer to CDN and send it as a file attachment via WeChat iLink.
 * Built-in CDN pipeline: rawsize→MD5→getUploadUrl→encrypt→POST CDN→sendMessage.
 * Designed for @sendfile text-flagged sends where the bridge reads a local
 * file and needs to deliver it directly.
 */
export async function sendFileBuffer(
  to: string,
  buffer: Buffer,
  fileName: string,
  opts: WeixinSendOpts & { cdnBaseUrl: string },
  sendFn: typeof sendMessage = sendMessage,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a file");
  }

  const rawsize = buffer.length;
  const rawfilemd5 = crypto.createHash("md5").update(buffer).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString("hex");

  const uploadUrlResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      filekey,
      media_type: UploadMediaType.FILE,
      to_user_id: to,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
    },
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`getUploadUrl returned no upload URL`);
  }

  const downloadEncryptedQueryParam = await uploadBufferToCdn({
    buf: buffer,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    cdnBaseUrl: opts.cdnBaseUrl,
    aeskey,
  });

  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: downloadEncryptedQueryParam,
        aes_key: hexToBase64(aeskeyHex),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(rawsize),
    },
  };

  const clientId = `wechat-acp-${crypto.randomUUID()}`;
  await sendFn({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: buildSendReq({
      to,
      contextToken: opts.contextToken,
      clientId,
      itemList: [fileItem],
    }) as unknown as { msg?: import("./types.js").WeixinMessage },
  });

  return clientId;
}
