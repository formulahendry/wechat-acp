import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_INJECTION_TARGET, type InjectedMessage } from "./types.js";

const INJECT_DIR_MODE = 0o700;
const INJECT_FILE_MODE = 0o600;

export interface QueueInjectedMessageParams {
  injectDir: string;
  text: string;
  target?: string;
  contextToken?: string;
}

export interface QueuedInjectedMessage {
  job: InjectedMessage;
  filePath: string;
}

export async function queueInjectedMessage(
  params: QueueInjectedMessageParams,
): Promise<QueuedInjectedMessage> {
  const text = params.text.trim();
  if (!text) {
    throw new Error("Injected message text cannot be empty");
  }

  const pendingDir = path.join(params.injectDir, "pending");
  await fs.mkdir(params.injectDir, { recursive: true, mode: INJECT_DIR_MODE });
  await fs.chmod(params.injectDir, INJECT_DIR_MODE).catch(() => {});
  await fs.mkdir(pendingDir, { recursive: true, mode: INJECT_DIR_MODE });
  await fs.chmod(pendingDir, INJECT_DIR_MODE).catch(() => {});

  const job: InjectedMessage = {
    id: `inj_${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    target: params.target ?? DEFAULT_INJECTION_TARGET,
    text,
    source: "cli",
    ...(params.contextToken ? { contextToken: params.contextToken } : {}),
  };

  const tmpPath = path.join(pendingDir, `.${job.id}.tmp`);
  const filePath = path.join(pendingDir, `${job.id}.json`);
  await fs.writeFile(tmpPath, JSON.stringify(job, null, 2) + "\n", {
    encoding: "utf-8",
    mode: INJECT_FILE_MODE,
  });
  await fs.chmod(tmpPath, INJECT_FILE_MODE).catch(() => {});
  await fs.rename(tmpPath, filePath);

  return { job, filePath };
}
