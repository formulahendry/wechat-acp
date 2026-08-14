/**
 * Per-user ACP session manager.
 *
 * Each WeChat user gets their own agent subprocess + ACP session.
 * Messages are queued per-user to ensure serialized processing.
 */

import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import {
  WeChatAcpClient,
  type AgentImage,
  type AgentAudio,
  type AgentFile,
} from "./client.js";
import type { AgentResourceLink } from "../artifacts/types.js";
import {
  spawnAgent,
  killAgentAndWait,
  AgentProcessCleanupError,
  type AgentProcessInfo,
} from "./agent-manager.js";
import type { SessionResumePolicy } from "../config.js";
import { trackEvent, trackException, hashUserId } from "../telemetry/index.js";

/**
 * Build a short, user-friendly notice for a turn that ended without the
 * agent producing any textual reply. The raw `stopReason` enum is kept
 * out of the user-facing text (it is still logged) so users see a
 * meaningful message rather than an internal token like `max_tokens`.
 */
function emptyTurnNotice(stopReason: acp.StopReason | undefined): string {
  switch (stopReason) {
    case "max_tokens":
      return "ℹ️ The agent stopped at its output length limit before sending a reply. Try a more specific or shorter request.";
    case "max_turn_requests":
      return "ℹ️ The agent reached its tool-call limit before sending a reply. Try again or narrow the task.";
    case "refusal":
      return "ℹ️ The agent declined to respond to this request.";
    case "cancelled":
      return "ℹ️ The request was cancelled before the agent sent a reply.";
    default:
      return "ℹ️ The agent finished without sending a reply. Try rephrasing your request.";
  }
}

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  contextToken: string;
  replyGeneration?: number;
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
  mcpLease?: SessionMcpLease;
  configOptions: acp.SessionConfigOption[];
  queue: PendingMessage[];
  processing: boolean;
  activeMessage?: PendingMessage;
  closedError?: Error;
  processExitedError?: Error;
  drainingExitedTurn?: boolean;
  promptDispatched?: boolean;
  exitCleanup?: Promise<void>;
  cleanupRegistered?: boolean;
  connectionClosedError?: Promise<never>;
  lifecycleGeneration?: number;
  sessionIdPersisted?: boolean;
  lastActivity: number;
  createdAt: number;
}

export interface ResetSessionResult {
  hadActiveSession: boolean;
  cancelledTurn: boolean;
  cancelledPendingCreation: boolean;
  droppedQueueCount: number;
}

export interface RuntimeBridgeSettings {
  thoughts: boolean;
  diffs: boolean;
  images: boolean;
  audio: boolean;
  resources: boolean;
}

export type RuntimeBridgeSetting = keyof RuntimeBridgeSettings;

export interface SessionMcpLease {
  mcpServer: acp.McpServer;
  close(): Promise<void>;
}

export interface SessionManagerOpts {
  agentCommand: string;
  agentArgs: string[];
  agentCwd: string;
  agentEnv?: Record<string, string>;
  agentPreset?: string;
  idleTimeoutMs: number;
  maxConcurrentUsers: number;
  resumePolicy?: SessionResumePolicy;
  getPersistedSessionId?: (userId: string) => Promise<string | undefined>;
  persistSessionId?: (userId: string, sessionId: string) => Promise<void>;
  removePersistedSessionId?: (userId: string) => Promise<void>;
  turnEndMessage?: string;
  showThoughts: boolean;
  showDiffs?: boolean;
  showImages?: boolean;
  showAudio?: boolean;
  showResources?: boolean;
  resourceInlineLimit?: number;
  createMcpLease?: () => SessionMcpLease;
  agentShutdownTimeoutMs?: number;
  killAgentProcess?: (
    process: ChildProcess,
    timeoutMs?: number,
  ) => Promise<void>;
  log: (msg: string) => void;
  onReply: (
    userId: string,
    contextToken: string,
    text: string,
    replyGeneration?: number,
    isSessionCurrent?: () => boolean,
  ) => Promise<void>;
  onReplyImage?: (
    userId: string,
    contextToken: string,
    image: AgentImage,
    replyGeneration?: number,
    isSessionCurrent?: () => boolean,
  ) => Promise<void>;
  onReplyAudio?: (
    userId: string,
    contextToken: string,
    audio: AgentAudio,
    replyGeneration?: number,
    isSessionCurrent?: () => boolean,
  ) => Promise<void>;
  onReplyFile?: (
    userId: string,
    contextToken: string,
    file: AgentFile,
    replyGeneration?: number,
    isSessionCurrent?: () => boolean,
  ) => Promise<void>;
  resolveResourceLink?: (link: AgentResourceLink) => Promise<AgentFile | null>;
  sendTyping: (
    userId: string,
    contextToken: string,
    replyGeneration?: number,
    isSessionCurrent?: () => boolean,
  ) => Promise<void>;
}

interface PendingSessionCreation {
  promise: Promise<UserSession>;
  abortController: AbortController;
  cancelled: boolean;
}

interface SessionCleanupState {
  processes: Set<ChildProcess>;
  mcpLeases: Set<SessionMcpLease>;
  removePersistedSessionId: boolean;
}

