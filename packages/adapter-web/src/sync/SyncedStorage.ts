/**
 * SyncedStorage — StoragePort de l'app : base IndexedDB PAR COMPTE + outbox atomique +
 * synchronisation avec le serveur (RPC `sync_push` / `sync_pull_v2`, migration 010).
 * Contrat : docs/architecture/sync.md § 4.
 *
 * Garanties :
 *  - une écriture de l'app = UNE transaction (`kv` + `outbox`) : jamais de donnée
 *    modifiée sans son entrée d'outbox, jamais de succès sans persistance ;
 *  - `base` (version serveur connue) fixée à la création de l'entrée : le serveur
 *    refuse une écriture qui ignorerait une modification d'un autre appareil
 *    (conflit → résolution par domaine, `@kinetic/core`) ;
 *  - chaque page de pull est appliquée en UNE transaction, curseur compris ; une clé
 *    en attente n'est jamais écrasée par le pull ;
 *  - rejet permanent → entrée « bloquée », visible, plus de réessai automatique ;
 *    erreurs réseau / 401 → réessais avec backoff, jamais de boucle serrée ;
 *  - une lecture en échec LÈVE une erreur (jamais `null` déguisé en « absent »).
 */
import {
  STORAGE_KEYS,
  EMPTY_SYNC_STATUS,
  defaultMergeRegistry,
  jsonEqual,
  validateStorageKey,
  validateStorageValue,
  type MergeRegistry,
  type StorageKey,
  type StoragePort,
  type StorageWrite,
  type SyncKeyState,
  type SyncStatus,
} from '@kinetic/core';
import {
  type IdbGuardOptions,
  deleteDatabase,
  requestToPromise,
  txEntries,
  txKeys,
} from './idb.js';
import {
  DELETE_ALL_KEY,
  GUEST_OWNER,
  LocalSyncDb,
  META_CURSOR,
  META_INITIAL_PULL_DONE,
  META_LAST_PULL_AT,
  META_LAST_PUSH_AT,
  META_MIGRATED_FROM,
  META_LEGACY_CURSOR,
  META_NEEDS_RECONCILE,
  S_KV,
  S_META,
  S_OUTBOX,
  S_RECOVERY,
  S_VERSIONS,
  type OutboxEntry,
  type RecoveryRecord,
  type VersionInfo,
  bumpEpoch,
} from './local-db.js';
import type { LegacyMigrationResult } from './legacy-migration.js';
import type { GuestDataSummary, SyncEngine } from './engine.js';
import { isLocalOnlyKey } from './local-keys.js';
import type { SyncRemote } from './remote.js';
import {
  META_PULL_MODE,
  newEntry,
  rearm,
  stateOf,
  toPlain,
  type EngineHost,
  type EngineState,
  type MergeModule,
} from './shared.js';

const BROADCAST_CHANNEL = 'kinetic-sync';

/** Écriture à fusionner alors que le moteur n'est pas chargé : transaction annulée, rejouée. */
class StaleWriteRetry extends Error {
  constructor() {
    super('[sync] écriture fondée sur un état périmé : fusion nécessaire');
    this.name = 'StaleWriteRetry';
  }
}

export { backoffDelayMs } from './shared.js';
export type { MergeModule } from './shared.js';
export type { GuestDataSummary } from './engine.js';

/** Chargement du moteur (push/pull) : module séparé, hors du bundle de démarrage. */
const loadEngine = (): Promise<typeof import('./engine.js')> => import('./engine.js');

export interface SyncedStorageOptions {
  /** Identifiant du compte (`session.user.id`) ou `'guest'`. */
  owner: string;
  /** Serveur de synchro ; `null` = mode invité (aucune outbox). */
  remote: SyncRemote | null;
  factory?: IDBFactory;
  /** Délais de la parade WebKit (ouverture, lecture bloquées) ; injectés par les tests. */
  idbGuard?: Partial<IdbGuardOptions>;
  /** Registre de fusion (immédiat). Sinon chargé à la demande par `loadMerge`, sinon `lww`. */
  registry?: MergeRegistry;
  /**
   * Chargement à la demande des règles de fusion par domaine (conflits, réconciliation,
   * liaison invité) : hors du chemin de démarrage (budget du bundle initial).
   */
  loadMerge?: () => Promise<MergeModule>;
  /** Migrer l'ancienne base `keyval-store` (défaut : oui). */
  migrateLegacy?: boolean | { dbName: string; storeName: string };
  /**
   * L'app a tourné en REPLI sur l'ancienne base (`LegacyFallbackStorage`) : reprendre les
   * écritures journalisées pendant ce repli (sinon perdues en silence).
   */
  recoverFallbackWrites?: boolean;
  now?: () => number;
  isOnline?: () => boolean;
  /** Déclencheurs automatiques (anti-rebond, retour réseau, premier plan, 60 s). Défaut : oui. */
  autoSync?: boolean;
  debounceMs?: number;
  pullIntervalMs?: number;
  pageSize?: number;
  batchMaxItems?: number;
  batchMaxBytes?: number;
  /** Cible des événements DOM (`kinetic:sync-status`…) ; défaut : `window` s'il existe. */
  eventTarget?: EventTarget | null;
}

