/**
 * WeChat iLink HTTP API client.
 * Adapted from @tencent-weixin/openclaw-weixin api/api.ts
 */

import crypto from "node:crypto";

import type {
  BaseInfo,
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendTypingReq,
  GetConfigResp,
  NotifyStartResp,
  NotifyStopResp,
} from "./types.js";

const CHANNEL_VERSION = "1.0.2";

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

async function apiGet<T>(baseUrl: string, path: string, token?: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path}`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = 15_000,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const payload = { ...body, base_info: buildBaseInfo() };
  const bodyStr = JSON.stringify(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { ret: 0, msgs: [] } as T;
    }
    throw err;
  }
}

export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  get_updates_buf: string;
  timeoutMs?: number;
}): Promise<GetUpdatesResp> {
  return apiPost<GetUpdatesResp>(
    params.baseUrl,
    "ilink/bot/getupdates",
    { get_updates_buf: params.get_updates_buf },
    params.token,
    params.timeoutMs ?? 38_000,
  );
}

export async function sendMessage(params: {
  baseUrl: string;
  token?: string;
  body: SendMessageReq;
}): Promise<void> {
  await apiPost(params.baseUrl, "ilink/bot/sendmessage", params.body as unknown as Record<string, unknown>, params.token);
}

export async function getUploadUrl(params: {
  baseUrl: string;
  token?: string;
  body: GetUploadUrlReq;
}): Promise<GetUploadUrlResp> {
  return apiPost<GetUploadUrlResp>(
    params.baseUrl,
    "ilink/bot/getuploadurl",
    params.body as unknown as Record<string, unknown>,
    params.token,
  );
}

export async function getConfig(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<GetConfigResp> {
  return apiPost<GetConfigResp>(
    params.baseUrl,
    "ilink/bot/getconfig",
    {
      ilink_user_id: params.ilinkUserId,
      ...(params.contextToken ? { context_token: params.contextToken } : {}),
    },
    params.token,
    10_000,
  );
}

export async function sendTyping(params: {
  baseUrl: string;
  token?: string;
  body: SendTypingReq;
}): Promise<void> {
  await apiPost(
    params.baseUrl,
    "ilink/bot/sendtyping",
    params.body as unknown as Record<string, unknown>,
    params.token,
    10_000,
  );
}

export async function getBotQrcode(params: {
  baseUrl: string;
  botType?: string;
}): Promise<{ qrcode: string; qrcode_img_content: string }> {
  return apiGet(
    params.baseUrl,
    `ilink/bot/get_bot_qrcode?bot_type=${params.botType ?? "3"}`,
  );
}

export async function getQrcodeStatus(params: {
  baseUrl: string;
  qrcode: string;
  verifyCode?: string;
}): Promise<{
  status: string;
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}> {
  let qs = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
  if (params.verifyCode) {
    qs += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
  }
  return apiGet(params.baseUrl, qs);
}

export async function notifyStart(params: {
  baseUrl: string;
  token?: string;
}): Promise<NotifyStartResp> {
  return apiPost<NotifyStartResp>(
    params.baseUrl,
    "ilink/bot/msg/notifystart",
    { base_info: buildBaseInfo() },
    params.token,
    10_000,
  );
}

export async function notifyStop(params: {
  baseUrl: string;
  token?: string;
}): Promise<NotifyStopResp> {
  return apiPost<NotifyStopResp>(
    params.baseUrl,
    "ilink/bot/msg/notifystop",
    { base_info: buildBaseInfo() },
    params.token,
    10_000,
  );
}
