/**
 * AES-128-ECB encrypt/decrypt for WeChat CDN media.
 * Adapted from @tencent-weixin/openclaw-weixin cdn/aes-ecb.ts
 */

import crypto from "node:crypto";
import type { CDNMedia } from "./types.js";

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Compute AES-128-ECB ciphertext size (PKCS7 padding to a 16-byte boundary). */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
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

/** Default bound on a single CDN request (upload or download). Generous for
 * multi-MiB image bodies, but finite so a hung request rejects and the
 * caller's retry logic regains control (image sends run on the serialized
 * per-client task queue; an unsettled request there would stall every later
 * notification and the final flush). */
const CDN_TIMEOUT_MS = 60_000;

/** Run a CDN request under a bounded timeout, mirroring apiPost. The signal
 * stays armed across body consumption, and a timeout rejects with a
 * descriptive error instead of hanging or being swallowed. */
async function withCdnTimeout<T>(
  timeoutMs: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKey: Buffer,
  cdnBaseUrl: string,
  timeoutMs = CDN_TIMEOUT_MS,
): Promise<Buffer> {
  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  const ciphertext = await withCdnTimeout(timeoutMs, "CDN download", async (signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`CDN download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
  return decryptAesEcb(ciphertext, aesKey);
}

export async function uploadToCdn(params: {
  buffer: Buffer;
  uploadParam?: string;
  /** Full upload URL from getUploadUrl; takes precedence over uploadParam when set. */
  uploadFullUrl?: string;
  aesKey: Buffer;
  filekey: string;
  cdnBaseUrl: string;
  timeoutMs?: number;
}): Promise<string> {
  const encrypted = encryptAesEcb(params.buffer, params.aesKey);
  const fullUrl = params.uploadFullUrl?.trim();
  let url: string;
  if (fullUrl) {
    url = fullUrl;
  } else if (params.uploadParam) {
    url = `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
  } else {
    throw new Error("CDN upload: need uploadFullUrl or uploadParam");
  }

  const res = await withCdnTimeout(params.timeoutMs ?? CDN_TIMEOUT_MS, "CDN upload", (signal) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: encrypted,
      signal,
    }),
  );

  if (!res.ok) throw new Error(`CDN upload failed: HTTP ${res.status}`);
  const downloadParam = res.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("CDN upload: missing x-encrypted-param header");
  return downloadParam;
}
