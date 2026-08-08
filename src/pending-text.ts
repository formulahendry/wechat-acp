export interface PendingTextSnapshot {
  generation: number;
  segments: string[];
}

interface PendingTextEntry {
  generation: number;
  segments: string[];
  expiresAt: number;
  contexts: Map<string, number>;
  lastUsedAt: number;
}

export interface PendingTextRegistryOptions {
  ttlMs: number;
  maxUsers: number;
  maxSegmentsPerUser: number;
  maxContextsPerUser?: number;
  now?: () => number;
}

/**
 * Bounded in-memory storage for failed text segments. Prompt generations keep
 * late failures from an older turn from restoring output after a newer prompt.
 */
export class PendingTextRegistry {
  private readonly entries = new Map<string, PendingTextEntry>();
  private readonly now: () => number;
  private readonly maxContextsPerUser: number;

  constructor(private readonly options: PendingTextRegistryOptions) {
    this.now = options.now ?? Date.now;
    this.maxContextsPerUser = options.maxContextsPerUser ?? 50;
  }

  supersede(userId: string, contextToken: string): number {
    const entry = this.getOrCreateEntry(userId);
    entry.generation++;
    entry.segments = [];
    entry.expiresAt = 0;
    entry.lastUsedAt = this.now();
    entry.contexts.set(contextToken, entry.generation);
    while (entry.contexts.size > this.maxContextsPerUser) {
      const oldest = entry.contexts.keys().next().value;
      if (oldest === undefined) break;
      entry.contexts.delete(oldest);
    }
    return entry.generation;
  }

  generationForContext(userId: string, contextToken: string): number | undefined {
    const entry = this.entries.get(userId);
    if (!entry) return undefined;
    entry.lastUsedAt = this.now();
    return entry.contexts.get(contextToken);
  }

  recordFailures(userId: string, generation: number, segments: string[]): boolean {
    if (segments.length === 0) return true;
    const entry = this.entries.get(userId);
    if (!entry || entry.generation !== generation) return false;
    entry.segments = [...entry.segments, ...segments].slice(0, this.options.maxSegmentsPerUser);
    entry.expiresAt = this.now() + this.options.ttlMs;
    entry.lastUsedAt = this.now();
    return true;
  }

  snapshot(userId: string): PendingTextSnapshot | null {
    const entry = this.entries.get(userId);
    if (!entry) return null;
    entry.lastUsedAt = this.now();
    if (entry.expiresAt > 0 && entry.expiresAt <= this.now()) {
      entry.segments = [];
      entry.expiresAt = 0;
    }
    if (entry.segments.length === 0) return null;
    return { generation: entry.generation, segments: [...entry.segments] };
  }

  replace(userId: string, generation: number, segments: string[]): boolean {
    const entry = this.entries.get(userId);
    if (!entry || entry.generation !== generation) return false;
    entry.segments = segments.slice(0, this.options.maxSegmentsPerUser);
    entry.expiresAt = entry.segments.length > 0 ? this.now() + this.options.ttlMs : 0;
    entry.lastUsedAt = this.now();
    return true;
  }

  private getOrCreateEntry(userId: string): PendingTextEntry {
    const existing = this.entries.get(userId);
    if (existing) return existing;
    while (this.entries.size >= this.options.maxUsers) {
      let oldestUser: string | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [candidateUser, entry] of this.entries) {
        if (entry.lastUsedAt < oldestTime) {
          oldestTime = entry.lastUsedAt;
          oldestUser = candidateUser;
        }
      }
      if (oldestUser === undefined) break;
      this.entries.delete(oldestUser);
    }
    const entry: PendingTextEntry = {
      generation: 0,
      segments: [],
      expiresAt: 0,
      contexts: new Map(),
      lastUsedAt: this.now(),
    };
    this.entries.set(userId, entry);
    return entry;
  }
}

export interface DrainPendingTextResult {
  pendingCount: number;
  sentCount: number;
  remainingCount: number;
}

export async function drainPendingText(
  registry: PendingTextRegistry,
  userId: string,
  send: (segment: string) => Promise<boolean>,
): Promise<DrainPendingTextResult> {
  const snapshot = registry.snapshot(userId);
  if (!snapshot) {
    return { pendingCount: 0, sentCount: 0, remainingCount: 0 };
  }

  let sentCount = 0;
  for (let index = 0; index < snapshot.segments.length; index++) {
    if (!(await send(snapshot.segments[index]!))) {
      const remainder = snapshot.segments.slice(index);
      const retained = registry.replace(userId, snapshot.generation, remainder);
      return {
        pendingCount: snapshot.segments.length,
        sentCount,
        remainingCount: retained ? remainder.length : 0,
      };
    }
    sentCount++;
  }

  registry.replace(userId, snapshot.generation, []);
  return {
    pendingCount: snapshot.segments.length,
    sentCount,
    remainingCount: 0,
  };
}
