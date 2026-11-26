/**
 * Petit wrapper IndexedDB à promesses, multi-stores (idb-keyval ne gère qu'un store
 * par base). Règle d'or : dans `runTransaction`, la fonction ne doit attendre QUE des
 * requêtes IndexedDB de la transaction (sinon la transaction se valide toute seule).
 */

export function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export type UpgradeFn = (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void;

// ─── Robustesse WebKit (docs/architecture/sync.md § 4.11) ──────────────────────
//
// WebKit (Safari, WKWebView de l'app iPhone) a un défaut connu (bug 226547 et
// apparentés) : au démarrage ou juste après une navigation, `indexedDB.open` — ou la
// première transaction — peut ne JAMAIS répondre tant que le processus IndexedDB n'a pas
// été « réveillé ». Parade : appeler `indexedDB.databases()` à intervalle court jusqu'à
// réponse avant la première ouverture, et ne jamais attendre une ouverture sans limite.

/** Horloge injectable (tests). */
export interface IdbTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdbGuardOptions {
  /** Délai de réponse d'une tentative d'ouverture (ni success, ni error, ni upgradeneeded). */
  openTimeoutMs: number;
  /** Nombre de tentatives d'ouverture avant `IdbUnresponsiveError`. */
  openAttempts: number;
  /** Réveil : intervalle entre deux appels à `databases()`. */
  wakeIntervalMs: number;
  /** Réveil : durée maximale ; au-delà, l'ouverture est tentée quand même. */
  wakeMaxMs: number;
  /** Délai de surveillance d'une transaction en LECTURE (voir `LocalSyncDb.tx`). */
  readTimeoutMs: number;
  timers: IdbTimers;
}

export const DEFAULT_IDB_GUARD: Readonly<IdbGuardOptions> = {
  openTimeoutMs: 4000,
  openAttempts: 3,
  wakeIntervalMs: 100,
  wakeMaxMs: 3000,
  readTimeoutMs: 5000,
  timers: {
    // Résolus à l'appel (et non à l'import) : les horloges simulées des tests s'appliquent.
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
};

export function idbGuard(overrides?: Partial<IdbGuardOptions>): IdbGuardOptions {
  return { ...DEFAULT_IDB_GUARD, ...overrides };
}

/**
 * IndexedDB ne répond plus (ouverture ou lecture sans réponse, réessais compris). Ce
 * n'est PAS une base vide ni absente : les données sont toujours sur l'appareil, le
 * processus IndexedDB de WebKit est bloqué. Ne jamais l'interpréter comme « rien ».
 */
export class IdbUnresponsiveError extends Error {
  constructor(what: string) {
    super(`[idb] ${what} : IndexedDB ne répond pas`);
    this.name = 'IdbUnresponsiveError';
  }
}

export function isIdbUnresponsive(err: unknown): err is IdbUnresponsiveError {
  return err instanceof Error && err.name === 'IdbUnresponsiveError';
}

type UnresponsiveListener = (err: IdbUnresponsiveError) => void;
const unresponsiveListeners = new Set<UnresponsiveListener>();

/**
 * Prévenu quand IndexedDB est déclaré bloqué (échec DÉFINITIF : réessais épuisés). L'app
 * y branche sa reprise (rechargement unique, puis message) ; renvoie le désabonnement.
 */
export function onIdbUnresponsive(listener: UnresponsiveListener): () => void {
  unresponsiveListeners.add(listener);
  return () => unresponsiveListeners.delete(listener);
}

/** Signale un blocage définitif aux abonnés et renvoie l'erreur (pour `throw`). */
export function reportUnresponsive(err: IdbUnresponsiveError): IdbUnresponsiveError {
  for (const listener of [...unresponsiveListeners]) {
    try {
      listener(err);
    } catch (e) {
      console.warn('[idb] abonné au blocage IndexedDB en erreur :', e);
    }
  }
  return err;
}

/** Réveil déjà fait (ou en cours) pour cette fabrique, dans ce chargement de page. */
const awake = new WeakMap<IDBFactory, Promise<void>>();

/**
 * « Réveil » du processus IndexedDB de WebKit : `databases()` appelé toutes les
 * `wakeIntervalMs` jusqu'à la première réponse (succès ou erreur), au plus `wakeMaxMs`.
 * Ne rejette jamais : au-delà, l'ouverture est tentée quand même (elle a son délai).
 */
export function wakeIndexedDb(factory: IDBFactory, g: IdbGuardOptions): Promise<void> {
  if (typeof factory.databases !== 'function') return Promise.resolve();
  const known = awake.get(factory);
  if (known) return known;
  const woken = new Promise<void>((resolve) => {
    let settled = false;
    let timer: unknown = null;
    let elapsed = 0;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) g.timers.clearTimeout(timer);
      resolve();
    };
    const tick = (): void => {
      if (settled) return;
      try {
        factory.databases().then(finish, finish);
      } catch {
        finish();
        return;
      }
      if (elapsed >= g.wakeMaxMs) {
        console.warn('[idb] databases() sans réponse : ouverture tentée quand même');
        finish();
        return;
      }
      const step = Math.max(1, Math.min(g.wakeIntervalMs, g.wakeMaxMs - elapsed));
      elapsed += step;
      timer = g.timers.setTimeout(tick, step);
    };
    tick();
  });
  awake.set(factory, woken);
  return woken;
}

