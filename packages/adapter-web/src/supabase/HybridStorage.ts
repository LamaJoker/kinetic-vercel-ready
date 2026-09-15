import type { StoragePort, StorageKey } from '@kinetic/core';
import { STORAGE_KEYS } from '@kinetic/core';

/**
 * HybridStorage — stockage offline-first :
 * - `local` (IndexedDB) : source de vérité pour les lectures (rapide, hors-ligne) ;
 * - `remote` (Supabase) : miroir cloud, alimenté par une OUTBOX persistante.
 *
 * ── Garanties ────────────────────────────────────────────────────────────
 *
 * 1. Aucune écriture perdue au reload / kill de l'app.
 *    Chaque set/remove est inscrit dans une outbox persistée en IndexedDB
 *    (clé `SYNC_OUTBOX`) AVANT de rendre la main. L'outbox est rechargée au
 *    démarrage (`ready`) et rejouée dès que le réseau le permet.
 *
 * 2. Pas d'abandon silencieux.
 *    Un échec distant replanifie l'entrée avec un backoff exponentiel (max 5 min).
 *    Au 3e échec consécutif on émet `EVENT_SYNC_FAILED` pour l'UI, mais l'entrée
 *    reste dans l'outbox jusqu'au succès.
 *
 * 3. Suppressions propagées (tombstones).
 *    `remove()` est une opération de l'outbox comme `set()` : une donnée supprimée
 *    hors-ligne ne ressuscite pas sur les autres appareils.
 *
 * 4. Delta sync sur horloge SERVEUR.
 *    Si le remote expose `pullChanges()` (RPC `sync_pull`), le curseur est le
 *    `updated_at` maximal renvoyé par Postgres — insensible au décalage d'horloge
 *    du téléphone. Une fenêtre de recouvrement de 5 s couvre les transactions
 *    commitées en retard (ré-appliquer une valeur identique est idempotent).
 *
 * 5. Les écritures locales non confirmées gagnent.
 *    Une clé présente dans l'outbox n'est jamais écrasée par une valeur distante.
 *
 * Résolution de conflit : Last-Write-Wins PAR CLÉ. C'est pour cela que les
 * collections volumineuses (séances) sont stockées une clé par élément.
 */

type OutboxOp = 'set' | 'remove';

interface OutboxEntry {
  op: OutboxOp;
  attempts: number;
  /** Timestamp (ms) avant lequel on ne retente pas. */
  nextTryAt: number;
  /** Incrémenté à chaque nouvelle écriture locale sur la clé (anti lost-update pendant un flush). */
  rev: number;
}

export interface RemoteChange {
  key: StorageKey;
  value: unknown;
  updatedAt: string;
}

/** Remote capable de renvoyer valeurs + horodatage serveur en une requête paginée. */
export interface PullCapableStorage {
  /**
   * Renvoie les changements strictement après (since, afterKey), triés par
   * (updatedAt, key). Renvoie `null` si le serveur ne supporte pas l'opération
   * (migration non appliquée) → HybridStorage bascule sur le mode legacy.
   */
  pullChanges(since: string, afterKey: string, limit: number): Promise<RemoteChange[] | null>;
}

/** Remote legacy capable de lister les clés modifiées depuis une date. */
interface DeltaCapableStorage {
  keysSince?(since: string): Promise<readonly StorageKey[]>;
}

export interface HybridStorageOptions {
  /** Horloge injectable (tests). */
  now?: () => number;
  /** Planification du retry automatique ; `null` pour désactiver (tests). */
  scheduleRetry?: ((fn: () => void, delayMs: number) => unknown) | null;
}

const OUTBOX_KEY = STORAGE_KEYS.SYNC_OUTBOX;
const CURSOR_KEY = STORAGE_KEYS.SYNC_CURSOR;
const SYNC_FLAG_KEY = STORAGE_KEYS.SYNC_INITIAL_DONE;
const SYNC_LAST_AT_KEY = STORAGE_KEYS.SYNC_LAST_AT;

/** Clés purement locales : jamais poussées, jamais tirées du cloud. */
const LOCAL_ONLY_KEYS: ReadonlySet<string> = new Set([
  OUTBOX_KEY,
  CURSOR_KEY,
  SYNC_FLAG_KEY,
  SYNC_LAST_AT_KEY,
  STORAGE_KEYS.SCHEMA_VERSION,
]);

