/**
 * Spawn and manage ACP agent subprocesses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { WeChatAcpClient } from "./client.js";
import { trackException } from "../telemetry/index.js";

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  configOptions: acp.SessionConfigOption[];
}

export async function spawnAgent(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: WeChatAcpClient;
  mcpServers?: acp.McpServer[];
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<AgentProcessInfo> {
  const { command, args, cwd, env, client, mcpServers = [], signal, log } = params;
  if (signal?.aborted) {
    throw new Error("Agent spawn aborted");
  }

  // On Windows, shell mode avoids EINVAL/ENOENT for command shims like npx/claude/gemini.
  const useShell = process.platform === "win32";

  log(`Spawning agent: ${command} ${args.join(" ")} (cwd: ${cwd}, shell=${useShell})`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: { ...process.env, ...env },
    shell: useShell,
    windowsHide: true,
  });

  proc.on("error", (err) => {
    log(`Agent process error: ${String(err)}`);
    trackException(err, "agent_spawn");
  });

  proc.on("exit", (code, signal) => {
    log(`Agent process exited: code=${code} signal=${signal}`);
  });
  const abortSpawn = () => killAgent(proc);
  signal?.addEventListener("abort", abortSpawn, { once: true });

  try {
    if (!proc.stdin || !proc.stdout) {
      const err = new Error("Failed to get agent process stdio");
      trackException(err, "agent_spawn");
      throw err;
    }

    const input = Writable.toWeb(proc.stdin);
    const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const connection = new acp.ClientSideConnection(() => client, stream);

    // Initialize
    log("Initializing ACP connection...");
    const initResult = await abortable(
      connection.initialize({
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
      }),
      signal,
    );
    log(`ACP initialized (protocol v${initResult.protocolVersion})`);

    // Create session
    const supportsHttpMcp = initResult.agentCapabilities?.mcpCapabilities?.http === true;
    const sessionMcpServers = supportsHttpMcp
      ? mcpServers.filter(
          (server): server is acp.McpServerHttp & { type: "http" } =>
            "type" in server && server.type === "http",
        )
      : [];
    if (mcpServers.length > 0 && !supportsHttpMcp) {
      log("Agent does not advertise HTTP MCP support; file attachments are unavailable");
    }
    log("Creating ACP session...");
    const sessionResult = await abortable(
      connection.newSession({
        cwd,
        mcpServers: sessionMcpServers,
      }),
      signal,
    );
    log(`ACP session created: ${sessionResult.sessionId}`);

    return {
      process: proc,
      connection,
      sessionId: sessionResult.sessionId,
      configOptions: sessionResult.configOptions ?? [],
    };
  } catch (err) {
    killAgent(proc);
    throw err;
  } finally {
    signal?.removeEventListener("abort", abortSpawn);
  }
}

export function killAgent(proc: ChildProcess): void {
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGTERM");
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, 5_000).unref();
  }
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error("Agent spawn aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("Agent spawn aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
