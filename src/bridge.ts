/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import type * as acp from "@agentclientprotocol/sdk";
import crypto from "node:crypto";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, uploadImageMedia, sendImageItem, uploadFileMedia, sendFileItem, splitText, TEXT_CHUNK_LIMIT } from "./weixin/send.js";
import type { UploadedImageMedia, UploadedFileMedia } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import {
  SessionManager,
  type ResetSessionResult,
  type RuntimeBridgeSetting,
} from "./acp/session.js";
import { AUDIO_MIME_EXTENSIONS } from "./acp/client.js";
import type { AgentImage, AgentAudio, AgentFile } from "./acp/client.js";
import {
  startArtifactMcpServer,
  type ArtifactMcpServer,
} from "./artifacts/server.js";
import { sanitizeFileName } from "./artifacts/store.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import type { WeChatAcpConfig } from "./config.js";
import {
  BRIDGE_COMMANDS,
  buildAgentSessionScope,
  matchBridgeCommand,
  resolveCommandAliases,
} from "./config.js";
import { drainPendingText, PendingTextRegistry } from "./pending-text.js";
import { InjectionMonitor } from "./inject/monitor.js";
import type { InjectedMessage } from "./inject/types.js";
import {
  getPersistedSessionId,
  removePersistedSession,
  resolveUserTarget,
  updateLastActiveUser,
  updatePersistedSession,
} from "./storage/state.js";
import { trackEvent, trackException, hashUserId } from "./telemetry/index.js";

const ACP_CONFIG_COMMAND = BRIDGE_COMMANDS.acpConfig;
const ACP_CANCEL_COMMAND = BRIDGE_COMMANDS.acpCancel;
const ACP_NEW_COMMAND = BRIDGE_COMMANDS.acpNew;
const ACP_MORE_COMMAND = BRIDGE_COMMANDS.acpMore;
const BUFFER_START_COMMAND = BRIDGE_COMMANDS.promptStart;
const BUFFER_DONE_COMMAND = BRIDGE_COMMANDS.promptDone;
const BUFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BUFFER_MAX_BLOCKS = 50;
const PENDING_TEXT_TTL_MS = 10 * 60 * 1000;
const PENDING_TEXT_MAX_SEGMENTS = 50;
const SEGMENT_SEND_MAX_ATTEMPTS = 3;
const SEGMENT_SEND_RETRY_BASE_MS = 300;
const RUNTIME_BRIDGE_CONFIG_OPTIONS: ReadonlyArray<{
  id: string;
  setting: RuntimeBridgeSetting;
  name: string;
}> = [
  { id: "bridge.thoughts", setting: "thoughts", name: "Thoughts" },
  { id: "bridge.diffs", setting: "diffs", name: "Diffs" },
  { id: "bridge.images", setting: "images", name: "Tool Images" },
  { id: "bridge.audio", setting: "audio", name: "Audio" },
  { id: "bridge.resources", setting: "resources", name: "Tool Resources" },
];

interface MessageBuffer {
  blocks: acp.ContentBlock[];
  contextToken: string;
  pending: Promise<void>;
  lastUpdatedAt: number;
  generation: number;
}

/**
 * Minimum spacing between two consecutive outbound text messages to the
 * same user. Each reply segment is an independent iLink API call with no
 * ordering hint, and WeChat appears to order back-to-back bot messages by
 * server-receive time. Without spacing, near-simultaneous sends can race
 * and be delivered to the user out of order (see issue #38). A short delay
 * separates their server-side timestamps and preserves order.
 */
