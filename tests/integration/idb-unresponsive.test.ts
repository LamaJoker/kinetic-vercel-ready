/**
 * Parade WebKit (sync.md § 4.11) : IndexedDB qui ne répond plus au démarrage ou juste
 * après une navigation (bug WebKit 226547 et apparentés). Sur l'iPhone, environ un
 * lancement sur dix après le rechargement de la démo : ouverture ou première lecture
 * sans aucune réponse, écrans vides, aucune erreur.
 *
 * Moteur : l'IndexedDB mémoire du dépôt (tests/support/fake-indexeddb.ts), enveloppé
 * pour reproduire le défaut : requête d'ouverture ou transaction qui ne déclenche AUCUN
 * événement, `databases()` qui ne répond jamais. Délais courts injectés (horloge réelle).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  databaseExists,
  deleteDatabase,
  type IdbGuardOptions,
  IdbUnresponsiveError,
  onIdbUnresponsive,
  openDatabase,
  requestToPromise,
} from '../../packages/adapter-web/src/sync/idb.js';
import { LocalSyncDb, S_KV } from '../../packages/adapter-web/src/sync/local-db.js';
import { SyncedStorage } from '../../packages/adapter-web/src/sync/SyncedStorage.js';
import {
  closeAllLocalDatabases,
  closeLocalDatabasesOnPageHide,
} from '../../packages/adapter-web/src/sync/connections.js';
import { LegacyFallbackStorage } from '../../packages/adapter-web/src/sync/fallback-storage.js';
import {
  createStorageRecovery,
  type StorageRecoveryEnv,
} from '../../apps/web/src/lib/storage-unresponsive.js';
import {
  createFakeIndexedDB,
  type FakeDatabase,
  type FakeIndexedDB,
  FakeOpenRequest,
  FakeRequest,
} from '../support/fake-indexeddb';

const GUARD: Partial<IdbGuardOptions> = {
  openTimeoutMs: 30,
  openAttempts: 3,
  wakeIntervalMs: 5,
  wakeMaxMs: 40,
  readTimeoutMs: 30,
};

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Requête d'ouverture « avalée » par WebKit : aucun événement tant qu'elle n'est pas libérée. */
class StalledOpen {
  readonly req = new FakeOpenRequest();
  constructor(
    private readonly fake: FakeIndexedDB,
    private readonly name: string,
    private readonly version: number | undefined,
  ) {}

  /** Réponse tardive : la vraie ouverture a lieu, ses événements arrivent sur la requête avalée. */
  release(): void {
    const real = this.fake.open(this.name, this.version);
    const req = this.req;
    real.onupgradeneeded = (ev) => {
      req.result = real.result;
      req.transaction = real.transaction;
      req.onupgradeneeded?.({ ...ev, target: req });
    };
    real.onsuccess = () => {
      req.result = real.result;
      req.onsuccess?.({ target: req });
    };
    real.onerror = (ev) => {
      req.error = real.error;
      req.onerror?.({ target: req, preventDefault: ev.preventDefault });
    };
  }
}

interface Plan {
  /** Nombre de prochaines ouvertures avalées. */
  stallOpens: number;
  /** `databases()` ne répond jamais. */
  databasesHang: boolean;
  /** Nombre de prochaines transactions `readonly` qui ne se terminent jamais. */
  stallReads: number;
  /** Transactions `readonly` laissées passer avant d'appliquer `stallReads`. */
  skipReads: number;
  /** Nombre de prochaines transactions `readwrite` qui ne se terminent jamais. */
  stallWrites: number;
  /** Nombre de prochaines transactions, quel que soit leur mode, qui ne se terminent jamais. */
  stallAny: number;
}

/** Transaction qui ne se termine jamais : ses requêtes ne répondent pas. */
function stalledTransaction(counter: { aborts: number }): IDBTransaction {
  const store = new Proxy(
    {},
    {
      get: () => () => new FakeRequest(),
    },
  );
  const tx = {
    oncomplete: null,
    onabort: null,
    onerror: null,
    error: null,
    objectStore: () => store,
    abort: () => {
      // WebKit bloqué : l'annulation n'aboutit pas non plus (aucun événement).
      counter.aborts++;
    },
  };
  return tx as unknown as IDBTransaction;
}

