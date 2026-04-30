import type { StoragePort, StorageKey } from '@kinetic/core';
import { STORAGE_KEYS } from '@kinetic/core';

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
 * syncFromRemote:
 * - DELTA SYNC by default: fetches only keys changed since lastSyncAt using
 *   the remote.keysSince(timestamp) API when available, falling back to full
 *   keys() scan. This prevents the N+1 query problem on large datasets.
 * - SAFE BY DEFAULT: never overwrites existing local data.
 *   Only pulls keys that are missing locally (initial sync on a new device).
 * - Use { force: true } only for an explicit user-triggered "pull from cloud".
 */

type PendingWrite = { key: StorageKey; value: unknown; attempts: number };

/** Remote that supports delta sync (optional interface) */
interface DeltaCapableStorage {
  keysSince?(since: string): Promise<readonly StorageKey[]>;
}

const SYNC_FLAG_KEY = STORAGE_KEYS.SYNC_INITIAL_DONE;
const SYNC_LAST_AT_KEY = STORAGE_KEYS.SYNC_LAST_AT;

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
   * syncFromRemote — pull changes from remote into local.
   *
   * Delta mode (default):
   *   Uses lastSyncAt timestamp to fetch only keys modified since last sync.
   *   Falls back to full scan if no lastSyncAt recorded (first sync ever).
   *   Only pulls keys that DO NOT exist locally (prevents lost-update on reload).
   *
   * Force mode ({ force: true }):
   *   Pulls every remote key and overwrites local. Reserved for explicit
   *   user-triggered "restore from cloud" action.
   */
  async syncFromRemote(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.isOnline()) return;

    const force = opts.force === true;
    const lastSyncAt = await this.local.get<string>(SYNC_LAST_AT_KEY);

    // ── Delta sync: fetch only keys changed since last sync ──────────────
    let keysToSync: readonly StorageKey[];

    if (!force && lastSyncAt && this._hasDeltaSupport()) {
      // Remote supports delta queries — avoids N+1 on large datasets
      keysToSync = await (this.remote as DeltaCapableStorage).keysSince!(lastSyncAt);
    } else {
      // Fallback: full scan (first sync, or remote doesn't support delta)
      keysToSync = await this.remote.keys();
    }

    // ── Apply changes in batches of 20 ──────────────────────────────────
    const BATCH_SIZE = 20;
    for (let i = 0; i < keysToSync.length; i += BATCH_SIZE) {
      const batch = keysToSync.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (key) => {
          // Skip internal sync meta keys
          if (key === SYNC_FLAG_KEY || key === SYNC_LAST_AT_KEY) return;
          try {
            if (!force) {
              const localValue = await this.local.get(key);
              if (localValue !== null) return; // ← never clobber local data
            }
            const value = await this.remote.get(key);
            if (value !== null) await this.local.set(key, value);
          } catch (err) {
            console.warn(`[HybridStorage] syncFromRemote failed for key "${key}":`, err);
          }
        }),
      );
    }

    // ── Record sync timestamp for next delta ─────────────────────────────
    const now = new Date().toISOString();
    await this.local.set(SYNC_LAST_AT_KEY, now);
    await this.local.set(SYNC_FLAG_KEY, true);
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

  private _hasDeltaSupport(): boolean {
    return typeof (this.remote as DeltaCapableStorage).keysSince === 'function';
  }
}
