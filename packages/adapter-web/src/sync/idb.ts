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

export function openDatabase(
  factory: IDBFactory,
  name: string,
  version: number | undefined,
  upgrade: UpgradeFn,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = version === undefined ? factory.open(name) : factory.open(name, version);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.onupgradeneeded = (ev) => {
      const tx = req.transaction;
      if (!tx) return;
      try {
        upgrade(req.result, ev.oldVersion, tx);
      } catch (err) {
        tx.abort();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Une autre version de l'app (ou deleteDatabase) demande la base : on libère.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error(`IndexedDB open "${name}" failed`));
    req.onblocked = () => {
      console.warn(`[idb] ouverture de "${name}" bloquée par un autre onglet`);
    };
  });
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
    let done: Promise<T>;
    try {
      done = Promise.resolve(fn(tx));
    } catch (err) {
      done = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    done.catch((err: unknown) => {
      failed = true;
      try {
        tx.abort();
      } catch {
        /* déjà terminée */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    tx.oncomplete = () => {
      if (failed) return;
      done.then(resolve, reject);
    };
    tx.onabort = () => {
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

/**
 * La base existe-t-elle ? `indexedDB.databases()` quand disponible ; sinon ouverture
 * sans version dont la création est annulée (la base n'est alors pas créée).
 */
export async function databaseExists(factory: IDBFactory, name: string): Promise<boolean> {
  if (typeof factory.databases === 'function') {
    try {
      const list = await factory.databases();
      return list.some((d) => d.name === name);
    } catch {
      /* repli ci-dessous */
    }
  }
  return new Promise<boolean>((resolve) => {
    let existed = true;
    const req = factory.open(name);
    req.onupgradeneeded = () => {
      existed = false;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      req.result.close();
      resolve(existed);
    };
    req.onerror = () => resolve(false);
  });
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