export interface RecoveryItem {
  id: string;
  key: string;
  reason: RecoveryRecord['reason'];
  at: string;
  value: unknown;
}

interface LockManagerLike {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
}

const inProcessLocks = new Map<string, Promise<unknown>>();

function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  if (nav?.locks && typeof nav.locks.request === 'function') return nav.locks.request(name, fn);
  const prev = inProcessLocks.get(name) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  inProcessLocks.set(
    name,
    run.catch(() => undefined),
  );
  return run;
}

export class SyncedStorage implements StoragePort {
  readonly owner: string;
  readonly dbName: string;
  /** Résultat de la migration de l'ancienne base (diagnostic). */
  migration: LegacyMigrationResult | null = null;
  /**
   * Écritures du repli reprises (ou rien à reprendre) à l'ouverture ; `false` si la reprise
   * a échoué (réessayée au prochain lancement) ou n'a pas été demandée.
   */
  fallbackRecovered = false;

  private readonly remote: SyncRemote | null;
  private registry: MergeRegistry | null;
  private readonly loadMerge: (() => Promise<MergeModule>) | null;
  private mergeModule: Promise<MergeModule> | null = null;
  private readonly now: () => number;
  private readonly onlineFn: () => boolean;
  private readonly autoSync: boolean;
  private readonly debounceMs: number;
  private readonly pullIntervalMs: number;
  private readonly pageSize: number;
  private readonly batchMaxItems: number;
  private readonly batchMaxBytes: number;
  private readonly events: EventTarget | null;
  private readonly lockName: string;

  /** Occupation, reconnexion nécessaire, derniers échecs d'envoi / de réception. */
  private readonly state: EngineState = {
    busy: 0,
    authRequired: false,
    pushError: null,
    pullError: null,
  };
  private enginePromise: Promise<SyncEngine> | null = null;
  private disposed = false;
  private started = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<(s: SyncStatus) => void>();
  private lastStatus: SyncStatus = EMPTY_SYNC_STATUS;
  private readonly cleanups: Array<() => void> = [];

  private constructor(
    private readonly db: LocalSyncDb,
    opts: SyncedStorageOptions,
  ) {
    this.owner = opts.owner;
    this.dbName = db.name;
    this.remote = opts.owner === GUEST_OWNER ? null : opts.remote;
    this.registry = opts.registry ?? null;
    this.loadMerge = opts.loadMerge ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.onlineFn =
      opts.isOnline ??
      (() => typeof navigator === 'undefined' || (navigator as Navigator).onLine !== false);
    this.autoSync = opts.autoSync ?? true;
    this.debounceMs = opts.debounceMs ?? 1_000;
    this.pullIntervalMs = opts.pullIntervalMs ?? 60_000;
    this.pageSize = opts.pageSize ?? 500;
    this.batchMaxItems = opts.batchMaxItems ?? 100;
    this.batchMaxBytes = opts.batchMaxBytes ?? 3 * 1024 * 1024;
    this.events =
      opts.eventTarget !== undefined
        ? opts.eventTarget
        : typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
          ? window
          : null;
    this.lockName = `kinetic-sync:${db.name}`;
    this.lastStatus = { ...EMPTY_SYNC_STATUS, enabled: this.remote !== null };
  }

