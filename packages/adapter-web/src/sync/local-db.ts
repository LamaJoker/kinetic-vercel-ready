/**
 * Base IndexedDB PAR COMPTE (docs/architecture/sync.md § 4.1) :
 *   `kinetic-u-<userId>` pour un compte, `kinetic-guest` pour le mode invité.
 * Object stores : `kv` (données), `outbox`, `versions`, `meta`, `recovery`.
 * `meta.owner` est écrit à la création : une base dont le propriétaire ne correspond
 * pas au compte attendu n'est JAMAIS utilisée (OwnerMismatchError).
 */
import type { SyncKeyState } from '@kinetic/core';
import {
  type IdbGuardOptions,
  IdbUnresponsiveError,
  forgetWake,
  idbGuard,
  isIdbUnresponsive,
  openDatabase,
  reportUnresponsive,
  runTransaction,
} from './idb.js';

export const GUEST_OWNER = 'guest';
export const DB_VERSION = 1;

export const S_KV = 'kv';
export const S_OUTBOX = 'outbox';
export const S_VERSIONS = 'versions';
export const S_META = 'meta';
export const S_RECOVERY = 'recovery';
export const ALL_STORES = [S_KV, S_OUTBOX, S_VERSIONS, S_META, S_RECOVERY] as const;

/** Clé d'outbox réservée à « supprimer toutes mes données cloud » (jamais une clé de donnée). */
export const DELETE_ALL_KEY = '\u0000delete_all';

export const META_OWNER = 'owner';
export const META_CURSOR = 'cursor';
export const META_INITIAL_PULL_DONE = 'initialPullDone';
export const META_NEEDS_RECONCILE = 'needsReconcile';
export const META_MIGRATED_FROM = 'migratedFrom';
/**
 * Curseur serveur de l'ANCIEN client (`kinetic:sync:cursor`, `updated_at` du dernier
 * changement tiré) recopié à la migration : à la réconciliation, une clé modifiée sur le
 * serveur APRÈS ce curseur n'a jamais été vue par cet appareil, sa copie locale est
 * périmée (sync.md § 4.1).
 */
export const META_LEGACY_CURSOR = 'legacyCursor';
export const META_LAST_PUSH_AT = 'lastPushAt';
export const META_LAST_PULL_AT = 'lastPullAt';
export const META_REV = 'revCounter';
/**
 * Génération de l'état local : incrémentée par chaque remise à zéro locale (« Effacer les
 * données de cet appareil », « Supprimer toutes mes données cloud »), qui ne prennent pas
 * le verrou de synchro. Une réponse de pull ou de push obtenue pour une génération
 * précédente n'est pas appliquée telle quelle (elle visait un état qui n'existe plus).
 */
export const META_EPOCH = 'localEpoch';

/** Génération locale courante, lue dans la transaction `tx` (qui inclut `meta`). */
export async function readEpoch(tx: IDBTransaction): Promise<number> {
  const req = tx.objectStore(S_META).get(META_EPOCH);
  const value = await new Promise<unknown>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('meta epoch read failed'));
  });
  return typeof value === 'number' ? value : 0;
}

/** Passe à la génération suivante (dans la transaction de la remise à zéro). */
export async function bumpEpoch(tx: IDBTransaction): Promise<void> {
  const current = await readEpoch(tx);
  tx.objectStore(S_META).put(current + 1, META_EPOCH);
}

/** Pull abandonné : l'état local a été remis à zéro pendant l'appel (rien n'est appliqué). */
export class LocalResetError extends Error {
  constructor() {
    super('[sync] état local remis à zéro pendant la synchro : réponse ignorée');
    this.name = 'LocalResetError';
  }
}
/** Base invité : décision de liaison (`linked:<userId>` / `declined:<userId>`). */
export const META_GUEST_LINK = 'guestLink';

export type OutboxOp = 'set' | 'delete' | 'delete_all';

