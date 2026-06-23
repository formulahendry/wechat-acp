/**
 * WeChat QR login flow + token persistence.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getBotQrcode, getQrcodeStatus } from "./api.js";

export interface TokenData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  savedAt: string;
}

function getTokenPath(storageDir: string): string {
  return path.join(storageDir, "token.json");
}

export function loadToken(storageDir: string): TokenData | null {
  const tokenPath = getTokenPath(storageDir);
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as TokenData;
  } catch {
    return null;
  }
}

export function saveToken(storageDir: string, data: TokenData): void {
  fs.mkdirSync(storageDir, { recursive: true });
  const tokenPath = getTokenPath(storageDir);
  fs.writeFileSync(tokenPath, JSON.stringify(data, null, 2), "utf-8");
}

async function readVerifyCodeFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const MAX_QR_REFRESH_COUNT = 3;

export async function login(params: {
  baseUrl: string;
  botType?: string;
  storageDir: string;
  log: (msg: string) => void;
  renderQrUrl?: (url: string) => void;
}): Promise<TokenData> {
  const { baseUrl, botType, storageDir, log, renderQrUrl } = params;

  log("Starting WeChat QR login...");

  const qrResp = await getBotQrcode({ baseUrl, botType });
  const qrcodeUrl = qrResp.qrcode_img_content;

  log("Please scan the QR code with WeChat:");
  log(`QR URL: ${qrcodeUrl}`);
  if (renderQrUrl) {
    renderQrUrl(qrcodeUrl);
  }

  const deadline = Date.now() + 5 * 60_000;
  let currentQrcode = qrResp.qrcode;
  let currentBaseUrl = baseUrl;
  let refreshCount = 0;
  let pendingVerifyCode: string | undefined;

  while (Date.now() < deadline) {
    const statusResp = await getQrcodeStatus({
      baseUrl: currentBaseUrl,
      qrcode: currentQrcode,
      verifyCode: pendingVerifyCode,
    });

    switch (statusResp.status) {
      case "wait":
        break;
      case "scaned": {
        if (pendingVerifyCode) {
          log("Pair-code accepted");
          pendingVerifyCode = undefined;
        }
        log("QR scanned, please confirm in WeChat...");
        break;
      }
      case "need_verifycode": {
        const prompt = pendingVerifyCode
          ? "❌ Wrong code, please re-enter the number shown on your phone: "
          : "Enter the verification number shown on your phone: ";
        const code = await readVerifyCodeFromStdin(prompt);
        pendingVerifyCode = code;
        continue;
      }
      case "verify_code_blocked": {
        log("Verification code blocked (too many attempts)");
        process.stdout.write("\n⛔ Too many incorrect attempts.\n");
        pendingVerifyCode = undefined;
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH_COUNT) {
          throw new Error("Verification code blocked and QR refresh limit reached");
        }
        log(`Refreshing QR code (${refreshCount}/${MAX_QR_REFRESH_COUNT})...`);
        const newQr = await getBotQrcode({ baseUrl, botType });
        currentQrcode = newQr.qrcode;
        if (renderQrUrl) {
          renderQrUrl(newQr.qrcode_img_content);
        } else {
          log(`New QR URL: ${newQr.qrcode_img_content}`);
        }
        break;
      }
      case "scaned_but_redirect": {
        const redirectHost = (statusResp as Record<string, unknown>).redirect_host as string | undefined;
        if (redirectHost) {
          currentBaseUrl = `https://${redirectHost}`;
          log(`Redirecting polling to ${currentBaseUrl}`);
        }
        break;
      }
      case "binded_redirect": {
        log("Bot already bound to this account");
        process.stdout.write("\n✅ Already connected, no need to re-connect.\n");
        throw new Error("Already connected (binded_redirect)");
      }
      case "expired": {
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH_COUNT) {
          throw new Error("QR code expired multiple times, please retry");
        }
        log(`QR expired, refreshing (${refreshCount}/${MAX_QR_REFRESH_COUNT})...`);
        const newQr = await getBotQrcode({ baseUrl, botType });
        currentQrcode = newQr.qrcode;
        if (renderQrUrl) {
          renderQrUrl(newQr.qrcode_img_content);
        } else {
          log(`New QR URL: ${newQr.qrcode_img_content}`);
        }
        break;
      }
      case "confirmed": {
        log("Login successful!");
        const tokenData: TokenData = {
          token: statusResp.bot_token!,
          baseUrl: statusResp.baseurl || baseUrl,
          accountId: statusResp.ilink_bot_id!,
          userId: statusResp.ilink_user_id!,
          savedAt: new Date().toISOString(),
        };
        saveToken(storageDir, tokenData);
        log(`Bot ID: ${tokenData.accountId}`);
        log(`Token saved to ${getTokenPath(storageDir)}`);
        return tokenData;
      }
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error("Login timeout (5 minutes)");
}