  /**
   * Ouvre (ou crée) la base du compte, vérifie son propriétaire et migre l'ancienne
   * base locale si besoin. Lève OwnerMismatchError si la base appartient à un autre compte.
   */
  static async open(opts: SyncedStorageOptions): Promise<SyncedStorage> {
    const factory = opts.factory ?? globalThis.indexedDB;
    if (!factory) throw new Error('[sync] IndexedDB indisponible');
    const db = await LocalSyncDb.open(factory, opts.owner, opts.idbGuard);
    const storage = new SyncedStorage(db, opts);
    let migrated: unknown;
    try {
      migrated = await db.tx([S_META], 'readonly', (tx) =>
        requestToPromise(tx.objectStore(S_META).get(META_MIGRATED_FROM)),
      );
    } catch (err) {
      db.close(); // lecture bloquée (WebKit) : aucune connexion orpheline
      throw err;
    }
    const names =
      typeof opts.migrateLegacy === 'object'
        ? {
            legacyDbName: opts.migrateLegacy.dbName,
            legacyStoreName: opts.migrateLegacy.storeName,
          }
        : {};
    if (migrated !== undefined) {
      storage.migration = { status: 'already-done' };
    } else if (opts.migrateLegacy !== false) {
      try {
        // Module de migration chargé seulement au premier lancement de cette base.
        const { migrateLegacyStore } = await import('./legacy-migration.js');
        storage.migration = await migrateLegacyStore(db, {
          factory,
          syncEnabled: storage.remote !== null,
          now: storage.now,
          ...names,
        });
      } catch (err) {
        // Annulée (transaction unique) : réessayée au prochain lancement.
        db.close();
        throw err;
      }
    }
    if (storage.migration?.status === 'migrated') {
      // Première migration : les écritures du repli sont dans les données copiées.
      storage.fallbackRecovered = true;
    } else if (opts.recoverFallbackWrites === true) {
      try {
        const { importFallbackWrites } = await import('./legacy-migration.js');
        await importFallbackWrites(db, {
          factory,
          syncEnabled: storage.remote !== null,
          now: storage.now,
          ...names,
        });
        storage.fallbackRecovered = true;
      } catch (err) {
        // Journal conservé : réessai au prochain lancement. La base reste utilisable.
        console.warn('[sync] reprise des écritures du repli impossible :', err);
      }
    }
    return storage;
  }

  get syncEnabled(): boolean {
    return this.remote !== null;
  }

  // ─── StoragePort ─────────────────────────────────────────────────────────

  async get<T>(key: StorageKey): Promise<T | null> {
    const value = await this.db.tx([S_KV], 'readonly', async (tx) => {
      const v = await requestToPromise(tx.objectStore(S_KV).get(key));
      // Vue de l'app notée DANS la transaction : aucun pull ne peut s'intercaler.
      this.observe(key);
      return v;
    });
    return value === undefined ? null : (value as T);
  }

  async set<T>(key: StorageKey, value: T): Promise<void> {
    await this.setMany([{ key, value }]);
  }

  async remove(key: StorageKey): Promise<void> {
    await this.setMany([{ key, remove: true }]);
  }

  async keys(): Promise<readonly StorageKey[]> {
    return this.db.tx([S_KV], 'readonly', (tx) => txKeys(tx, S_KV));
  }

  // ─── Vue de l'app (écritures fondées sur un état périmé) ──────────────────
  //
  // Les pages gardent en mémoire ce qu'elles ont lu et réécrivent la valeur ENTIÈRE.
  // Si la synchro a modifié la clé entre la lecture et l'écriture, l'écriture est
  // fusionnée (règles par domaine) avec ce que la synchro a apporté, au lieu de
  // l'écraser (engine.rebaseStaleWrite). Suivi en mémoire, par instance : un pull fait
  // par un AUTRE onglet n'est pas vu ici (sync.md § 4.8 ter).

  /** Clé → nombre de modifications de `kv` par la synchro (clés vues par l'app seulement). */
  private readonly remoteRev = new Map<string, number>();
  /** Clé → valeur de `remoteRev` à la dernière lecture / écriture de l'app. */
  private readonly seenRev = new Map<string, number>();
  /** Clé → état vu par l'app, quand la synchro a modifié la clé depuis. */
  private readonly seenState = new Map<string, SyncKeyState>();

  private observe(key: string): void {
    this.seenRev.set(key, this.remoteRev.get(key) ?? 0);
    this.seenState.delete(key);
  }

  private isStale(key: string): boolean {
    const seen = this.seenRev.get(key);
    return seen !== undefined && seen !== (this.remoteRev.get(key) ?? 0);
  }

  /** La vue de l'app (`appView`) diffère désormais de `kv` : la prochaine écriture sera fusionnée. */
  private diverge(key: string, appView: SyncKeyState): void {
    this.observe(key);
    this.remoteTouched(key, appView);
  }

