/**
 * CDN upload pipeline for WeChat media.
 * Adapted from @tencent-weixin/openclaw-weixin cdn/upload.ts + cdn/cdn-upload.ts
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getUploadUrl } from "./api.js";
import { encryptAesEcb, aesEcbPaddedSize } from "./media.js";
import { UploadMediaType } from "./types.js";

const UPLOAD_MAX_RETRIES = 3;

export interface UploadedFileInfo {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

interface UploadToCdnParams {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  log: (msg: string) => void;
}

async function uploadToCdn(params: UploadToCdnParams): Promise<string> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey, log } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);

  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  } else {
    throw new Error("CDN upload URL missing (need upload_full_url or upload_param)");
  }

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
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
      if (attempt < UPLOAD_MAX_RETRIES) {
        log(`CDN upload attempt ${attempt} failed, retrying: ${String(err)}`);
      } else {
        log(`CDN upload all ${UPLOAD_MAX_RETRIES} attempts failed: ${String(err)}`);
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return downloadParam;
}

async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token: string;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  log: (msg: string) => void;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, baseUrl, token, cdnBaseUrl, mediaType, log } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    baseUrl,
    token,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    },
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`getUploadUrl returned no upload URL`);
  }

  const downloadEncryptedQueryParam = await uploadToCdn({
    buf: plaintext,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    cdnBaseUrl,
    aeskey,
    log,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export async function uploadImage(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token: string;
  cdnBaseUrl: string;
  log: (msg: string) => void;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({ ...params, mediaType: UploadMediaType.IMAGE });
}

export async function uploadVideo(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token: string;
  cdnBaseUrl: string;
  log: (msg: string) => void;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({ ...params, mediaType: UploadMediaType.VIDEO });
}

export async function uploadFile(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token: string;
  cdnBaseUrl: string;
  log: (msg: string) => void;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({ ...params, mediaType: UploadMediaType.FILE });
}