const EPOCH = '1970-01-01T00:00:00.000Z';
const PULL_PAGE_SIZE = 500;
const CURSOR_OVERLAP_MS = 5_000;
/** Marge appliquée quand on migre depuis l'ancien curseur basé sur l'horloge client. */
const LEGACY_CURSOR_SKEW_MS = 60 * 60 * 1000;
const FAILURE_NOTIFY_THRESHOLD = 3;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const OUTBOX_WARN_SIZE = 5_000;

export function isLocalOnlyKey(key: StorageKey): boolean {
  return LOCAL_ONLY_KEYS.has(key);
}

export function backoffDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 1_000, MAX_BACKOFF_MS);
}

export class HybridStorage implements StoragePort {
  /** Résolue quand l'outbox persistée a été rechargée. */
  readonly ready: Promise<void>;

  private outbox = new Map<StorageKey, OutboxEntry>();
  private revCounter = 0;
  private flushing = false;
  private persistChain: Promise<void> = Promise.resolve();
  private retryTimer: unknown = null;
  private _onlineHandler: (() => void) | null = null;
  private readonly now: () => number;
  private readonly scheduleRetry: ((fn: () => void, delayMs: number) => unknown) | null;

  constructor(
    private readonly local: StoragePort,
    private readonly remote: StoragePort,
    options: HybridStorageOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.scheduleRetry =
      options.scheduleRetry === undefined
        ? typeof setTimeout === 'function'
          ? (fn, ms) => setTimeout(fn, ms)
          : null
        : options.scheduleRetry;

    this.ready = this.hydrateOutbox();

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this._onlineHandler = () => void this.flushPendingWrites({ ignoreBackoff: true });
      window.addEventListener('online', this._onlineHandler);
    }
  }

  dispose(): void {
    if (this._onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
    if (this.retryTimer !== null && typeof clearTimeout === 'function') {
      clearTimeout(this.retryTimer as ReturnType<typeof setTimeout>);
      this.retryTimer = null;
    }
  }

  // ─── StoragePort ─────────────────────────────────────────────────────────

  async get<T>(key: StorageKey): Promise<T | null> {
    return this.local.get<T>(key);
  }

  async set<T>(key: StorageKey, value: T): Promise<void> {
    await this.local.set(key, value);
    if (isLocalOnlyKey(key)) return;
    await this.enqueue(key, 'set');
  }

  async remove(key: StorageKey): Promise<void> {
    await this.local.remove(key);
    if (isLocalOnlyKey(key)) return;
    await this.enqueue(key, 'remove');
  }

  async keys(): Promise<readonly StorageKey[]> {
    return this.local.keys();
  }

  /**
   * clear — efface local ET cloud (action utilisateur « supprimer mes données »).
   * L'outbox est vidée : il n'y a plus rien à pousser.
   */
  async clear(): Promise<void> {
    await this.ready;
    this.outbox.clear();
    await this.local.clear();
    try {
      await this.remote.clear();
    } catch (err) {
      console.warn('[HybridStorage] remote clear failed:', err);
    }
  }

  // ─── État de synchro (UI) ────────────────────────────────────────────────

  /** Nombre d'opérations locales pas encore confirmées par le cloud. */
  async pendingCount(): Promise<number> {
    await this.ready;
    return this.outbox.size;
  }

  // ─── Outbox ──────────────────────────────────────────────────────────────

  private async hydrateOutbox(): Promise<void> {
    try {
      const saved = await this.local.get<Array<[StorageKey, OutboxEntry]>>(OUTBOX_KEY);
      if (!Array.isArray(saved)) return;
      for (const item of saved) {
        if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
        const [key, entry] = item;
        if (!entry || (entry.op !== 'set' && entry.op !== 'remove')) continue;
        // Rev locale neuve : les revs ne sont comparées qu'au sein d'une session.
        this.outbox.set(key, {
          op: entry.op,
          attempts: Number.isFinite(entry.attempts) ? entry.attempts : 0,
          nextTryAt: 0, // nouveau démarrage → on retente tout de suite
          rev: ++this.revCounter,
        });
      }
    } catch (err) {
      console.warn('[HybridStorage] outbox hydrate failed:', err);
    }
  }

  private async enqueue(key: StorageKey, op: OutboxOp): Promise<void> {
    await this.ready;
    this.outbox.set(key, { op, attempts: 0, nextTryAt: 0, rev: ++this.revCounter });
    if (this.outbox.size === OUTBOX_WARN_SIZE) {
      console.warn(`[HybridStorage] outbox très volumineuse (${OUTBOX_WARN_SIZE} entrées)`);
    }
    await this.persistOutbox();
    if (this.isOnline()) void this.flushPendingWrites();
  }

  /** Écritures sérialisées : la dernière écriture IDB porte toujours le dernier snapshot. */
  private persistOutbox(): Promise<void> {
    const snapshot = [...this.outbox.entries()].map(
      ([key, e]) =>
        [key, { op: e.op, attempts: e.attempts, nextTryAt: e.nextTryAt, rev: 0 }] as const,
    );
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        if (snapshot.length === 0) await this.local.remove(OUTBOX_KEY);
        else await this.local.set(OUTBOX_KEY, snapshot);
      });
    return this.persistChain.catch((err: unknown) => {
      console.error('[HybridStorage] outbox persist failed:', err);
    });
  }

  async flushPendingWrites(opts: { ignoreBackoff?: boolean } = {}): Promise<void> {
    await this.ready;
    if (this.flushing) return;
    if (!this.isOnline()) return;
    if (this.outbox.size === 0) return;

    this.flushing = true;
    let changed = false;
    try {
      for (const key of [...this.outbox.keys()]) {
        const entry = this.outbox.get(key);
        if (!entry) continue;
        if (!opts.ignoreBackoff && entry.nextTryAt > this.now()) continue;

        try {
          if (entry.op === 'set') {
            const value = await this.local.get(key);
            if (value === null) {
              // Lecture locale en échec ou valeur absente sans tombstone :
              // on ne pousse surtout pas un "null" qui effacerait le cloud.
              throw new Error('local value unavailable');
            }
            await this.remote.set(key, value);
          } else {
            await this.remote.remove(key);
          }
          const after = this.outbox.get(key);
          if (after && after.rev === entry.rev) this.outbox.delete(key);
          changed = true;
        } catch (err) {
          const after = this.outbox.get(key);
          if (after && after.rev === entry.rev) {
            const attempts = entry.attempts + 1;
            this.outbox.set(key, {
              ...entry,
              attempts,
              nextTryAt: this.now() + backoffDelayMs(attempts),
            });
            changed = true;
            console.warn(`[HybridStorage] sync échouée pour "${key}" (tentative ${attempts})`, err);
            if (attempts === FAILURE_NOTIFY_THRESHOLD) this.notifySyncFailed(key, attempts);
          }
        }
      }
    } finally {
      this.flushing = false;
    }

    if (changed) await this.persistOutbox();
    this.planRetry();
  }

  private planRetry(): void {
    if (!this.scheduleRetry || this.outbox.size === 0 || this.retryTimer !== null) return;
    const soonest = Math.min(...[...this.outbox.values()].map((e) => e.nextTryAt));
    const delay = Math.max(1_000, soonest - this.now());
    this.retryTimer = this.scheduleRetry(() => {
      this.retryTimer = null;
      void this.flushPendingWrites();
    }, delay);
  }

  private notifySyncFailed(key: StorageKey, attempts: number): void {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_SYNC_FAILED, { detail: { key, attempts } }),
    );
  }

  // ─── Pull (cloud → local) ────────────────────────────────────────────────

  /**
   * syncFromRemote — tire les changements du cloud.
   * - initial (jamais synchronisé) : ne tire que ce qui manque en local, puis
   *   pousse les données locales absentes du cloud (ex. données du mode invité) ;
   * - delta : applique les changements des autres appareils (sauf clés en outbox) ;
   * - force : écrase le local avec le cloud (restauration manuelle).
   *
   * Si la requête distante échoue, le curseur n'avance pas.
   */
  async syncFromRemote(opts: { force?: boolean } = {}): Promise<void> {
    await this.ready;
    if (!this.isOnline()) return;
    const force = opts.force === true;

    try {
      const handled = await this.pullWithServerCursor(force);
      if (!handled) await this.legacySync(force);
    } catch (err) {
      console.warn('[HybridStorage] syncFromRemote aborted:', err);
      return;
    }

    await this.local.set(SYNC_FLAG_KEY, true);
    void this.flushPendingWrites({ ignoreBackoff: true });
  }

  /** @returns false si le remote ne supporte pas pullChanges (fallback legacy). */
  private async pullWithServerCursor(force: boolean): Promise<boolean> {
    const remote = this.remote as Partial<PullCapableStorage>;
    if (typeof remote.pullChanges !== 'function') return false;

    const storedCursor = await this.local.get<string>(CURSOR_KEY);
    const legacyLastAt = await this.local.get<string>(SYNC_LAST_AT_KEY);
    const initial = force || (!storedCursor && !legacyLastAt);

    let since = EPOCH;
    if (!force && storedCursor) since = shiftIso(storedCursor, -CURSOR_OVERLAP_MS);
    else if (!force && legacyLastAt) since = shiftIso(legacyLastAt, -LEGACY_CURSOR_SKEW_MS);

    let afterKey = '';
    let maxUpdatedAt: string | null = storedCursor;
    const seenRemoteKeys = new Set<StorageKey>();

    for (;;) {
      const page = await remote.pullChanges(since, afterKey, PULL_PAGE_SIZE);
      if (page === null) return false;

      for (const change of page) {
        seenRemoteKeys.add(change.key);
        if (!maxUpdatedAt || compareTimestamps(change.updatedAt, maxUpdatedAt) > 0) {
          maxUpdatedAt = change.updatedAt;
        }
        await this.applyRemoteValue(change.key, change.value, {
          skipIfLocalExists: initial && !force,
          skipIfPending: !force,
        });
      }

      if (page.length < PULL_PAGE_SIZE) break;
      const last = page[page.length - 1]!;
      since = last.updatedAt;
      afterKey = last.key;
    }

    if (initial && !force) await this.enqueueLocalOnlyData(seenRemoteKeys);
    if (maxUpdatedAt) await this.local.set(CURSOR_KEY, maxUpdatedAt);
    return true;
  }

  /** Mode legacy (remote sans pullChanges) : comportement historique conservé. */
  private async legacySync(force: boolean): Promise<void> {
    const lastSyncAt = await this.local.get<string>(SYNC_LAST_AT_KEY);
    const delta = this.remote as DeltaCapableStorage;

    if (!force && lastSyncAt) {
      if (typeof delta.keysSince === 'function') {
        const keys = await delta.keysSince(lastSyncAt);
        await this.applyKeys(keys, { skipIfPending: true });
      } else {
        const keys = await this.remote.keys();
        await this.applyKeys(keys, { skipIfLocalExists: true, skipIfPending: true });
      }
    } else {
      const keys = await this.remote.keys();
      await this.applyKeys(keys, { skipIfLocalExists: !force, skipIfPending: !force });
    }

    await this.local.set(SYNC_LAST_AT_KEY, new Date(this.now()).toISOString());
  }

  private async applyKeys(
    keys: readonly StorageKey[],
    opts: { skipIfLocalExists?: boolean; skipIfPending?: boolean },
  ): Promise<void> {
    const BATCH_SIZE = 20;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      await Promise.all(
        keys.slice(i, i + BATCH_SIZE).map(async (key) => {
          if (isLocalOnlyKey(key)) return;
          if (opts.skipIfPending && this.outbox.has(key)) return;
          try {
            if (opts.skipIfLocalExists && (await this.local.get(key)) !== null) return;
            const value = await this.remote.get(key);
            if (value !== null) await this.local.set(key, value);
          } catch (err) {
            console.warn(`[HybridStorage] syncFromRemote failed for key "${key}":`, err);
          }
        }),
      );
    }
  }

  private async applyRemoteValue(
    key: StorageKey,
    value: unknown,
    opts: { skipIfLocalExists: boolean; skipIfPending: boolean },
  ): Promise<void> {
    if (isLocalOnlyKey(key)) return;
    if (opts.skipIfPending && this.outbox.has(key)) return;
    try {
      if (opts.skipIfLocalExists && (await this.local.get(key)) !== null) return;
      if (value === null || value === undefined) return;
      await this.local.set(key, value);
    } catch (err) {
      console.warn(`[HybridStorage] apply failed for key "${key}":`, err);
    }
  }

  /** Première liaison compte ↔ appareil : pousse les données locales absentes du cloud. */
  private async enqueueLocalOnlyData(remoteKeys: ReadonlySet<StorageKey>): Promise<void> {
    const localKeys = await this.local.keys();
    let added = false;
    for (const key of localKeys) {
      if (isLocalOnlyKey(key) || remoteKeys.has(key) || this.outbox.has(key)) continue;
      this.outbox.set(key, { op: 'set', attempts: 0, nextTryAt: 0, rev: ++this.revCounter });
      added = true;
    }
    if (added) await this.persistOutbox();
  }

  private isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }
}

/** Compare deux timestamps ISO/Postgres (microsecondes tolérées). */
export function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta < tb ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function shiftIso(iso: string, deltaMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return EPOCH;
  return new Date(Math.max(0, t + deltaMs)).toISOString();
}