  private remoteTouched(key: string, before: SyncKeyState): void {
    const seen = this.seenRev.get(key);
    if (seen === undefined) return;
    const rev = this.remoteRev.get(key) ?? 0;
    if (seen === rev) this.seenState.set(key, before);
    this.remoteRev.set(key, rev + 1);
  }

  private needsRebase(key: string): boolean {
    return this.remote !== null && !isLocalOnlyKey(key) && this.isStale(key);
  }

  /** Écriture atomique de plusieurs clés (données + outbox en UNE transaction). */
  async setMany(writes: readonly StorageWrite[]): Promise<void> {
    if (writes.length === 0) return;
    let rebase: { engine: SyncEngine; registry: MergeRegistry } | null = null;
    const load = async (): Promise<{ engine: SyncEngine; registry: MergeRegistry }> => ({
      engine: await this.engine(),
      registry: await this.getRegistry(),
    });
    if (writes.some((w) => this.needsRebase(w.key))) rebase = await load();
    for (;;) {
      try {
        await this.writeMany(writes, rebase);
        return;
      } catch (err) {
        // Clé devenue périmée entre la vérification et la transaction (pull intercalé).
        if (err instanceof StaleWriteRetry && rebase === null) {
          rebase = await load();
          continue;
        }
        throw err;
      }
    }
  }

  private async writeMany(
    writes: readonly StorageWrite[],
    rebase: { engine: SyncEngine; registry: MergeRegistry } | null,
  ): Promise<void> {
    const prepared = writes.map((w) => {
      if (!validateStorageKey(w.key)) {
        throw new Error(
          `SyncedStorage: invalid key format "${w.key}" — expected /^[a-zA-Z0-9:_-]{1,200}$/`,
        );
      }
      if (w.remove === true) return { key: w.key, deleted: true as const };
      if (!validateStorageValue(w.value)) {
        throw new Error(
          `SyncedStorage: value for key "${w.key}" exceeds 1 MB limit or is not serialisable`,
        );
      }
      return { key: w.key, deleted: false as const, value: toPlain(w.value) };
    });
    const now = this.now();
    const notices: string[] = [];
    const stores = [S_KV, S_OUTBOX, S_VERSIONS, S_RECOVERY];
    const changed = await this.db.tx(stores, 'readwrite', async (tx) => {
      const out: string[] = [];
      for (const asked of prepared) {
        const kv = tx.objectStore(S_KV);
        const current = await requestToPromise(kv.get(asked.key));
        let w = asked;
        let appView: SyncKeyState | null = null;
        if (this.needsRebase(asked.key)) {
          if (rebase === null) throw new StaleWriteRetry();
          const local: SyncKeyState = asked.deleted
            ? { deleted: true }
            : { deleted: false, value: asked.value };
          const r = await rebase.engine.rebaseStaleWrite(
            rebase.registry,
            tx,
            asked.key,
            local,
            this.seenState.get(asked.key),
            now,
          );
          out.push(...r.extraKeys);
          if (r.notice !== undefined) notices.push(r.notice);
          w = r.result.deleted
            ? { key: asked.key, deleted: true }
            : { key: asked.key, deleted: false, value: toPlain(r.result.value) };
          if (w.deleted !== asked.deleted || (!w.deleted && !jsonEqual(w.value, asked.value))) {
            appView = local;
          }
        }
        if (w.deleted) kv.delete(w.key);
        else kv.put(w.value, w.key);
        // Vue de l'app = ce qu'elle vient d'écrire (périmée si la fusion l'a changé).
        if (appView) this.diverge(w.key, appView);
        else this.observe(w.key);
        out.push(w.key);
        if (this.remote === null || isLocalOnlyKey(w.key)) continue;

        const outbox = tx.objectStore(S_OUTBOX);
        const entry = (await requestToPromise(outbox.get(w.key))) as OutboxEntry | undefined;
        const op = w.deleted ? 'delete' : 'set';
        if (entry) {
          outbox.put(
            rearm(entry, { op, rev: entry.rev + 1, attempts: 0, nextTryAt: 0, seed: false }),
            w.key,
          );
          continue;
        }
        const version = (await requestToPromise(tx.objectStore(S_VERSIONS).get(w.key))) as
          | VersionInfo
          | undefined;
        // Écriture sans effet (même valeur que la version serveur connue) ou suppression
        // d'une clé que l'appareil n'a jamais vue : rien à pousser.
        if (w.deleted && current === undefined && (!version || version.deleted)) continue;
        if (
          !w.deleted &&
          version &&
          !version.deleted &&
          current !== undefined &&
          jsonEqual(current, w.value)
        ) {
          continue;
        }
        const base = version?.updated_at ?? null;
        outbox.put(
          newEntry(op, base, now, {
            ancestor: base === null ? { deleted: true } : stateOf(current),
          }),
          w.key,
        );
      }
      return out;
    });
    for (const message of notices) this.emit(STORAGE_KEYS.EVENT_NOTIFY, { kind: 'info', message });
    this.afterLocalWrite(changed);
  }

