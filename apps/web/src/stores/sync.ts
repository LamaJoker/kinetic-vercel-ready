/**
 * Store Alpine `sync` — état de synchronisation (docs/architecture/sync.md § 4.9).
 * Alimenté par l'événement `kinetic:sync-status` publié par SyncedStorage.
 * Usage : <span x-text="$store.sync.label"></span>
 */
import {
  STORAGE_KEYS,
  EMPTY_SYNC_STATUS,
  isCloudBackedUp,
  syncReasonLabel,
  syncStatusLabel,
  type SyncStatus,
} from '@kinetic/core';
import { getSyncedStorage } from '../deps';

const TIME_FMT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const DAY_FMT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

/** « aujourd'hui 14:32 » / « 3 nov. 14:32 » (français). */
export function formatSyncTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('fr-FR', TIME_FMT);
  return d.toDateString() === now.toDateString()
    ? `aujourd’hui ${time}`
    : `${d.toLocaleDateString('fr-FR', DAY_FMT)} ${time}`;
}

export function syncStore() {
  return {
    status: EMPTY_SYNC_STATUS as SyncStatus,
    busy: false,
    _onStatus: null as ((ev: Event) => void) | null,

    init(): void {
      this._onStatus = (ev: Event) => {
        const detail = (ev as CustomEvent<SyncStatus>).detail;
        if (detail && typeof detail === 'object') this.status = detail;
      };
      window.addEventListener(STORAGE_KEYS.EVENT_SYNC_STATUS, this._onStatus);
    },

    destroy(): void {
      if (this._onStatus)
        window.removeEventListener(STORAGE_KEYS.EVENT_SYNC_STATUS, this._onStatus);
      this._onStatus = null;
    },

    get enabled(): boolean {
      return this.status.enabled;
    },

    get label(): string {
      return syncStatusLabel(this.status);
    },

    get pending(): number {
      return this.status.pending;
    },

    get hasBlocked(): boolean {
      return this.status.blocked.length > 0;
    },

    /** Entrées bloquées, avec un libellé français par raison. */
    get blockedItems(): Array<{ key: string; label: string }> {
      return this.status.blocked.map((b) => ({ key: b.key, label: syncReasonLabel(b.reason) }));
    },

    get recoveryCount(): number {
      return this.status.recovery;
    },

    get isError(): boolean {
      return this.status.state === 'error' || this.status.state === 'auth_required';
    },

    get lastSyncLabel(): string {
      const last = [this.status.lastPushAt, this.status.lastPullAt]
        .filter((x): x is string => typeof x === 'string')
        .sort()
        .pop();
      const when = formatSyncTime(last ?? null);
      return when ? `Dernière synchronisation : ${when}` : 'Pas encore synchronisé';
    },

    /** Données réellement sauvegardées dans le cloud (rappel de sauvegarde, F6). */
    get cloudBackedUp(): boolean {
      return isCloudBackedUp(this.status);
    },

    /** « Synchroniser maintenant ». */
    async syncNow(): Promise<void> {
      if (this.busy) return;
      this.busy = true;
      try {
        const storage = await getSyncedStorage();
        await storage?.sync({ ignoreBackoff: true });
        await storage?.publishStatus();
      } catch (err) {
        console.warn('[sync] synchronisation manuelle :', err);
      } finally {
        this.busy = false;
      }
    },

    /** « Réessayer » les éléments bloqués. */
    async retryBlocked(): Promise<void> {
      if (this.busy) return;
      this.busy = true;
      try {
        const storage = await getSyncedStorage();
        await storage?.retryBlocked();
        await storage?.publishStatus();
      } catch (err) {
        console.warn('[sync] nouvel essai :', err);
      } finally {
        this.busy = false;
      }
    },
  };
}