class SessionResetError extends Error {
  constructor() {
    super("ACP session reset before the message was processed");
    this.name = "SessionResetError";
  }
}

class AgentConnectionClosedError extends Error {
  constructor() {
    super("Agent connection closed before the active operation completed");
    this.name = "AgentConnectionClosedError";
  }
}

const AGENT_EXIT_DRAIN_TIMEOUT_MS = 1_000;

class SessionCreationCleanupError extends AggregateError {
  constructor(
    readonly creationError: unknown,
    cleanupError: unknown,
    readonly mcpLease: SessionMcpLease | undefined,
  ) {
    super(
      [creationError, cleanupError],
      "Agent creation failed and MCP lease cleanup also failed",
    );
    this.name = "SessionCreationCleanupError";
  }
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private exitedSessions = new Map<string, Set<UserSession>>();
  private pendingSessions = new Map<string, PendingSessionCreation>();
  private userLifecycleChains = new Map<string, Promise<void>>();
  private userGenerations = new Map<string, number>();
  private resetOperations = new Map<string, Promise<ResetSessionResult>>();
  private cleanupStates = new Map<string, SessionCleanupState>();
  private cleanupOperations = new Map<string, Promise<void>>();
  private runtimeBridgeSettings = new WeakMap<UserSession, RuntimeBridgeSettings>();
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
    for (const pending of this.pendingSessions.values()) {
      pending.abortController.abort();
    }
    await Promise.allSettled(
      [...this.pendingSessions.values()].map((pending) => pending.promise),
    );
    await Promise.allSettled([...this.resetOperations.values()]);

