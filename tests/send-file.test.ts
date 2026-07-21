/**
 * Tests for sendFileMessage protocol shape.
 *
 * Verifies the outbound file pipeline (used for ACP audio content) against
 * the iLink conventions mirrored from @tencent-weixin/openclaw-weixin:
 * getuploadurl request fields with media_type=FILE, file_item structure
 * (file_name, plaintext len as a decimal string, and the aes_key encoding
 * that the inbound parseAesKey() expects), and client_id idempotency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  sendFileMessage,
  uploadFileMedia,
  sendFileItem,
  type MediaSendDeps,
} from "../src/weixin/send.js";
import { parseAesKey, aesEcbPaddedSize, uploadToCdn } from "../src/weixin/media.js";
import { MessageItemType, UploadMediaType } from "../src/weixin/types.js";
import type { getUploadUrl as GetUploadUrlFn, sendMessage as SendMessageFn } from "../src/weixin/api.js";

type GetUploadUrlArgs = Parameters<typeof GetUploadUrlFn>[0];
type UploadArgs = Parameters<typeof uploadToCdn>[0];
type SendMessageArgs = Parameters<typeof SendMessageFn>[0];

const FILE = Buffer.from("not-really-an-mp3-but-fine-for-tests");
const FILE_NAME = "audio-2026-01-01T00-00-00-000Z.mp3";
const OPTS = {
  baseUrl: "http://fake",
  contextToken: "ctx",
  cdnBaseUrl: "http://fake-cdn/c2c",
};

function makeDeps(capture: {
  uploadUrlReqs: GetUploadUrlArgs[];
  uploads: UploadArgs[];
  sends: SendMessageArgs[];
}, uploadFullUrl?: string): MediaSendDeps {
  return {
    getUploadUrlFn: async (args) => {
      capture.uploadUrlReqs.push(args);
      return { upload_param: "up-param", upload_full_url: uploadFullUrl };
    },
    uploadFn: async (args) => {
      capture.uploads.push(args);
      return "download-param";
    },
    sendFn: async (args) => {
      capture.sends.push(args);
    },
  };
}

test("sendFileMessage requests an upload slot with media_type=FILE and correct metadata", async () => {
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];

  await sendFileMessage("user123", FILE, FILE_NAME, OPTS, undefined, makeDeps(capture));

  assert.equal(capture.uploadUrlReqs.length, 1);
  const body = capture.uploadUrlReqs[0].body;
  assert.equal(body.media_type, UploadMediaType.FILE);
  assert.equal(body.to_user_id, "user123");
  assert.equal(body.rawsize, FILE.length);
  assert.equal(body.rawfilemd5, crypto.createHash("md5").update(FILE).digest("hex"));
  assert.equal(body.filesize, aesEcbPaddedSize(FILE.length));
  assert.equal(body.no_need_thumb, true);
  assert.match(body.filekey, /^[0-9a-f]{32}$/, "filekey is 32 hex chars");
  assert.match(body.aeskey!, /^[0-9a-f]{32}$/, "aeskey is hex-encoded 16 bytes");
});

test("sendFileMessage sends a well-formed file item", async () => {
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];

  await sendFileMessage("user123", FILE, FILE_NAME, OPTS, undefined, makeDeps(capture));

  assert.equal(capture.uploads.length, 1);
  const upload = capture.uploads[0];
  assert.equal(upload.buffer, FILE);
  assert.equal(upload.uploadParam, "up-param");
  assert.equal(upload.cdnBaseUrl, OPTS.cdnBaseUrl);

  assert.equal(capture.sends.length, 1);
  const msg = capture.sends[0].body.msg;
  assert.equal(msg.to_user_id, "user123");
  assert.equal(msg.context_token, "ctx");
  assert.equal(msg.item_list.length, 1);

  const item = msg.item_list[0];
  assert.equal(item.type, MessageItemType.FILE);
  assert.ok(item.file_item, "file_item present");
  assert.equal(item.file_item!.media!.encrypt_query_param, "download-param");
  assert.equal(item.file_item!.media!.encrypt_type, 1);
  assert.equal(item.file_item!.file_name, FILE_NAME);
  // Plaintext size as a decimal string, unlike the image item's numeric
  // ciphertext mid_size.
  assert.equal(item.file_item!.len, String(FILE.length));

  // The aes_key must round-trip through the same convention the inbound
  // path decodes: base64 of the hex string, which parseAesKey() converts
  // back to the raw 16-byte key that was announced to getuploadurl.
  const announcedKey = Buffer.from(capture.uploadUrlReqs[0].body.aeskey!, "hex");
  const parsed = parseAesKey({ encrypt_query_param: "x", aes_key: item.file_item!.media!.aes_key! });
  assert.ok(parsed && parsed.equals(announcedKey), "aes_key decodes back to the announced key");
});

test("sendFileMessage prefers upload_full_url when present", async () => {
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];

  await sendFileMessage("user123", FILE, FILE_NAME, OPTS, undefined, makeDeps(capture, "http://cdn/full-upload-url"));

  assert.equal(capture.uploads[0].uploadFullUrl, "http://cdn/full-upload-url");
});

test("sendFileMessage reuses a provided clientId for gateway de-duplication", async () => {
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];
  const deps = makeDeps(capture);

  const stableId = "wechat-acp-file-stable-id";
  const returnedId = await sendFileMessage("user123", FILE, FILE_NAME, OPTS, stableId, deps);
  await sendFileMessage("user123", FILE, FILE_NAME, OPTS, stableId, deps);

  assert.equal(returnedId, stableId);
  assert.deepEqual(
    capture.sends.map((s) => s.body.msg.client_id),
    [stableId, stableId],
    "retries carry the same client_id",
  );
});

test("sendFileMessage fails fast when no upload URL is returned", async () => {
  const deps: MediaSendDeps = {
    getUploadUrlFn: async () => ({}),
    uploadFn: async () => {
      throw new Error("should not be called");
    },
    sendFn: async () => {
      throw new Error("should not be called");
    },
  };

  await assert.rejects(
    () => sendFileMessage("user123", FILE, FILE_NAME, OPTS, undefined, deps),
    /no upload URL/,
  );
});

test("file send retry with reused media is byte-identical and does not re-upload", async () => {
  /**
   * Retry semantics used by deliverAudio in bridge.ts: upload once via
   * uploadFileMedia, then retry only sendFileItem with the same media
   * descriptor, file name and client_id. Every attempt must serialize to
   * an identical message so the iLink gateway can de-duplicate.
   */
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];
  const deps = makeDeps(capture);

  const media = await uploadFileMedia("user123", FILE, OPTS, deps);
  assert.equal(capture.uploads.length, 1, "exactly one upload");
  assert.equal(media.raw_size, FILE.length, "raw_size is the plaintext size");

  let sendCalls = 0;
  const flakySend: NonNullable<MediaSendDeps["sendFn"]> = async (args) => {
    capture.sends.push(args);
    sendCalls++;
    if (sendCalls === 1) throw new Error("connection reset");
  };

  const stableId = "wechat-acp-file-retry-id";
  await assert.rejects(
    () => sendFileItem("user123", media, FILE_NAME, OPTS, stableId, flakySend),
    /connection reset/,
  );
  await sendFileItem("user123", media, FILE_NAME, OPTS, stableId, flakySend);

  assert.equal(capture.uploads.length, 1, "retry must not re-upload");
  assert.equal(capture.sends.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(capture.sends[0].body)),
    JSON.parse(JSON.stringify(capture.sends[1].body)),
    "retry payload must be byte-identical to the first attempt",
  );
});
