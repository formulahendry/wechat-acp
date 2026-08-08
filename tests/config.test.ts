import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAgentSessionScope,
  parseSessionResumePolicy,
} from "../src/config.js";

test("preset session scope ignores bundled command changes", () => {
  const first = buildAgentSessionScope({
    preset: "copilot",
    command: "npx",
    args: ["@github/copilot", "--acp"],
    cwd: ".",
  });
  const second = buildAgentSessionScope({
    preset: "copilot",
    command: "copilot",
    args: ["--acp", "--new-default"],
    cwd: ".",
  });

  assert.equal(first, second);
});

test("raw agent session scope includes command, args, and cwd", () => {
  const base = {
    command: "agent",
    args: ["--acp"],
    cwd: ".",
  };
  assert.notEqual(
    buildAgentSessionScope(base),
    buildAgentSessionScope({ ...base, args: ["--acp", "--other"] }),
  );
  assert.notEqual(
    buildAgentSessionScope(base),
    buildAgentSessionScope({ ...base, cwd: ".." }),
  );
});

test("session resume policy accepts only documented modes", () => {
  assert.equal(parseSessionResumePolicy("off"), "off");
  assert.equal(parseSessionResumePolicy("auto"), "auto");
  assert.equal(parseSessionResumePolicy("required"), "required");
  assert.throws(() => parseSessionResumePolicy("yes"), /Invalid session resume policy/);
});
