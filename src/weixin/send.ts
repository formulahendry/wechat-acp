/**
 * Send messages via WeChat iLink API.
 */

import crypto from "node:crypto";
import { getUploadUrl, sendMessage } from "./api.js";
import { uploadToCdn } from "./media.js";
import {
  MessageItemType,
  MessageState,
  MessageType,
  UploadMediaType,
  type MessageItem,
} from "./types.js";

export interface WeixinSendOpts {
  baseUrl: string;
  token?: string;
  contextToken?: string;
}

export interface WeixinMediaSendOpts extends WeixinSendOpts {
  cdnBaseUrl: string;
}

export interface UploadedWeixinMedia {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aesKeyHex: string;
  md5: string;
  rawSize: number;
  ciphertextSize: number;
}

function aesEcbPaddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16;
}

function createCdnMedia(uploaded: UploadedWeixinMedia) {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aesKeyHex).toString("base64"),
    encrypt_type: 1,
  };
}

async function uploadMediaBuffer(params: {
  to: string;
  buffer: Buffer;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  opts: WeixinMediaSendOpts;
}): Promise<UploadedWeixinMedia> {
  const aesKey = crypto.randomBytes(16);
  const filekey = crypto.randomBytes(16).toString("hex");
  const md5 = crypto.createHash("md5").update(params.buffer).digest("hex");
  const rawSize = params.buffer.length;
  const ciphertextSize = aesEcbPaddedSize(rawSize);

  const uploadUrl = await getUploadUrl({
    baseUrl: params.opts.baseUrl,
    token: params.opts.token,
    body: {
      filekey,
      media_type: params.mediaType,
      to_user_id: params.to,
      rawsize: rawSize,
      rawfilemd5: md5,
      filesize: ciphertextSize,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
    },
  });

  const downloadEncryptedQueryParam = await uploadToCdn({
    buffer: params.buffer,
    uploadParam: uploadUrl.upload_param,
    uploadFullUrl: uploadUrl.upload_full_url,
    aesKey,
    filekey,
    cdnBaseUrl: params.opts.cdnBaseUrl,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aesKeyHex: aesKey.toString("hex"),
    md5,
    rawSize,
    ciphertextSize,
  };
}

async function sendMediaMessage(
  to: string,
  item: MessageItem,
  opts: WeixinSendOpts,
  clientId?: string,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  const id = clientId ?? `wechat-acp-${crypto.randomUUID()}`;
  await sendMessage({
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
        item_list: [item],
      },
    },
  });
  return id;
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

export async function sendImageMessage(
  to: string,
  image: Buffer,
  opts: WeixinMediaSendOpts,
  clientId?: string,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  const uploaded = await uploadMediaBuffer({
    to,
    buffer: image,
    mediaType: UploadMediaType.IMAGE,
    opts,
  });

  return sendMediaMessage(
    to,
    {
      type: MessageItemType.IMAGE,
      image_item: {
        media: createCdnMedia(uploaded),
        mid_size: uploaded.ciphertextSize,
      },
    },
    opts,
    clientId,
  );
}

export async function sendFileMessage(
  to: string,
  fileName: string,
  file: Buffer,
  opts: WeixinMediaSendOpts,
  clientId?: string,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  const uploaded = await uploadMediaBuffer({
    to,
    buffer: file,
    mediaType: UploadMediaType.FILE,
    opts,
  });

  return sendMediaMessage(
    to,
    {
      type: MessageItemType.FILE,
      file_item: {
        media: createCdnMedia(uploaded),
        file_name: fileName,
        md5: uploaded.md5,
        len: String(uploaded.rawSize),
      },
    },
    opts,
    clientId,
  );
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
