/**
 * Send messages via WeChat iLink API.
 */

import crypto from "node:crypto";
import { sendMessage, getUploadUrl } from "./api.js";
import { aesEcbPaddedSize, uploadToCdn } from "./media.js";
import { MessageType, MessageState, MessageItemType, UploadMediaType } from "./types.js";

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
 * Image upload/send dependencies, injectable for tests.
 */
export interface ImageSendDeps {
  getUploadUrlFn?: typeof getUploadUrl;
  uploadFn?: typeof uploadToCdn;
  sendFn?: typeof sendMessage;
}

export interface WeixinImageSendOpts extends WeixinSendOpts {
  cdnBaseUrl: string;
}

/**
 * Upload an image to the WeChat CDN and send it as a native image message.
 *
 * Protocol (mirrors @tencent-weixin/openclaw-weixin):
 *   - random 16-byte AES key + 32-hex-char filekey
 *   - getuploadurl with media_type=IMAGE, plaintext md5/size, padded ciphertext size
 *   - AES-128-ECB encrypt + CDN POST; download param comes back via x-encrypted-param
 *   - sendmessage with image_item.media { encrypt_query_param, aes_key, encrypt_type: 1 }
 *     where aes_key is the base64 of the hex-encoded key string (the same convention
 *     parseAesKey() decodes on the inbound path) and mid_size is the ciphertext size.
 *
 * Returns the client_id used, so callers can retry with the same id for
 * gateway de-duplication.
 */
export async function sendImageMessage(
  to: string,
  image: Buffer,
  opts: WeixinImageSendOpts,
  clientId?: string,
  deps?: ImageSendDeps,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  const getUploadUrlFn = deps?.getUploadUrlFn ?? getUploadUrl;
  const uploadFn = deps?.uploadFn ?? uploadToCdn;
  const sendFn = deps?.sendFn ?? sendMessage;

  const rawsize = image.length;
  const rawfilemd5 = crypto.createHash("md5").update(image).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrlFn({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      filekey,
      media_type: UploadMediaType.IMAGE,
      to_user_id: to,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
    },
  });

  if (!uploadUrlResp.upload_full_url?.trim() && !uploadUrlResp.upload_param) {
    throw new Error("getUploadUrl returned no upload URL (need upload_full_url or upload_param)");
  }

  const downloadParam = await uploadFn({
    buffer: image,
    uploadParam: uploadUrlResp.upload_param,
    uploadFullUrl: uploadUrlResp.upload_full_url,
    aesKey,
    filekey,
    cdnBaseUrl: opts.cdnBaseUrl,
  });

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
        item_list: [
          {
            type: MessageItemType.IMAGE,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
                encrypt_type: 1,
              },
              mid_size: filesize,
            },
          },
        ],
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
