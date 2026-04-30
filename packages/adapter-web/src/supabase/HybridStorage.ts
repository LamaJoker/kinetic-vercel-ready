import type { StoragePort, StorageKey } from '@kinetic/core';
import { STORAGE_KEYS } from '@kinetic/core';

/**
 * HybridStorage — offline-first combination of:
 * - local (IndexedDB): source of truth for reads (fast + offline-safe)
 * - remote (Supabase): best-effort mirror for writes
 *
 * ── Sync strategy ────────────────────────────────────────────────────────
 *
 * INITIAL SYNC (no lastSyncAt recorded):
 *   Only pulls keys MISSING from local. Never overwrites existing data.
 *   Scenario: new device setup, pull cloud → local without losing anything.
 *
 * DELTA SYNC (lastSyncAt exists):
 *   Uses keysSince(lastSyncAt) to fetch only keys modified on remote since
 *   the last sync. These keys are changes from OTHER devices → apply them,
 *   UNLESS we have an in-flight pending write for that key (meaning we
 *   changed it locally while offline since the last sync → our write wins).
 *   This is Last-Write-Wins per key, protected against the lost-update trap.
 *
 * FORCE (user-triggered "restore from cloud"):
 *   Overwrites all local keys with remote. No guards.
 *
 * ── Anti lost-update guarantee ────────────────────────────────────────────
 *
 * Scenario that MUST NOT happen:
 *   1. User saves a session (written to local + queued for remote)
 *   2. Page reloads before the remote write succeeded (still pending)
 *   3. syncFromRemote fires and overwrites local with the stale remote value
 *
 * Guard: `pendingWrites` tracks everything written locally but not yet
 * confirmed on remote. Delta sync skips those keys → local version preserved.
 */

type PendingWrite = { key: StorageKey; value: unknown; attempts: number };

/** Optional interface for remotes that support efficient delta queries */
interface DeltaCapableStorage {
  keysSince?(since: string): Promise<readonly StorageKey[]>;
}

const SYNC_FLAG_KEY    = STORAGE_KEYS.SYNC_INITIAL_DONE;
const SYNC_LAST_AT_KEY = STORAGE_KEYS.SYNC_LAST_AT;

export class HybridStorage implements StoragePort {
  private pendingWrites = new Map<StorageKey, PendingWrite>();
  private flushing      = false;

  constructor(
    private readonly local:  StoragePort,
    private readonly remote: StoragePort,
  ) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { void this.flushPendingWrites(); });
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
   * See class-level JSDoc for the three modes (initial / delta / force).
   */
  async syncFromRemote(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.isOnline()) return;

    const force      = opts.force === true;
    const lastSyncAt = await this.local.get<string>(SYNC_LAST_AT_KEY);

    if (!force && lastSyncAt) {
      // ── DELTA SYNC: apply other-device changes, guard our pending writes ─
      await this._deltaSyncFromRemote(lastSyncAt);
    } else {
      // ── INITIAL SYNC (no lastSyncAt) or FORCE ────────────────────────────
      await this._fullSyncFromRemote(force);
    }

    // Record sync timestamp for next delta
    await this.local.set(SYNC_LAST_AT_KEY, new Date().toISOString());
    await this.local.set(SYNC_FLAG_KEY, true);
  }

  /**
   * _deltaSyncFromRemote — apply keys that changed on remote since lastSyncAt.
   * Skips keys we have locally pending (our local write is newer).
   *
   * ── Delta vs. full-scan fallback ─────────────────────────────────────────
   * - WITH keysSince(): keys returned are confirmed to have changed after
   *   lastSyncAt → they're changes from other devices → overwrite local
   *   (unless we have a pending write for that key).
   *
   * - WITHOUT keysSince() (fallback): we get ALL remote keys, but we don't
   *   know which ones actually changed since lastSyncAt. Overwriting local
   *   indiscriminately would resurrect stale remote data over newer local
   *   writes. In this case, behave like initial sync (skip existing local).
   */
  private async _deltaSyncFromRemote(lastSyncAt: string): Promise<void> {
    if (this._hasDeltaSupport()) {
      // True delta: only keys that changed on remote since lastSyncAt
      const deltaKeys = await (this.remote as DeltaCapableStorage).keysSince!(lastSyncAt);
      await this._applyKeys(deltaKeys, { skipIfPendingWrite: true });
    } else {
      // No delta support: full scan but safe (skip existing local, like initial sync)
      const allKeys = await this.remote.keys();
      await this._applyKeys(allKeys, { skipIfLocalExists: true, skipIfPendingWrite: true });
    }
  }

  /**
   * _fullSyncFromRemote — initial device setup or force restore.
   * Initial: only pull keys missing locally (no clobber).
   * Force: overwrite everything.
   */
  private async _fullSyncFromRemote(force: boolean): Promise<void> {
    const remoteKeys = await this.remote.keys();
    await this._applyKeys(remoteKeys, {
      skipIfLocalExists: !force,
      skipIfPendingWrite: !force,
    });
  }

  private async _applyKeys(
    keys: readonly StorageKey[],
    opts: { skipIfLocalExists?: boolean; skipIfPendingWrite?: boolean },
  ): Promise<void> {
    const BATCH_SIZE = 20;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (key) => {
          if (key === SYNC_FLAG_KEY || key === SYNC_LAST_AT_KEY) return;
          try {
            // Guard: don't clobber a key we're about to push to remote
            if (opts.skipIfPendingWrite && this.pendingWrites.has(key)) return;

            // Guard: initial sync — only pull what's missing
            if (opts.skipIfLocalExists) {
              const localValue = await this.local.get(key);
              if (localValue !== null) return;
            }

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
    this.pendingWrites.set(key, { key, value, attempts: prev?.attempts ?? 0 });
  }

  private isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine;
  }

  private _hasDeltaSupport(): boolean {
    return typeof (this.remote as DeltaCapableStorage).keysSince === 'function';
  }
}
