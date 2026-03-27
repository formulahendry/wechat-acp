/**
 * ACP Client implementation for WeChat.
 *
 * Implements the acp.Client interface: handles session updates (accumulates
 * text chunks), auto-allows all permission requests, and provides filesystem
 * access for the agent.
 */

import fs from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

export interface WeChatAcpClientOpts {
  sendTyping: () => Promise<void>;
  onThoughtFlush: (text: string) => Promise<void>;
  log: (msg: string) => void;
  showThoughts: boolean;
}

export class WeChatAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private opts: WeChatAcpClientOpts;
  private lastTypingAt = 0;
  private static readonly TYPING_INTERVAL_MS = 5_000;

  constructor(opts: WeChatAcpClientOpts) {
    this.opts = opts;
  }

  updateCallbacks(callbacks: { sendTyping: () => Promise<void>; onThoughtFlush: (text: string) => Promise<void> }): void {
    this.opts = {
      ...this.opts,
      sendTyping: callbacks.sendTyping,
      onThoughtFlush: callbacks.onThoughtFlush,
    };
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-allow: find first "allow" option.
    // Different agents may use snake_case or kebab-case option kinds.
    const allowOpt = params.options.find(
      (o) => {
        const kind = String((o as { kind?: string }).kind ?? "");
        return (
          kind === "allow_once" ||
          kind === "allow_always" ||
          kind === "allow-once" ||
          kind === "allow-always"
        );
      },
    );
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? "allow";

    this.opts.log(`[permission] auto-allowed: ${params.toolCall?.title ?? "unknown"} → ${optionId}`);

    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.maybeFlushThoughts();
        if (update.content.type === "text") {
          this.chunks.push(update.content.text);
        }
        // Throttle typing indicators
        await this.maybeSendTyping();
        break;

      case "tool_call":
        await this.maybeFlushThoughts();
        this.opts.log(`[tool] ${update.title} (${update.status})`);
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        if (update.content.type === "text") {
          const text = update.content.text;
          this.opts.log(`[thought] ${text.length > 80 ? text.substring(0, 80) + "..." : text}`);
          if (this.opts.showThoughts) {
            this.thoughtChunks.push(text);
          }
        }
        await this.maybeSendTyping();
        break;

      case "tool_call_update":
        if (update.status === "completed" && update.content) {
          for (const c of update.content) {
            if (c.type === "diff") {
              const diff = c as acp.Diff;
              const header = `--- ${diff.path}`;
              const lines: string[] = [header];
              if (diff.oldText != null) {
                for (const l of diff.oldText.split("\n")) lines.push(`- ${l}`);
              }
              if (diff.newText != null) {
                for (const l of diff.newText.split("\n")) lines.push(`+ ${l}`);
              }
              this.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
            }
          }
        }
        if (update.status) {
          this.opts.log(`[tool] ${update.toolCallId} → ${update.status}`);
        }
        break;

      case "plan":
        // Log plan entries
        if (update.entries) {
          const items = update.entries
            .map((e: acp.PlanEntry, i: number) => `  ${i + 1}. [${e.status}] ${e.content}`)
            .join("\n");
          this.opts.log(`[plan]\n${items}`);
        }
        break;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    try {
      const content = await fs.promises.readFile(params.path, "utf-8");
      return { content };
    } catch (err) {
      throw new Error(`Failed to read file ${params.path}: ${String(err)}`);
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    try {
      await fs.promises.writeFile(params.path, params.content, "utf-8");
      return {};
    } catch (err) {
      throw new Error(`Failed to write file ${params.path}: ${String(err)}`);
    }
  }

  /** Get accumulated text and reset the buffer. Also flushes any remaining thoughts. */
  async flush(): Promise<string> {
    await this.maybeFlushThoughts();
    const text = this.chunks.join("");
    this.chunks = [];
    this.lastTypingAt = 0;
    return text;
  }

  private async maybeFlushThoughts(): Promise<void> {
    if (this.thoughtChunks.length === 0) return;
    const thoughtText = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    if (thoughtText.trim()) {
      try {
        await this.opts.onThoughtFlush(`💭 [Thinking]\n${thoughtText}`);
      } catch {
        // best effort
      }
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < WeChatAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    try {
      await this.opts.sendTyping();
    } catch {
      // typing is best-effort
    }
  }
}
