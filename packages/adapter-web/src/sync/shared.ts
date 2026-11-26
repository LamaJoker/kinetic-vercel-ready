/**
 * Outils partagés par la base synchronisée (SyncedStorage) et le moteur de synchro
 * (engine.ts, chargé à la demande).
 */
import type { GuestMergePlan, MergeRegistry, StorageWrite, SyncKeyState } from '@kinetic/core';
import type { LocalSyncDb, OutboxEntry } from './local-db.js';
import type { SyncRemote } from './remote.js';

export const META_PULL_MODE = 'pullMode';
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

export type PullMode = 'delta' | 'full' | 'reconcile' | 'resync';

export function backoffDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 1_000, MAX_BACKOFF_MS);
}

/** Copie JSON « plate » (les Proxy réactifs d'Alpine sont refusés par IndexedDB). */
export function toPlain(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export function stateOf(value: unknown): SyncKeyState {
  return value === undefined ? { deleted: true } : { deleted: false, value };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function newEntry(
  op: OutboxEntry['op'],
  base: string | null,
  now: number,
  extra: Partial<OutboxEntry> = {},
): OutboxEntry {
  return {
    op,
    base,
    rev: 1,
    attempts: 0,
    nextTryAt: 0,
    state: 'pending',
    queuedAt: now,
    origin: 'app',
    ...extra,
  };
}

/** Remet une entrée en attente (nouvelle écriture locale, résolution de conflit). */
export function rearm(entry: OutboxEntry, patch: Partial<OutboxEntry>): OutboxEntry {
  const next: OutboxEntry = { ...entry, ...patch, state: 'pending' };
  delete next.reason;
  return next;
}

export interface MergeModule {
  registry: MergeRegistry;
  planGuestMerge(
    guestEntries: Iterable<readonly [string, unknown]>,
    account: ReadonlyMap<string, unknown>,
    nowIso: string,
  ): GuestMergePlan;
}

/** État mutable partagé entre la base et le moteur (affiché par getStatus). */
export interface EngineState {
  busy: number;
  authRequired: boolean;
  pushError: string | null;
  pullError: string | null;
}

/** Ce que le moteur utilise de SyncedStorage. */
export interface EngineHost {
  readonly db: LocalSyncDb;
  readonly remote: SyncRemote | null;
  readonly owner: string;
  readonly pageSize: number;
  readonly batchMaxItems: number;
  readonly batchMaxBytes: number;
  readonly state: EngineState;
  now(): number;
  isOnline(): boolean;
  isDisposed(): boolean;
  emit(name: string, detail: unknown): void;
  broadcast(keys: string[], kind: 'write' | 'pull' | 'clear'): void;
  scheduleStatus(): void;
  getRegistry(): Promise<MergeRegistry>;
  getMergeModule(): Promise<MergeModule | null>;
  setMany(writes: readonly StorageWrite[]): Promise<void>;
  isInitialPullDone(): Promise<boolean>;
  /** L'app a lu ou écrit `key` dans ce processus (sa vue peut devenir périmée). */
  observes(key: string): boolean;
  /**
   * La synchro modifie `key` dans `kv` (appelé DANS la transaction, avant l'écriture) ;
   * `before` = état de la clé juste avant. Sert à reconnaître une écriture de l'app
   * fondée sur un état périmé (SyncedStorage.setMany).
   */
  remoteTouched(key: string, before: SyncKeyState): void;
}
