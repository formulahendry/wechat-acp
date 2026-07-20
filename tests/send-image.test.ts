/**
 * Tests for sendImageMessage protocol shape.
 *
 * Verifies the outbound image pipeline against the iLink conventions
 * mirrored from @tencent-weixin/openclaw-weixin: getuploadurl request
 * fields, ciphertext sizing, image_item structure (including the
 * aes_key encoding that the inbound parseAesKey() expects), and
 * client_id idempotency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sendImageMessage, type ImageSendDeps } from "../src/weixin/send.js";
import { parseAesKey, aesEcbPaddedSize } from "../src/weixin/media.js";
import { MessageItemType, UploadMediaType } from "../src/weixin/types.js";
import type { getUploadUrl as GetUploadUrlFn, sendMessage as SendMessageFn } from "../src/weixin/api.js";
import type { uploadToCdn as UploadToCdnFn } from "../src/weixin/media.js";

type GetUploadUrlArgs = Parameters<typeof GetUploadUrlFn>[0];
type UploadArgs = Parameters<typeof UploadToCdnFn>[0];
type SendMessageArgs = Parameters<typeof SendMessageFn>[0];

const IMAGE = Buffer.from("not-really-a-png-but-fine-for-tests");
const OPTS = {
  baseUrl: "http://fake",
  contextToken: "ctx",
  cdnBaseUrl: "http://fake-cdn/c2c",
};

function makeDeps(capture: {
  uploadUrlReqs: GetUploadUrlArgs[];
  uploads: UploadArgs[];
  sends: SendMessageArgs[];
}, uploadFullUrl?: string): ImageSendDeps {
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

test("sendImageMessage requests an upload slot with correct metadata", async () => {
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];

  await sendImageMessage("user123", IMAGE, OPTS, undefined, makeDeps(capture));

  assert.equal(capture.uploadUrlReqs.length, 1);
  const body = capture.uploadUrlReqs[0].body;
  assert.equal(body.media_type, UploadMediaType.IMAGE);
  assert.equal(body.to_user_id, "user123");
  assert.equal(body.rawsize, IMAGE.length);
  assert.equal(body.rawfilemd5, crypto.createHash("md5").update(IMAGE).digest("hex"));
  assert.equal(body.filesize, aesEcbPaddedSize(IMAGE.length));
  assert.equal(body.no_need_thumb, true);
  assert.match(body.filekey, /^[0-9a-f]{32}$/, "filekey is 32 hex chars");
  assert.match(body.aeskey!, /^[0-9a-f]{32}$/, "aeskey is hex-encoded 16 bytes");
});

test("sendImageMessage sends a well-formed image item", async () => {
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];

  await sendImageMessage("user123", IMAGE, OPTS, undefined, makeDeps(capture));

  assert.equal(capture.uploads.length, 1);
  const upload = capture.uploads[0];
  assert.equal(upload.buffer, IMAGE);
  assert.equal(upload.uploadParam, "up-param");
  assert.equal(upload.cdnBaseUrl, OPTS.cdnBaseUrl);

  assert.equal(capture.sends.length, 1);
  const msg = capture.sends[0].body.msg;
  assert.equal(msg.to_user_id, "user123");
  assert.equal(msg.context_token, "ctx");
  assert.equal(msg.item_list.length, 1);

  const item = msg.item_list[0];
  assert.equal(item.type, MessageItemType.IMAGE);
  assert.ok(item.image_item, "image_item present");
  assert.equal(item.image_item!.media.encrypt_query_param, "download-param");
  assert.equal(item.image_item!.media.encrypt_type, 1);
  assert.equal(item.image_item!.mid_size, aesEcbPaddedSize(IMAGE.length));

  // The aes_key must round-trip through the same convention the inbound
  // path decodes: base64 of the hex string, which parseAesKey() converts
  // back to the raw 16-byte key that was announced to getuploadurl.
  const announcedKey = Buffer.from(capture.uploadUrlReqs[0].body.aeskey!, "hex");
  const parsed = parseAesKey({ encrypt_query_param: "x", aes_key: item.image_item!.media.aes_key });
  assert.ok(parsed && parsed.equals(announcedKey), "aes_key decodes back to the announced key");
});

test("sendImageMessage prefers upload_full_url when present", async () => {
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];

  await sendImageMessage("user123", IMAGE, OPTS, undefined, makeDeps(capture, "http://cdn/full-upload-url"));

  assert.equal(capture.uploads[0].uploadFullUrl, "http://cdn/full-upload-url");
});

test("sendImageMessage reuses a provided clientId for gateway de-duplication", async () => {
  const capture = { uploadUrlReqs: [], uploads: [], sends: [] } as Parameters<typeof makeDeps>[0];
  const deps = makeDeps(capture);

  const stableId = "wechat-acp-image-stable-id";
  const returnedId = await sendImageMessage("user123", IMAGE, OPTS, stableId, deps);
  await sendImageMessage("user123", IMAGE, OPTS, stableId, deps);

  assert.equal(returnedId, stableId);
  assert.deepEqual(
    capture.sends.map((s) => s.body.msg.client_id),
    [stableId, stableId],
    "retries carry the same client_id",
  );
});

test("sendImageMessage fails fast when no upload URL is returned", async () => {
  const deps: ImageSendDeps = {
    getUploadUrlFn: async () => ({}),
    uploadFn: async () => {
      throw new Error("should not be called");
    },
    sendFn: async () => {
      throw new Error("should not be called");
    },
  };

  await assert.rejects(
    () => sendImageMessage("user123", IMAGE, OPTS, undefined, deps),
    /no upload URL/,
  );
});