const REPLY_SEND_SPACING_MS = 150;

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private artifactMcpServer: ArtifactMcpServer | null = null;
  private injectionMonitor: InjectionMonitor | null = null;
  private tokenData: TokenData | null = null;
  private stateUpdate = Promise.resolve();
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  private typingChains = new Map<string, Promise<void>>();
  // Timestamp (ms) at which the last text message was issued to each user,
  // used to pace consecutive sends so they don't race and arrive reordered.
  private lastSendAt = new Map<string, number>();
  // Per-user promise chain serializing replies so concurrent sendReply calls
  // (e.g. a command reply racing an active session flush) cannot interleave
  // their segments and arrive out of order (issue #38).
  private sendChains = new Map<string, Promise<void>>();
  private messageHandlingChains = new Map<string, Promise<void>>();
  private resetEpoch = 0;
  private userResetEpochs = new Map<string, number>();
  private pendingText: PendingTextRegistry;
  // Per-user message buffer for /acp-prompt-start.../acp-prompt-done multi-part compose
  private messageBuffers = new Map<string, MessageBuffer>();
  // Per-user expiry timers for buffer cleanup
  private bufferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Users currently flushing their buffer (between /done and enqueue).
  // Maps userId to a promise that resolves when the flush completes, so
  // messages arriving during the flush wait for the buffered prompt to
  // enqueue first, preserving turn order.
  private bufferFlushing = new Map<string, Promise<void>>();
  private log: (msg: string) => void;

  constructor(config: WeChatAcpConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-acp] ${msg}`));
    this.pendingText = new PendingTextRegistry({
      ttlMs: PENDING_TEXT_TTL_MS,
      maxUsers: Math.max(1, config.session.maxConcurrentUsers),
      maxSegmentsPerUser: PENDING_TEXT_MAX_SEGMENTS,
    });
  }

  async start(opts?: {
    forceLogin?: boolean;
    renderQrUrl?: (url: string) => void;
  }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    // 1. Login or load token
    if (!forceLogin) {
      this.tokenData = loadToken(this.config.storage.dir);
      if (this.tokenData) {
        trackEvent("token.reused");
      }
    }

    if (!this.tokenData) {
      const loginStart = Date.now();
      try {
        this.tokenData = await login({
          baseUrl: this.config.wechat.baseUrl,
          botType: this.config.wechat.botType,
          storageDir: this.config.storage.dir,
          log: this.log,
          renderQrUrl,
        });
        trackEvent("login.success", {
          forced: !!forceLogin,
          durationMs: Date.now() - loginStart,
        });
      } catch (err) {
        trackException(err, "auth");
        trackEvent("login.failure", {
          forced: !!forceLogin,
          durationMs: Date.now() - loginStart,
          errorType: err instanceof Error ? err.name : "Unknown",
        });
        throw err;
      }
    } else {
      this.log(`Loaded saved token (Bot: ${this.tokenData.accountId}, saved at ${this.tokenData.savedAt})`);
      this.log(`Use --login to force re-login`);
    }

    try {
      // 2. Start the local artifact MCP server and create SessionManager
      try {
        this.artifactMcpServer = await startArtifactMcpServer({
          rootDir: this.config.agent.cwd,
          log: this.log,
        });
      } catch (err) {
        this.log(`Artifact MCP unavailable; agent file attachments disabled: ${String(err)}`);
        trackException(err, "artifact_mcp");
      }
      const resumePolicy = this.config.session.resume ?? "off";
      if (resumePolicy !== "off" && !this.config.storage.stateFile) {
        throw new Error("Session resume requires storage.stateFile");
      }
      const sessionScope = buildAgentSessionScope(this.config.agent);
      const stateFile = this.config.storage.stateFile;
      this.sessionManager = new SessionManager({
        agentCommand: this.config.agent.command,
        agentArgs: this.config.agent.args,
        agentCwd: this.config.agent.cwd,
        agentEnv: this.config.agent.env,
        agentPreset: this.config.agent.preset ?? "raw",
        idleTimeoutMs: this.config.session.idleTimeoutMs,
        maxConcurrentUsers: this.config.session.maxConcurrentUsers,
        resumePolicy,
        getPersistedSessionId:
          resumePolicy !== "off" && stateFile
            ? async (userId) => {
                await this.stateUpdate.catch(() => {});
                return getPersistedSessionId(stateFile, userId, sessionScope);
              }
            : undefined,
        persistSessionId:
          resumePolicy !== "off" && stateFile
            ? (userId, sessionId) =>
                this.enqueueStateUpdate(() =>
                  updatePersistedSession(stateFile, userId, sessionScope, sessionId),
                )
            : undefined,
        removePersistedSessionId:
          stateFile
            ? (userId) =>
                this.enqueueStateUpdate(() =>
                  removePersistedSession(stateFile, userId, sessionScope),
                )
            : undefined,
        turnEndMessage: this.config.session.turnEndMessage,
        showThoughts: this.config.agent.showThoughts,
        showDiffs: this.config.agent.showDiffs ?? false,
        showImages: this.config.agent.showImages ?? true,
        showAudio: this.config.agent.showAudio ?? true,
        showResources: this.config.agent.showResources ?? true,
        resourceInlineLimit: this.config.agent.resourceInlineLimit,
        createMcpLease: this.artifactMcpServer
          ? () => this.artifactMcpServer!.createLease()
          : undefined,
        log: this.log,
        onReply: (
          userId,
          contextToken,
          text,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendAgentReply(
            userId,
            contextToken,
            text,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
        onReplyImage: (
          userId,
          contextToken,
          image,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendImageReply(
            userId,
            contextToken,
            image,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
        onReplyAudio: (
          userId,
          contextToken,
          audio,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendAudioReply(
            userId,
            contextToken,
            audio,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
        onReplyFile: (
          userId,
          contextToken,
          file,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendFileReply(
            userId,
            contextToken,
            file,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
        resolveResourceLink: this.artifactMcpServer
          ? (link) => this.artifactMcpServer!.resolveResourceLink(link)
          : undefined,
        sendTyping: (
          userId,
          contextToken,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendTypingIndicator(
            userId,
            contextToken,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
      });
      this.sessionManager.start();

      if (this.config.storage.injectDir && this.config.storage.stateFile) {
        this.injectionMonitor = new InjectionMonitor({
          injectDir: this.config.storage.injectDir,
          log: this.log,
          onMessage: (job) => this.enqueueInjectedMessage(job),
        });
        await this.injectionMonitor.start();
        this.log(`Injection queue: ${this.config.storage.injectDir}`);
      }

      // 3. Start monitor loop
      this.log("Starting message polling...");
      await startMonitor({
        baseUrl: this.tokenData.baseUrl,
        token: this.tokenData.token,
        storageDir: this.config.storage.dir,
        abortSignal: this.abortController.signal,
        log: this.log,
        onMessage: (msg) => {
          this.handleMessage(msg).catch((err) => {
            this.log(`Failed to handle message: ${String(err)}`);
            trackException(err, "message");
          });
        },
      });
    } catch (err) {
      try {
        await this.stop();
      } catch (cleanupErr) {
        throw new AggregateError(
          [err, cleanupErr],
          "Bridge startup failed and cleanup also failed",
        );
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    const cleanupErrors: unknown[] = [];
    try {
      await this.injectionMonitor?.stop();
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      await this.sessionManager?.stop();
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      await this.artifactMcpServer?.close();
    } catch (err) {
      cleanupErrors.push(err);
    } finally {
      this.artifactMcpServer = null;
    }
    await this.stateUpdate.catch((err) => {
      this.log(`Failed to flush state before stop: ${String(err)}`);
      trackException(sanitizeStateError(err), "state");
    });
    this.log("Bridge stopped");
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Bridge cleanup failed");
    }
  }

  async handleMessage(msg: WeixinMessage): Promise<void> {
    // Only process user messages (not bot's own messages)
    if (msg.message_type !== MessageType.USER) return;

    // Skip group messages (v1: direct only)
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    const acpNewCommand = this.extractAcpNewCommand(msg);
    if (acpNewCommand === ACP_NEW_COMMAND) {
      const generation = ++this.resetEpoch;
      this.userResetEpochs.set(userId, generation);
      return this.trackMessageHandling(
        userId,
        this.handleUserMessage(msg, userId, contextToken, generation),
      );
    }

    const generation = this.messageGenerationForUser(userId);
    const previous = this.messageHandlingChains.get(userId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => {
        if (!this.isMessageGenerationCurrent(userId, generation)) return;
        return this.handleUserMessage(msg, userId, contextToken, generation);
      });
    return this.trackMessageHandling(userId, current);
  }

  private async trackMessageHandling(
    userId: string,
    current: Promise<void>,
  ): Promise<void> {
    this.messageHandlingChains.set(userId, current);
    try {
      await current;
    } finally {
      if (this.messageHandlingChains.get(userId) === current) {
        this.messageHandlingChains.delete(userId);
      }
    }
  }

  private async handleUserMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);
    this.rememberActiveUser(userId, contextToken);

    trackEvent(
      "message.received",
      {
        userIdHash: hashUserId(userId),
        kind: this.messageKind(msg),
      },
      hashUserId(userId),
    );

    const acpNewCommand = this.extractAcpNewCommand(msg);
    if (acpNewCommand) {
      await this.handleAcpNewCommand(
        acpNewCommand,
        userId,
        contextToken,
        generation,
      );
      return;
    }

    const acpConfigCommand = this.extractAcpConfigCommand(msg);
    if (acpConfigCommand) {
      await this.handleAcpConfigCommand(
        acpConfigCommand,
        userId,
        contextToken,
        generation,
      );
      return;
    }

    const acpCancelCommand = this.extractAcpCancelCommand(msg);
    if (acpCancelCommand) {
      await this.handleAcpCancelCommand(
        acpCancelCommand,
        userId,
        contextToken,
        generation,
      );
      return;
    }

    if (this.extractBridgeCommand(msg, ACP_MORE_COMMAND)) {
      await this.handleAcpMoreCommand(userId, contextToken, generation);
      return;
    }

    // /acp-prompt-start — enter buffering mode
    if (this.isBufferStartCommand(msg)) {
      this.handleBufferStart(userId, contextToken, generation);
      return;
    }

    // /acp-prompt-done — flush buffer and send to agent
    if (this.isBufferDoneCommand(msg)) {
      await this.handleBufferDone(userId, contextToken, generation);
      return;
    }

    // If user is in buffering mode, append to buffer instead of enqueuing
    if (this.messageBuffers.has(userId)) {
      this.appendToBuffer(msg, userId, contextToken);
      return;
    }

    this.beginAgentPrompt(userId, contextToken);
    const waitForFlush = this.bufferFlushing.get(userId);
    await (waitForFlush
      ? waitForFlush.then(() =>
          this.enqueueMessage(
            msg,
            userId,
            contextToken,
            () => this.isMessageGenerationCurrent(userId, generation),
            generation,
          ),
        )
      : this.enqueueMessage(
          msg,
          userId,
          contextToken,
          () => this.isMessageGenerationCurrent(userId, generation),
          generation,
        ));
  }

  protected async enqueueMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
    isCurrent: () => boolean = () => true,
    replyGeneration?: number,
  ): Promise<void> {
    const prompt = await weixinMessageToPrompt(
      msg,
      this.config.wechat.cdnBaseUrl,
      this.log,
      this.config.storage.inboxDir,
    );

    if (!isCurrent()) return;
    await this.sessionManager!.enqueue(userId, {
      prompt,
      contextToken,
      replyGeneration,
    });
  }

  protected async resetUserSession(
    userId: string,
  ): Promise<ResetSessionResult> {
    if (!this.sessionManager) {
      throw new Error("Bridge is not ready yet.");
    }
    return this.sessionManager.resetSession(userId);
  }

  private async handleAcpNewCommand(
    command: string,
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    if (args.length > 1) {
      await this.sendReply(
        userId,
        contextToken,
        this.formatAcpNewUsage(`Unknown argument: ${args.slice(1).join(" ")}`),
      );
      return;
    }

    const buffer = this.messageBuffers.get(userId);
    const droppedBufferedBlockCount = buffer?.blocks.length ?? 0;
    this.messageBuffers.delete(userId);
    this.bufferFlushing.delete(userId);
    this.clearBufferTimer(userId);
    this.pendingText.clearExisting(userId);
    const typingCancellation = this.cancelTypingIndicator(
      userId,
      contextToken,
    ).catch((err) => {
      this.log(`Failed to cancel typing for ${userId}: ${String(err)}`);
    });

    try {
      const result = await this.resetUserSession(userId);
      await typingCancellation;
      if (!this.isMessageGenerationCurrent(userId, generation)) return;
      trackEvent(
        "command.acp_new",
        {
          userIdHash: hashUserId(userId),
          hadActiveSession: result.hadActiveSession,
          cancelledTurn: result.cancelledTurn,
          cancelledPendingCreation: result.cancelledPendingCreation,
          droppedQueueCount: result.droppedQueueCount,
          droppedBufferedBlockCount,
        },
        hashUserId(userId),
      );
      await this.sendReply(
        userId,
        contextToken,
        this.formatAcpNewResult(result, droppedBufferedBlockCount),
      );
    } catch (err) {
      await typingCancellation;
      this.log(`Failed to reset ACP session for ${userId}: ${String(err)}`);
      trackException(err, "session.reset", hashUserId(userId));
      if (!this.isMessageGenerationCurrent(userId, generation)) return;
      await this.sendReply(
        userId,
        contextToken,
        `⚠️ Could not fully clear the ACP session: ${describeError(err)}. Restarting now may restore the previous context.`,
      );
    }
  }

  private formatAcpNewResult(
    result: ResetSessionResult,
    droppedBufferedBlockCount: number,
  ): string {
    const lines = [
      "✅ ACP session cleared. Your next message will start a fresh session.",
    ];
    if (result.droppedQueueCount > 0) {
      lines.push(`Dropped ${result.droppedQueueCount} queued message(s).`);
    }
    if (droppedBufferedBlockCount > 0) {
      lines.push(
        `Dropped ${droppedBufferedBlockCount} buffered content block(s).`,
      );
    }
    return lines.join("\n");
  }

  private formatAcpNewUsage(error?: string): string {
    const lines: string[] = [];
    if (error) {
      lines.push(`⚠️ ${error}`, "");
    }
    lines.push(
      "💡 **Usage**",
      `   • Start a fresh session:  ${ACP_NEW_COMMAND}${this.aliasHint(ACP_NEW_COMMAND)}`,
    );
    return lines.join("\n");
  }

  private async enqueueInjectedMessage(job: InjectedMessage): Promise<void> {
    if (!this.sessionManager || !this.config.storage.stateFile) {
      throw new Error("Bridge is not ready to process injected messages");
    }

    const admittedResetEpoch = this.resetEpoch;
    const target = await this.resolveInjectedTarget(job);
    const generation = this.messageGenerationForUser(target.userId);
    if (generation > admittedResetEpoch) {
      throw new Error(
        `Injected message ${job.id} was discarded because the target ACP session was reset`,
      );
    }
    this.beginAgentPrompt(target.userId, target.contextToken);
    const prompt: acp.ContentBlock[] = [{ type: "text", text: job.text }];
    this.log(`[inject] enqueue ${job.id} for ${target.userId}`);
    trackEvent(
      "message.injected",
      {
        userIdHash: hashUserId(target.userId),
        targetKind: job.target === "last-active-user" ? "last-active-user" : "explicit",
      },
      hashUserId(target.userId),
    );
    await this.sessionManager.enqueueAndWait(target.userId, {
      prompt,
      contextToken: target.contextToken,
      replyGeneration: generation,
    });
  }

  protected resolveInjectedTarget(job: InjectedMessage): Promise<{
    userId: string;
    contextToken: string;
  }> {
    return resolveUserTarget(
      this.config.storage.stateFile!,
      job.target,
      job.contextToken,
    );
  }

  private async handleAcpConfigCommand(
    command: string,
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    if (args.length === 1) {
      const configOptions = this.sessionManager?.getSessionConfigOptions(userId);
      const runtimeSettings = this.sessionManager?.getRuntimeBridgeSettings(userId);
      trackEvent(
        "command.acp_config.view",
        {
          userIdHash: hashUserId(userId),
          hasSession: !!runtimeSettings,
          optionCount: runtimeSettings
            ? RUNTIME_BRIDGE_CONFIG_OPTIONS.length + (configOptions?.length ?? 0)
            : 0,
        },
        hashUserId(userId),
      );
      await this.sendReply(userId, contextToken, this.formatAcpConfigList(userId));
      return;
    }

    if (args[1] === "set") {
      if (args.length < 4) {
        await this.sendReply(userId, contextToken, this.formatAcpConfigUsage("Missing configId or value."));
        return;
      }

      const configId = args[2]!;
      const rawValue = args.slice(3).join(" ");
      try {
        const runtimeOption = RUNTIME_BRIDGE_CONFIG_OPTIONS.find(
          (option) => option.id === configId,
        );
        let displayValue: string;
        let optionType: string;
        if (runtimeOption) {
          if (!this.sessionManager?.getRuntimeBridgeSettings(userId)) {
            throw new Error(
              "No active ACP session for this chat yet. Send a normal message first.",
            );
          }
          const value = this.resolveBooleanConfigValue(configId, rawValue);
          this.sessionManager.setRuntimeBridgeSetting(
            userId,
            runtimeOption.setting,
            value,
          );
          displayValue = value ? "on" : "off";
          optionType = "boolean";
        } else {
          const resolved = this.resolveAcpConfigValue(userId, configId, rawValue);
          await this.sessionManager!.setSessionConfigOption(
            userId,
            configId,
            resolved.rawValue,
          );
          displayValue = resolved.displayValue;
          optionType = this.sessionManager!
            .getSessionConfigOptions(userId)
            ?.find((option) => option.id === configId)?.type ?? "unknown";
        }
        if (!this.isMessageGenerationCurrent(userId, generation)) return;
        trackEvent(
          "command.acp_config.set",
          {
            userIdHash: hashUserId(userId),
            configId,
            optionType,
            optionValue: displayValue,
          },
          hashUserId(userId),
        );
        await this.sendReply(
          userId,
          contextToken,
          `✅ Updated ACP config: ${configId} = ${displayValue}\n\n${this.formatAcpConfigList(userId)}`,
        );
      } catch (err) {
        if (!this.isMessageGenerationCurrent(userId, generation)) return;
        await this.sendReply(
          userId,
          contextToken,
          this.formatAcpConfigUsage(err instanceof Error ? err.message : String(err)),
        );
      }
      return;
    }

    await this.sendReply(
      userId,
      contextToken,
      this.formatAcpConfigUsage(`Unknown subcommand: ${args[1]}`),
    );
  }

  private async handleAcpCancelCommand(
    command: string,
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    const sub = args[1]?.toLowerCase();

    if (sub && sub !== "all") {
      await this.sendReply(userId, contextToken, this.formatAcpCancelUsage(`Unknown subcommand: ${args[1]}`));
      return;
    }

    if (!this.sessionManager) {
      await this.sendReply(userId, contextToken, this.formatAcpCancelUsage("Bridge is not ready yet."));
      return;
    }

    const drainQueue = sub === "all";
    const result = await this.sessionManager.cancelCurrent(userId, { drainQueue });
    if (!this.isMessageGenerationCurrent(userId, generation)) return;

    trackEvent(
      "command.acp_cancel",
      {
        userIdHash: hashUserId(userId),
        drainQueue,
        cancelledTurn: result.cancelledTurn,
        droppedQueueCount: result.droppedQueueCount,
      },
      hashUserId(userId),
    );

    await this.sendReply(userId, contextToken, this.formatAcpCancelResult(result, drainQueue));
  }

  protected async handleAcpMoreCommand(
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const isCurrent = () =>
      this.isMessageGenerationCurrent(userId, generation);
    return this.queueSendTask(userId, async () => {
      if (!isCurrent()) return;
      const result = await drainPendingText(
        this.pendingText,
        userId,
        (segment) =>
          isCurrent()
            ? this.sendTextSegment(userId, contextToken, segment, isCurrent)
            : Promise.resolve(false),
      );
      if (!isCurrent()) return;
      trackEvent(
        "command.acp_more",
        {
          userIdHash: hashUserId(userId),
          pendingCount: result.pendingCount,
          sentCount: result.sentCount,
          remainingCount: result.remainingCount,
        },
        hashUserId(userId),
      );
      if (result.pendingCount === 0) {
        await this.sendTextSegment(
          userId,
          contextToken,
          "No pending messages right now.",
          isCurrent,
        );
      }
      if (!isCurrent()) return;
      this.cancelTypingIndicator(userId, contextToken).catch(() => {});
    });
  }

  private formatAcpCancelResult(
    result: { cancelledTurn: boolean; droppedQueueCount: number },
    drainQueue: boolean,
  ): string {
    const lines: string[] = [];
    if (result.cancelledTurn) {
      lines.push("🛑 Cancel signal sent. The current ACP turn will stop shortly.");
    } else {
      lines.push("ℹ️ No active ACP turn to cancel.");
    }
    if (drainQueue && result.droppedQueueCount > 0) {
      lines.push(`Dropped ${result.droppedQueueCount} queued message(s).`);
    }
    lines.push("");
    lines.push("💡 **Usage**");
    lines.push(`   • Cancel current turn:        ${ACP_CANCEL_COMMAND}${this.aliasHint(ACP_CANCEL_COMMAND)}`);
    lines.push(`   • Cancel + drop queued msgs:  ${ACP_CANCEL_COMMAND} all`);
    return lines.join("\n");
  }

  private formatAcpCancelUsage(error?: string): string {
    const lines: string[] = [];
    if (error) {
      lines.push(`⚠️ ${error}`);
      lines.push("");
    }
    lines.push("💡 **Usage**");
    lines.push(`   • Cancel current turn:        ${ACP_CANCEL_COMMAND}${this.aliasHint(ACP_CANCEL_COMMAND)}`);
    lines.push(`   • Cancel + drop queued msgs:  ${ACP_CANCEL_COMMAND} all`);
    return lines.join("\n");
  }

  private isBufferStartCommand(msg: WeixinMessage): boolean {
    return this.extractBridgeCommand(msg, BUFFER_START_COMMAND) !== null;
  }

  private isBufferDoneCommand(msg: WeixinMessage): boolean {
    return this.extractBridgeCommand(msg, BUFFER_DONE_COMMAND) !== null;
  }

  private handleBufferStart(
    userId: string,
    contextToken: string,
    generation: number,
  ): void {
    const existing = this.messageBuffers.get(userId);
    if (existing?.generation === generation) {
      const buffer = existing;
      this.sendReply(userId, contextToken, `📝 Already in buffering mode (${buffer.blocks.length} block(s) collected). Keep sending, then ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)} to submit.`).catch((err) => {
        this.log(`Failed to send buffer active notice to ${userId}: ${String(err)}`);
      });
      return;
    }
    if (existing) {
      this.messageBuffers.delete(userId);
      this.clearBufferTimer(userId);
    }

    const buffer: MessageBuffer = {
      blocks: [],
      contextToken,
      pending: Promise.resolve(),
      lastUpdatedAt: Date.now(),
      generation,
    };
    this.messageBuffers.set(userId, buffer);
    this.resetBufferTimer(userId, buffer);
    this.log(`Buffer started for ${userId}`);
    trackEvent(
      "command.buffer_start",
      { userIdHash: hashUserId(userId) },
      hashUserId(userId),
    );
    this.sendReply(userId, contextToken, `📝 Buffering mode started. Send your messages (text, images, files), then send ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)} to submit them all at once.`).catch((err) => {
      this.log(`Failed to send buffer start confirmation to ${userId}: ${String(err)}`);
    });
  }

  private handleBufferDone(
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const buffer = this.messageBuffers.get(userId);
    if (!buffer || buffer.generation !== generation) {
      return this.sendReply(userId, contextToken, `⚠️ Nothing buffered. Send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} first, then send messages before ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)}.`);
    }

    this.beginAgentPrompt(userId, contextToken);

    // Remove from map immediately so new messages during the await
    // are not appended to a stale buffer.
    const pending = buffer.pending;
    this.messageBuffers.delete(userId);
    this.clearBufferTimer(userId);

    // Register a flushing promise so messages arriving during the await
    // queue behind the buffered prompt, preserving turn order.
    const flushPromise = this.doFlush(
      userId,
      contextToken,
      buffer,
      pending,
      () => this.isMessageGenerationCurrent(userId, generation),
      generation,
    );
    this.bufferFlushing.set(userId, flushPromise);
    void flushPromise.finally(() => {
      // Only clear if this is still our flush (not a newer one)
      if (this.bufferFlushing.get(userId) === flushPromise) {
        this.bufferFlushing.delete(userId);
      }
    }).catch(() => {});
    return flushPromise;
  }

  private async doFlush(
    userId: string,
    contextToken: string,
    buffer: MessageBuffer,
    pending: Promise<void>,
    isCurrent: () => boolean,
    replyGeneration: number,
  ): Promise<void> {
    // Wait for any in-flight appends to finish before reading
    try {
      await pending;
    } catch {
      if (!isCurrent()) return;
      // A prior append failed (e.g. image download error). The chain
      // already logged/tracked the error. Clear the buffer so the user
      // can start fresh.
      await this.sendReply(userId, contextToken, `⚠️ A buffered message failed to process. Buffer cleared. Please send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} to try again.`);
      return;
    }

    if (!isCurrent()) return;

    // Check expiry
    if (Date.now() - buffer.lastUpdatedAt > BUFFER_TTL_MS) {
      await this.sendReply(userId, contextToken, `⚠️ Buffer expired (10 min without activity). Please send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} to start over.`);
      return;
    }

    if (buffer.blocks.length === 0) {
      await this.sendReply(userId, contextToken, `⚠️ Buffer is empty. Send some messages before ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)}.`);
      return;
    }

    this.log(`Buffer flushed for ${userId}: ${buffer.blocks.length} block(s)`);
    trackEvent(
      "command.buffer_done",
      {
        userIdHash: hashUserId(userId),
        blockCount: buffer.blocks.length,
      },
      hashUserId(userId),
    );

    if (!isCurrent()) return;
    await this.enqueueBufferedPrompt(
      userId,
      contextToken,
      buffer.blocks,
      replyGeneration,
    );
  }

  protected async enqueueBufferedPrompt(
    userId: string,
    contextToken: string,
    prompt: acp.ContentBlock[],
    replyGeneration?: number,
  ): Promise<void> {
    await this.sessionManager!.enqueue(userId, {
      prompt,
      contextToken,
      replyGeneration,
    });
  }

  private appendToBuffer(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): void {
    const buffer = this.messageBuffers.get(userId);
    if (!buffer) return;
    const isCurrentBuffer = () =>
      this.messageBuffers.get(userId) === buffer &&
      this.isMessageGenerationCurrent(userId, buffer.generation);

    // Chain the async conversion so /acp-prompt-done waits for all in-flight appends
    buffer.pending = buffer.pending
      .then(async () => {
        // Re-check buffer still exists (could have been flushed or expired)
        if (!isCurrentBuffer()) return;

        // Check TTL
        if (Date.now() - buffer.lastUpdatedAt > BUFFER_TTL_MS) {
          this.messageBuffers.delete(userId);
          this.log(`Buffer expired for ${userId}`);
          await this.sendReply(userId, contextToken, `⚠️ Buffering timed out (10 min without activity). Please send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} again.`);
          return;
        }

        // Check block limit
        if (buffer.blocks.length >= BUFFER_MAX_BLOCKS) {
          await this.sendReply(userId, contextToken, `⚠️ Buffer is full (${BUFFER_MAX_BLOCKS} blocks max). Send ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)} to submit what you have.`);
          return;
        }

        const prompt = await weixinMessageToPrompt(
          msg,
          this.config.wechat.cdnBaseUrl,
          this.log,
          this.config.storage.inboxDir,
        );
        if (!isCurrentBuffer()) return;
        buffer.blocks.push(...prompt);
        buffer.contextToken = contextToken;
        buffer.lastUpdatedAt = Date.now();
        this.resetBufferTimer(userId, buffer);

        this.log(`Buffered message from ${userId}, now ${buffer.blocks.length} block(s)`);
      });

    buffer.pending.catch((err) => {
      this.log(`Failed to buffer message from ${userId}: ${String(err)}`);
      trackException(err, "buffer", hashUserId(userId));
    });
  }

  private resetBufferTimer(userId: string, expectedBuffer: MessageBuffer): void {
    this.clearBufferTimer(userId);
    this.bufferTimers.set(userId, setTimeout(() => {
      const buffer = this.messageBuffers.get(userId);
      if (buffer !== expectedBuffer) return;
      this.messageBuffers.delete(userId);
      this.bufferTimers.delete(userId);
      this.log(`Buffer expired (timer) for ${userId}`);
    }, BUFFER_TTL_MS));
  }

  private clearBufferTimer(userId: string): void {
    const timer = this.bufferTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.bufferTimers.delete(userId);
    }
  }

  private rememberActiveUser(userId: string, contextToken: string): void {
    if (!this.config.storage.stateFile) return;
    const update = this.enqueueStateUpdate(() =>
      updateLastActiveUser(this.config.storage.stateFile!, userId, contextToken),
    );
    update.catch((err) => {
      this.log(`Failed to persist last active user: ${String(err)}`);
      trackException(sanitizeStateError(err), "state", hashUserId(userId));
    });
  }

  private enqueueStateUpdate(update: () => Promise<void>): Promise<void> {
    const pending = this.stateUpdate.catch(() => {}).then(update);
    this.stateUpdate = pending;
    return pending;
  }

  private async sendReply(userId: string, contextToken: string, text: string): Promise<void> {
    // Serialize all replies to the same user behind a per-user promise chain so
    // that segments from separate sendReply calls cannot interleave (issue #38).
    // The stored link swallows errors so one failed reply doesn't break the
    // chain for the next caller, while the returned promise still propagates.
    const generation = this.messageGenerationForUser(userId);
    const isCurrent = () =>
      this.isMessageGenerationCurrent(userId, generation);
    return this.queueSendTask(userId, () => {
      if (!isCurrent()) return Promise.resolve();
      return this.deliverReply(
        userId,
        contextToken,
        text,
        undefined,
        isCurrent,
      );
    });
  }

  protected beginAgentPrompt(userId: string, contextToken: string): void {
    this.pendingText.supersede(userId, contextToken);
  }

  protected async sendAgentReply(
    userId: string,
    contextToken: string,
    text: string,
    replyGeneration: number,
    isSessionCurrent: () => boolean = () => true,
  ): Promise<void> {
    const generation = this.pendingText.generationForContext(userId, contextToken);
    return this.queueAgentSendTask(
      userId,
      replyGeneration,
      (isCurrent) =>
        this.deliverReply(
          userId,
          contextToken,
          text,
          generation,
          isCurrent,
        ),
      isSessionCurrent,
    );
  }

  private queueAgentSendTask(
    userId: string,
    generation: number,
    task: (isCurrent: () => boolean) => Promise<void>,
    isSessionCurrent: () => boolean = () => true,
  ): Promise<void> {
    const isCurrent = () =>
      isSessionCurrent() &&
      this.isMessageGenerationCurrent(userId, generation);
    return this.queueSendTask(userId, () => {
      if (!isCurrent()) {
        return Promise.resolve();
      }
      return task(isCurrent);
    });
  }

  private queueSendTask(userId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.sendChains.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.sendChains.set(userId, current.catch(() => {}));
    return current;
  }

  private async deliverReply(
    userId: string,
    contextToken: string,
    text: string,
    generation?: number,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const segments = splitText(text, TEXT_CHUNK_LIMIT);
    const startedAt = Date.now();
    let segmentsSent = 0;
    const failedSegments: string[] = [];

    for (const segment of segments) {
      if (!isCurrent()) return;
      const sent = await this.sendTextSegment(
        userId,
        contextToken,
        segment,
        isCurrent,
      );
      if (!isCurrent()) return;
      if (sent) {
        segmentsSent++;
      } else {
        failedSegments.push(segment);
      }
    }

    if (generation !== undefined) {
      this.pendingText.recordFailures(userId, generation, failedSegments);
    }

    if (failedSegments.length > 0) {
      trackException(
        new Error(
          `deliverReply: ${failedSegments.length}/${segments.length} segment(s) failed to send after retries`,
        ),
        "reply",
        hashUserId(userId),
      );
    }

    trackEvent(
      "reply.sent",
      {
        userIdHash: hashUserId(userId),
        segments: segments.length,
        segmentsSent,
        chars: text.length,
        durationMs: Date.now() - startedAt,
      },
      hashUserId(userId),
    );

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  protected async sendTextSegment(
    userId: string,
    contextToken: string,
    segment: string,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const segmentClientId = `wechat-acp-${crypto.randomUUID()}`;
    for (let attempt = 1; attempt <= SEGMENT_SEND_MAX_ATTEMPTS; attempt++) {
      if (!isCurrent()) return false;
      try {
        await this.paceConsecutiveSend(userId);
        if (!isCurrent()) return false;
        await sendTextMessage(
          userId,
          segment,
          {
            baseUrl: this.tokenData!.baseUrl,
            token: this.tokenData!.token,
            contextToken,
          },
          segmentClientId,
        );
        return true;
      } catch (err) {
        if (!isCurrent()) return false;
        trackException(err, "reply.segment", hashUserId(userId));
        if (attempt < SEGMENT_SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, SEGMENT_SEND_RETRY_BASE_MS * attempt));
        }
      }
    }
    return false;
  }

  private async sendImageReply(
    userId: string,
    contextToken: string,
    image: AgentImage,
    replyGeneration: number,
    isSessionCurrent?: () => boolean,
  ): Promise<void> {
    // Ride the same per-user chain as text replies so an image cannot
    // interleave with the segments of a concurrent text reply.
    return this.queueAgentSendTask(
      userId,
      replyGeneration,
      (isCurrent) =>
        this.deliverImage(userId, contextToken, image, isCurrent),
      isSessionCurrent,
    );
  }

  private async deliverImage(
    userId: string,
    contextToken: string,
    image: AgentImage,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const buffer = Buffer.from(image.data, "base64");
    const startedAt = Date.now();
    // Stable idempotency key across attempts. Together with reusing the
    // uploaded media descriptor below, every send attempt carries a
    // byte-identical payload, so the iLink gateway can de-duplicate by
    // client_id without a retry ever referencing different media.
    const clientId = `wechat-acp-${crypto.randomUUID()}`;
    const sendOpts = {
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      contextToken,
      cdnBaseUrl: this.config.wechat.cdnBaseUrl,
    };
    let media: UploadedImageMedia | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= SEGMENT_SEND_MAX_ATTEMPTS; attempt++) {
      if (!isCurrent()) return;
      try {
        // Upload once; only re-run if a previous attempt failed before the
        // upload completed. A send-stage failure retries with the same media.
        media ??= await uploadImageMedia(userId, buffer, sendOpts);
        if (!isCurrent()) return;
        await this.paceConsecutiveSend(userId);
        if (!isCurrent()) return;
        await sendImageItem(userId, media, sendOpts, clientId);
        if (!isCurrent()) return;
        trackEvent(
          "reply.image.sent",
          {
            userIdHash: hashUserId(userId),
            bytes: buffer.length,
            mimeType: image.mimeType,
            durationMs: Date.now() - startedAt,
          },
          hashUserId(userId),
        );
        this.cancelTypingIndicator(userId, contextToken).catch(() => {});
        return;
      } catch (err) {
        if (!isCurrent()) return;
        lastError = err;
        trackException(err, "reply.image", hashUserId(userId));
        if (attempt < SEGMENT_SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, SEGMENT_SEND_RETRY_BASE_MS * attempt));
        }
      }
    }

    // Propagate so the ACP client appends its delivery-failure placeholder.
    throw lastError instanceof Error
      ? lastError
      : new Error(`deliverImage: failed after ${SEGMENT_SEND_MAX_ATTEMPTS} attempts`);
  }

  private async sendAudioReply(
    userId: string,
    contextToken: string,
    audio: AgentAudio,
    replyGeneration: number,
    isSessionCurrent?: () => boolean,
  ): Promise<void> {
    const mime = audio.mimeType.trim().toLowerCase();
    const ext = Object.hasOwn(AUDIO_MIME_EXTENSIONS, mime) ? AUDIO_MIME_EXTENSIONS[mime] : "bin";
    const fileName = `audio-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    return this.queueFileReply(
      userId,
      contextToken,
      { data: audio.data, name: fileName, mimeType: audio.mimeType },
      "audio",
      replyGeneration,
      isSessionCurrent,
    );
  }

  private async sendFileReply(
    userId: string,
    contextToken: string,
    file: AgentFile,
    replyGeneration: number,
    isSessionCurrent?: () => boolean,
  ): Promise<void> {
    return this.queueFileReply(
      userId,
      contextToken,
      file,
      "file",
      replyGeneration,
      isSessionCurrent,
    );
  }

  private async queueFileReply(
    userId: string,
    contextToken: string,
    file: AgentFile,
    telemetryKind: "audio" | "file",
    replyGeneration: number,
    isSessionCurrent?: () => boolean,
  ): Promise<void> {
    // Ride the same per-user chain as text and image replies so a file cannot
    // interleave with the segments of a concurrent reply.
    return this.queueAgentSendTask(
      userId,
      replyGeneration,
      (isCurrent) =>
        this.deliverFile(
          userId,
          contextToken,
          file,
          telemetryKind,
          isCurrent,
        ),
      isSessionCurrent,
    );
  }

  private async deliverFile(
    userId: string,
    contextToken: string,
    file: AgentFile,
    telemetryKind: "audio" | "file",
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const buffer = Buffer.from(file.data, "base64");
    const startedAt = Date.now();
    // Stable idempotency key and name across attempts, same contract as
    // deliverImage: every send attempt carries a byte-identical payload.
    const clientId = `wechat-acp-${crypto.randomUUID()}`;
    const fileName = sanitizeFileName(file.name);
    const sendOpts = {
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      contextToken,
      cdnBaseUrl: this.config.wechat.cdnBaseUrl,
    };
    let media: UploadedFileMedia | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= SEGMENT_SEND_MAX_ATTEMPTS; attempt++) {
      if (!isCurrent()) return;
      try {
        // Upload once; only re-run if a previous attempt failed before the
        // upload completed. A send-stage failure retries with the same media.
        media ??= await uploadFileMedia(userId, buffer, sendOpts);
        if (!isCurrent()) return;
        await this.paceConsecutiveSend(userId);
        if (!isCurrent()) return;
        await sendFileItem(userId, media, fileName, sendOpts, clientId);
        if (!isCurrent()) return;
        trackEvent(
          `reply.${telemetryKind}.sent`,
          {
            userIdHash: hashUserId(userId),
            bytes: buffer.length,
            mimeType: file.mimeType,
            durationMs: Date.now() - startedAt,
          },
          hashUserId(userId),
        );
        this.cancelTypingIndicator(userId, contextToken).catch(() => {});
        return;
      } catch (err) {
        if (!isCurrent()) return;
        lastError = err;
        trackException(err, `reply.${telemetryKind}`, hashUserId(userId));
        if (attempt < SEGMENT_SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, SEGMENT_SEND_RETRY_BASE_MS * attempt));
        }
      }
    }

    // Propagate so the ACP client appends its delivery-failure placeholder.
    throw lastError instanceof Error
      ? lastError
      : new Error(`deliverFile: failed after ${SEGMENT_SEND_MAX_ATTEMPTS} attempts`);
  }

  /**
   * Wait, if necessary, so that consecutive text messages to the same user
   * are issued at least {@link REPLY_SEND_SPACING_MS} apart. This spaces
   * out their server-receive timestamps so WeChat preserves the order the
   * bridge sent them in, instead of racing and delivering them reversed
   * (issue #38). Sends to different users are tracked independently and do
   * not delay each other.
   */
  private async paceConsecutiveSend(userId: string): Promise<void> {
    const last = this.lastSendAt.get(userId);
    const now = Date.now();
    if (last !== undefined) {
      const wait = REPLY_SEND_SPACING_MS - (now - last);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    this.lastSendAt.set(userId, Date.now());
  }

  private async cancelTypingIndicator(userId: string, contextToken: string): Promise<void> {
    return this.queueTypingTask(userId, async () => {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return;
      await this.sendTypingStatus(userId, ticket, TypingStatus.CANCEL);
    });
  }

  protected async sendTypingIndicator(
    userId: string,
    contextToken: string,
    replyGeneration: number,
    isSessionCurrent: () => boolean = () => true,
  ): Promise<void> {
    return this.queueTypingTask(userId, async () => {
      if (
        !isSessionCurrent() ||
        !this.isMessageGenerationCurrent(userId, replyGeneration)
      ) {
        return;
      }
      try {
        const ticket = await this.getTypingTicket(userId, contextToken);
        if (
          !ticket ||
          !isSessionCurrent() ||
          !this.isMessageGenerationCurrent(userId, replyGeneration)
        ) {
          return;
        }
        await this.sendTypingStatus(
          userId,
          ticket,
          TypingStatus.TYPING,
        );
      } catch {
        // Typing is best-effort
      }
    });
  }

  protected async sendTypingStatus(
    userId: string,
    ticket: string,
    status: (typeof TypingStatus)[keyof typeof TypingStatus],
  ): Promise<void> {
    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status,
      },
    });
  }

  private queueTypingTask(
    userId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = this.typingChains.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const stored = current.catch(() => {});
    this.typingChains.set(userId, stored);
    void stored.finally(() => {
      if (this.typingChains.get(userId) === stored) {
        this.typingChains.delete(userId);
      }
    });
    return current;
  }

  private async getTypingTicket(userId: string, contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;

    try {
      const resp = await getConfig({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        ilinkUserId: userId,
        contextToken,
      });

      if (resp.typing_ticket) {
        this.typingTickets.set(userId, {
          ticket: resp.typing_ticket,
          expiresAt: Date.now() + 24 * 60 * 60_000, // 24h cache
        });
        return resp.typing_ticket;
      }
    } catch {
      // Not critical
    }
    return null;
  }

  private previewMessage(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        const text = item.text_item.text;
        return text.length > 50 ? text.substring(0, 50) + "..." : text;
      }
      if (item.type === 2) return "[image]";
      if (item.type === 3) return item.voice_item?.text ? `[voice] ${item.voice_item.text.substring(0, 30)}` : "[voice]";
      if (item.type === 4) return `[file] ${item.file_item?.file_name ?? ""}`;
      if (item.type === 5) return "[video]";
    }
    return "[empty]";
  }

  private messageKind(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1) return "text";
      if (item.type === 2) return "image";
      if (item.type === 3) return "voice";
      if (item.type === 4) return "file";
      if (item.type === 5) return "video";
    }
    return "empty";
  }

  private extractAcpConfigCommand(msg: WeixinMessage): string | null {
    return this.extractBridgeCommand(msg, ACP_CONFIG_COMMAND);
  }

  private extractAcpCancelCommand(msg: WeixinMessage): string | null {
    return this.extractBridgeCommand(msg, ACP_CANCEL_COMMAND);
  }

  private extractAcpNewCommand(msg: WeixinMessage): string | null {
    return this.extractBridgeCommand(msg, ACP_NEW_COMMAND);
  }

  private isMessageGenerationCurrent(
    userId: string,
    generation: number,
  ): boolean {
    return this.messageGenerationForUser(userId) === generation;
  }

  protected messageGenerationForUser(userId: string): number {
    return this.userResetEpochs.get(userId) ?? 0;
  }

  private requireReplyGeneration(
    replyGeneration: number | undefined,
  ): number {
    if (replyGeneration === undefined) {
      throw new Error("Agent callback is missing its reset generation");
    }
    return replyGeneration;
  }

  private extractBridgeCommand(msg: WeixinMessage, canonical: string): string | null {
    const items = msg.item_list ?? [];
    if (items.length !== 1) return null;

    const item = items[0];
    if (item?.type !== 1 || !item.text_item?.text) return null;

    return matchBridgeCommand(item.text_item.text, canonical, this.config.commandAliases);
  }

  /**
   * Render a usage hint suffix listing any configured aliases for a
   * canonical command, e.g. " (aliases: /cancel, /取消)". Returns an
   * empty string when no aliases are configured.
   */
  private aliasHint(canonical: string): string {
    const aliases = resolveCommandAliases(canonical, this.config.commandAliases);
    return aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
  }

  private formatAcpConfigList(userId: string): string {
    const configOptions = this.sessionManager?.getSessionConfigOptions(userId);
    const runtimeSettings = this.sessionManager?.getRuntimeBridgeSettings(userId);
    if (!runtimeSettings) {
      return this.formatAcpConfigUsage(
        "No active ACP session for this chat yet. Send a normal message first.",
      );
    }

    const lines: string[] = [];
    lines.push("⚙️ **Runtime Bridge Config**");
    lines.push("━━━━━━━━━━━━━━━━");

    for (const option of RUNTIME_BRIDGE_CONFIG_OPTIONS) {
      lines.push("");
      lines.push(`📌 **${option.name}**  (id: \`${option.id}\`)`);
      lines.push(`   • Current: ${runtimeSettings[option.setting] ? "on" : "off"}`);
      lines.push("   • Options: on | off");
    }

    lines.push("");
    lines.push("⚙️ **ACP Session Config**");
    lines.push("━━━━━━━━━━━━━━━━");

    if (!configOptions || configOptions.length === 0) {
      lines.push("");
      lines.push("The current ACP agent does not expose any configurable session options.");
    } else {
      for (const option of configOptions) {
        lines.push("");
        lines.push(`📌 **${option.name}**  (id: \`${option.id}\`)`);
        lines.push(`   • Current: ${this.describeCurrentConfigValue(option)}`);
        if (option.type === "select") {
          lines.push(`   • Options: ${this.listConfigOptionChoices(option).join(" | ")}`);
        } else if (option.type === "boolean") {
          lines.push(`   • Options: true | false`);
        }
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━");
    lines.push("💡 **Usage**");
    lines.push(`   • View:   ${ACP_CONFIG_COMMAND}${this.aliasHint(ACP_CONFIG_COMMAND)}`);
    lines.push(`   • Update: ${ACP_CONFIG_COMMAND} set <configId> <value>`);
    return lines.join("\n");
  }

  private formatAcpConfigUsage(error?: string): string {
    const lines: string[] = [];
    if (error) {
      lines.push(`⚠️ ${error}`);
      lines.push("");
    }
    lines.push("💡 **Usage**");
    lines.push(`   • View:   ${ACP_CONFIG_COMMAND}${this.aliasHint(ACP_CONFIG_COMMAND)}`);
    lines.push(`   • Update: ${ACP_CONFIG_COMMAND} set <configId> <value>`);
    return lines.join("\n");
  }

  private describeCurrentConfigValue(option: acp.SessionConfigOption): string {
    if (option.type === "boolean") {
      return option.currentValue ? "true" : "false";
    }

    const current = this.findConfigOptionChoice(option, option.currentValue);
    return current ? this.describeConfigChoice(current) : option.currentValue;
  }

  private listConfigOptionChoices(option: acp.SessionConfigOption): string[] {
    if (option.type !== "select") return [];
    return this.flattenSelectOptions(option.options).map((choice) => this.describeConfigChoice(choice));
  }

  private resolveAcpConfigValue(
    userId: string,
    configId: string,
    rawValue: string,
  ): { rawValue: string | boolean; displayValue: string } {
    const configOptions = this.sessionManager?.getSessionConfigOptions(userId);
    if (!configOptions) {
      throw new Error("No active ACP session for this chat yet. Send a normal message first.");
    }

    const option = configOptions.find((candidate) => candidate.id === configId);
    if (!option) {
      throw new Error(`Unknown ACP config option: ${configId}`);
    }

    if (option.type === "boolean") {
      const value = this.resolveBooleanConfigValue(configId, rawValue);
      return { rawValue: value, displayValue: String(value) };
    }

    const candidates = this.flattenSelectOptions(option.options).filter((choice) =>
      this.configChoiceAliases(choice).has(rawValue.trim().toLowerCase())
    );
    if (candidates.length === 0) {
      throw new Error(
        `Invalid value for ${configId}: ${rawValue}. Options: ${this.listConfigOptionChoices(option).join(", ")}`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(`Ambiguous value for ${configId}: ${rawValue}`);
    }

    const match = candidates[0]!;
    return {
      rawValue: match.value,
      displayValue: this.describeConfigChoice(match),
    };
  }

  private resolveBooleanConfigValue(configId: string, rawValue: string): boolean {
    const normalized = rawValue.trim().toLowerCase();
    if (["true", "on", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "off", "0", "no"].includes(normalized)) {
      return false;
    }
    throw new Error(`Invalid boolean value for ${configId}: ${rawValue}`);
  }

  private flattenSelectOptions(
    options: acp.SessionConfigSelect["options"],
  ): acp.SessionConfigSelectOption[] {
    if (options.length === 0) return [];

    const first = options[0];
    if (first && "value" in first) {
      return options as acp.SessionConfigSelectOption[];
    }

    return (options as acp.SessionConfigSelectGroup[]).flatMap((group) => group.options);
  }

  private findConfigOptionChoice(
    option: acp.SessionConfigSelect,
    rawValue: string,
  ): acp.SessionConfigSelectOption | undefined {
    return this.flattenSelectOptions(option.options).find((choice) => choice.value === rawValue);
  }

  private configChoiceAliases(choice: acp.SessionConfigSelectOption): Set<string> {
    const aliases = new Set<string>();
    aliases.add(choice.value.toLowerCase());
    aliases.add(choice.name.toLowerCase());

    const compactName = choice.name.toLowerCase().replace(/\s+/g, "-");
    aliases.add(compactName);

    const tail = this.extractConfigValueTail(choice.value);
    if (tail) aliases.add(tail.toLowerCase());

    return aliases;
  }

  private describeConfigChoice(choice: acp.SessionConfigSelectOption): string {
    const tail = this.extractConfigValueTail(choice.value);
    if (tail && tail.toLowerCase() !== choice.name.toLowerCase()) {
      return tail;
    }
    return choice.value;
  }

  private extractConfigValueTail(value: string): string {
    const hashIndex = value.lastIndexOf("#");
    if (hashIndex >= 0 && hashIndex < value.length - 1) {
      return value.slice(hashIndex + 1);
    }

    const slashIndex = value.lastIndexOf("/");
    if (slashIndex >= 0 && slashIndex < value.length - 1) {
      return value.slice(slashIndex + 1);
    }

    return value;
  }
}

function sanitizeStateError(err: unknown): Error {
  const code = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  const sanitized = new Error(code ? `State persistence failed (${code})` : "State persistence failed");
  sanitized.name = err instanceof Error ? err.name : "Error";
  sanitized.stack = undefined;
  return sanitized;
}

function describeError(err: unknown): string {
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
