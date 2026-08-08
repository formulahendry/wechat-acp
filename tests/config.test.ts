import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRIDGE_COMMANDS,
  buildAgentSessionScope,
  matchBridgeCommand,
  parseSessionResumePolicy,
  validateCommandAliases,
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

test("acp-more aliases validate and bare aliases match only the full message", () => {
  const aliases = {
    [BRIDGE_COMMANDS.acpMore]: ["/acp-fetch-msg", "."],
  };
  assert.doesNotThrow(() => validateCommandAliases(aliases));
  assert.equal(
    matchBridgeCommand("/acp-fetch-msg", BRIDGE_COMMANDS.acpMore, aliases),
    BRIDGE_COMMANDS.acpMore,
  );
  assert.equal(
    matchBridgeCommand(".", BRIDGE_COMMANDS.acpMore, aliases),
    BRIDGE_COMMANDS.acpMore,
  );
  assert.equal(matchBridgeCommand(". extra", BRIDGE_COMMANDS.acpMore, aliases), null);
});