    const sessions = new Set([
      ...this.sessions.values(),
      ...[...this.exitedSessions.values()].flatMap((entries) => [...entries]),
    ]);
    for (const session of sessions) {
      this.opts.log(`Stopping session for ${session.userId}`);
      session.closedError = new Error(
        "Session stopped before queued message was processed",
      );
      this.rejectSessionCompletions(session, session.closedError);
      session.cleanupRegistered = true;
      this.registerSessionCleanup(session, true);
    }
    this.sessions.clear();
    this.exitedSessions.clear();
    const results = await Promise.allSettled(
      [...this.cleanupStates.keys()].map((userId) =>
        this.retryCleanupState(userId)
      ),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Failed to stop ACP sessions",
      );
    }
  }

  async enqueue(userId: string, message: PendingMessage): Promise<void> {
    const generation = this.userGenerations.get(userId) ?? 0;
    return this.withUserLifecycle(userId, () =>
      this.enqueueUnlocked(userId, message, generation),
    );
  }

  private async enqueueUnlocked(
    userId: string,
    message: PendingMessage,
    generation: number,
  ): Promise<void> {
    if (this.aborted) {
      throw new Error("Session manager is stopped");
    }
    if (!this.isUserGenerationCurrent(userId, generation)) {
      throw new SessionResetError();
    }

    let session: UserSession;
    try {
      session =
        this.sessions.get(userId) ??
        (await this.getOrCreateSession(
          userId,
          message.contextToken,
          () => this.isUserGenerationCurrent(userId, generation),
          generation,
          message.replyGeneration,
        ));
    } catch (err) {
      if (!this.isUserGenerationCurrent(userId, generation)) {
        throw new SessionResetError();
      }
      if (err instanceof SessionResetError) {
        throw err;
      }
      try {
        await this.opts.onReply(
          userId,
          message.contextToken,
          `⚠️ Agent session error: ${errorMessage(err)}`,
          message.replyGeneration,
        );
      } catch (replyErr) {
        this.opts.log(`[${userId}] Failed to send session error: ${String(replyErr)}`);
      }
      throw err;
    }
    if (!this.isUserGenerationCurrent(userId, generation)) {
      throw new SessionResetError();
    }
    if (this.sessions.get(userId) !== session) {
      throw session.closedError ??
        new Error("Agent session ended before the message could be queued");
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

    function errorMessage(err: unknown): string {
      if (err instanceof Error) return err.message;
      if (
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        typeof err.message === "string"
      ) {
        return err.message;
      }
      return String(err);
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

  getSessionConfigOptions(userId: string): acp.SessionConfigOption[] | undefined {
    return this.sessions.get(userId)?.configOptions;
  }

  getRuntimeBridgeSettings(userId: string): RuntimeBridgeSettings | undefined {
    const session = this.sessions.get(userId);
    if (!session) return undefined;
    return { ...this.getOrCreateRuntimeBridgeSettings(session) };
  }

  setRuntimeBridgeSetting(
    userId: string,
    setting: RuntimeBridgeSetting,
    value: boolean,
  ): RuntimeBridgeSettings {
    const session = this.sessions.get(userId);
    if (!session) {
      throw new Error("No active ACP session for this chat yet. Send a normal message first.");
    }

    session.lastActivity = Date.now();
    const settings = this.getOrCreateRuntimeBridgeSettings(session);
    settings[setting] = value;
    return { ...settings };
  }

  async setSessionConfigOption(
    userId: string,
    configId: string,
    value: string | boolean,
  ): Promise<acp.SessionConfigOption[]> {
    const session = this.sessions.get(userId);
    if (!session) {
      throw new Error("No active ACP session for this chat yet. Send a normal message first.");
    }

    session.lastActivity = Date.now();
    const response = await session.agentInfo.connection.setSessionConfigOption(
      typeof value === "boolean"
        ? { sessionId: session.agentInfo.sessionId, configId, type: "boolean", value }
        : { sessionId: session.agentInfo.sessionId, configId, value },
    );
    session.configOptions = response.configOptions;
    session.agentInfo.configOptions = response.configOptions;
    return response.configOptions;
  }

  /**
   * Cancel the in-flight ACP prompt turn for a user, optionally also dropping
   * any messages that were queued behind it.
   *
   * The ACP `session/cancel` notification is fire-and-forget; the in-flight
   * `prompt()` call will resolve naturally with `stopReason: "cancelled"` and
   * the existing `processQueue` loop will flush whatever output was already
   * streamed back to WeChat (with a `[cancelled]` suffix).
   */
  async cancelCurrent(
    userId: string,
    opts?: { drainQueue?: boolean },
  ): Promise<{ cancelledTurn: boolean; droppedQueueCount: number }> {
    const session = this.sessions.get(userId);
    if (!session) {
      return { cancelledTurn: false, droppedQueueCount: 0 };
    }

    session.lastActivity = Date.now();

    let droppedQueueCount = 0;
    if (opts?.drainQueue && session.queue.length > 0) {
      const dropped = session.queue.splice(0);
      droppedQueueCount = dropped.length;
      const err = new Error("Cancelled before queued message was processed");
      for (const pending of dropped) {
        pending.completion?.reject(err);
      }
    }

    if (!session.processing) {
      return { cancelledTurn: false, droppedQueueCount };
    }

    try {
      await session.agentInfo.connection.cancel({ sessionId: session.agentInfo.sessionId });
    } catch (err) {
      this.opts.log(`[${userId}] cancel notification failed: ${String(err)}`);
    }

    return { cancelledTurn: true, droppedQueueCount };
  }

  resetSession(userId: string): Promise<ResetSessionResult> {
    this.userGenerations.set(
      userId,
      (this.userGenerations.get(userId) ?? 0) + 1,
    );
    const existingReset = this.resetOperations.get(userId);
    if (existingReset) return existingReset;

    const pending = this.pendingSessions.get(userId);
    if (pending) {
      pending.cancelled = true;
      pending.abortController.abort();
    }

    const reset = this.withUserLifecycle(userId, async () => {
      if (this.aborted) {
        throw new Error("Session manager is stopped");
      }

      const activeSession = this.sessions.get(userId);
      const sessions = new Set([
        ...(activeSession ? [activeSession] : []),
        ...(this.exitedSessions.get(userId) ?? []),
      ]);
      const resetError = new SessionResetError();
      let droppedQueueCount = 0;
      let cancelledTurn = false;

      for (const session of sessions) {
        session.closedError = resetError;
        session.drainingExitedTurn = false;
        cancelledTurn ||= session.processing;
        droppedQueueCount += session.queue.length;
        this.rejectSessionCompletions(session, resetError);
        session.cleanupRegistered = true;
        this.registerSessionCleanup(session, true);
      }
      this.sessions.delete(userId);
      this.exitedSessions.delete(userId);

      if (this.opts.removePersistedSessionId) {
        this.getOrCreateCleanupState(userId).removePersistedSessionId = true;
      }

      await this.retryCleanupState(userId);

      return {
        hadActiveSession: sessions.size > 0,
        cancelledTurn,
        cancelledPendingCreation: pending !== undefined,
        droppedQueueCount,
      };
    });
    this.resetOperations.set(userId, reset);
    void reset.finally(() => {
      if (this.resetOperations.get(userId) === reset) {
        this.resetOperations.delete(userId);
      }
    }).catch(() => {});
    return reset;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  private getOrCreateSession(
    userId: string,
    contextToken: string,
    isCurrent: () => boolean = () => true,
    lifecycleGeneration = this.userGenerations.get(userId) ?? 0,
    replyGeneration?: number,
  ): Promise<UserSession> {
    if (!isCurrent()) {
      return Promise.reject(new SessionResetError());
    }
    const existing = this.sessions.get(userId);
    if (existing) return Promise.resolve(existing);
    const pending = this.pendingSessions.get(userId);
    if (pending) return pending.promise;
    const cleanupOperation = this.cleanupOperations.get(userId);
    if (cleanupOperation) {
      return cleanupOperation.then(() => {
        if (!isCurrent()) throw new SessionResetError();
        return this.getOrCreateSession(
          userId,
          contextToken,
          isCurrent,
          lifecycleGeneration,
          replyGeneration,
        );
      });
    }
    if (this.cleanupStates.has(userId)) {
      return Promise.reject(
        new Error(
          "Previous ACP session cleanup is incomplete. Run /acp-new again before sending another message.",
        ),
      );
    }
    if (
      !this.hasSessionCapacity(userId)
    ) {
      const eviction = this.evictOldest();
      if (eviction) {
        return eviction.then(
          () => {
            if (!isCurrent()) throw new SessionResetError();
            return this.getOrCreateSession(
              userId,
              contextToken,
              isCurrent,
              lifecycleGeneration,
              replyGeneration,
            );
          },
          (err) => {
            if (
              !this.hasSessionCapacity(userId)
            ) {
              throw err;
            }
            if (!isCurrent()) throw new SessionResetError();
            return this.getOrCreateSession(
              userId,
              contextToken,
              isCurrent,
              lifecycleGeneration,
              replyGeneration,
            );
          },
        );
      }
    }
    if (
      !this.hasSessionCapacity(userId)
    ) {
      return Promise.reject(
        new Error(
          `Maximum concurrent sessions reached (${this.opts.maxConcurrentUsers})`,
        ),
      );
    }

    const abortController = new AbortController();
    let entry!: PendingSessionCreation;
    const creation = Promise.resolve().then(async () => {
      if (this.aborted) {
        throw new Error("Session manager is stopped");
      }
      if (entry.cancelled) {
        throw new SessionResetError();
      }
      if (!isCurrent()) {
        throw new SessionResetError();
      }
      const existingAfterWait = this.sessions.get(userId);
      if (existingAfterWait) return existingAfterWait;

      let created: UserSession;
      try {
        created = await this.createSession(
          userId,
          contextToken,
          abortController.signal,
          replyGeneration,
        );
      } catch (err) {
        if (
          err instanceof SessionCreationCleanupError ||
          err instanceof AgentProcessCleanupError
        ) {
          this.registerCreationCleanupFailure(userId, err);
        }
        if (entry.cancelled) {
          throw new SessionResetError();
        }
        throw err;
      }
      created.lifecycleGeneration = lifecycleGeneration;
      if (this.aborted) {
        this.registerSessionCleanup(created, true);
        throw new Error("Session manager stopped while creating a session");
      }
      if (entry.cancelled) {
        this.registerSessionCleanup(created, true);
        try {
          await this.retryCleanupState(userId);
        } catch (err) {
          this.opts.log(
            `[${userId}] Cancelled session creation cleanup will be retried by reset: ${String(err)}`,
          );
        }
        throw new SessionResetError();
      }

      const winner = this.sessions.get(userId);
      if (winner) {
        this.registerSessionCleanup(created, true);
        await this.retryCleanupState(userId);
        return winner;
      }
      this.invalidateExitedSessions(userId);
      this.sessions.set(userId, created);
      if (
        created.agentInfo.process.exitCode !== null ||
        created.agentInfo.process.signalCode !== null
      ) {
        this.handleAgentExit(userId, created.agentInfo.process);
        throw created.closedError ??
          new Error("Agent process exited while creating the session");
      }
      return created;
    });
    entry = {
      promise: creation,
      abortController,
      cancelled: false,
    };
    this.pendingSessions.set(userId, entry);
    void creation.finally(() => {
      if (this.pendingSessions.get(userId) === entry) {
        this.pendingSessions.delete(userId);
      }
    }).catch(() => {});
    return creation;
  }

  private withUserLifecycle<T>(
    userId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.userLifecycleChains.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.userLifecycleChains.set(userId, settled);
    void settled.finally(() => {
      if (this.userLifecycleChains.get(userId) === settled) {
        this.userLifecycleChains.delete(userId);
      }
    });
    return run;
  }

  private getOrCreateCleanupState(userId: string): SessionCleanupState {
    const existing = this.cleanupStates.get(userId);
    if (existing) return existing;
    const state: SessionCleanupState = {
      processes: new Set(),
      mcpLeases: new Set(),
      removePersistedSessionId: false,
    };
    this.cleanupStates.set(userId, state);
    return state;
  }

  private registerCreationCleanupFailure(
    userId: string,
    err: SessionCreationCleanupError | AgentProcessCleanupError,
  ): void {
    const state = this.getOrCreateCleanupState(userId);
    if (err instanceof AgentProcessCleanupError) {
      state.processes.add(err.process);
      return;
    }
    if (err.mcpLease) {
      state.mcpLeases.add(err.mcpLease);
    }
    if (err.creationError instanceof AgentProcessCleanupError) {
      state.processes.add(err.creationError.process);
    }
  }

  private registerSessionCleanup(
    session: UserSession,
    includeProcess: boolean,
  ): void {
    const agentProcess = session.agentInfo.process;
    const processCanBeCleaned =
      (agentProcess.exitCode === null && agentProcess.signalCode === null) ||
      agentProcess.pid !== undefined;
    if (!session.mcpLease && (!includeProcess || !processCanBeCleaned)) return;
    const state = this.getOrCreateCleanupState(session.userId);
    if (includeProcess && processCanBeCleaned) {
      state.processes.add(agentProcess);
    }
    if (session.mcpLease) {
      state.mcpLeases.add(session.mcpLease);
    }
  }

  private retryCleanupInBackground(userId: string, source: string): void {
    void this.retryCleanupState(userId).catch((err) => {
      this.opts.log(
        `[${userId}] ${source} cleanup failed and was retained for retry: ${String(err)}`,
      );
      trackException(err, "session.cleanup", hashUserId(userId));
    });
  }

  private retryCleanupState(userId: string): Promise<void> {
    const existing = this.cleanupOperations.get(userId);
    if (existing) return existing;
    const operation = this.runCleanupState(userId);
    this.cleanupOperations.set(userId, operation);
    void operation.finally(() => {
      if (this.cleanupOperations.get(userId) === operation) {
        this.cleanupOperations.delete(userId);
      }
    }).catch(() => {});
    return operation;
  }

  private async runCleanupState(userId: string): Promise<void> {
    while (true) {
      const state = this.cleanupStates.get(userId);
      if (!state) return;

      const operations: Array<{
        run: () => Promise<void>;
        complete: () => void;
      }> = [];
      for (const process of state.processes) {
        operations.push({
          run: () =>
            (this.opts.killAgentProcess ?? killAgentAndWait)(
              process,
              this.opts.agentShutdownTimeoutMs,
            ),
          complete: () => {
            state.processes.delete(process);
          },
        });
      }
      for (const lease of state.mcpLeases) {
        operations.push({
          run: () => lease.close(),
          complete: () => {
            state.mcpLeases.delete(lease);
          },
        });
      }
      if (
        state.removePersistedSessionId &&
        this.opts.removePersistedSessionId
      ) {
        operations.push({
          run: () => this.opts.removePersistedSessionId!(userId),
          complete: () => {
            state.removePersistedSessionId = false;
          },
        });
      }

      const results = await Promise.allSettled(
        operations.map(({ run }) => Promise.resolve().then(run)),
      );
      const failures: unknown[] = [];
      for (let index = 0; index < results.length; index++) {
        const result = results[index]!;
        if (result.status === "fulfilled") {
          operations[index]!.complete();
        } else {
          failures.push(result.reason);
        }
      }

      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Failed to fully reset ACP session",
        );
      }
      if (
        state.processes.size === 0 &&
        state.mcpLeases.size === 0 &&
        !state.removePersistedSessionId
      ) {
        if (this.cleanupStates.get(userId) === state) {
          this.cleanupStates.delete(userId);
        }
        return;
      }
    }
  }

  private reservedSessionCount(): number {
    const cleanupUsersWithLiveResources = [...this.cleanupStates]
      .filter(
        ([, state]) =>
          state.processes.size > 0 || state.mcpLeases.size > 0,
      )
      .map(([userId]) => userId);
    return new Set([
      ...this.sessions.keys(),
      ...this.exitedSessions.keys(),
      ...this.pendingSessions.keys(),
      ...cleanupUsersWithLiveResources,
    ]).size;
  }

  private hasSessionCapacity(userId: string): boolean {
    if (this.exitedSessions.has(userId)) return true;
    return this.reservedSessionCount() < this.opts.maxConcurrentUsers;
  }

  private async createSession(
    userId: string,
    contextToken: string,
    signal: AbortSignal,
    replyGeneration?: number,
  ): Promise<UserSession> {
    this.opts.log(`Creating new session for ${userId}`);

    let sessionRef: UserSession | undefined;
    const isSessionCurrent = () =>
      sessionRef === undefined || this.isCurrentSession(sessionRef);
    const client = new WeChatAcpClient({
      sendTyping: () =>
        this.opts.sendTyping(
          userId,
          contextToken,
          replyGeneration,
          isSessionCurrent,
        ),
      onThoughtFlush: (text) =>
        this.opts.onReply(
          userId,
          contextToken,
          text,
          replyGeneration,
          isSessionCurrent,
        ),
      onMessageFlush: (text) =>
        this.opts.onReply(
          userId,
          contextToken,
          text,
          replyGeneration,
          isSessionCurrent,
        ),
      ...(this.opts.onReplyImage
        ? {
            onImageFlush: (image: AgentImage) =>
              this.opts.onReplyImage!(
                userId,
                contextToken,
                image,
                replyGeneration,
                isSessionCurrent,
              ),
          }
        : {}),
      ...(this.opts.onReplyAudio
        ? {
            onAudioFlush: (audio: AgentAudio) =>
              this.opts.onReplyAudio!(
                userId,
                contextToken,
                audio,
                replyGeneration,
                isSessionCurrent,
              ),
          }
        : {}),
      ...(this.opts.onReplyFile
        ? {
            onFileFlush: (file: AgentFile) =>
              this.opts.onReplyFile!(
                userId,
                contextToken,
                file,
                replyGeneration,
                isSessionCurrent,
              ),
          }
        : {}),
      resolveResourceLink: this.opts.resolveResourceLink,
      onConfigOptionsUpdate: (configOptions) => {
        const session = this.sessions.get(userId);
        if (!session || session.client !== client) return;
        session.configOptions = configOptions;
        session.agentInfo.configOptions = configOptions;
      },
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      showThoughts: this.opts.showThoughts,
      showDiffs: this.opts.showDiffs ?? false,
      showImages: this.opts.showImages ?? true,
      showAudio: this.opts.showAudio ?? true,
      showResources: this.opts.showResources ?? true,
      resourceInlineLimit: this.opts.resourceInlineLimit,
    });

    const mcpLease = this.opts.createMcpLease?.();
    let agentInfo: AgentProcessInfo;
    try {
      const resumePolicy = this.opts.resumePolicy ?? "off";
      const persistedSessionId =
        resumePolicy === "off"
          ? undefined
          : await this.opts.getPersistedSessionId?.(userId);
      agentInfo = await spawnAgent({
        command: this.opts.agentCommand,
        args: this.opts.agentArgs,
        cwd: this.opts.agentCwd,
        env: this.opts.agentEnv,
        client,
        mcpServers: mcpLease ? [mcpLease.mcpServer] : [],
        resumePolicy,
        persistedSessionId,
        signal,
        log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      });
    } catch (err) {
      try {
        await mcpLease?.close();
      } catch (cleanupErr) {
        throw new SessionCreationCleanupError(err, cleanupErr, mcpLease);
      }
      throw err;
    }

    if (agentInfo.sessionOutcome === "not_found") {
      try {
        await this.opts.removePersistedSessionId?.(userId);
      } catch (err) {
        this.opts.log(`[${userId}] Failed to remove invalid persisted session: ${String(err)}`);
        trackException(err, "session.persistence", hashUserId(userId));
      }
    }

    trackEvent(
      "session.created",
      {
        userIdHash: hashUserId(userId),
        agentPreset: this.opts.agentPreset ?? "raw",
        activeSessions: this.sessions.size + 1,
        sessionOutcome: agentInfo.sessionOutcome,
      },
      hashUserId(userId),
    );

    // If agent process exits, clean up the session
    agentInfo.process.on("exit", () => {
      this.handleAgentExit(userId, agentInfo.process);
    });

    sessionRef = {
      userId,
      contextToken,
      client,
      agentInfo,
      mcpLease,
      configOptions: agentInfo.configOptions,
      queue: [],
      processing: false,
      sessionIdPersisted: agentInfo.sessionOutcome === "loaded",
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    return sessionRef;
  }

  private handleAgentExit(userId: string, agentProcess: ChildProcess): void {
    const session = this.sessions.get(userId);
    if (!session || session.agentInfo.process !== agentProcess) return;

    this.opts.log(`Agent process for ${userId} exited, removing session`);
    session.processExitedError = new Error(
      "Agent process exited before queued message was processed",
    );
    this.rejectQueuedCompletions(session, session.processExitedError);
    this.sessions.delete(userId);
    this.trackExitedSession(session);
    if (session.promptDispatched) {
      session.drainingExitedTurn = true;
      return;
    }
    void this.finalizeExitedSession(session);
  }

  private async processQueue(session: UserSession): Promise<void> {
    try {
      while (session.queue.length > 0 && !this.aborted) {
        const pending = session.queue.shift()!;
        session.activeMessage = pending;
        let completionError: unknown;
        const promptStartedAt = Date.now();
        const isSessionCurrent = () => this.isCurrentSession(session);

        try {
          // Keep the ACP client instance stable because the connection is bound
          // to it. beginTurn runs on the client's notification queue: every task
          // from the previous turn (including ones left queued when a failed
          // prompt() rejected early) delivers with its own turn's callbacks
          // before the swap, and residual undelivered buffers are discarded at
          // the boundary instead of leaking into this turn (issue 54).
          const outputSettings = { ...this.getOrCreateRuntimeBridgeSettings(session) };
          const beginTurn = session.client.beginTurn({
            sendTyping: () =>
              this.runIfCurrent(session, () =>
                this.opts.sendTyping(
                  session.userId,
                  pending.contextToken,
                  pending.replyGeneration,
                  isSessionCurrent,
                ),
              ),
            onThoughtFlush: (text) =>
              this.runIfCurrent(session, () =>
                this.opts.onReply(
                  session.userId,
                  pending.contextToken,
                  text,
                  pending.replyGeneration,
                  isSessionCurrent,
                ),
              ),
            onMessageFlush: (text) =>
              this.runIfCurrent(session, () =>
                this.opts.onReply(
                  session.userId,
                  pending.contextToken,
                  text,
                  pending.replyGeneration,
                  isSessionCurrent,
                ),
              ),
            ...(this.opts.onReplyImage
              ? {
                  onImageFlush: (image: AgentImage) =>
                    this.runIfCurrent(session, () =>
                      this.opts.onReplyImage!(
                        session.userId,
                        pending.contextToken,
                        image,
                        pending.replyGeneration,
                        isSessionCurrent,
                      ),
                    ),
                }
              : {}),
            ...(this.opts.onReplyAudio
              ? {
                  onAudioFlush: (audio: AgentAudio) =>
                    this.runIfCurrent(session, () =>
                      this.opts.onReplyAudio!(
                        session.userId,
                        pending.contextToken,
                        audio,
                        pending.replyGeneration,
                        isSessionCurrent,
                      ),
                    ),
                }
              : {}),
            ...(this.opts.onReplyFile
              ? {
                  onFileFlush: (file: AgentFile) =>
                    this.runIfCurrent(session, () =>
                      this.opts.onReplyFile!(
                        session.userId,
                        pending.contextToken,
                        file,
                        pending.replyGeneration,
                        isSessionCurrent,
                      ),
                    ),
                }
              : {}),
          }, {
            showThoughts: outputSettings.thoughts,
            showDiffs: outputSettings.diffs,
            showImages: outputSettings.images,
            showAudio: outputSettings.audio,
            showResources: outputSettings.resources,
          });
          await this.awaitAgentOperation(
            session,
            beginTurn,
            "turn setup",
          );

          if (!this.isCurrentSession(session)) {
            completionError = session.closedError ?? new SessionResetError();
            continue;
          }

          // Send typing immediately so user knows the prompt was received
          this.runIfCurrent(session, () =>
            this.opts.sendTyping(
              session.userId,
              pending.contextToken,
              pending.replyGeneration,
              isSessionCurrent,
            ),
          ).catch(() => {});

          // Send ACP prompt
          this.opts.log(`[${session.userId}] Sending prompt to agent...`);
          session.promptDispatched = true;
          const result = await this.awaitAgentOperation(
            session,
            session.agentInfo.connection.prompt({
              sessionId: session.agentInfo.sessionId,
              prompt: pending.prompt,
            }),
            "prompt response",
          );
          if (!this.isCurrentSession(session)) {
            completionError = session.closedError ?? new SessionResetError();
            continue;
          }
          await this.persistSessionId(session);

          // Collect accumulated text
          let replyText = await session.client.flush();
          if (!this.isCurrentSession(session)) {
            completionError = session.closedError ?? new SessionResetError();
            continue;
          }

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
            await this.opts.onReply(
              session.userId,
              pending.contextToken,
              replyText,
              pending.replyGeneration,
              isSessionCurrent,
            );
          } else if (!session.client.hasProducedMessage) {
            // The turn ended without the agent ever producing a textual reply
            // (e.g. it stopped after thoughts or a tool call). Surface a minimal
            // notice so a turn never ends with zero user-facing output.
            this.opts.log(
              `[${session.userId}] Empty reply with no message produced (${result.stopReason}); sending fallback notice`,
            );
            await this.opts.onReply(
              session.userId,
              pending.contextToken,
              emptyTurnNotice(result.stopReason),
              pending.replyGeneration,
              isSessionCurrent,
            );
          }

          if (!this.isCurrentSession(session)) {
            completionError = session.closedError ?? new SessionResetError();
            continue;
          }

          if (this.opts.turnEndMessage?.trim()) {
            try {
              await this.opts.onReply(
                session.userId,
                pending.contextToken,
                this.opts.turnEndMessage,
                pending.replyGeneration,
                isSessionCurrent,
              );
            } catch (err) {
              this.opts.log(
                `[${session.userId}] Failed to send turn end message: ${String(err)}`,
              );
              trackException(err, "reply.turn_end", hashUserId(session.userId));
            }
          }
        } catch (err) {
          completionError = err;
          if (!this.isCurrentSession(session)) {
            return;
          }
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
          if (
            session.agentInfo.process.killed ||
            session.agentInfo.process.exitCode !== null ||
            session.processExitedError !== undefined ||
            err instanceof AgentConnectionClosedError
          ) {
            this.opts.log(`[${session.userId}] Agent process died, removing session`);
            session.closedError =
              err instanceof Error ? err : new Error(String(err));
            this.rejectSessionCompletions(session, err);
            if (this.sessions.get(session.userId) === session) {
              this.sessions.delete(session.userId);
            }
            await this.finalizeExitedSession(session);
            return;
          }

          // Send error message to user
          try {
            await this.opts.onReply(
              session.userId,
              pending.contextToken,
              `⚠️ Agent error: ${String(err)}`,
              pending.replyGeneration,
              isSessionCurrent,
            );
          } catch {
            // best effort
          }
        } finally {
          session.promptDispatched = false;
          if (pending.completion) {
            const finalError = session.closedError ?? completionError;
            if (finalError) {
              pending.completion.reject(finalError);
            } else {
              pending.completion.resolve();
            }
          }
          if (session.activeMessage === pending) {
            session.activeMessage = undefined;
          }
        }
      }
    } finally {
      session.processing = false;
      if (session.processExitedError) {
        await this.finalizeExitedSession(session);
      }
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
        session.closedError = new Error(
          "Session expired before queued message was processed",
        );
        this.rejectSessionCompletions(session, session.closedError);
        this.registerSessionCleanup(session, true);
        this.sessions.delete(userId);
        this.retryCleanupInBackground(userId, "Idle session");
      }
    }
  }

  private evictOldest(): Promise<void> | undefined {
    let oldest: { userId: string; lastActivity: number } | null = null;
    for (const [userId, session] of this.sessions) {
      if (
        !session.processing &&
        !this.pendingSessions.has(userId) &&
        (!oldest || session.lastActivity < oldest.lastActivity)
      ) {
        oldest = { userId, lastActivity: session.lastActivity };
      }
    }
    if (oldest) {
      this.opts.log(`Evicting oldest idle session: ${oldest.userId}`);
      const session = this.sessions.get(oldest.userId);
      if (session) {
        session.closedError = new Error(
          "Session evicted before queued message was processed",
        );
        this.rejectSessionCompletions(session, session.closedError);
        this.registerSessionCleanup(session, true);
        this.sessions.delete(oldest.userId);
        return this.retryCleanupState(oldest.userId);
      }
    }
    return undefined;
  }

  private rejectSessionCompletions(session: UserSession, err: unknown): void {
    if (session.activeMessage?.completion) {
      session.activeMessage.completion.reject(err);
      session.activeMessage.completion = undefined;
    }
    this.rejectQueuedCompletions(session, err);
  }

  private rejectQueuedCompletions(session: UserSession, err: unknown): void {
    for (const pending of session.queue.splice(0)) {
      pending.completion?.reject(err);
    }
  }

  private isCurrentSession(session: UserSession): boolean {
    if (this.aborted) return false;
    if (
      session.lifecycleGeneration !== undefined &&
      !this.isUserGenerationCurrent(
        session.userId,
        session.lifecycleGeneration,
      )
    ) {
      return false;
    }
    const current = this.sessions.get(session.userId);
    return (
      current === session ||
      (
        current === undefined &&
        session.drainingExitedTurn === true &&
        session.closedError === undefined
      )
    );
  }

  private async awaitAgentOperation<T>(
    session: UserSession,
    operation: Promise<T>,
    operationName: string,
  ): Promise<T> {
    const process = session.agentInfo.process;
    let onExit: (() => void) | undefined;
    const processExited =
      process.exitCode !== null || process.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            onExit = resolve;
            process.once("exit", onExit);
          });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exitTimeout = processExited.then(
      () =>
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `${operationName} did not finish within ${AGENT_EXIT_DRAIN_TIMEOUT_MS}ms after agent process exit`,
                ),
              ),
            AGENT_EXIT_DRAIN_TIMEOUT_MS,
          );
        }),
    );
    session.connectionClosedError ??=
      session.agentInfo.connection.closed.then(() => {
        throw new AgentConnectionClosedError();
      });

    try {
      return await Promise.race([
        operation,
        session.connectionClosedError,
        exitTimeout,
      ]);
    } finally {
      if (onExit) process.off("exit", onExit);
      if (timeout) clearTimeout(timeout);
    }
  }

  private finalizeExitedSession(session: UserSession): Promise<void> {
    if (session.exitCleanup) return session.exitCleanup;
    if (session.cleanupRegistered) {
      session.drainingExitedTurn = false;
      this.untrackExitedSession(session);
      return Promise.resolve();
    }
    session.drainingExitedTurn = false;
    const error =
      session.closedError ??
      session.processExitedError ??
      new Error("Agent process exited");
    session.closedError = error;
    this.rejectSessionCompletions(session, error);
    this.registerSessionCleanup(session, true);
    session.exitCleanup = this.retryCleanupState(session.userId).catch((err) => {
      this.opts.log(
        `[${session.userId}] Agent exit cleanup failed and was retained for retry: ${String(err)}`,
      );
      trackException(err, "session.cleanup", hashUserId(session.userId));
    }).finally(() => {
      this.untrackExitedSession(session);
    });
    return session.exitCleanup;
  }

  private trackExitedSession(session: UserSession): void {
    const sessions =
      this.exitedSessions.get(session.userId) ?? new Set<UserSession>();
    sessions.add(session);
    this.exitedSessions.set(session.userId, sessions);
  }

  private invalidateExitedSessions(userId: string): void {
    for (const session of this.exitedSessions.get(userId) ?? []) {
      if (!session.drainingExitedTurn) continue;
      session.closedError = new Error(
        "Agent session was replaced before its response was delivered",
      );
      session.drainingExitedTurn = false;
      this.rejectSessionCompletions(session, session.closedError);
      void this.finalizeExitedSession(session);
    }
  }

  private untrackExitedSession(session: UserSession): void {
    const sessions = this.exitedSessions.get(session.userId);
    if (!sessions) return;
    sessions.delete(session);
    if (sessions.size === 0) {
      this.exitedSessions.delete(session.userId);
    }
  }

  private isUserGenerationCurrent(
    userId: string,
    generation: number,
  ): boolean {
    return (this.userGenerations.get(userId) ?? 0) === generation;
  }

  private runIfCurrent(
    session: UserSession,
    task: () => Promise<void>,
  ): Promise<void> {
    return this.isCurrentSession(session) ? task() : Promise.resolve();
  }

  private async persistSessionId(session: UserSession): Promise<void> {
    if (
      session.sessionIdPersisted ||
      !this.opts.persistSessionId ||
      session.processExitedError !== undefined ||
      !this.isCurrentSession(session)
    ) {
      return;
    }
    try {
      await this.opts.persistSessionId(session.userId, session.agentInfo.sessionId);
      session.sessionIdPersisted = true;
      this.opts.log(`[${session.userId}] Persisted ACP session ${session.agentInfo.sessionId}`);
    } catch (err) {
      this.opts.log(`[${session.userId}] Failed to persist ACP session: ${String(err)}`);
      trackException(err, "session.persistence", hashUserId(session.userId));
    }
  }

  private getOrCreateRuntimeBridgeSettings(
    session: UserSession,
  ): RuntimeBridgeSettings {
    let settings = this.runtimeBridgeSettings.get(session);
    if (!settings) {
      settings = {
        thoughts: this.opts.showThoughts,
        diffs: this.opts.showDiffs ?? false,
        images: this.opts.showImages ?? true,
        audio: this.opts.showAudio ?? true,
        resources: this.opts.showResources ?? true,
      };
      this.runtimeBridgeSettings.set(session, settings);
    }
    return settings;
  }
}