/** Le prochain accès refera le réveil (après un blocage constaté). */
export function forgetWake(factory: IDBFactory): void {
  awake.delete(factory);
}

type OpenOutcome = { kind: 'db'; db: IDBDatabase } | { kind: 'no-answer' };

/** UNE requête d'ouverture, abandonnée si elle ne répond pas dans `openTimeoutMs`. */
function openOnce(
  factory: IDBFactory,
  name: string,
  version: number | undefined,
  upgrade: UpgradeFn,
  g: IdbGuardOptions,
): Promise<OpenOutcome> {
  return new Promise<OpenOutcome>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = version === undefined ? factory.open(name) : factory.open(name, version);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let abandoned = false;
    let timer: unknown = null;
    const answered = (): void => {
      if (timer !== null) g.timers.clearTimeout(timer);
      timer = null;
    };
    timer = g.timers.setTimeout(() => {
      timer = null;
      abandoned = true;
      resolve({ kind: 'no-answer' });
    }, g.openTimeoutMs);

    req.onupgradeneeded = (ev) => {
      answered();
      const tx = req.transaction;
      if (!tx) return;
      if (abandoned) {
        // Réponse tardive d'une tentative abandonnée : aucune création ici, la tentative
        // suivante (en file derrière celle-ci) fera la montée de version.
        try {
          tx.abort();
        } catch {
          /* déjà terminée */
        }
        return;
      }
      try {
        upgrade(req.result, ev.oldVersion, tx);
      } catch (err) {
        tx.abort();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    req.onsuccess = () => {
      answered();
      const db = req.result;
      if (abandoned) {
        // Succès tardif d'une tentative abandonnée : connexion fermée, aucune fuite.
        db.close();
        return;
      }
      // Une autre version de l'app (ou deleteDatabase) demande la base : on libère.
      db.onversionchange = () => db.close();
      resolve({ kind: 'db', db });
    };
    req.onerror = (ev) => {
      answered();
      if (abandoned) {
        ev.preventDefault();
        return;
      }
      reject(req.error ?? new Error(`IndexedDB open "${name}" failed`));
    };
    req.onblocked = () => {
      // Autre connexion ouverte (autre onglet, versionchange) : ce n'est pas un blocage
      // WebKit. On attend qu'elle se ferme, comme avant : pas de délai dans ce cas.
      answered();
      console.warn(`[idb] ouverture de "${name}" bloquée par un autre onglet`);
    };
  });
}

/**
 * Point UNIQUE d'ouverture d'une base. Réveil WebKit avant la première ouverture, puis
 * jusqu'à `openAttempts` tentatives de `openTimeoutMs` ; au-delà, `IdbUnresponsiveError`
 * (jamais d'attente indéfinie, jamais de base « vide » à la place).
 */
export async function openDatabase(
  factory: IDBFactory,
  name: string,
  version: number | undefined,
  upgrade: UpgradeFn,
  guard?: Partial<IdbGuardOptions>,
  cancelled?: () => boolean,
): Promise<IDBDatabase> {
  const g = idbGuard(guard);
  for (let attempt = 1; attempt <= g.openAttempts; attempt++) {
    await wakeIndexedDb(factory, g);
    // Fermée pendant le réveil (effacement, suppression du compte) : aucune requête
    // d'ouverture, qui recréerait une base supprimée entre-temps.
    if (cancelled?.() === true) throw new Error(`[idb] ouverture de "${name}" annulée`);
    const outcome = await openOnce(factory, name, version, upgrade, g);
    if (outcome.kind === 'db') return outcome.db;
    console.warn(
      `[idb] ouverture de "${name}" sans réponse (tentative ${attempt}/${g.openAttempts})`,
    );
    // Nouveau réveil avant la tentative suivante.
    forgetWake(factory);
  }
  throw reportUnresponsive(new IdbUnresponsiveError(`ouverture de "${name}"`));
}

/**
 * Surveillance d'une transaction : sans fin (ni complete, ni error, ni abort) après `ms`,
 * elle est abandonnée et la promesse rejetée avec `IdbUnresponsiveError`. `keepWaiting`
 * repousse l'échéance (une écriture légitime en cours peut retenir la lecture) au plus
 * `maxExtensions` fois.
 */
export interface TxWatchdog {
  ms: number;
  timers: IdbTimers;
  keepWaiting?: () => boolean;
  maxExtensions?: number;
}

