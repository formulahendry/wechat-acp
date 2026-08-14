/**
 * Configuration types and defaults for wechat-acp.
 */

import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export type SessionResumePolicy = "off" | "auto" | "required";

export const DEFAULT_RESOURCE_INLINE_LIMIT = 1000;
export const MAX_RESOURCE_INLINE_LIMIT = 4000;

export interface AgentCommandConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentPreset extends AgentCommandConfig {
  label: string;
  description?: string;
}

export interface ResolvedAgentConfig extends AgentCommandConfig {
  id?: string;
  label?: string;
  source: "preset" | "raw";
}

export const BUILT_IN_AGENTS: Record<string, AgentPreset> = {
  copilot: {
    label: "GitHub Copilot",
    command: "npx",
    args: ["@github/copilot", "--acp", "--yolo", "--enable-all-github-mcp-tools"],
    description: "GitHub Copilot",
  },
  claude: {
    label: "Claude Code",
    command: "npx",
    args: ["@agentclientprotocol/claude-agent-acp"],
    description: "Claude Code ACP",
  },
  gemini: {
    label: "Gemini CLI",
    command: "npx",
    args: ["@google/gemini-cli", "--experimental-acp"],
    description: "Gemini CLI",
  },
  qwen: {
    label: "Qwen Code",
    command: "npx",
    args: ["@qwen-code/qwen-code", "--acp", "--experimental-skills"],
    description: "Qwen Code",
  },
  codex: {
    label: "Codex CLI",
    command: "npx",
    args: ["@zed-industries/codex-acp"],
    description: "Codex ACP",
  },
  opencode: {
    label: "OpenCode",
    command: "npx",
    args: ["opencode-ai", "acp"],
    description: "OpenCode",
  },
  openclaw: {
    label: "OpenClaw",
    command: "npx",
    args: ["openclaw", "acp"],
    description: "OpenClaw",
  },
  kiro: {
    label: "Kiro CLI",
    command: "kiro-cli",
    args: ["acp"],
    description: "Kiro CLI",
  },
  hermes: {
    label: "Hermes Agent",
    command: "hermes",
    args: ["acp"],
    description: "Hermes Agent",
  },
  kimi: {
    label: "Kimi CLI",
    command: "kimi",
    args: ["acp"],
    description: "Kimi CLI (Moonshot AI)",
  },
  pi: {
    label: "pi ACP",
    command: "npx",
    args: ["pi-acp"],
    description: "pi coding agent ACP adapter",
  },
};

/**
 * Canonical bridge slash commands that `wechat-acp` handles itself
 * (i.e. not forwarded to the underlying agent). Used as the keys of
 * {@link WeChatAcpConfig.commandAliases} and as the fallback names that
 * always work regardless of configured aliases.
 */
export const BRIDGE_COMMANDS = {
  acpConfig: "/acp-config",
  acpCancel: "/acp-cancel",
  acpNew: "/acp-new",
  acpMore: "/acp-more",
  promptStart: "/acp-prompt-start",
  promptDone: "/acp-prompt-done",
} as const;

export interface WeChatAcpConfig {
  /**
   * Optional user-defined aliases for bridge slash commands. Maps a
   * canonical command (e.g. `"/acp-cancel"`) to one or more custom
   * aliases (e.g. `["/cancel", "/取消"]`). The canonical command always
   * keeps working as a fallback. See {@link BRIDGE_COMMANDS} for the set
   * of commands that can be aliased.
   */
  commandAliases?: Record<string, string[]>;
  wechat: {
    baseUrl: string;
    cdnBaseUrl: string;
    botType: string;
  };
  agent: {
    preset?: string;
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    showThoughts: boolean;
    showDiffs?: boolean;
    /**
     * Render inline images produced inside ACP tool calls. Defaults to `true`;
     * set to `false` (or pass `--hide-images`) to suppress intermediate tool
     * images. Explicit agent message images and attachments are always sent.
     */
    showImages?: boolean;
    /**
     * Deliver agent-produced ACP `audio` content blocks as WeChat file
     * messages. Defaults to `true`; set to `false` (or pass
     * `--hide-audio`) to drop them.
     */
    showAudio?: boolean;
    /**
     * Render intermediate ACP tool `resource` output in WeChat: text resources
     * inline as fenced code blocks, image blobs through the image pipeline,
     * other blobs as a one-line placeholder. Explicit agent resources and
     * files sent through the bridge artifact tool are always delivered.
     * Defaults to `true`; set to `false` (or pass `--hide-resources`)
     * to drop them. Active sessions can override this with
     * `bridge.resources` through `/acp-config`.
     */
    showResources?: boolean;
    /**
     * Maximum tool text-resource length to render inline. Longer resources
     * are sent as file attachments. Set to `0` to attach every non-empty tool
     * text resource. Defaults to 1000 characters.
     */
    resourceInlineLimit?: number;
  };
  agents: Record<string, AgentPreset>;
  session: {
    idleTimeoutMs: number;
    maxConcurrentUsers: number;
    /**
     * Whether persisted ACP sessions should be loaded after bridge restarts.
     * `auto` falls back to a new session only when loading is unsupported or
     * the saved session no longer exists. `required` rejects those fallbacks.
     */
    resume?: SessionResumePolicy;
    /**
     * Optional standalone message sent after an ACP prompt turn completes.
     * Omit or set to an empty string to disable the completion indicator.
     */
    turnEndMessage?: string;
  };
  daemon: {
    enabled: boolean;
    logFile: string;
    pidFile: string;
  };
  storage: {
    dir: string;
    instance?: string;
    stateFile?: string;
    injectDir?: string;
    /**
     * Directory where incoming binary files received from WeChat are
     * persisted so the agent can read them by path. Set to `null` to
     * disable saving (matches pre-0.3 behavior, where the file buffer
     * was dropped after download). Unset (`undefined`) is treated the
     * same as `null` by the bridge so existing library users that
     * construct `WeChatAcpConfig` without this field keep working.
     */
    inboxDir?: string | null;
  };
}

