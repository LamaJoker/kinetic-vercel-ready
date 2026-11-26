/**
 * Repli quand la base du compte (`kinetic-u-<id>` / `kinetic-guest`) ne s'ouvre pas
 * (erreur IndexedDB passagère de WebKit, base corrompue, migration en échec) : l'app
 * tourne sur l'ancienne base `keyval-store` / `keyval`.
 *
 * Toute écriture faite pendant le repli est JOURNALISÉE dans la même transaction
 * (`kinetic:sync:fallback-journal` = { <base cible>: [clés] }). À la prochaine ouverture
 * de la base du compte, ces clés sont reprises (`importFallbackWrites`) : sans ce journal,
 * une séance enregistrée pendant le repli restait dans l'ancienne base, que l'app ne relit
 * plus une fois la migration faite, et disparaissait en silence.
 */
import {
  STORAGE_KEYS,
  validateStorageKey,
  validateStorageValue,
  type StorageKey,
  type StoragePort,
  type StorageWrite,
} from '@kinetic/core';
import { openDatabase, requestToPromise, runTransaction } from './idb.js';
import { dbNameForOwner } from './local-db.js';
import { toPlain } from './shared.js';

export const FALLBACK_DB_NAME = 'keyval-store';
export const FALLBACK_STORE_NAME = 'keyval';

export type FallbackJournal = Record<string, string[]>;

export interface LegacyFallbackStorageOptions {
  /** Propriétaire de la base qui aurait dû s'ouvrir (compte ou `'guest'`). */
  owner: string;
  factory?: IDBFactory;
  dbName?: string;
  storeName?: string;
}

/** Clés réservées de l'ancienne base, jamais montrées à l'app. */
const HIDDEN: ReadonlySet<string> = new Set([
  STORAGE_KEYS.SYNC_FALLBACK_JOURNAL,
  STORAGE_KEYS.SYNC_MIGRATED_TO,
]);

export function readJournal(raw: unknown): FallbackJournal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: FallbackJournal = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

export class LegacyFallbackStorage implements StoragePort {
  readonly target: string;
  private readonly factory: IDBFactory | undefined;
  private readonly dbName: string;
  private readonly storeName: string;
  private db: Promise<IDBDatabase> | null = null;

  constructor(opts: LegacyFallbackStorageOptions) {
    this.target = dbNameForOwner(opts.owner);
    this.factory = opts.factory ?? globalThis.indexedDB;
    this.dbName = opts.dbName ?? FALLBACK_DB_NAME;
    this.storeName = opts.storeName ?? FALLBACK_STORE_NAME;
  }

  private connection(): Promise<IDBDatabase> {
    if (!this.db) {
      const factory = this.factory;
      if (!factory) return Promise.reject(new Error('[sync] IndexedDB indisponible'));
      const store = this.storeName;
      this.db = openDatabase(factory, this.dbName, undefined, (db) => {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }).catch((err: unknown) => {
        this.db = null;
        throw err;
      });
    }
    return this.db;
  }

  /**
   * Clés visibles par cette base cible : `null` = toutes (ancienne base non migrée, ou
   * migrée vers CETTE base) ; sinon seulement ses propres écritures de repli. L'ancienne
   * base migrée vers une AUTRE base (autre compte, invité) contient les données de
   * celle-ci : jamais montrées ni reprises par ce compte.
   */
  private async scope(store: IDBObjectStore): Promise<Set<string> | null> {
    const [marker, journal] = await Promise.all([
      requestToPromise(store.get(STORAGE_KEYS.SYNC_MIGRATED_TO)),
      requestToPromise(store.get(STORAGE_KEYS.SYNC_FALLBACK_JOURNAL)),
    ]);
    if (marker === undefined || marker === this.target) return null;
    return new Set(readJournal(journal)[this.target] ?? []);
  }

  async get<T>(key: StorageKey): Promise<T | null> {
    if (HIDDEN.has(key)) return null;
    const db = await this.connection();
    const value = await runTransaction(db, [this.storeName], 'readonly', async (tx) => {
      const store = tx.objectStore(this.storeName);
      const visible = await this.scope(store);
      if (visible && !visible.has(key)) return undefined;
      return requestToPromise(store.get(key));
    });
    return value === undefined ? null : (value as T);
  }

