/**
 * Per-user ACP session manager.
 *
 * Each WeChat user gets their own agent subprocess + ACP session.
 * Messages are queued per-user to ensure serialized processing.
 */

import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { WeChatAcpClient } from "./client.js";
import { spawnAgent, killAgent, type AgentProcessInfo } from "./agent-manager.js";
import { trackEvent, trackException, hashUserId } from "../telemetry/index.js";

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  contextToken: string;
  completion?: {
    resolve: () => void;
    reject: (err: unknown) => void;
  };
}

export interface UserSession {
  userId: string;
  contextToken: string;
  client: WeChatAcpClient;
  agentInfo: AgentProcessInfo;
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
  createdAt: number;
}

export interface SessionManagerOpts {
  agentCommand: string;
  agentArgs: string[];
  agentCwd: string;
  agentEnv?: Record<string, string>;
  agentPreset?: string;
  idleTimeoutMs: number;
  maxConcurrentUsers: number;
  showThoughts: boolean;
  showDiffs?: boolean;
  log: (msg: string) => void;
  onReply: (userId: string, contextToken: string, text: string) => Promise<void>;
  sendTyping: (userId: string, contextToken: string) => Promise<void>;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private opts: SessionManagerOpts;
  private aborted = false;

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
  }

  start(): void {
    // Run cleanup every 2 minutes
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 2 * 60_000);
    this.cleanupTimer.unref();
  }

  async stop(): Promise<void> {
    this.aborted = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Kill all agent processes
    for (const [userId, session] of this.sessions) {
      this.opts.log(`Stopping session for ${userId}`);
      this.rejectQueuedCompletions(session, new Error("Session stopped before queued message was processed"));
      killAgent(session.agentInfo.process);
    }
    this.sessions.clear();
  }

  async enqueue(userId: string, message: PendingMessage): Promise<void> {
    if (this.aborted) {
      throw new Error("Session manager is stopped");
    }

    let session = this.sessions.get(userId);

    if (!session) {
      if (this.sessions.size >= this.opts.maxConcurrentUsers) {
        // Evict oldest idle session
        this.evictOldest();
      }

      session = await this.createSession(userId, message.contextToken);
      this.sessions.set(userId, session);
    }

    // Always update contextToken to the latest
    session.contextToken = message.contextToken;
    session.lastActivity = Date.now();
    session.queue.push(message);

    if (!session.processing) {
      // Fire-and-forget processing loop for this user
      session.processing = true;
      this.processQueue(session).catch((err) => {
        this.opts.log(`[${userId}] queue processing error: ${String(err)}`);
      });
    }
  }

  async enqueueAndWait(
    userId: string,
    message: Omit<PendingMessage, "completion">,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.enqueue(userId, {
        ...message,
        completion: { resolve, reject },
      }).catch(reject);
    });
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId);
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  private async createSession(userId: string, contextToken: string): Promise<UserSession> {
    this.opts.log(`Creating new session for ${userId}`);

    const client = new WeChatAcpClient({
      sendTyping: () => this.opts.sendTyping(userId, contextToken),
      onThoughtFlush: (text) => this.opts.onReply(userId, contextToken, text),
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      showThoughts: this.opts.showThoughts,
      showDiffs: this.opts.showDiffs ?? true,
    });

    const agentInfo = await spawnAgent({
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
    });

    trackEvent(
      "session.created",
      {
        userIdHash: hashUserId(userId),
        agentPreset: this.opts.agentPreset ?? "raw",
        activeSessions: this.sessions.size + 1,
      },
      hashUserId(userId),
    );

    // If agent process exits, clean up the session
    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(userId);
      if (s && s.agentInfo.process === agentInfo.process) {
        this.opts.log(`Agent process for ${userId} exited, removing session`);
        this.rejectQueuedCompletions(s, new Error("Agent process exited before queued message was processed"));
        this.sessions.delete(userId);
      }
    });

    return {
      userId,
      contextToken,
      client,
      agentInfo,
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
  }

  private async processQueue(session: UserSession): Promise<void> {
    try {
      while (session.queue.length > 0 && !this.aborted) {
        const pending = session.queue.shift()!;
        let completionError: unknown;

        // Keep the ACP client instance stable because the connection is bound to it.
        session.client.updateCallbacks({
          sendTyping: () => this.opts.sendTyping(session.userId, pending.contextToken),
          onThoughtFlush: (text) => this.opts.onReply(session.userId, pending.contextToken, text),
        });

        // Reset chunks for the new turn
        await session.client.flush();

        const promptStartedAt = Date.now();
        try {
          // Send typing immediately so user knows the prompt was received
          this.opts.sendTyping(session.userId, pending.contextToken).catch(() => {});

          // Send ACP prompt
          this.opts.log(`[${session.userId}] Sending prompt to agent...`);
          const result = await session.agentInfo.connection.prompt({
            sessionId: session.agentInfo.sessionId,
            prompt: pending.prompt,
          });

          // Collect accumulated text
          let replyText = await session.client.flush();

          if (result.stopReason === "cancelled") {
            replyText += "\n[cancelled]";
          } else if (result.stopReason === "refusal") {
            replyText += "\n[agent refused to continue]";
          }

          this.opts.log(`[${session.userId}] Agent done (${result.stopReason}), reply ${replyText.length} chars`);

          trackEvent(
            "prompt.completed",
            {
              userIdHash: hashUserId(session.userId),
              agentPreset: this.opts.agentPreset ?? "raw",
              stopReason: String(result.stopReason),
              success: true,
              durationMs: Date.now() - promptStartedAt,
              replyChars: replyText.length,
            },
            hashUserId(session.userId),
          );

          // Send reply back to WeChat
          if (replyText.trim()) {
            await this.opts.onReply(session.userId, pending.contextToken, replyText);
          }
        } catch (err) {
          completionError = err;
          this.opts.log(`[${session.userId}] Agent prompt error: ${String(err)}`);

          trackException(err, "prompt", hashUserId(session.userId));
          trackEvent(
            "prompt.completed",
            {
              userIdHash: hashUserId(session.userId),
              agentPreset: this.opts.agentPreset ?? "raw",
              stopReason: "error",
              success: false,
              durationMs: Date.now() - promptStartedAt,
              replyChars: 0,
            },
            hashUserId(session.userId),
          );

          // Check if agent died
          if (session.agentInfo.process.killed || session.agentInfo.process.exitCode !== null) {
            this.opts.log(`[${session.userId}] Agent process died, removing session`);
            this.rejectQueuedCompletions(session, err);
            this.sessions.delete(session.userId);
            return;
          }

          // Send error message to user
          try {
            await this.opts.onReply(
              session.userId,
              pending.contextToken,
              `⚠️ Agent error: ${String(err)}`,
            );
          } catch {
            // best effort
          }
        } finally {
          if (pending.completion) {
            if (completionError) {
              pending.completion.reject(completionError);
            } else {
              pending.completion.resolve();
            }
          }
        }
      }
    } finally {
      session.processing = false;
    }
  }

  private cleanupIdleSessions(): void {
    if (this.opts.idleTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (now - session.lastActivity > this.opts.idleTimeoutMs && !session.processing) {
        this.opts.log(`Session for ${userId} idle for ${Math.round((now - session.lastActivity) / 60_000)}min, removing`);
        killAgent(session.agentInfo.process);
        this.sessions.delete(userId);
      }
    }
  }

  private evictOldest(): void {
    let oldest: { userId: string; lastActivity: number } | null = null;
    for (const [userId, session] of this.sessions) {
      if (!session.processing && (!oldest || session.lastActivity < oldest.lastActivity)) {
        oldest = { userId, lastActivity: session.lastActivity };
      }
    }
    if (oldest) {
      this.opts.log(`Evicting oldest idle session: ${oldest.userId}`);
      const session = this.sessions.get(oldest.userId);
      if (session) {
        this.rejectQueuedCompletions(session, new Error("Session evicted before queued message was processed"));
        killAgent(session.agentInfo.process);
        this.sessions.delete(oldest.userId);
      }
    }
  }

  private rejectQueuedCompletions(session: UserSession, err: unknown): void {
    for (const pending of session.queue.splice(0)) {
      pending.completion?.reject(err);
    }
  }
}