  /**
   * Efface les données de CET appareil pour ce compte (local uniquement) : valeurs,
   * outbox, versions, éléments mis de côté, curseur. Le cloud n'est pas touché ; la
   * prochaine synchro refait un pull complet. Lève une erreur en cas d'échec.
   */
  async clear(): Promise<void> {
    await this.db.tx([S_KV, S_OUTBOX, S_VERSIONS, S_META, S_RECOVERY], 'readwrite', async (tx) => {
      // Pull / push en vol (verrou non pris : ne pas attendre un réseau qui pend) : leur
      // réponse ne sera pas appliquée à la base vidée (curseur, entrées recréées).
      await bumpEpoch(tx);
      for (const s of [S_KV, S_OUTBOX, S_VERSIONS, S_RECOVERY]) tx.objectStore(s).clear();
      const meta = tx.objectStore(S_META);
      for (const k of [
        META_CURSOR,
        META_INITIAL_PULL_DONE,
        META_NEEDS_RECONCILE,
        META_LEGACY_CURSOR,
        META_LAST_PULL_AT,
        META_LAST_PUSH_AT,
        META_PULL_MODE,
      ]) {
        meta.delete(k);
      }
    });
    this.state.pushError = null;
    this.state.pullError = null;
    this.broadcast([], 'clear');
    this.scheduleStatus();
  }

  /** Alias explicite de `clear()` (« Effacer les données de cet appareil »). */
  clearDevice(): Promise<void> {
    return this.clear();
  }

  // ─── Cycle de vie ────────────────────────────────────────────────────────

  /** Démarre la synchro automatique (après le premier rendu). Idempotent. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.openChannel();
    this.scheduleStatus();
    if (!this.remote) return;
    if (this.autoSync) this.installTriggers();
    // Nouveau démarrage : les entrées en backoff sont retentées tout de suite.
    void this.sync({ ignoreBackoff: true }).catch((err: unknown) =>
      console.warn('[sync] démarrage :', err),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const fn of this.cleanups.splice(0)) fn();
    for (const t of [this.flushTimer, this.retryTimer, this.statusTimer]) {
      if (t !== null) clearTimeout(t);
    }
    if (this.pullTimer !== null) clearInterval(this.pullTimer);
    this.flushTimer = this.retryTimer = this.statusTimer = null;
    this.pullTimer = null;
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
    this.db.close();
  }

  private installTriggers(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onOnline = (): void => {
      void this.sync({ ignoreBackoff: true }).catch(() => undefined);
    };
    const onOffline = (): void => this.scheduleStatus();
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void this.sync().catch(() => undefined);
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    this.cleanups.push(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    });
    if (this.pullIntervalMs > 0) {
      this.pullTimer = setInterval(() => {
        const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
        if (visible) void this.sync().catch(() => undefined);
      }, this.pullIntervalMs);
    }
  }

  private openChannel(): void {
    if (this.channel || typeof BroadcastChannel !== 'function') return;
    try {
      const ch = new BroadcastChannel(BROADCAST_CHANNEL);
      ch.onmessage = (ev: MessageEvent) => {
        const data = ev.data as { db?: string; keys?: string[] } | null;
        if (!data || data.db !== this.dbName) return;
        this.emit(STORAGE_KEYS.EVENT_SYNC_APPLIED, { keys: data.keys ?? [], source: 'tab' });
        this.scheduleStatus();
      };
      this.channel = ch;
    } catch {
      this.channel = null;
    }
  }

  private afterLocalWrite(keys: string[]): void {
    this.broadcast(keys, 'write');
    this.scheduleStatus();
    if (!this.remote || !this.autoSync || !this.started || this.disposed) return;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingWrites().catch(() => undefined);
    }, this.debounceMs);
  }

  // ─── Synchro : point d'entrée ────────────────────────────────────────────

  /** Pull puis push (démarrage, premier plan, retour réseau, « Synchroniser maintenant »). */
  async sync(opts: { ignoreBackoff?: boolean } = {}): Promise<void> {
    if (!this.remote || this.disposed) return;
    await this.pull();
    await this.flushPendingWrites(opts);
  }

