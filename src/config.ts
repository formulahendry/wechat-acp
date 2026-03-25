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
  hermes: {
    label: "Hermes Agent",
    command: "hermes",
    args: ["acp"],
    description: "Hermes Agent ACP mode",
  },
  copilot: {
    label: "GitHub Copilot",
    command: "npx",
    args: ["@github/copilot", "--acp", "--yolo"],
    description: "GitHub Copilot",
  },
  claude: {
    label: "Claude Code",
    command: "npx",
    args: ["@zed-industries/claude-code-acp"],
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
};

export interface WeChatAcpConfig {
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
  };
}

export function defaultStorageDir(): string {
  return path.join(os.homedir(), ".wechat-acp");
}

export function defaultConfig(): WeChatAcpConfig {
  const storageDir = defaultStorageDir();
  return {
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
    },
    agents: { ...BUILT_IN_AGENTS },
    session: {
      idleTimeoutMs: 30 * 60_000, // 30 minutes
      maxConcurrentUsers: 10,
    },
    daemon: {
      enabled: false,
      logFile: path.join(storageDir, "wechat-acp.log"),
      pidFile: path.join(storageDir, "daemon.pid"),
    },
    storage: {
      dir: storageDir,
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
