/**
 * Anonymous usage telemetry via Azure Application Insights.
 *
 * Privacy:
 *   - No message content, filenames, transcripts, URLs, tokens, or paths are collected.
 *   - WeChat user IDs are sha256-hashed with a per-install salt and truncated.
 *   - Only the categorical events declared in `EventName` are emitted.
 *
 * Disable: set environment variable `WECHAT_ACP_TELEMETRY=0` (or `false` / `off`).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Hard-coded connection string. Replace with the project's Application Insights
// resource connection string before shipping.
const CONNECTION_STRING =
  "InstrumentationKey=94c435ed-3c7a-4428-862e-b8648d9fb199;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=02dd3391-f729-4208-90e7-28edf7f50d1e";

export type EventName =
  | "app.start"
  | "app.stop"
  | "login.success"
  | "login.failure"
  | "token.reused"
  | "message.received"
  | "message.injected"
  | "session.created"
  | "prompt.completed"
  | "reply.sent";

type PropValue = string | number | boolean;

interface AppInsightsClient {
  trackEvent(t: {
    name: string;
    properties?: Record<string, unknown>;
    tagOverrides?: Record<string, string>;
  }): void;
  trackException(t: {
    exception: Error;
    properties?: Record<string, unknown>;
    tagOverrides?: Record<string, string>;
  }): void;
  flush(opts?: { callback?: (msg: string) => void }): void;
  context: { tags: Record<string, string>; keys: { cloudRole: string; userId: string } };
  commonProperties: Record<string, string>;
}

let client: AppInsightsClient | null = null;
let installId = "";
let disabled = false;

function isDisabledByEnv(): boolean {
  const v = (process.env.WECHAT_ACP_TELEMETRY ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

function loadOrCreateInstallId(storageDir: string): string {
  const idFile = path.join(storageDir, "telemetry-id");
  try {
    if (fs.existsSync(idFile)) {
      const existing = fs.readFileSync(idFile, "utf-8").trim();
      if (existing) return existing;
    }
    const id = crypto.randomUUID();
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(idFile, id, "utf-8");
    return id;
  } catch {
    // Storage not writable — fall back to ephemeral per-process id.
    return crypto.randomUUID();
  }
}

/**
 * Initialize telemetry. Safe to call once at startup.
 * Becomes a no-op (sync) when telemetry is disabled or initialization fails.
 */
export function initTelemetry(opts: {
  version: string;
  storageDir: string;
  agentPreset?: string;
  daemon?: boolean;
}): void {
  if (isDisabledByEnv()) {
    disabled = true;
    return;
  }

  try {
    installId = loadOrCreateInstallId(opts.storageDir);

    // Lazy-load the SDK so disabled installs don't pay any cost.
    // Cast through `unknown` so the type stays opaque even if the package
    // isn't yet installed at type-check time.
    const appInsights = require("applicationinsights") as unknown as {
      setup: (cs: string) => {
        setAutoCollectRequests: (b: boolean) => any;
        setAutoCollectPerformance: (b: boolean) => any;
        setAutoCollectExceptions: (b: boolean) => any;
        setAutoCollectDependencies: (b: boolean) => any;
        setAutoCollectConsole: (b: boolean) => any;
        setSendLiveMetrics: (b: boolean) => any;
        setInternalLogging: (a: boolean, b: boolean) => any;
        start: () => any;
      };
      defaultClient: AppInsightsClient;
    };

    appInsights
      .setup(CONNECTION_STRING)
      .setAutoCollectRequests(false)
      .setAutoCollectPerformance(false)
      .setAutoCollectExceptions(false)
      .setAutoCollectDependencies(false)
      .setAutoCollectConsole(false)
      .setSendLiveMetrics(false)
      .setInternalLogging(false, false)
      .start();

    const c = appInsights.defaultClient as unknown as AppInsightsClient;
    // Static envelope tags. These attach to every outgoing event automatically
    // — no need to repeat them per-event.
    c.context.tags[c.context.keys.cloudRole] = "wechat-acp";
    c.context.tags[c.context.keys.userId] = installId;
    c.context.tags["ai.application.ver"] = opts.version;
    // commonProperties is auto-merged into every event's customDimensions.
    c.commonProperties = {
      version: opts.version,
      node: process.version,
      os: process.platform,
      arch: process.arch,
      installId,
      ...(opts.agentPreset ? { agentPreset: opts.agentPreset } : {}),
      ...(opts.daemon !== undefined ? { daemon: String(opts.daemon) } : {}),
    };
    client = c;
  } catch {
    // Telemetry must never break the app.
    client = null;
    disabled = true;
  }
}

/**
 * Build per-event tagOverrides. Only the session id varies per call; cloud
 * role, user id, and application version are pinned once on `context.tags`
 * at init time.
 */
function buildTagOverrides(sessionId?: string): Record<string, string> {
  // Fall back to installId so app-lifecycle events (no per-user context) still
  // have a stable, non-null session id rather than collapsing into one global
  // bucket across all installs.
  return { "ai.session.id": sessionId && sessionId.length > 0 ? sessionId : installId };
}

export function trackEvent(
  name: EventName,
  props?: Record<string, PropValue>,
  sessionId?: string,
): void {
  if (disabled || !client) return;
  try {
    const properties: Record<string, string> = {};
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        properties[k] = typeof v === "string" ? v : String(v);
      }
    }
    client.trackEvent({ name, properties, tagOverrides: buildTagOverrides(sessionId) });
  } catch {
    // ignore
  }
}

export function trackException(err: unknown, area: string, sessionId?: string): void {
  if (disabled || !client) return;
  try {
    const exception = err instanceof Error ? err : new Error(String(err));
    client.trackException({
      exception,
      properties: { area },
      tagOverrides: buildTagOverrides(sessionId),
    });
  } catch {
    // ignore
  }
}

/**
 * Hash a WeChat user id with the install salt so it's stable per-install
 * but cannot be linked across installs and cannot be reversed to the raw id.
 */
export function hashUserId(userId: string): string {
  if (!userId) return "";
  const salt = installId || "wechat-acp";
  return crypto.createHash("sha256").update(salt).update(userId).digest("hex").slice(0, 16);
}

/** Flush pending telemetry, with at most ~2s wait. */
export async function shutdownTelemetry(): Promise<void> {
  if (disabled || !client) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      client!.flush({ callback: () => done() });
    } catch {
      done();
      return;
    }
    setTimeout(done, 2_000).unref();
  });
}