  /**
   * Compatibilité (ancienne API HybridStorage) : `force` = restauration depuis le
   * cloud = pull complet en mode resync (les entrées en attente sont conservées).
   */
  async syncFromRemote(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.remote) return;
    await this.pull(opts.force ? { resync: true } : {});
    await this.flushPendingWrites({ ignoreBackoff: true });
  }

  // ─── Push ────────────────────────────────────────────────────────────────

  async flushPendingWrites(opts: { ignoreBackoff?: boolean } = {}): Promise<void> {
    const remote = this.remote;
    if (!remote || this.disposed) return;
    const engine = await this.engine();
    await withLock(this.lockName, () => engine.flushLocked(remote, opts.ignoreBackoff === true));
    await this.planRetry();
    this.scheduleStatus();
  }

  private getMergeModule(): Promise<MergeModule | null> {
    if (!this.loadMerge) return Promise.resolve(null);
    if (!this.mergeModule) {
      this.mergeModule = this.loadMerge().catch((err: unknown) => {
        this.mergeModule = null; // réessai au prochain conflit
        throw err;
      });
    }
    return this.mergeModule;
  }

  /** Registre de fusion : fourni, sinon chargé à la demande, sinon `lww`. */
  private async getRegistry(): Promise<MergeRegistry> {
    if (this.registry) return this.registry;
    const merge = await this.getMergeModule();
    return merge?.registry ?? defaultMergeRegistry;
  }

  // ─── Pull ────────────────────────────────────────────────────────────────

  async pull(opts: { resync?: boolean } = {}): Promise<void> {
    const remote = this.remote;
    if (!remote || this.disposed) return;
    const engine = await this.engine();
    await withLock(this.lockName, () => engine.pullLocked(remote, opts.resync === true));
    this.scheduleStatus();
  }

  // ─── « Supprimer toutes mes données cloud » ──────────────────────────────

  /**
   * Inscrit une suppression totale dans l'outbox (persistée : survit à un redémarrage,
   * envoyée avant tout le reste), puis l'envoie. Résout UNIQUEMENT après la réponse
   * positive du serveur ; sinon lève une erreur (la demande reste en attente).
   */
  async deleteAllCloudData(): Promise<void> {
    if (!this.remote) throw new Error('Synchronisation cloud inactive sur cet appareil');
    const now = this.now();
    await this.db.tx([S_OUTBOX, S_META], 'readwrite', async (tx) => {
      const outbox = tx.objectStore(S_OUTBOX);
      // Envoi en vol : sa réponse ne doit pas consommer une entrée écrite après la demande.
      await bumpEpoch(tx);
      // Les modifications en attente plus anciennes que la demande sont abandonnées.
      outbox.clear();
      outbox.put(newEntry('delete_all', null, now), DELETE_ALL_KEY);
    });
    this.scheduleStatus();
    await this.flushPendingWrites({ ignoreBackoff: true });
    const left = await this.db.tx([S_OUTBOX], 'readonly', (tx) =>
      requestToPromise(tx.objectStore(S_OUTBOX).get(DELETE_ALL_KEY)),
    );
    if (left !== undefined) {
      const e = left as OutboxEntry;
      if (e.state === 'blocked') throw new Error(e.reason ?? 'Suppression refusée par le serveur');
      throw new Error(
        this.onlineFn()
          ? (this.state.pushError ?? 'Suppression en attente : nouvel essai automatique')
          : 'Hors ligne : la suppression sera envoyée au retour du réseau',
      );
    }
  }

  // ─── État ────────────────────────────────────────────────────────────────

  async pendingCount(): Promise<number> {
    if (!this.remote) return 0;
    const entries = await this.db.tx([S_OUTBOX], 'readonly', (tx) =>
      txEntries<OutboxEntry>(tx, S_OUTBOX),
    );
    return entries.filter(([, e]) => e.state === 'pending').length;
  }

  async isInitialPullDone(): Promise<boolean> {
    if (!this.remote) return true;
    const v = await this.db.tx([S_META], 'readonly', (tx) =>
      requestToPromise(tx.objectStore(S_META).get(META_INITIAL_PULL_DONE)),
    );
    return v === true;
  }

  async getStatus(): Promise<SyncStatus> {
    const enabled = this.remote !== null;
    const { entries, recovery, lastPushAt, lastPullAt } = await this.db.tx(
      [S_OUTBOX, S_RECOVERY, S_META],
      'readonly',
      async (tx) => {
        const m = tx.objectStore(S_META);
        const [e, r, push, pull] = await Promise.all([
          txEntries<OutboxEntry>(tx, S_OUTBOX),
          requestToPromise(tx.objectStore(S_RECOVERY).count()),
          requestToPromise(m.get(META_LAST_PUSH_AT)),
          requestToPromise(m.get(META_LAST_PULL_AT)),
        ]);
        return {
          entries: e,
          recovery: r,
          lastPushAt: typeof push === 'string' ? push : null,
          lastPullAt: typeof pull === 'string' ? pull : null,
        };
      },
    );
    const deleteAllPending = entries.some(([k]) => k === DELETE_ALL_KEY);
    const data = entries.filter(([k]) => k !== DELETE_ALL_KEY);
    const pending = data.filter(([, e]) => e.state === 'pending').length;
    const blocked = data
      .filter(([, e]) => e.state === 'blocked')
      .map(([key, e]) => ({ key, reason: e.reason ?? 'rejected' }));
    let state: SyncStatus['state'] = 'synced';
    if (enabled) {
      if (this.state.authRequired) state = 'auth_required';
      else if (!this.onlineFn()) state = 'offline';
      else if (this.state.busy > 0) state = 'syncing';
      else if (
        blocked.length > 0 ||
        (this.state.pushError !== null && (pending > 0 || deleteAllPending))
      )
        state = 'error';
      else if (pending > 0 || deleteAllPending) state = 'pending';
    }
    return {
      state,
      pending,
      blocked,
      recovery,
      lastPushAt,
      lastPullAt,
      lastError: this.state.pushError ?? this.state.pullError,
      deleteAllPending,
      enabled,
    };
  }

  get status(): SyncStatus {
    return this.lastStatus;
  }

  onStatus(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Publie l'état (coalescé) : listeners + événement `kinetic:sync-status`. */
  private scheduleStatus(): void {
    if (this.disposed || this.statusTimer !== null) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      void this.publishStatus();
    }, 0);
  }

  async publishStatus(): Promise<SyncStatus> {
    if (this.disposed) return this.lastStatus;
    try {
      const s = await this.getStatus();
      this.lastStatus = s;
      for (const l of this.listeners) l(s);
      this.emit(STORAGE_KEYS.EVENT_SYNC_STATUS, s);
      return s;
    } catch (err) {
      console.warn('[sync] état indisponible :', err);
      return this.lastStatus;
    }
  }

  /** Remet les entrées bloquées en attente (« Réessayer »), puis envoie. */
  async retryBlocked(): Promise<void> {
    await this.db.tx([S_OUTBOX], 'readwrite', async (tx) => {
      const outbox = tx.objectStore(S_OUTBOX);
      for (const [k, e] of await txEntries<OutboxEntry>(tx, S_OUTBOX)) {
        if (e.state === 'blocked') outbox.put(rearm(e, { attempts: 0, nextTryAt: 0 }), k);
      }
    });
    this.state.authRequired = false;
    this.state.pushError = null;
    await this.flushPendingWrites({ ignoreBackoff: true });
  }

  /** Session rafraîchie / reconnexion : relance la synchro. */
  resume(): void {
    this.state.authRequired = false;
    void this.sync({ ignoreBackoff: true }).catch(() => undefined);
  }

  private async planRetry(): Promise<void> {
    if (!this.remote || !this.autoSync || !this.started || this.disposed) return;
    const entries = await this.db.tx([S_OUTBOX], 'readonly', (tx) =>
      txEntries<OutboxEntry>(tx, S_OUTBOX),
    );
    const times = entries.filter(([, e]) => e.state === 'pending').map(([, e]) => e.nextTryAt);
    if (times.length === 0) return;
    const at = Math.max(this.now() + 1_000, Math.min(...times));
    if (this.retryTimer !== null && this.retryAt <= at) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryAt = at;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushPendingWrites().catch(() => undefined);
    }, at - this.now());
  }

  // ─── Éléments mis de côté (recovery) ─────────────────────────────────────

  async listRecovery(): Promise<RecoveryItem[]> {
    const rows = await this.db.tx([S_RECOVERY], 'readonly', (tx) =>
      txEntries<RecoveryRecord>(tx, S_RECOVERY),
    );
    return rows.map(([id, r]) => ({ id, key: r.key, reason: r.reason, at: r.at, value: r.value }));
  }

  /** « Restaurer » : réécrit la valeur (synchronisée normalement) ; la valeur actuelle est mise de côté. */
  async restoreRecovery(id: string): Promise<void> {
    const rec = await this.db.tx([S_RECOVERY], 'readonly', (tx) =>
      requestToPromise(tx.objectStore(S_RECOVERY).get(id)),
    );
    if (!rec) return;
    const r = rec as RecoveryRecord;
    const current = await this.get<unknown>(r.key);
    const nowIso = new Date(this.now()).toISOString();
    await this.db.tx([S_RECOVERY], 'readwrite', (tx) => {
      const store = tx.objectStore(S_RECOVERY);
      store.delete(id);
      if (current !== null && !jsonEqual(current, r.value)) {
        const swap: RecoveryRecord = { key: r.key, value: current, reason: 'conflict', at: nowIso };
        store.put(swap, `conflict:${nowIso}:${r.key}:restore`);
      }
    });
    await this.set(r.key, r.value);
  }

  /** « Supprimer définitivement ». */
  async discardRecovery(id: string): Promise<void> {
    await this.db.tx([S_RECOVERY], 'readwrite', (tx) => {
      tx.objectStore(S_RECOVERY).delete(id);
    });
    this.scheduleStatus();
  }

  // ─── Liaison invité → compte ─────────────────────────────────────────────

  // ─── Liaison invité → compte (moteur chargé à la demande) ────────────────

  /** Données présentes dans la base invité de cet appareil (sans la créer). */
  async guestDataSummary(): Promise<GuestDataSummary> {
    return (await this.engine()).guestDataSummary();
  }

  /**
   * « Ajouter les données de cet appareil à votre compte » : fusion par domaine,
   * chaque clé fusionnée passe par l'outbox avec la `base` serveur. Exige le pull
   * complet du compte. La base invité est conservée intacte.
   */
  async importGuestData(): Promise<{ written: number }> {
    return (await this.engine()).importGuestData();
  }

  /** « Ne pas les ajouter » : la base invité reste intacte, récupérable depuis le profil. */
  async declineGuestData(): Promise<void> {
    return (await this.engine()).declineGuestData();
  }

  private engine(): Promise<SyncEngine> {
    if (!this.enginePromise) {
      this.enginePromise = loadEngine().then(
        (m) => new m.SyncEngine(this.host()),
        (err: unknown) => {
          this.enginePromise = null; // réessai au prochain appel (chunk introuvable…)
          throw err;
        },
      );
    }
    return this.enginePromise;
  }

  private host(): EngineHost {
    return {
      db: this.db,
      remote: this.remote,
      owner: this.owner,
      pageSize: this.pageSize,
      batchMaxItems: this.batchMaxItems,
      batchMaxBytes: this.batchMaxBytes,
      state: this.state,
      now: () => this.now(),
      isOnline: () => this.onlineFn(),
      isDisposed: () => this.disposed,
      emit: (name, detail) => this.emit(name, detail),
      broadcast: (keys, kind) => this.broadcast(keys, kind),
      scheduleStatus: () => this.scheduleStatus(),
      getRegistry: () => this.getRegistry(),
      getMergeModule: () => this.getMergeModule(),
      setMany: (writes) => this.setMany(writes),
      isInitialPullDone: () => this.isInitialPullDone(),
      observes: (key) => this.seenRev.has(key),
      remoteTouched: (key, before) => this.remoteTouched(key, before),
    };
  }

  /** Supprime complètement la base locale de ce compte (après suppression du compte). */
  async destroyLocalDatabase(): Promise<void> {
    this.dispose();
    await deleteDatabase(this.db.factory, this.dbName);
  }

  // ─── Événements ──────────────────────────────────────────────────────────

  private emit(name: string, detail: unknown): void {
    if (!this.events || typeof CustomEvent !== 'function') return;
    try {
      this.events.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      /* cible indisponible */
    }
  }

  private broadcast(keys: string[], kind: 'write' | 'pull' | 'clear'): void {
    try {
      this.channel?.postMessage({ db: this.dbName, keys, kind });
    } catch {
      /* canal fermé */
    }
  }
}
