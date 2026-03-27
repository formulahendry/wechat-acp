/**
 * Spawn and manage ACP agent subprocesses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { WeChatAcpClient } from "./client.js";

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
}

export async function spawnAgent(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: WeChatAcpClient;
  log: (msg: string) => void;
}): Promise<AgentProcessInfo> {
  const { command, args, cwd, env, client, log } = params;

  // On Windows, shell mode avoids EINVAL/ENOENT for command shims like npx/claude/gemini.
  const useShell = process.platform === "win32";

  log(`Spawning agent: ${command} ${args.join(" ")} (cwd: ${cwd}, shell=${useShell})`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: { ...process.env, ...env },
    shell: useShell,
  });

  proc.on("error", (err) => {
    log(`Agent process error: ${String(err)}`);
  });

  proc.on("exit", (code, signal) => {
    log(`Agent process exited: code=${code} signal=${signal}`);
  });

  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error("Failed to get agent process stdio");
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  // Initialize
  log("Initializing ACP connection...");
  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: {
      name: packageJson.name,
      title: packageJson.name,
      version: packageJson.version,
    },
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
  });
  log(`ACP initialized (protocol v${initResult.protocolVersion})`);

  const authMethod = pickAuthMethod(initResult.authMethods);
  if (authMethod) {
    log(`Authenticating ACP client via "${authMethod}"...`);
    await connection.authenticate({ methodId: authMethod });
    log("ACP authentication completed");
  }

  // Create session
  log("Creating ACP session...");
  const sessionResult = await connection.newSession({
    cwd,
    mcpServers: [],
  });
  log(`ACP session created: ${sessionResult.sessionId}`);

  return {
    process: proc,
    connection,
    sessionId: sessionResult.sessionId,
  };
}

function pickAuthMethod(
  authMethods?: Array<{ id: string }> | null,
): string | null {
  if (!authMethods || authMethods.length === 0) return null;

  // Prefer cursor_login when available, then fallback to first advertised method.
  const cursorLogin = authMethods.find((method) => method.id === "cursor_login");
  return cursorLogin?.id ?? authMethods[0]?.id ?? null;
}

export function killAgent(proc: ChildProcess): void {
  if (!proc.killed) {
    proc.kill("SIGTERM");
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5_000).unref();
  }
}
