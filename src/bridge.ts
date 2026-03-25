/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./acp/session.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import type { WeChatAcpConfig } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
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
    }

    if (!this.tokenData) {
      this.tokenData = await login({
        baseUrl: this.config.wechat.baseUrl,
        botType: this.config.wechat.botType,
        storageDir: this.config.storage.dir,
        log: this.log,
        renderQrUrl,
      });
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
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      log: this.log,
      onReply: (userId, contextToken, text) => this.sendReply(userId, contextToken, text),
      sendTyping: (userId, contextToken) => this.sendTypingIndicator(userId, contextToken),
    });
    this.sessionManager.start();

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
    await this.sessionManager?.stop();
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

    // Convert and enqueue — fire-and-forget (don't block the poll loop)
    this.enqueueMessage(msg, userId, contextToken).catch((err) => {
      this.log(`Failed to enqueue message from ${userId}: ${String(err)}`);
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
    );

    await this.sessionManager!.enqueue(userId, { prompt, contextToken });
  }

  private async sendReply(userId: string, contextToken: string, text: string): Promise<void> {
    const formatted = formatForWeChat(text);
    const segments = splitText(formatted, TEXT_CHUNK_LIMIT);

    for (const segment of segments) {
      await sendTextMessage(userId, segment, {
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        contextToken,
      });
    }

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
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
}
