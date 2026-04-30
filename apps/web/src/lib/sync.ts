/**
 * apps/web/src/lib/sync.ts
 *
 * CRDT Vector Clock pour la résolution de conflits multi-device.
 *
 * Les types et fonctions CRDT vivaient ici en doublon de packages/core/src/crdt.ts.
 * Ce fichier re-exporte désormais depuis @kinetic/core pour éviter toute divergence.
 *
 * SyncedValue<T> est un alias de CRDTValue<T> pour la rétro-compatibilité avec
 * le code qui l'importait depuis ce fichier.
 */

// ── Tous les imports en haut ─────────────────────────────────────────────
import {
  createClock,
  incrementClock,
  mergeClock,
  compareClocks,
  resolveConflict,
  STORAGE_KEYS,
} from '@kinetic/core';
import type {
  VectorClock,
  ClockComparison,
  CRDTValue,
  StoragePort,
} from '@kinetic/core';

// ── Re-exports pour les consommateurs de ce module ────────────────────────
export { createClock, incrementClock, mergeClock, compareClocks, resolveConflict };
export type { VectorClock, ClockComparison as CausalOrder };
// Alias rétro-compat : CRDTValue était nommé SyncedValue ici
export type { CRDTValue as SyncedValue };

// ── Device Identity ───────────────────────────────────────────────────────

export type DeviceId = string;

/**
 * getOrCreateDeviceId — retourne le device ID persisté en localStorage.
 *
 * Note: localStorage est utilisé intentionnellement (pas IDB) pour que
 * le device ID survive à un clear() de la base IndexedDB. Il est aussi
 * synchrone, ce qui le rend utilisable avant l'init async des stores.
 *
 * Ne pas appeler en contexte SSR — vérifier `typeof window !== 'undefined'`.
 */
export function getOrCreateDeviceId(): DeviceId {
  if (typeof window === 'undefined') {
    // SSR / test context — retourne un ID stable temporaire
    return 'server-0000-0000-0000-000000000000';
  }
  let id = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEYS.DEVICE_ID, id);
  }
  return id;
}

// ── Sync Manager ──────────────────────────────────────────────────────────

interface SyncMeta {
  lastSyncAt: string;
  deviceId:   DeviceId;
  clock:      VectorClock;
}

interface PendingWrite {
  key:         string;
  value:       unknown;
  syncedValue: CRDTValue<unknown>;
  retries:     number;
}

const SYNC_META_KEY      = STORAGE_KEYS.SYNC_LAST_AT;
const PENDING_WRITES_KEY = 'kinetic:sync:pending';

export class SyncManager {
  private readonly deviceId: DeviceId;
  private clock:             VectorClock;
  private pendingWrites      = new Map<string, PendingWrite>();
  private syncTimer:         ReturnType<typeof setTimeout> | null = null;
  private isSyncing          = false;

  constructor(
    private readonly local:  StoragePort,
    private readonly remote: StoragePort,
  ) {
    this.deviceId = getOrCreateDeviceId();
    this.clock    = createClock(this.deviceId);
  }

  async initialize(): Promise<void> {
    const meta = await this.local.get<SyncMeta>(SYNC_META_KEY);
    if (meta) this.clock = meta.clock;

    const pending = await this.local.get<[string, PendingWrite][]>(PENDING_WRITES_KEY);
    if (pending) this.pendingWrites = new Map(pending);

    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'SYNC_REQUESTED') {
          this.scheduleSyncFlush();
        }
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { void this.syncFromRemote(); });
    }
  }

  async write<T>(key: string, value: T): Promise<void> {
    this.clock = incrementClock(this.clock, this.deviceId);

    const syncedValue: CRDTValue<T> = {
      value,
      clock:    { ...this.clock },
      deviceId: this.deviceId,
      wallTime: Date.now(),
    };

    await this.local.set(key, syncedValue);

    this.pendingWrites.set(key, { key, value, syncedValue, retries: 0 });
    await this._savePendingWrites();

    this.scheduleSyncFlush();
  }

  async read<T>(key: string): Promise<T | null> {
    const synced = await this.local.get<CRDTValue<T>>(key);
    return synced?.value ?? null;
  }

  async syncFromRemote(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const remoteKeys = await this.remote.keys();

      await Promise.all(
        remoteKeys.map(async (key) => {
          const remoteValue = await this.remote.get<CRDTValue<unknown>>(key);
          if (!remoteValue?.clock) return;

          const localValue = await this.local.get<CRDTValue<unknown>>(key);

          if (!localValue) {
            await this.local.set(key, remoteValue);
            return;
          }

          const winner = resolveConflict(localValue, remoteValue);
          await this.local.set(key, winner);

          this.clock = mergeClock(this.clock, remoteValue.clock);
        }),
      );

      const meta: SyncMeta = {
        lastSyncAt: new Date().toISOString(),
        deviceId:   this.deviceId,
        clock:      this.clock,
      };
      await this.local.set(SYNC_META_KEY, meta);

    } finally {
      this.isSyncing = false;
    }
  }

  private scheduleSyncFlush(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => { void this.flushPendingWrites(); }, 2000);
  }

  private async flushPendingWrites(): Promise<void> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (this.pendingWrites.size === 0) return;

    const MAX_RETRIES = 3;

    for (const [key, pending] of this.pendingWrites) {
      try {
        await this.remote.set(key, pending.syncedValue);
        this.pendingWrites.delete(key);
      } catch {
        pending.retries++;
        if (pending.retries >= MAX_RETRIES) {
          console.warn(`[Sync] Abandon après ${MAX_RETRIES} tentatives pour`, key);
          this.pendingWrites.delete(key);
        }
      }
    }

    await this._savePendingWrites();
  }

  private async _savePendingWrites(): Promise<void> {
    await this.local.set(
      PENDING_WRITES_KEY,
      [...this.pendingWrites.entries()],
    );
  }
}
