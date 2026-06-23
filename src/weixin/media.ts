/**
 * AES-128-ECB encrypt/decrypt for WeChat CDN media.
 * Adapted from @tencent-weixin/openclaw-weixin cdn/aes-ecb.ts
 */

import crypto from "node:crypto";
import type { CDNMedia } from "./types.js";

export function aesEcbPaddedSize(plaintextLen: number): number {
  const blockSize = 16;
  const padLen = blockSize - (plaintextLen % blockSize);
  return plaintextLen + padLen;
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse the AES key from CDN media reference.
 * The key can be either:
 *   - base64 → 16 raw bytes (use directly)
 *   - base64 → 32 hex chars → parse hex → 16 bytes
 */
export function parseAesKey(media: CDNMedia): Buffer | null {
  const raw = media.aes_key;
  if (!raw) return null;

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const hexStr = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
      return Buffer.from(hexStr, "hex");
    }
  }
  return decoded.subarray(0, 16);
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKey: Buffer,
  cdnBaseUrl: string,
): Promise<Buffer> {
  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download failed: HTTP ${res.status}`);
  const ciphertext = Buffer.from(await res.arrayBuffer());
  return decryptAesEcb(ciphertext, aesKey);
}

export async function uploadToCdn(params: {
  buffer: Buffer;
  uploadParam: string;
  aesKey: Buffer;
  filekey: string;
  cdnBaseUrl: string;
}): Promise<string> {
  const encrypted = encryptAesEcb(params.buffer, params.aesKey);
  const url = `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: encrypted,
  });

  if (!res.ok) throw new Error(`CDN upload failed: HTTP ${res.status}`);
  const downloadParam = res.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("CDN upload: missing x-encrypted-param header");
  return downloadParam;
}
