import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentFile,
  AgentResourceLink,
  MAX_AGENT_FILE_BYTES,
} from "./types.js";

const DEFAULT_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface StoredArtifact {
  data: Buffer;
  name: string;
  mimeType: string;
  byteLength: number;
  expiresAt: number;
}

export interface ArtifactStoreOptions {
  rootDir: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
}

export interface PublishedArtifact {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly rootDir: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;
  private fileReadChain: Promise<void> = Promise.resolve();
  private totalBytes = 0;

  private constructor(rootDir: string, options: ArtifactStoreOptions) {
    this.rootDir = rootDir;
    this.maxFileBytes = options.maxFileBytes ?? MAX_AGENT_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_TOTAL_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.cleanupTimer = setInterval(() => this.purgeExpired(), 60_000);
    this.cleanupTimer.unref();
  }

  static async create(options: ArtifactStoreOptions): Promise<ArtifactStore> {
    const rootDir = await fs.realpath(options.rootDir);
    const stat = await fs.stat(rootDir);
    if (!stat.isDirectory()) {
      throw new Error("Artifact root is not a directory");
    }
    return new ArtifactStore(rootDir, options);
  }

  async publish(
    filePath: string,
    requestedName?: string,
  ): Promise<PublishedArtifact> {
    return this.withFileReadLock(async () => {
      this.purgeExpired();
      const file = await this.readAllowedFile(filePath, (size) => {
        if (this.totalBytes + size > this.maxTotalBytes) {
          throw new Error(
            `Artifact store capacity exceeded (${this.maxTotalBytes} bytes)`,
          );
        }
      });

      const id = randomUUID();
      const name = sanitizeFileName(
        requestedName ?? path.basename(file.realPath),
      );
      const mimeType = inferMimeType(name);
      this.artifacts.set(id, {
        data: file.data,
        name,
        mimeType,
        byteLength: file.byteLength,
        expiresAt: Date.now() + this.ttlMs,
      });
      this.totalBytes += file.byteLength;

      return {
        uri: `wechat-acp://artifact/${id}`,
        name,
        mimeType,
        size: file.byteLength,
      };
    });
  }

  async resolveResourceLink(
    link: AgentResourceLink,
  ): Promise<AgentFile | null> {
    if (link.uri.startsWith("wechat-acp://artifact/")) {
      return this.consume(link.uri.slice("wechat-acp://artifact/".length));
    }

    let filePath: string;
    try {
      filePath = link.uri.startsWith("file:")
        ? fileURLToPath(link.uri)
        : link.uri;
    } catch {
      return null;
    }
    if (!path.isAbsolute(filePath)) return null;

    return this.withFileReadLock(async () => {
      const file = await this.readAllowedFile(filePath);
      const name = sanitizeFileName(link.name ?? path.basename(file.realPath));
      return {
        data: file.data.toString("base64"),
        name,
        mimeType: link.mimeType ?? inferMimeType(name),
      };
    });
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    this.artifacts.clear();
    this.totalBytes = 0;
  }

  private consume(id: string): AgentFile | null {
    this.purgeExpired();
    const artifact = this.artifacts.get(id);
    if (!artifact) return null;
    this.artifacts.delete(id);
    this.totalBytes -= artifact.byteLength;
    return {
      data: artifact.data.toString("base64"),
      name: artifact.name,
      mimeType: artifact.mimeType,
    };
  }

  private async readAllowedFile(
    filePath: string,
    beforeRead?: (size: number) => void,
  ): Promise<{
    data: Buffer;
    byteLength: number;
    realPath: string;
  }> {
    const candidate = path.resolve(this.rootDir, filePath);
    const realPath = await fs.realpath(candidate);
    const relative = path.relative(this.rootDir, realPath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("File is outside the allowed workspace");
    }

    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await fs.open(realPath, constants.O_RDONLY | noFollow);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Path is not a regular file");
      if (stat.size > this.maxFileBytes) {
        throw new Error(`File exceeds the ${this.maxFileBytes} byte limit`);
      }
      beforeRead?.(stat.size);

      const allocated = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < allocated.byteLength) {
        const { bytesRead } = await handle.read(
          allocated,
          offset,
          allocated.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const data =
        offset === allocated.byteLength
          ? allocated
          : Buffer.from(allocated.subarray(0, offset));
      return { data, byteLength: data.byteLength, realPath };
    } finally {
      await handle.close();
    }
  }

  private withFileReadLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.fileReadChain.then(task);
    this.fileReadChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, artifact] of this.artifacts) {
      if (artifact.expiresAt > now) continue;
      this.artifacts.delete(id);
      this.totalBytes -= artifact.byteLength;
    }
  }
}

export function sanitizeFileName(name: string): string {
  const sanitized = path
    .basename(name)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 255);
  return sanitized || "artifact";
}

export function inferMimeType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".aac": "audio/aac",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".tar": "application/x-tar",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".zip": "application/zip",
  };
  return mimeTypes[extension] ?? "application/octet-stream";
}