const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validate an instance name. Names are used as a directory segment under
 * `~/.wechat-acp/instances/`, so we restrict them to a safe character set
 * to prevent path traversal (`..`, absolute paths) and platform-specific
 * issues with hidden / reserved names.
 */
export function validateInstanceName(instance: string): void {
  if (!INSTANCE_NAME_PATTERN.test(instance)) {
    throw new Error(
      `Invalid --instance name: ${JSON.stringify(instance)}. ` +
        "Must be 1-64 chars, start with a letter or digit, " +
        "and contain only letters, digits, '.', '_', or '-'.",
    );
  }
}

export function defaultStorageDir(instance?: string): string {
  const root = path.join(os.homedir(), ".wechat-acp");
  if (!instance) return root;
  validateInstanceName(instance);
  return path.join(root, "instances", instance);
}

export function defaultConfig(opts?: { instance?: string }): WeChatAcpConfig {
  const instance = opts?.instance;
  const storageDir = defaultStorageDir(instance);
  return {
    commandAliases: {},
    wechat: {
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      botType: "3",
    },
    agent: {
      preset: undefined,
      command: "",
      args: [],
      cwd: process.cwd(),
      showThoughts: true,
      showDiffs: false,
      showImages: true,
      showAudio: true,
      showResources: true,
      resourceInlineLimit: DEFAULT_RESOURCE_INLINE_LIMIT,
    },
    agents: { ...BUILT_IN_AGENTS },
    session: {
      idleTimeoutMs: 1440 * 60_000, // 24 hours
      maxConcurrentUsers: 10,
      resume: "off",
    },
    daemon: {
      enabled: false,
      logFile: path.join(storageDir, "wechat-acp.log"),
      pidFile: path.join(storageDir, "daemon.pid"),
    },
    storage: {
      dir: storageDir,
      instance,
      stateFile: path.join(storageDir, "state.json"),
      injectDir: path.join(storageDir, "inject"),
      inboxDir: path.join(storageDir, "inbox"),
    },
  };
}

export function parseSessionResumePolicy(value: unknown): SessionResumePolicy {
  if (value === "off" || value === "auto" || value === "required") {
    return value;
  }
  throw new Error(
    `Invalid session resume policy: ${JSON.stringify(value)}. ` +
      'Expected "off", "auto", or "required".',
  );
}

export function parseResourceInlineLimit(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_RESOURCE_INLINE_LIMIT
  ) {
    return value;
  }
  throw new Error(
    `Invalid resource inline limit: ${JSON.stringify(value)}. ` +
      `Expected an integer from 0 to ${MAX_RESOURCE_INLINE_LIMIT}.`,
  );
}

/**
 * Build a stable, opaque key for persisted sessions. Preset identities stay
 * stable when bundled command arguments evolve; raw commands intentionally
 * treat any command-line change as a different agent configuration.
 */
export function buildAgentSessionScope(
  agent: Pick<WeChatAcpConfig["agent"], "preset" | "command" | "args" | "cwd">,
): string {
  const cwd = path.resolve(agent.cwd);
  const identity = agent.preset
    ? { kind: "preset", id: agent.preset, cwd }
    : { kind: "raw", command: agent.command, args: agent.args, cwd };
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  return `v1:${digest}`;
}

/**
 * Parse agent string like "claude code" or "npx tsx ./agent.ts"
 * into { command, args }.
 */
