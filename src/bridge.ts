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
import { sendTextMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./acp/session.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import type { WeChatAcpConfig } from "./config.js";
import { BRIDGE_COMMANDS, resolveCommandAliases, resolveCommandNames } from "./config.js";
import { InjectionMonitor } from "./inject/monitor.js";
import type { InjectedMessage } from "./inject/types.js";
import { resolveUserTarget, updateLastActiveUser } from "./storage/state.js";
import { trackEvent, trackException, hashUserId } from "./telemetry/index.js";

const ACP_CONFIG_COMMAND = BRIDGE_COMMANDS.acpConfig;
const ACP_CANCEL_COMMAND = BRIDGE_COMMANDS.acpCancel;
const BUFFER_START_COMMAND = BRIDGE_COMMANDS.promptStart;
const BUFFER_DONE_COMMAND = BRIDGE_COMMANDS.promptDone;
const TEXT_CHUNK_LIMIT = 4000;
const BUFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BUFFER_MAX_BLOCKS = 50;
const SEGMENT_SEND_MAX_ATTEMPTS = 3;
const SEGMENT_SEND_RETRY_BASE_MS = 300;

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
  private injectionMonitor: InjectionMonitor | null = null;
  private tokenData: TokenData | null = null;
  private stateUpdate = Promise.resolve();
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  // Timestamp (ms) at which the last text message was issued to each user,
  // used to pace consecutive sends so they don't race and arrive reordered.
  private lastSendAt = new Map<string, number>();
  // Per-user promise chain serializing replies so concurrent sendReply calls
  // (e.g. a command reply racing an active session flush) cannot interleave
  // their segments and arrive out of order (issue #38).
  private sendChains = new Map<string, Promise<void>>();
  // Per-user message buffer for /acp-prompt-start.../acp-prompt-done multi-part compose
  private messageBuffers = new Map<string, {
    blocks: acp.ContentBlock[];
    contextToken: string;
    pending: Promise<void>;
    lastUpdatedAt: number;
  }>();
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

    // 2. Create SessionManager
    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentCwd: this.config.agent.cwd,
      agentEnv: this.config.agent.env,
      agentPreset: this.config.agent.preset ?? "raw",
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      showDiffs: this.config.agent.showDiffs ?? false,
      log: this.log,
      onReply: (userId, contextToken, text) => this.sendReply(userId, contextToken, text),
      sendTyping: (userId, contextToken) => this.sendTypingIndicator(userId, contextToken),
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
      onMessage: (msg) => this.handleMessage(msg),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    await this.injectionMonitor?.stop();
    await this.sessionManager?.stop();
    await this.stateUpdate.catch((err) => {
      this.log(`Failed to flush state before stop: ${String(err)}`);
      trackException(sanitizeStateError(err), "state");
    });
    this.log("Bridge stopped");
  }

  private handleMessage(msg: WeixinMessage): void {
    // Only process user messages (not bot's own messages)
    if (msg.message_type !== MessageType.USER) return;

    // Skip group messages (v1: direct only)
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

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

    const acpConfigCommand = this.extractAcpConfigCommand(msg);
    if (acpConfigCommand) {
      this.handleAcpConfigCommand(acpConfigCommand, userId, contextToken).catch((err) => {
        this.log(`Failed to handle ACP config command from ${userId}: ${String(err)}`);
        trackException(err, "command", hashUserId(userId));
      });
      return;
    }

    const acpCancelCommand = this.extractAcpCancelCommand(msg);
    if (acpCancelCommand) {
      this.handleAcpCancelCommand(acpCancelCommand, userId, contextToken).catch((err) => {
        this.log(`Failed to handle ACP cancel command from ${userId}: ${String(err)}`);
        trackException(err, "command", hashUserId(userId));
      });
      return;
    }

    // /acp-prompt-start — enter buffering mode
    if (this.isBufferStartCommand(msg)) {
      this.handleBufferStart(userId, contextToken);
      return;
    }

    // /acp-prompt-done — flush buffer and send to agent
    if (this.isBufferDoneCommand(msg)) {
      this.handleBufferDone(userId, contextToken).catch((err) => {
        this.log(`Failed to flush message buffer for ${userId}: ${String(err)}`);
        trackException(err, "buffer", hashUserId(userId));
      });
      return;
    }

    // If user is in buffering mode, append to buffer instead of enqueuing
    if (this.messageBuffers.has(userId)) {
      this.appendToBuffer(msg, userId, contextToken);
      return;
    }

    // Convert and enqueue — fire-and-forget (don't block the poll loop)
    const waitForFlush = this.bufferFlushing.get(userId);
    const enqueue = waitForFlush
      ? waitForFlush.then(() => this.enqueueMessage(msg, userId, contextToken))
      : this.enqueueMessage(msg, userId, contextToken);
    enqueue.catch((err) => {
      this.log(`Failed to enqueue message from ${userId}: ${String(err)}`);
      trackException(err, "enqueue", hashUserId(userId));
    });
  }

  private async enqueueMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    const prompt = await weixinMessageToPrompt(
      msg,
      this.config.wechat.cdnBaseUrl,
      this.log,
      this.config.storage.inboxDir,
    );

    await this.sessionManager!.enqueue(userId, { prompt, contextToken });
  }

  private async enqueueInjectedMessage(job: InjectedMessage): Promise<void> {
    if (!this.sessionManager || !this.config.storage.stateFile) {
      throw new Error("Bridge is not ready to process injected messages");
    }

    const target = await resolveUserTarget(this.config.storage.stateFile, job.target, job.contextToken);
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
    });
  }

  private async handleAcpConfigCommand(
    command: string,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    if (args.length === 1) {
      const configOptions = this.sessionManager?.getSessionConfigOptions(userId);
      trackEvent(
        "command.acp_config.view",
        {
          userIdHash: hashUserId(userId),
          hasSession: !!configOptions,
          optionCount: configOptions?.length ?? 0,
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
        const resolved = this.resolveAcpConfigValue(userId, configId, rawValue);
        await this.sessionManager!.setSessionConfigOption(userId, configId, resolved.rawValue);
        const optionType = this.sessionManager!
          .getSessionConfigOptions(userId)
          ?.find((o) => o.id === configId)?.type;
        trackEvent(
          "command.acp_config.set",
          {
            userIdHash: hashUserId(userId),
            configId,
            optionType: optionType ?? "unknown",
            optionValue: resolved.displayValue,
          },
          hashUserId(userId),
        );
        await this.sendReply(
          userId,
          contextToken,
          `✅ Updated ACP config: ${configId} = ${resolved.displayValue}\n\n${this.formatAcpConfigList(userId)}`,
        );
      } catch (err) {
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

  private handleBufferStart(userId: string, contextToken: string): void {
    if (this.messageBuffers.has(userId)) {
      const buffer = this.messageBuffers.get(userId)!;
      this.sendReply(userId, contextToken, `📝 Already in buffering mode (${buffer.blocks.length} block(s) collected). Keep sending, then ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)} to submit.`).catch((err) => {
        this.log(`Failed to send buffer active notice to ${userId}: ${String(err)}`);
      });
      return;
    }

    this.messageBuffers.set(userId, { blocks: [], contextToken, pending: Promise.resolve(), lastUpdatedAt: Date.now() });
    this.resetBufferTimer(userId);
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

  private handleBufferDone(userId: string, contextToken: string): Promise<void> {
    const buffer = this.messageBuffers.get(userId);
    if (!buffer) {
      return this.sendReply(userId, contextToken, `⚠️ Nothing buffered. Send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} first, then send messages before ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)}.`);
    }

    // Remove from map immediately so new messages during the await
    // are not appended to a stale buffer.
    const pending = buffer.pending;
    this.messageBuffers.delete(userId);
    this.clearBufferTimer(userId);

    // Register a flushing promise so messages arriving during the await
    // queue behind the buffered prompt, preserving turn order.
    const flushPromise = this.doFlush(userId, contextToken, buffer, pending);
    this.bufferFlushing.set(userId, flushPromise);
    flushPromise.finally(() => {
      // Only clear if this is still our flush (not a newer one)
      if (this.bufferFlushing.get(userId) === flushPromise) {
        this.bufferFlushing.delete(userId);
      }
    });
    return flushPromise;
  }

  private async doFlush(
    userId: string,
    contextToken: string,
    buffer: { blocks: acp.ContentBlock[]; contextToken: string; pending: Promise<void>; lastUpdatedAt: number },
    pending: Promise<void>,
  ): Promise<void> {
    // Wait for any in-flight appends to finish before reading
    try {
      await pending;
    } catch {
      // A prior append failed (e.g. image download error). The chain
      // already logged/tracked the error. Clear the buffer so the user
      // can start fresh.
      await this.sendReply(userId, contextToken, `⚠️ A buffered message failed to process. Buffer cleared. Please send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} to try again.`);
      return;
    }

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

    await this.sessionManager!.enqueue(userId, {
      prompt: buffer.blocks,
      contextToken: buffer.contextToken,
    });
  }

  private appendToBuffer(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): void {
    const buffer = this.messageBuffers.get(userId);
    if (!buffer) return;

    // Chain the async conversion so /acp-prompt-done waits for all in-flight appends
    buffer.pending = buffer.pending
      .then(async () => {
        // Re-check buffer still exists (could have been flushed or expired)
        if (!this.messageBuffers.has(userId)) return;

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
        buffer.blocks.push(...prompt);
        buffer.contextToken = contextToken;
        buffer.lastUpdatedAt = Date.now();
        this.resetBufferTimer(userId);

        this.log(`Buffered message from ${userId}, now ${buffer.blocks.length} block(s)`);
      });

    buffer.pending.catch((err) => {
      this.log(`Failed to buffer message from ${userId}: ${String(err)}`);
      trackException(err, "buffer", hashUserId(userId));
    });
  }

  private resetBufferTimer(userId: string): void {
    this.clearBufferTimer(userId);
    this.bufferTimers.set(userId, setTimeout(() => {
      const buffer = this.messageBuffers.get(userId);
      if (!buffer) return;
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
    this.stateUpdate = this.stateUpdate
      .catch(() => {})
      .then(() => updateLastActiveUser(this.config.storage.stateFile!, userId, contextToken));
    this.stateUpdate.catch((err) => {
      this.log(`Failed to persist last active user: ${String(err)}`);
      trackException(sanitizeStateError(err), "state", hashUserId(userId));
    });
  }

  private async sendReply(userId: string, contextToken: string, text: string): Promise<void> {
    // Serialize all replies to the same user behind a per-user promise chain so
    // that segments from separate sendReply calls cannot interleave (issue #38).
    // The stored link swallows errors so one failed reply doesn't break the
    // chain for the next caller, while the returned promise still propagates.
    const previous = this.sendChains.get(userId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.deliverReply(userId, contextToken, text));
    this.sendChains.set(
      userId,
      current.catch(() => {}),
    );
    return current;
  }

  private async deliverReply(userId: string, contextToken: string, text: string): Promise<void> {
    const segments = splitText(text, TEXT_CHUNK_LIMIT);
    const startedAt = Date.now();
    let segmentsSent = 0;
    let anyFailed = false;

    for (const segment of segments) {
      // Generate one stable idempotency key per segment *before* the retry
      // loop so that all attempts for the same segment reuse the same
      // client_id. The iLink gateway de-duplicates by client_id, so a retry
      // after a transient hard error (connection reset, 5xx) will not produce
      // a duplicate message even if the first attempt was already received.
      const segmentClientId = `wechat-acp-${crypto.randomUUID()}`;
      let sent = false;

      for (let attempt = 1; attempt <= SEGMENT_SEND_MAX_ATTEMPTS; attempt++) {
        try {
          await this.paceConsecutiveSend(userId);
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
          sent = true;
          break;
        } catch (err) {
          trackException(err, "reply.segment", hashUserId(userId));
          if (attempt < SEGMENT_SEND_MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, SEGMENT_SEND_RETRY_BASE_MS * attempt));
          }
        }
      }

      if (sent) {
        segmentsSent++;
      } else {
        // Log the drop but continue — a single failed segment must not
        // prevent the remaining segments from being delivered.
        anyFailed = true;
      }
    }

    if (anyFailed) {
      trackException(
        new Error(
          `deliverReply: ${segments.length - segmentsSent}/${segments.length} segment(s) failed to send after retries`,
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
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;

    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: TypingStatus.CANCEL,
      },
    });
  }

  private async sendTypingIndicator(userId: string, contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return;

      await sendTyping({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        },
      });
    } catch {
      // Typing is best-effort
    }
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

  private extractBridgeCommand(msg: WeixinMessage, canonical: string): string | null {
    const items = msg.item_list ?? [];
    if (items.length !== 1) return null;

    const item = items[0];
    if (item?.type !== 1 || !item.text_item?.text) return null;

    const text = item.text_item.text.trim();
    const names = resolveCommandNames(canonical, this.config.commandAliases);
    for (const name of names) {
      // Exact match → normalize to the canonical command with no arguments.
      // This is the only matching mode for bare-phrase aliases (no leading
      // "/"), e.g. a voice-transcribed "取消", which must match the whole
      // message to avoid false positives.
      if (text === name) return canonical;
      // Slash-prefixed names (the canonical command and "/"-style aliases)
      // also support trailing arguments. Replace the matched name with the
      // canonical command so handlers always see a single, stable token.
      if (name.startsWith("/") && text.startsWith(`${name} `)) {
        return canonical + text.slice(name.length);
      }
    }
    return null;
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
    if (!configOptions) {
      return this.formatAcpConfigUsage(
        "No active ACP session for this chat yet. Send a normal message first.",
      );
    }
    if (configOptions.length === 0) {
      return this.formatAcpConfigUsage(
        "The current ACP agent does not expose any configurable session options.",
      );
    }

    const lines: string[] = [];
    lines.push("⚙️ **ACP Session Config**");
    lines.push("━━━━━━━━━━━━━━━━");

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
      const normalized = rawValue.trim().toLowerCase();
      if (["true", "on", "1", "yes"].includes(normalized)) {
        return { rawValue: true, displayValue: "true" };
      }
      if (["false", "off", "0", "no"].includes(normalized)) {
        return { rawValue: false, displayValue: "false" };
      }
      throw new Error(`Invalid boolean value for ${configId}: ${rawValue}`);
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
