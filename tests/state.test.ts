import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  getPersistedSessionId,
  loadState,
  removePersistedSession,
  updateLastActiveUser,
  updatePersistedSession,
} from "../src/storage/state.js";

test("session persistence preserves user routing state and supports removal", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-state-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "state.json");

  await updateLastActiveUser(stateFile, "user-1", "context-1");
  await updatePersistedSession(stateFile, "user-1", "scope-1", "session-1");
  await updateLastActiveUser(stateFile, "user-1", "context-2");

  assert.equal(
    await getPersistedSessionId(stateFile, "user-1", "scope-1"),
    "session-1",
  );
  const state = await loadState(stateFile);
  assert.equal(state.users?.["user-1"]?.contextToken, "context-2");
  assert.ok(state.users?.["user-1"]?.sessions?.["scope-1"]?.savedAt);

  await removePersistedSession(stateFile, "user-1", "scope-1");
  assert.equal(
    await getPersistedSessionId(stateFile, "user-1", "scope-1"),
    undefined,
  );
  assert.equal((await loadState(stateFile)).users?.["user-1"]?.contextToken, "context-2");
});

test("persisting a session requires an existing user record", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-state-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "state.json");

  await assert.rejects(
    updatePersistedSession(stateFile, "unknown", "scope", "session"),
    /unknown user/,
  );
});