export function parseAgentCommand(agentStr: string): { command: string; args: string[] } {
  const parts = agentStr.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) {
    throw new Error("Agent command cannot be empty");
  }
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

export function resolveAgentSelection(
  agentSelection: string,
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS,
): ResolvedAgentConfig {
  const preset = registry[agentSelection];
  if (preset) {
    return {
      id: agentSelection,
      label: preset.label,
      command: preset.command,
      args: [...preset.args],
      env: preset.env ? { ...preset.env } : undefined,
      source: "preset",
    };
  }

  const parsed = parseAgentCommand(agentSelection);
  return {
    command: parsed.command,
    args: parsed.args,
    source: "raw",
  };
}

export function listBuiltInAgents(
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS,
): Array<{ id: string; preset: AgentPreset }> {
  return Object.entries(registry)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, preset]) => ({ id, preset }));
}

/**
 * Resolve the configured aliases for a canonical bridge command into a
 * trimmed, de-duplicated list. The canonical command itself is not
 * included — use {@link resolveCommandNames} when you need the full set
 * of names that should trigger a command.
 */
export function resolveCommandAliases(
  canonical: string,
  aliases?: Record<string, string[]>,
): string[] {
  const configured = aliases?.[canonical];
  if (!configured) return [];
  const result: string[] = [];
  for (const alias of configured) {
    const trimmed = alias.trim();
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Return the full ordered list of names that should trigger a bridge
 * command: the canonical name first, followed by any user-defined
 * aliases. The canonical name is always present so built-in commands
 * keep working as a fallback even when aliases are configured.
 */
export function resolveCommandNames(
  canonical: string,
  aliases?: Record<string, string[]>,
): string[] {
  return [canonical, ...resolveCommandAliases(canonical, aliases).filter((a) => a !== canonical)];
}

export function matchBridgeCommand(
  text: string,
  canonical: string,
  aliases?: Record<string, string[]>,
): string | null {
  const trimmed = text.trim();
  for (const name of resolveCommandNames(canonical, aliases)) {
    if (trimmed === name) return canonical;
    if (name.startsWith("/") && trimmed.startsWith(`${name} `)) {
      return canonical + trimmed.slice(name.length);
    }
  }
  return null;
}

/**
 * Validate a `commandAliases` map. Each key must be a known bridge
 * command (see {@link BRIDGE_COMMANDS}). Aliases must be non-empty
 * strings. Two alias styles are supported:
 *
 *  - Slash aliases (start with `/`) work like the built-in commands:
 *    they match the command token and may be followed by arguments, so
 *    they must not contain whitespace.
 *  - Bare-phrase aliases (no leading `/`) match only when they equal the
 *    entire message — useful for voice input (e.g. "取消"). They may
 *    contain spaces.
 *
 * Throws an `Error` describing the first problem found.
 */
export function validateCommandAliases(aliases: Record<string, string[]> | undefined): void {
  if (aliases === undefined) return;
  if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)) {
    throw new Error("commandAliases must be an object mapping a command to a list of aliases.");
  }

  const knownCommands = new Set<string>(Object.values(BRIDGE_COMMANDS));
  const seen = new Map<string, string>();

  for (const [canonical, list] of Object.entries(aliases)) {
    if (!knownCommands.has(canonical)) {
      throw new Error(
        `commandAliases: unknown command ${JSON.stringify(canonical)}. ` +
          `Known commands: ${[...knownCommands].join(", ")}.`,
      );
    }
    if (!Array.isArray(list)) {
      throw new Error(`commandAliases[${JSON.stringify(canonical)}] must be an array of strings.`);
    }
    for (const alias of list) {
      if (typeof alias !== "string" || alias.trim() === "") {
        throw new Error(`commandAliases[${JSON.stringify(canonical)}] contains an empty alias.`);
      }
      const trimmed = alias.trim();
      if (trimmed.startsWith("/") && /\s/.test(trimmed)) {
        throw new Error(
          `commandAliases: slash alias ${JSON.stringify(trimmed)} must not contain whitespace.`,
        );
      }
      if (knownCommands.has(trimmed) && trimmed !== canonical) {
        throw new Error(
          `commandAliases: alias ${JSON.stringify(trimmed)} collides with built-in command ${JSON.stringify(trimmed)}.`,
        );
      }
      const owner = seen.get(trimmed);
      if (owner && owner !== canonical) {
        throw new Error(
          `commandAliases: alias ${JSON.stringify(trimmed)} is mapped to both ` +
            `${JSON.stringify(owner)} and ${JSON.stringify(canonical)}.`,
        );
      }
      seen.set(trimmed, canonical);
    }
  }
}