function wrappedFactory(partial: Partial<Plan> = {}) {
  const { fake } = createFakeIndexedDB();
  const plan: Plan = {
    stallOpens: 0,
    databasesHang: false,
    stallReads: 0,
    skipReads: 0,
    stallWrites: 0,
    stallAny: 0,
    ...partial,
  };
  const stalled: StalledOpen[] = [];
  const stats = { opens: 0, databasesCalls: 0, aborts: 0 };
  /** Connexions obtenues par le code (pour vérifier qu'aucune ne reste ouverte). */
  const connections: FakeDatabase[] = [];
  const wrapDb = (db: IDBDatabase): IDBDatabase =>
    new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (stores: string | string[], mode?: IDBTransactionMode) => {
            if (plan.stallAny > 0) {
              plan.stallAny--;
              return stalledTransaction(stats);
            }
            if (mode === 'readonly' && plan.skipReads > 0) {
              plan.skipReads--;
              return target.transaction(stores, mode);
            }
            if (mode === 'readonly' && plan.stallReads > 0) {
              plan.stallReads--;
              return stalledTransaction(stats);
            }
            if (mode === 'readwrite' && plan.stallWrites > 0) {
              plan.stallWrites--;
              return stalledTransaction(stats);
            }
            return target.transaction(stores, mode);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const factory = {
    open(name: string, version?: number): IDBOpenDBRequest {
      stats.opens++;
      if (plan.stallOpens > 0) {
        plan.stallOpens--;
        const s = new StalledOpen(fake, name, version);
        stalled.push(s);
        return s.req as unknown as IDBOpenDBRequest;
      }
      const real = fake.open(name, version);
      const out = new FakeOpenRequest();
      real.onupgradeneeded = (ev) => {
        out.result = real.result;
        out.transaction = real.transaction;
        out.onupgradeneeded?.({ ...ev, target: out });
      };
      real.onsuccess = () => {
        out.result = real.result;
        if (real.result) connections.push(real.result);
        out.onsuccess?.({ target: out });
      };
      real.onerror = (ev) => {
        out.error = real.error;
        out.onerror?.({ target: out, preventDefault: ev.preventDefault });
      };
      // Résultat enveloppé (transactions pilotables), lu par le code au succès.
      return new Proxy(out, {
        get(target, prop) {
          if (prop === 'result' && target.result) {
            return wrapDb(target.result as unknown as IDBDatabase);
          }
          return Reflect.get(target, prop, target);
        },
        set(target, prop, value) {
          return Reflect.set(target, prop, value, target);
        },
      }) as unknown as IDBOpenDBRequest;
    },
    deleteDatabase: (name: string) => fake.deleteDatabase(name),
    databases(): Promise<IDBDatabaseInfo[]> {
      stats.databasesCalls++;
      if (plan.databasesHang) return new Promise<IDBDatabaseInfo[]>(() => undefined);
      return fake.databases();
    },
    cmp: (a: IDBValidKey, b: IDBValidKey) => fake.cmp(a as string, b as string),
  };
  return { factory: factory as unknown as IDBFactory, fake, plan, stalled, stats, connections };
}

const noUpgrade = (): void => undefined;
const createKv = (db: IDBDatabase): void => {
  if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
};

let unsubscribe: (() => void) | null = null;
function listenUnresponsive(): IdbUnresponsiveError[] {
  const seen: IdbUnresponsiveError[] = [];
  unsubscribe = onIdbUnresponsive((err) => seen.push(err));
  return seen;
}
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

describe('openDatabase : ouverture qui ne répond pas (WebKit)', () => {
  it('1re tentative sans réponse : abandonnée, 2e tentative réussie', async () => {
    const { factory, stats } = wrappedFactory({ stallOpens: 1 });
    const db = await openDatabase(factory, 'base-a', 1, createKv, GUARD);
    expect(stats.opens).toBe(2);
    expect(db.objectStoreNames.contains('kv')).toBe(true);
    db.close();
  });

  it('aucune réponse : IdbUnresponsiveError en temps borné (et signalée)', async () => {
    const seen = listenUnresponsive();
    const { factory, stats } = wrappedFactory({ stallOpens: 99 });
    const started = Date.now();
    await expect(openDatabase(factory, 'base-b', 1, createKv, GUARD)).rejects.toBeInstanceOf(
      IdbUnresponsiveError,
    );
    expect(stats.opens).toBe(3);
    // 3 × 30 ms d'attente (+ réveils) : borné, loin d'une attente indéfinie.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('IdbUnresponsiveError');
  });

  it("succès tardif d'une tentative abandonnée : la connexion obtenue est fermée", async () => {
    const { factory, stalled } = wrappedFactory({ stallOpens: 1 });
    const db = await openDatabase(factory, 'base-c', 1, createKv, GUARD);
    // La 1re requête répond enfin (après la base créée par la 2e) : succès tardif.
    stalled[0]!.release();
    await pause(20);
    const late = stalled[0]!.req.result;
    expect(late).toBeDefined();
    expect(late?._closed).toBe(true);
    db.close();
  });

  it("montée de version tardive d'une tentative abandonnée : annulée, aucune base ni connexion laissée", async () => {
    const { factory, fake, stalled } = wrappedFactory({ stallOpens: 1 });
    await expect(
      openDatabase(factory, 'base-d', 1, createKv, { ...GUARD, openAttempts: 1 }),
    ).rejects.toBeInstanceOf(IdbUnresponsiveError);
    stalled[0]!.release();
    await pause(20);
    // L'upgrade de la requête abandonnée n'a rien créé (la suivante s'en chargera).
    expect(fake.hasDatabase('base-d')).toBe(false);
    expect(stalled[0]!.req.result?._closed).toBe(true);
  });

  it('databases() qui ne répond jamais : réveil interrompu, ouverture faite quand même', async () => {
    const { factory, stats } = wrappedFactory({ databasesHang: true });
    const db = await openDatabase(factory, 'base-e', 1, createKv, GUARD);
    expect(db.objectStoreNames.contains('kv')).toBe(true);
    // Réveil : databases() rappelé à intervalle court pendant au plus wakeMaxMs.
    expect(stats.databasesCalls).toBeGreaterThan(1);
    db.close();
  });

  it('réveil fait une fois : les ouvertures suivantes ne rappellent pas databases()', async () => {
    const { factory, stats } = wrappedFactory();
    (await openDatabase(factory, 'base-f', 1, createKv, GUARD)).close();
    const calls = stats.databasesCalls;
    expect(calls).toBeGreaterThanOrEqual(1);
    (await openDatabase(factory, 'base-f', 1, createKv, GUARD)).close();
    expect(stats.databasesCalls).toBe(calls);
  });

  it('onblocked (autre connexion) : pas de délai, pas de nouvelle tentative', async () => {
    const { factory, stalled, stats } = wrappedFactory({ stallOpens: 1 });
    const opening = openDatabase(factory, 'base-g', 1, createKv, GUARD);
    await pause(5);
    // Une autre connexion retient la base : l'ouverture attend, sans être abandonnée.
    stalled[0]!.req.onblocked?.();
    await pause(150); // bien au-delà de 3 × openTimeoutMs
    expect(stats.opens).toBe(1);
    stalled[0]!.release();
    const db = await opening;
    expect(db.objectStoreNames.contains('kv')).toBe(true);
    db.close();
  });
});

describe('databaseExists : jamais « absente » quand IndexedDB est bloqué', () => {
  it('databases() bloqué : existence vérifiée par ouverture (base présente / absente)', async () => {
    const { factory } = wrappedFactory({ databasesHang: true });
    (await openDatabase(factory, 'presente', 1, createKv, GUARD)).close();
    expect(await databaseExists(factory, 'presente', GUARD)).toBe(true);
    expect(await databaseExists(factory, 'absente', GUARD)).toBe(false);
  });

  it('databases() ET ouverture bloqués : IdbUnresponsiveError, pas false', async () => {
    const { factory } = wrappedFactory({ databasesHang: true, stallOpens: 99 });
    await expect(databaseExists(factory, 'keyval-store', GUARD)).rejects.toBeInstanceOf(
      IdbUnresponsiveError,
    );
  });
});

describe('LocalSyncDb : lecture (readonly) qui ne se termine jamais', () => {
  it('1re lecture bloquée : connexion rouverte, lecture rejouée avec les vraies données', async () => {
    const { factory, plan, stats } = wrappedFactory();
    const storage = await SyncedStorage.open({
      owner: 'guest',
      remote: null,
      factory,
      migrateLegacy: false,
      idbGuard: GUARD,
    });
    await storage.set(STORAGE_KEYS.USER_PROFILE, { name: 'Léa' });
    await pause(20); // lectures de fond (état de synchro) terminées : seule keys() est bloquée
    const opensBefore = stats.opens;
    plan.stallReads = 1;
    expect(await storage.keys()).toEqual([STORAGE_KEYS.USER_PROFILE]);
    expect(stats.opens).toBe(opensBefore + 1);
    expect(stats.aborts).toBe(1);
    expect(await storage.get(STORAGE_KEYS.USER_PROFILE)).toEqual({ name: 'Léa' });
    storage.dispose();
  });

  it('lecture bloquée deux fois : IdbUnresponsiveError signalée, jamais une liste vide', async () => {
    const seen = listenUnresponsive();
    const { factory, plan } = wrappedFactory();
    const storage = await SyncedStorage.open({
      owner: 'guest',
      remote: null,
      factory,
      migrateLegacy: false,
      idbGuard: GUARD,
    });
    await storage.set(STORAGE_KEYS.USER_PROFILE, { name: 'Léa' });
    await pause(20); // lectures de fond (état de synchro) terminées : seule keys() est bloquée
    plan.stallReads = 2;
    await expect(storage.keys()).rejects.toBeInstanceOf(IdbUnresponsiveError);
    expect(seen).toHaveLength(1);
    // Les données sont intactes : la lecture suivante (WebKit débloqué) les retrouve.
    expect(await storage.keys()).toEqual([STORAGE_KEYS.USER_PROFILE]);
    storage.dispose();
  });

  it("écriture en cours : le délai de lecture est repoussé ; l'écriture n'est jamais abandonnée", async () => {
    const { factory, plan } = wrappedFactory();
    const db = await LocalSyncDb.open(factory, 'guest', GUARD);
    plan.stallWrites = 1;
    let writeSettled = false;
    void db
      .tx([S_KV], 'readwrite', (tx) => {
        tx.objectStore(S_KV).put(1, 'k');
      })
      .then(
        () => (writeSettled = true),
        () => (writeSettled = true),
      );
    plan.stallReads = 1;
    let readSettled = false;
    const reading = db
      .tx([S_KV], 'readonly', (tx) => requestToPromise(tx.objectStore(S_KV).count()))
      .finally(() => (readSettled = true));
    await pause(90); // 3 × readTimeoutMs : sans écriture en cours, déjà abandonnée
    expect(readSettled).toBe(false);
    // Écriture retenue indéfiniment : la lecture finit par être rejouée (pas d'attente infinie).
    await expect(reading).resolves.toBe(0);
    expect(writeSettled).toBe(false);
    db.close();
  });
});

/** Résout avec la valeur, ou rejette « délai » si la promesse ne se règle pas à temps. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('délai dépassé')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

describe('revue : première transaction, fermeture, écriture bloquée', () => {
  it("1re transaction de la connexion bloquée (contrôle du propriétaire) : l'ouverture aboutit en temps borné", async () => {
    const { factory, plan } = wrappedFactory();
    (await LocalSyncDb.open(factory, 'guest', GUARD)).close(); // base créée, propriétaire posé
    // Relance : la 1re transaction, quel que soit son mode, ne se termine jamais (WebKit).
    plan.stallAny = 1;
    const db = await within(1000, LocalSyncDb.open(factory, 'guest', GUARD));
    expect(db.owner).toBe('guest');
    db.close();
  });

  it('1re transaction bloquée deux fois : IdbUnresponsiveError, et aucune connexion laissée ouverte', async () => {
    const seen = listenUnresponsive();
    const { factory, plan, connections } = wrappedFactory();
    (await LocalSyncDb.open(factory, 'guest', GUARD)).close();
    plan.stallAny = 2;
    await expect(within(1000, LocalSyncDb.open(factory, 'guest', GUARD))).rejects.toBeInstanceOf(
      IdbUnresponsiveError,
    );
    expect(seen).toHaveLength(1);
    expect(connections.filter((c) => !c._closed)).toHaveLength(0);
    // Aucune connexion orpheline : la suppression (effacement, suppression de compte) aboutit.
    await within(500, deleteDatabase(factory, 'kinetic-guest'));
  });

  it('fermeture pendant la réouverture après une lecture bloquée : la base supprimée ne renaît pas', async () => {
    const { factory, fake, plan } = wrappedFactory({ databasesHang: true });
    const db = await LocalSyncDb.open(factory, 'guest', GUARD);
    plan.stallReads = 1;
    const reading = db.tx([S_KV], 'readonly', (tx) =>
      requestToPromise(tx.objectStore(S_KV).count()),
    );
    reading.catch(() => undefined);
    // Lecture abandonnée (30 ms), réouverture en cours (réveil : databases() sans réponse, 40 ms).
    await pause(45);
    // Effacement / suppression du compte pendant ce temps (SyncedStorage.destroyLocalDatabase).
    db.close();
    await within(500, deleteDatabase(factory, 'kinetic-guest'));
    await expect(within(1000, reading)).rejects.toThrow();
    await pause(50);
    expect(fake.hasDatabase('kinetic-guest')).toBe(false);
  });

  it("écriture bloquée sur l'ancienne connexion : la lecture rejouée n'est plus repoussée", async () => {
    const { factory, plan } = wrappedFactory();
    let readTimers = 0;
    const timers = {
      setTimeout: (fn: () => void, ms: number): unknown => {
        if (ms === 25) readTimers++;
        return setTimeout(fn, ms);
      },
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const db = await LocalSyncDb.open(factory, 'guest', { ...GUARD, readTimeoutMs: 25, timers });
    plan.stallWrites = 1;
    void db
      .tx([S_KV], 'readwrite', (tx) => {
        tx.objectStore(S_KV).put(1, 'k');
      })
      .catch(() => undefined);
    readTimers = 0;
    plan.stallReads = 2;
    await expect(
      within(
        2000,
        db.tx([S_KV], 'readonly', (tx) => requestToPromise(tx.objectStore(S_KV).count())),
      ),
    ).rejects.toBeInstanceOf(IdbUnresponsiveError);
    // 1re lecture : délai initial + 6 reports (écriture en cours sur CETTE connexion).
    // Lecture rejouée sur la nouvelle connexion : l'écriture bloquée de l'ancienne ne compte plus.
    expect(readTimers).toBe(8);
    db.close();
  });

  it('SyncedStorage.open : lecture de démarrage bloquée deux fois → erreur, connexion fermée', async () => {
    const seen = listenUnresponsive();
    const { factory, plan, connections } = wrappedFactory();
    (await LocalSyncDb.open(factory, 'guest', GUARD)).close();
    // Contrôle du propriétaire lu normalement, puis la lecture « migration faite ? » bloquée.
    plan.skipReads = 1;
    plan.stallReads = 2;
    await expect(
      within(
        1000,
        SyncedStorage.open({
          owner: 'guest',
          remote: null,
          factory,
          migrateLegacy: false,
          idbGuard: GUARD,
        }),
      ),
    ).rejects.toBeInstanceOf(IdbUnresponsiveError);
    expect(seen).toHaveLength(1);
    // Aucune connexion orpheline (WebKit bloqué ne délivre pas forcément versionchange).
    expect(connections.filter((c) => !c._closed)).toHaveLength(0);
    await within(500, deleteDatabase(factory, 'kinetic-guest'));
  });
});

// ─── Fermeture avant navigation / sortie de page (sync.md § 4.11 bis) ─────────────

describe('suspension des connexions (navigation pleine page, pagehide)', () => {
  it('suspend : écriture en cours terminée AVANT la fermeture, réouverture au prochain accès', async () => {
    const { factory, connections, stats } = wrappedFactory();
    const storage = await SyncedStorage.open({
      owner: 'guest',
      remote: null,
      factory,
      migrateLegacy: false,
      idbGuard: GUARD,
    });
    const writing = storage.set(STORAGE_KEYS.USER_PROFILE, { name: 'Léa' });
    let written = false;
    void writing.then(() => (written = true));
    await closeAllLocalDatabases({ waitMs: 1000 });
    expect(written).toBe(true);
    expect(connections.filter((c) => !c._closed)).toHaveLength(0);
    // Prochain accès : base rouverte, données là (rien de perdu, rien d'annulé).
    const opens = stats.opens;
    expect(await storage.get(STORAGE_KEYS.USER_PROFILE)).toEqual({ name: 'Léa' });
    expect(stats.opens).toBe(opens + 1);
    storage.dispose();
  });

  it('waitMs : 0 (pagehide) — fermeture immédiate, l’écriture déjà lancée va quand même à son terme', async () => {
    const { factory, connections } = wrappedFactory();
    const db = await LocalSyncDb.open(factory, 'guest', GUARD);
    const writing = db.tx([S_KV], 'readwrite', (tx) => {
      tx.objectStore(S_KV).put('v', 'k');
    });
    await pause(0); // transaction créée
    void closeAllLocalDatabases({ waitMs: 0 });
    expect(connections.filter((c) => !c._closed)).toHaveLength(0); // fermée tout de suite
    await expect(writing).resolves.toBeUndefined();
    expect(
      await db.tx([S_KV], 'readonly', (tx) => requestToPromise(tx.objectStore(S_KV).get('k'))),
    ).toBe('v');
    db.close();
  });

  it('transaction demandée sur la connexion suspendue : rejouée sur une connexion rouverte', async () => {
    const { factory } = wrappedFactory();
    const db = await LocalSyncDb.open(factory, 'guest', GUARD);
    await db.tx([S_KV], 'readwrite', (tx) => {
      tx.objectStore(S_KV).put(1, 'a');
    });
    // Lecture qui a déjà sa connexion quand la suspension la ferme.
    const reading = db.tx([S_KV], 'readonly', (tx) =>
      requestToPromise(tx.objectStore(S_KV).count()),
    );
    void db.suspend(0);
    await expect(reading).resolves.toBe(1);
    db.close();
  });

  it('suspension puis fermeture définitive : la base supprimée ne renaît pas', async () => {
    const { factory, fake } = wrappedFactory();
    const db = await LocalSyncDb.open(factory, 'guest', GUARD);
    await db.suspend(0);
    db.close(); // effacement / suppression du compte
    await within(500, deleteDatabase(factory, 'kinetic-guest'));
    await expect(db.tx([S_KV], 'readonly', (tx) => txCountOf(tx))).rejects.toThrow(/fermée/);
    await pause(20);
    expect(fake.hasDatabase('kinetic-guest')).toBe(false);
  });

  it('pagehide / freeze : connexions fermées, rouvertes au retour (cache de retour arrière)', async () => {
    const { factory, connections } = wrappedFactory();
    const win = new EventTarget();
    const doc = new EventTarget();
    const stop = closeLocalDatabasesOnPageHide({
      window: win as unknown as Window,
      document: doc as unknown as Document,
    });
    const db = await LocalSyncDb.open(factory, 'guest', GUARD);
    win.dispatchEvent(new Event('pagehide'));
    expect(connections.filter((c) => !c._closed)).toHaveLength(0);
    expect(await db.tx([S_KV], 'readonly', (tx) => txCountOf(tx))).toBe(0); // rouverte
    doc.dispatchEvent(new Event('freeze'));
    expect(connections.filter((c) => !c._closed)).toHaveLength(0);
    stop();
    await db.tx([S_KV], 'readonly', (tx) => txCountOf(tx));
    win.dispatchEvent(new Event('pagehide')); // écouteur retiré : rien n'est fermé
    expect(connections.filter((c) => !c._closed)).toHaveLength(1);
    db.close();
  });

  it('écriture lancée PENDANT la fermeture (page qui réagit encore) : attendue puis refermée avant de partir', async () => {
    const { factory, connections } = wrappedFactory();
    const storage = await SyncedStorage.open({
      owner: 'guest',
      remote: null,
      factory,
      migrateLegacy: false,
      idbGuard: GUARD,
    });
    // Écriture A, puis B déclenchée peu après la fin de A (ex. tableau de bord rendu par
    // la page qui part) : B rouvre la base pendant la fermeture.
    let wroteB = false;
    void storage.set(STORAGE_KEYS.USER_PROFILE, { name: 'Léa' }).then(async () => {
      await pause(5);
      await storage.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ date: '2026-11-28', weight: 77.6 }]);
      wroteB = true;
    });
    await closeAllLocalDatabases({ waitMs: 1000 });
    // Au départ de la page : B écrite, et AUCUNE connexion laissée ouverte.
    expect(wroteB).toBe(true);
    expect(connections.filter((c) => !c._closed)).toHaveLength(0);
    storage.dispose();
  });

  it('réouverture en cours au moment de la suspension : la connexion obtenue est refermée avant de partir', async () => {
    const { factory, connections } = wrappedFactory();
    const db = await LocalSyncDb.open(factory, 'guest', GUARD);
    await db.suspend(0);
    // Lecture qui rouvre la base ; la suspension arrive pendant la réouverture.
    const reading = db.tx([S_KV], 'readonly', (tx) => txCountOf(tx));
    await closeAllLocalDatabases({ waitMs: 1000 });
    await expect(reading).resolves.toBe(0);
    expect(connections.filter((c) => !c._closed)).toHaveLength(0);
    db.close();
  });

  it('repli (ancienne base) : suspendu puis rouvert, écritures de repli conservées', async () => {
    const { factory, connections } = wrappedFactory();
    const fallback = new LegacyFallbackStorage({ owner: 'guest', factory });
    await fallback.set(STORAGE_KEYS.USER_PROFILE, { name: 'Léa' });
    await closeAllLocalDatabases({ waitMs: 500 });
    expect(connections.filter((c) => !c._closed)).toHaveLength(0);
    expect(await fallback.get(STORAGE_KEYS.USER_PROFILE)).toEqual({ name: 'Léa' });
    fallback.dispose();
  });
});

const txCountOf = (tx: IDBTransaction): Promise<number> =>
  requestToPromise(tx.objectStore(S_KV).count());

// ─── Chaîne complète : lecture bloquée → erreur → rechargement → 2e blocage → message ──

describe('reprise : lecture bloquée jusqu’au message de secours', () => {
  /** Appareil : sessionStorage conservé d'un chargement de page à l'autre. */
  function device() {
    const session = new Map<string, string>();
    const reload = vi.fn();
    const showMessage = vi.fn<(retry: () => void) => void>();
    const env: StorageRecoveryEnv = {
      now: () => Date.now(),
      session: () => ({
        getItem: (k: string) => session.get(k) ?? null,
        setItem: (k: string, v: string) => void session.set(k, v),
      }),
      reload,
      showMessage,
      later: () => undefined, // page remplacée par le rechargement : minuterie sans effet
    };
    return { env, session, reload, showMessage };
  }

  /** Un chargement de page : gestionnaire branché sur `onIdbUnresponsive` (comme deps.ts). */
  function pageLoad(env: StorageRecoveryEnv): () => void {
    const handle = createStorageRecovery(env);
    return onIdbUnresponsive(() => void handle());
  }

  it('1er blocage : IdbUnresponsiveError (jamais une liste vide) et UN rechargement ; 2e blocage après rechargement : message', async () => {
    const d = device();
    const { factory, plan } = wrappedFactory();

    // Page 1 : la démo est écrite, puis toutes les lectures ne répondent plus (WebKit).
    let stop = pageLoad(d.env);
    const page1 = await SyncedStorage.open({
      owner: 'guest',
      remote: null,
      factory,
      migrateLegacy: false,
      idbGuard: GUARD,
    });
    await page1.set(STORAGE_KEYS.USER_PROFILE, { name: 'Léa' });
    await pause(20);
    plan.stallReads = 2; // lecture + lecture rejouée sur une connexion rouverte
    await expect(page1.keys()).rejects.toBeInstanceOf(IdbUnresponsiveError);
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.session.has(STORAGE_KEYS.STORAGE_UNRESPONSIVE_RELOAD_AT)).toBe(true);
    expect(d.showMessage).not.toHaveBeenCalled();
    // Autres lectures bloquées de la même page : pas de 2e rechargement.
    plan.stallReads = 2;
    await expect(page1.keys()).rejects.toBeInstanceOf(IdbUnresponsiveError);
    expect(d.reload).toHaveBeenCalledTimes(1);
    page1.dispose();
    stop();

    // Page 2 (après le rechargement) : l'ouverture elle-même ne répond plus.
    stop = pageLoad(d.env);
    plan.stallOpens = 3;
    await expect(
      within(
        2000,
        SyncedStorage.open({
          owner: 'guest',
          remote: null,
          factory,
          migrateLegacy: false,
          idbGuard: GUARD,
        }),
      ),
    ).rejects.toBeInstanceOf(IdbUnresponsiveError);
    expect(d.reload).toHaveBeenCalledTimes(1); // pas de boucle de rechargements
    expect(d.showMessage).toHaveBeenCalledTimes(1);
    stop();

    // Données intactes : WebKit débloqué, tout est relu.
    const page3 = await SyncedStorage.open({
      owner: 'guest',
      remote: null,
      factory,
      migrateLegacy: false,
      idbGuard: GUARD,
    });
    expect(await page3.get(STORAGE_KEYS.USER_PROFILE)).toEqual({ name: 'Léa' });
    page3.dispose();
  });
});
