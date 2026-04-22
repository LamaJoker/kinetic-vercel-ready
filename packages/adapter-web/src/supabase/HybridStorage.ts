import type { StoragePort, StorageKey } from '@kinetic/core';

/**
 * HybridStorage — offline-first combination of:
 * - local (IndexedDB): source of truth for reads (fast + offline-safe)
 * - remote (Supabase): best-effort mirror for writes
 *
 * Strategy:
 * - get/keys: local only
 * - set: write local, then push remote in background
 * - if offline or remote fails: keep a small in-memory pending queue, flushed on 'online'
 *
 * Conflict handling:
 * - last-write-wins is handled server-side by SupabaseStorage timestamps.
 */

type PendingWrite = { key: StorageKey; value: unknown; attempts: number };

export class HybridStorage implements StoragePort {
  private pendingWrites = new Map<StorageKey, PendingWrite>();
  private flushing = false;

  constructor(
    private readonly local: StoragePort,
    private readonly remote: StoragePort,
  ) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        void this.flushPendingWrites();
      });
    }
  }

  async get<T>(key: StorageKey): Promise<T | null> {
    return this.local.get<T>(key);
  }

  async set<T>(key: StorageKey, value: T): Promise<void> {
    await this.local.set(key, value);

    if (!this.isOnline()) {
      this.queueWrite(key, value);
      return;
    }

    this.remote.set(key, value).catch((err: unknown) => {
      console.warn('[HybridStorage] remote sync failed for', key, err);
      this.queueWrite(key, value);
    });
  }

  async remove(key: StorageKey): Promise<void> {
    await this.local.remove(key);
    this.remote.remove(key).catch(() => undefined);
  }

  async keys(): Promise<readonly StorageKey[]> {
    return this.local.keys();
  }

  async clear(): Promise<void> {
    await this.local.clear();
    this.remote.clear().catch(() => undefined);
    this.pendingWrites.clear();
  }

  /**
   * syncFromRemote — pull everything from remote into local.
   * Called on startup when authenticated.
   */
  async syncFromRemote(): Promise<void> {
    if (!this.isOnline()) return;

    const remoteKeys = await this.remote.keys();
    const BATCH_SIZE = 20;

    for (let i = 0; i < remoteKeys.length; i += BATCH_SIZE) {
      const batch = remoteKeys.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (key) => {
          try {
            const value = await this.remote.get(key);
            if (value !== null) await this.local.set(key, value);
          } catch (err) {
            console.warn(`[HybridStorage] syncFromRemote failed for key "${key}":`, err);
          }
        }),
      );
    }
  }

  async flushPendingWrites(): Promise<void> {
    if (this.flushing) return;
    if (!this.isOnline()) return;
    if (this.pendingWrites.size === 0) return;

    this.flushing = true;
    try {
      const entries = [...this.pendingWrites.entries()];
      for (const [key, pending] of entries) {
        try {
          await this.remote.set(key, pending.value);
          this.pendingWrites.delete(key);
        } catch (err) {
          const nextAttempts = pending.attempts + 1;
          this.pendingWrites.set(key, { ...pending, attempts: nextAttempts });
          if (nextAttempts >= 3) {
            console.warn(`[HybridStorage] giving up after ${nextAttempts} attempts for key "${key}"`);
            this.pendingWrites.delete(key);
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private queueWrite(key: StorageKey, value: unknown): void {
    const prev = this.pendingWrites.get(key);
    this.pendingWrites.set(key, {
      key,
      value,
      attempts: prev?.attempts ?? 0,
    });
  }

  private isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine;
  }
}