export interface OutboxEntry {
  op: OutboxOp;
  /** Version serveur connue à la CRÉATION de l'entrée ; inchangée par les écritures suivantes. */
  base: string | null;
  /** Incrémenté à chaque écriture locale (même transaction que la donnée). */
  rev: number;
  attempts: number;
  nextTryAt: number;
  state: 'pending' | 'blocked';
  reason?: string;
  seed?: boolean;
  queuedAt: number;
  origin?: 'app' | 'legacy' | 'reconcile' | 'guest';
  /** État de la clé à la version `base` (ancêtre de la fusion à trois voies) ; absent = inconnu. */
  ancestor?: SyncKeyState;
  /** Conflits successifs (anti-boucle). */
  conflicts?: number;
  /**
   * État envoyé par un appel dont la réponse n'est jamais arrivée (réseau coupé, tunnel) :
   * le serveur l'a peut-être appliqué. Au conflit suivant, un état serveur identique veut
   * dire « notre envoi est passé » : avance rapide, pas de fausse copie de conflit.
   */
  sent?: SyncKeyState;
  /**
   * États envoyés par des appels PRÉCÉDENTS restés sans réponse (le plus ancien d'abord,
   * 4 au plus) : n'importe lequel a pu être le dernier appliqué (1er envoi passé, réponse
   * perdue, puis 2e envoi jamais parti).
   */
  sentEarlier?: SyncKeyState[];
}

export interface VersionInfo {
  updated_at: string;
  deleted: boolean;
}

export interface PullCursor {
  since: string;
  afterKey: string;
}

export interface RecoveryRecord {
  key: string;
  value: unknown;
  reason: 'resync' | 'reconcile' | 'conflict';
  at: string;
}

export class OwnerMismatchError extends Error {
  constructor(dbName: string, expected: string, found: unknown) {
    super(
      `[sync] la base locale "${dbName}" appartient à "${String(found)}" et non à "${expected}" : utilisation refusée`,
    );
    this.name = 'OwnerMismatchError';
  }
}

const OWNER_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function dbNameForOwner(owner: string): string {
  if (owner === GUEST_OWNER) return 'kinetic-guest';
  if (!OWNER_RE.test(owner)) throw new Error(`[sync] identifiant de compte invalide : "${owner}"`);
  return `kinetic-u-${owner}`;
}

/** Erreurs IndexedDB « connexion perdue » (WebKit) : on rouvre la base et on rejoue. */
function isConnectionError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return name === 'InvalidStateError' || name === 'UnknownError';
}

/**
 * Une lecture retenue par une écriture légitime en cours (page de pull, migration) voit
 * son délai repoussé, au plus ce nombre de fois (≈ 35 s avec le délai par défaut).
 */
const READ_EXTENSIONS_WHILE_WRITING = 6;

function readOwner(tx: IDBTransaction): Promise<unknown> {
  const req = tx.objectStore(S_META).get(META_OWNER);
  return new Promise<unknown>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('meta owner read failed'));
  });
}

export class LocalSyncDb {
  private db: IDBDatabase | null;
  private reopening: Promise<IDBDatabase> | null = null;
  /** Fermée par `close()` : plus aucune réouverture (une base supprimée ne renaît pas). */
  private closed = false;
  /**
   * Transactions `readwrite` en cours, PAR connexion : seules celles de la connexion de
   * la lecture peuvent la retenir (une écriture bloquée sur une connexion abandonnée ne
   * repousse pas la lecture rejouée sur la nouvelle).
   */
  private readonly activeWrites = new Map<IDBDatabase, number>();
  private readonly guard: IdbGuardOptions;

  private constructor(
    readonly factory: IDBFactory,
    readonly name: string,
    readonly owner: string,
    db: IDBDatabase,
    guard: IdbGuardOptions,
  ) {
    this.db = db;
    this.guard = guard;
    this.watch(db);
  }

  static async open(
    factory: IDBFactory,
    owner: string,
    guard?: Partial<IdbGuardOptions>,
  ): Promise<LocalSyncDb> {
    const name = dbNameForOwner(owner);
    const g = idbGuard(guard);
    const db = await LocalSyncDb.connect(factory, name, owner, g);
    const local = new LocalSyncDb(factory, name, owner, db, g);
    let found: unknown;
    try {
      // 1re transaction de la connexion (souvent celle que WebKit « avale ») : une LECTURE,
      // donc surveillée ; l'écriture n'a lieu que si le propriétaire manque (rare).
      found = await local.tx([S_META], 'readonly', (tx) => readOwner(tx));
      if (found === undefined) {
        found = await local.tx([S_META], 'readwrite', async (tx) => {
          const value = await readOwner(tx);
          if (value === undefined) tx.objectStore(S_META).put(owner, META_OWNER);
          return value;
        });
      }
    } catch (err) {
      local.close(); // aucune connexion orpheline (deleteDatabase, versionchange)
      throw err;
    }
    if (found !== undefined && found !== owner) {
      local.close();
      throw new OwnerMismatchError(name, owner, found);
    }
    return local;
  }