  async set<T>(key: StorageKey, value: T): Promise<void> {
    await this.setMany([{ key, value }]);
  }

  async remove(key: StorageKey): Promise<void> {
    await this.setMany([{ key, remove: true }]);
  }

  /** Données ET journal en UNE transaction : jamais d'écriture non journalisée. */
  async setMany(writes: readonly StorageWrite[]): Promise<void> {
    for (const w of writes) {
      if (!validateStorageKey(w.key) || HIDDEN.has(w.key)) {
        throw new Error(`[sync] clé invalide : "${w.key}"`);
      }
      if (w.remove !== true && !validateStorageValue(w.value)) {
        throw new Error(`[sync] valeur de "${w.key}" trop volumineuse ou non sérialisable`);
      }
    }
    if (writes.length === 0) return;
    const db = await this.connection();
    await runTransaction(db, [this.storeName], 'readwrite', async (tx) => {
      const store = tx.objectStore(this.storeName);
      // Ancienne base pas encore migrée : la première écriture de repli la réserve pour
      // cette base cible (même règle que la migration : la première base qui la réclame).
      // Sinon la migration d'un AUTRE compte copierait ces écritures dans ce compte-là.
      const marker = await requestToPromise(store.get(STORAGE_KEYS.SYNC_MIGRATED_TO));
      if (marker === undefined) store.put(this.target, STORAGE_KEYS.SYNC_MIGRATED_TO);
      const journal = readJournal(
        await requestToPromise(store.get(STORAGE_KEYS.SYNC_FALLBACK_JOURNAL)),
      );
      const keys = new Set(journal[this.target] ?? []);
      for (const w of writes) {
        if (w.remove === true) store.delete(w.key);
        else store.put(toPlain(w.value), w.key);
        keys.add(w.key);
      }
      journal[this.target] = [...keys];
      store.put(journal, STORAGE_KEYS.SYNC_FALLBACK_JOURNAL);
    });
  }

  async keys(): Promise<readonly StorageKey[]> {
    const db = await this.connection();
    const { keys, visible } = await runTransaction(db, [this.storeName], 'readonly', async (tx) => {
      const store = tx.objectStore(this.storeName);
      return {
        visible: await this.scope(store),
        keys: await requestToPromise(store.getAllKeys()),
      };
    });
    return keys.filter(
      (k): k is string =>
        typeof k === 'string' && !HIDDEN.has(k) && (visible === null || visible.has(k)),
    );
  }

  /**
   * « Effacer les données de cet appareil » pendant le repli : données de cette base cible
   * effacées, marqueur de migration conservé ; les écritures journalisées pour CETTE base
   * sont abandonnées (rien à reprendre). Celles des AUTRES bases sont conservées, valeurs
   * comprises : effacées, leur reprise les prendrait pour des suppressions (séance d'un
   * autre compte supprimée dans son cloud). Ancienne base migrée vers une autre base :
   * seules les écritures de repli de cette base-ci sont effacées.
   */
  async clear(): Promise<void> {
    const db = await this.connection();
    await runTransaction(db, [this.storeName], 'readwrite', async (tx) => {
      const store = tx.objectStore(this.storeName);
      const visible = await this.scope(store);
      const journal = readJournal(
        await requestToPromise(store.get(STORAGE_KEYS.SYNC_FALLBACK_JOURNAL)),
      );
      const others = Object.fromEntries(Object.entries(journal).filter(([t]) => t !== this.target));
      const protectedKeys = new Set<string>([...HIDDEN, ...Object.values(others).flat()]);
      const keys = visible ? [...visible] : await requestToPromise(store.getAllKeys());
      for (const k of keys) {
        if (typeof k === 'string' && !protectedKeys.has(k)) store.delete(k);
      }
      if (Object.keys(others).length > 0) store.put(others, STORAGE_KEYS.SYNC_FALLBACK_JOURNAL);
      else store.delete(STORAGE_KEYS.SYNC_FALLBACK_JOURNAL);
    });
  }

  dispose(): void {
    void this.db?.then((db) => db.close()).catch(() => undefined);
    this.db = null;
  }
}
