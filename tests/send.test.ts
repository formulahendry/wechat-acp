/**
 * Tests for sendTextMessage idempotency-key behaviour.
 *
 * Verifies that when a caller provides an explicit clientId, all retries for
 * the same logical message reuse that id so the iLink gateway can de-duplicate
 * repeated deliveries of the same message.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTextMessage } from "../src/weixin/send.js";
import type { sendMessage as SendMessageFn } from "../src/weixin/api.js";

type SendMessageArgs = Parameters<typeof SendMessageFn>[0];

/** Build a fake sendFn that records the client_ids it is called with. */
function makeFakeSendFn(capturedIds: string[], throws?: () => Error): typeof SendMessageFn {
  let callCount = 0;
  return async (args: SendMessageArgs) => {
    capturedIds.push(args.body.msg.client_id);
    callCount++;
    if (throws && callCount === 1) throw throws();
  };
}

const baseOpts = { baseUrl: "http://fake", contextToken: "ctx" };

test("sendTextMessage uses provided clientId instead of generating a new UUID", async () => {
  const capturedIds: string[] = [];
  const fakeSend = makeFakeSendFn(capturedIds);

  const stableId = "wechat-acp-test-stable-id";
  const returnedId = await sendTextMessage("user123", "hello", baseOpts, stableId, fakeSend);

  assert.equal(capturedIds.length, 1);
  assert.equal(capturedIds[0], stableId, "must use the provided clientId");
  assert.equal(returnedId, stableId, "returned id must match the provided clientId");
});

test("sendTextMessage generates a fresh UUID when no clientId is provided", async () => {
  const capturedIds: string[] = [];
  const fakeSend = makeFakeSendFn(capturedIds);

  const returnedId = await sendTextMessage("user123", "hello", baseOpts, undefined, fakeSend);

  assert.equal(capturedIds.length, 1);
  assert.equal(capturedIds[0], returnedId, "sent id must match the returned id");
  assert.match(returnedId, /^wechat-acp-[0-9a-f-]{36}$/, "must be a UUID");
});

test("same clientId on retry means gateway receives identical client_id both times", async () => {
  /**
   * Simulates: first attempt throws (connection reset / 5xx); caller retries
   * with the SAME clientId. The iLink gateway de-duplicates by client_id, so
   * even if the first attempt was already received, the retry is a no-op.
   */
  const capturedIds: string[] = [];
  let callCount = 0;
  const fakeSend: typeof SendMessageFn = async (args: SendMessageArgs) => {
    capturedIds.push(args.body.msg.client_id);
    callCount++;
    if (callCount === 1) {
      throw new Error("connection reset");
    }
  };

  const stableId = "wechat-acp-idempotent-key";

  // First attempt throws
  await assert.rejects(
    () => sendTextMessage("user123", "hello", baseOpts, stableId, fakeSend),
    /connection reset/,
  );
  // Retry — reuse same stableId
  await sendTextMessage("user123", "hello", baseOpts, stableId, fakeSend);

  assert.equal(callCount, 2, "two HTTP calls were made");
  assert.deepEqual(
    capturedIds,
    [stableId, stableId],
    "both calls must carry the same client_id so the gateway can de-duplicate",
  );
});