  private static connect(
    factory: IDBFactory,
    name: string,
    owner: string,
    guard: IdbGuardOptions,
    cancelled?: () => boolean,
  ): Promise<IDBDatabase> {
    return openDatabase(
      factory,
      name,
      DB_VERSION,
      (db, oldVersion, tx) => {
        // Réouverture d'une base fermée entre-temps : création annulée.
        if (cancelled?.() === true) throw new Error(`[sync] base "${name}" fermée`);
        if (oldVersion < 1) {
          for (const s of ALL_STORES) {
            if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
          }
          tx.objectStore(S_META).put(owner, META_OWNER);
        }
      },
      guard,
      cancelled,
    );
  }

  private watch(db: IDBDatabase): void {
    const prev = db.onversionchange;
    db.onversionchange = (ev) => {
      if (typeof prev === 'function') prev.call(db, ev);
      db.close();
      if (this.db === db) this.db = null;
    };
    db.onclose = () => {
      if (this.db === db) this.db = null;
    };
  }

  private async connection(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.closed) throw new Error(`[sync] base "${this.name}" fermée`);
    if (!this.reopening) {
      this.reopening = LocalSyncDb.connect(
        this.factory,
        this.name,
        this.owner,
        this.guard,
        () => this.closed,
      )
        .then((db) => {
          if (this.closed) {
            db.close();
            throw new Error(`[sync] base "${this.name}" fermée`);
          }
          this.db = db;
          this.watch(db);
          return db;
        })
        .finally(() => {
          this.reopening = null;
        });
    }
    return this.reopening;
  }

  /**
   * Transaction atomique sur `stores`. En cas de perte de connexion (WebKit), la
   * base est rouverte et la transaction rejouée UNE fois : `fn` ne doit dépendre que
   * de ce qu'elle lit dans la transaction (aucun effet de bord hors IndexedDB).
   *
   * Une LECTURE (`readonly`) qui ne se termine jamais (blocage WebKit) est abandonnée
   * après `readTimeoutMs` (délai repoussé tant qu'une écriture de cette base est en
   * cours), puis rejouée UNE fois sur une connexion rouverte ; un second blocage lève
   * `IdbUnresponsiveError` (signalé à l'app). Les écritures ne sont PAS surveillées : une
   * écriture abandonnée par erreur pourrait avoir été validée quand même, et une page de
   * pull ou la migration peuvent légitimement durer.
   */
  async tx<T>(
    stores: readonly string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.connection();
    try {
      return await this.run(db, stores, mode, fn);
    } catch (err) {
      const stalled = isIdbUnresponsive(err);
      if (!stalled && !isConnectionError(err)) throw err;
      if (stalled) {
        console.warn(`[sync] lecture de "${this.name}" sans réponse : base rouverte`);
        forgetWake(this.factory); // nouveau réveil WebKit avant la réouverture
      }
      try {
        db.close();
      } catch {
        /* déjà fermée */
      }
      if (this.db === db) this.db = null;
      const fresh = await this.connection();
      try {
        return await this.run(fresh, stores, mode, fn);
      } catch (again) {
        if (again instanceof IdbUnresponsiveError) throw reportUnresponsive(again);
        throw again;
      }
    }
  }

  private async run<T>(
    db: IDBDatabase,
    stores: readonly string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    if (mode !== 'readonly') {
      this.activeWrites.set(db, (this.activeWrites.get(db) ?? 0) + 1);
      try {
        return await runTransaction(db, stores, mode, fn);
      } finally {
        const left = (this.activeWrites.get(db) ?? 1) - 1;
        if (left > 0) this.activeWrites.set(db, left);
        else this.activeWrites.delete(db);
      }
    }
    return runTransaction(db, stores, mode, fn, {
      ms: this.guard.readTimeoutMs,
      timers: this.guard.timers,
      keepWaiting: () => (this.activeWrites.get(db) ?? 0) > 0,
      maxExtensions: READ_EXTENSIONS_WHILE_WRITING,
    });
  }

  close(): void {
    this.closed = true;
    this.db?.close();
    this.db = null;
  }
}
