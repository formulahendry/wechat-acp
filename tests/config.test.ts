import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRIDGE_COMMANDS,
  buildAgentSessionScope,
  defaultConfig,
  matchBridgeCommand,
  parseResourceInlineLimit,
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

test("resource inline limit defaults to 1000 and accepts 0 through 4000", () => {
  assert.equal(defaultConfig().agent.resourceInlineLimit, 1000);
  assert.equal(parseResourceInlineLimit(0), 0);
  assert.equal(parseResourceInlineLimit(1000), 1000);
  assert.equal(parseResourceInlineLimit(4000), 4000);
  assert.throws(() => parseResourceInlineLimit(-1), /Invalid resource inline limit/);
  assert.throws(() => parseResourceInlineLimit(4001), /Invalid resource inline limit/);
  assert.throws(() => parseResourceInlineLimit(1.5), /Invalid resource inline limit/);
  assert.throws(() => parseResourceInlineLimit("1000"), /Invalid resource inline limit/);
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

test("acp-new supports a configurable clear alias", () => {
  const aliases = {
    [BRIDGE_COMMANDS.acpNew]: ["/acp-clear"],
  };
  assert.doesNotThrow(() => validateCommandAliases(aliases));
  assert.equal(
    matchBridgeCommand("/acp-clear", BRIDGE_COMMANDS.acpNew, aliases),
    BRIDGE_COMMANDS.acpNew,
  );
});
