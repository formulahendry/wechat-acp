/**
 * Configuration types and defaults for wechat-acp.
 */

import path from "node:path";
import os from "node:os";

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
  };
  agents: Record<string, AgentPreset>;
  session: {
    idleTimeoutMs: number;
    maxConcurrentUsers: number;
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
    },
    agents: { ...BUILT_IN_AGENTS },
    session: {
      idleTimeoutMs: 1440 * 60_000, // 24 hours
      maxConcurrentUsers: 10,
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