/**
 * Exécute `fn` dans UNE transaction. Résout avec le résultat de `fn` APRÈS la
 * validation (`oncomplete`) ; si `fn` échoue, la transaction est annulée (rollback)
 * et l'erreur est propagée. Une requête en erreur annule aussi la transaction.
 */
export function runTransaction<T>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
  watchdog?: TxWatchdog,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([...stores], mode);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let failed = false;
    let timer: unknown = null;
    const disarm = (): void => {
      if (timer !== null && watchdog) watchdog.timers.clearTimeout(timer);
      timer = null;
    };
    if (watchdog) {
      let extensions = 0;
      const fire = (): void => {
        timer = null;
        if (failed) return;
        if (watchdog.keepWaiting?.() === true && extensions < (watchdog.maxExtensions ?? 0)) {
          extensions++;
          timer = watchdog.timers.setTimeout(fire, watchdog.ms);
          return;
        }
        failed = true;
        try {
          tx.abort();
        } catch {
          /* déjà terminée, ou WebKit ne répond plus : la fin tardive est ignorée */
        }
        reject(new IdbUnresponsiveError(`transaction ${mode} sur ${stores.join(',')}`));
      };
      timer = watchdog.timers.setTimeout(fire, watchdog.ms);
    }
    let done: Promise<T>;
    try {
      done = Promise.resolve(fn(tx));
    } catch (err) {
      done = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    done.catch((err: unknown) => {
      disarm();
      failed = true;
      try {
        tx.abort();
      } catch {
        /* déjà terminée */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    tx.oncomplete = () => {
      disarm();
      if (failed) return;
      done.then(resolve, reject);
    };
    tx.onabort = () => {
      disarm();
      if (failed) return;
      failed = true;
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

export function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`deleteDatabase "${name}" failed`));
  });
}

/** Annulation volontaire de la création (sonde d'existence). */
class ProbeAbort extends Error {}

/**
 * La base existe-t-elle ? `indexedDB.databases()` quand disponible (avec délai) ; sinon
 * ouverture sans version dont la création est annulée (la base n'est alors pas créée).
 * IndexedDB bloqué → `IdbUnresponsiveError`, JAMAIS « absente » : une migration croirait
 * sinon qu'il n'y a rien à reprendre.
 */
export async function databaseExists(
  factory: IDBFactory,
  name: string,
  guard?: Partial<IdbGuardOptions>,
): Promise<boolean> {
  const g = idbGuard(guard);
  await wakeIndexedDb(factory, g);
  if (typeof factory.databases === 'function') {
    try {
      const list = await new Promise<IDBDatabaseInfo[] | null>((resolve, reject) => {
        const timer = g.timers.setTimeout(() => resolve(null), g.openTimeoutMs);
        factory.databases().then(
          (l) => {
            g.timers.clearTimeout(timer);
            resolve(l);
          },
          (err: unknown) => {
            g.timers.clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
      if (list) return list.some((d) => d.name === name);
      console.warn('[idb] databases() sans réponse : existence vérifiée par ouverture');
    } catch {
      /* repli ci-dessous */
    }
  }
  try {
    const db = await openDatabase(
      factory,
      name,
      undefined,
      () => {
        throw new ProbeAbort();
      },
      g,
    );
    db.close();
    return true;
  } catch (err) {
    if (err instanceof ProbeAbort) return false;
    if (isIdbUnresponsive(err)) throw err;
    return false;
  }
}

/** Lecture typée d'une clé dans un store de la transaction (`undefined` = absente). */
export function txGet<T>(
  tx: IDBTransaction,
  store: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return requestToPromise(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export function txPut(
  tx: IDBTransaction,
  store: string,
  key: IDBValidKey,
  value: unknown,
): Promise<unknown> {
  return requestToPromise(tx.objectStore(store).put(value, key));
}

export function txDelete(tx: IDBTransaction, store: string, key: IDBValidKey): Promise<unknown> {
  return requestToPromise(tx.objectStore(store).delete(key));
}

export function txClear(tx: IDBTransaction, store: string): Promise<unknown> {
  return requestToPromise(tx.objectStore(store).clear());
}

export function txCount(tx: IDBTransaction, store: string): Promise<number> {
  return requestToPromise(tx.objectStore(store).count());
}

export async function txKeys(tx: IDBTransaction, store: string): Promise<string[]> {
  const keys = await requestToPromise(tx.objectStore(store).getAllKeys());
  return keys.filter((k): k is string => typeof k === 'string');
}

/** Toutes les entrées d'un store, `[clé, valeur]` triées par clé. */
export async function txEntries<T>(tx: IDBTransaction, store: string): Promise<Array<[string, T]>> {
  const os = tx.objectStore(store);
  const [keys, values] = await Promise.all([
    requestToPromise(os.getAllKeys()),
    requestToPromise(os.getAll() as IDBRequest<T[]>),
  ]);
  const out: Array<[string, T]> = [];
  keys.forEach((k, i) => {
    if (typeof k === 'string') out.push([k, values[i] as T]);
  });
  return out;
}
