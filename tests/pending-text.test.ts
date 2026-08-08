import assert from "node:assert/strict";
import { test } from "node:test";

import {
  drainPendingText,
  PendingTextRegistry,
} from "../src/pending-text.js";

function makeRegistry(opts?: {
  now?: () => number;
  maxUsers?: number;
  maxSegmentsPerUser?: number;
}): PendingTextRegistry {
  return new PendingTextRegistry({
    ttlMs: 10 * 60_000,
    maxUsers: opts?.maxUsers ?? 10,
    maxSegmentsPerUser: opts?.maxSegmentsPerUser ?? 50,
    now: opts?.now,
  });
}

test("records only the failed text segments for the active prompt", () => {
  const registry = makeRegistry();
  const generation = registry.supersede("user", "context-1");

  assert.equal(registry.recordFailures("user", generation, ["failed-2", "failed-4"]), true);
  assert.deepEqual(registry.snapshot("user")?.segments, ["failed-2", "failed-4"]);
});

test("drains pending text in order", async () => {
  const registry = makeRegistry();
  const generation = registry.supersede("user", "context-1");
  registry.recordFailures("user", generation, ["one", "two", "three"]);
  const sent: string[] = [];

  const result = await drainPendingText(registry, "user", async (segment) => {
    sent.push(segment);
    return true;
  });

  assert.deepEqual(sent, ["one", "two", "three"]);
  assert.deepEqual(result, { pendingCount: 3, sentCount: 3, remainingCount: 0 });
  assert.equal(registry.snapshot("user"), null);
});

test("stops after the first persistent fetch failure and preserves the remainder", async () => {
  const registry = makeRegistry();
  const generation = registry.supersede("user", "context-1");
  registry.recordFailures("user", generation, ["one", "two", "three"]);
  const attempted: string[] = [];

  const result = await drainPendingText(registry, "user", async (segment) => {
    attempted.push(segment);
    return segment !== "two";
  });

  assert.deepEqual(attempted, ["one", "two"]);
  assert.deepEqual(result, { pendingCount: 3, sentCount: 1, remainingCount: 2 });
  assert.deepEqual(registry.snapshot("user")?.segments, ["two", "three"]);
});

test("reports no pending text without invoking the sender", async () => {
  const registry = makeRegistry();
  let called = false;

  const result = await drainPendingText(registry, "user", async () => {
    called = true;
    return true;
  });

  assert.equal(called, false);
  assert.deepEqual(result, { pendingCount: 0, sentCount: 0, remainingCount: 0 });
});

test("expires pending text and bounds users and segments", () => {
  let now = 0;
  const registry = makeRegistry({
    now: () => now,
    maxUsers: 2,
    maxSegmentsPerUser: 2,
  });
  const firstGeneration = registry.supersede("first", "context-1");
  registry.recordFailures("first", firstGeneration, ["one", "two", "three"]);
  assert.deepEqual(registry.snapshot("first")?.segments, ["one", "two"]);

  now = 1;
  registry.supersede("second", "context-2");
  now = 2;
  registry.supersede("third", "context-3");
  assert.equal(registry.snapshot("first"), null);

  const thirdGeneration = registry.generationForContext("third", "context-3")!;
  registry.recordFailures("third", thirdGeneration, ["pending"]);
  now += 10 * 60_000;
  assert.equal(registry.snapshot("third"), null);
});

test("a newer prompt rejects late failures and fetch remainder from the old prompt", async () => {
  const registry = makeRegistry();
  const oldGeneration = registry.supersede("user", "old-context");
  registry.recordFailures("user", oldGeneration, ["old-one", "old-two"]);

  const drain = drainPendingText(registry, "user", async (segment) => {
    registry.supersede("user", "new-context");
    return segment !== "old-one";
  });

  assert.deepEqual(await drain, { pendingCount: 2, sentCount: 0, remainingCount: 0 });
  assert.equal(registry.recordFailures("user", oldGeneration, ["late-old"]), false);
  assert.equal(registry.snapshot("user"), null);
});
