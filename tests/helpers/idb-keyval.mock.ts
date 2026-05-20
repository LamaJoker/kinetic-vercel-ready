/**
 * tests/helpers/idb-keyval.mock.ts
 *
 * Stub in-memory d'idb-keyval pour les tests Node (pas de vrai IDB disponible).
 * Utilisé via l'alias vitest : find: 'idb-keyval' → ce fichier.
 */

type CustomStore = symbol;

const stores = new Map<CustomStore, Map<string, unknown>>();

function getStore(store?: CustomStore): Map<string, unknown> {
  if (!store) {
    const key = Symbol('default');
    stores.set(key, new Map());
    return stores.get(key)!;
  }
  if (!stores.has(store)) stores.set(store, new Map());
  return stores.get(store)!;
}

export function createStore(_dbName: string, _storeName: string): CustomStore {
  const key = Symbol(`${_dbName}:${_storeName}`);
  stores.set(key, new Map());
  return key;
}

export async function get<T>(key: string, store?: CustomStore): Promise<T | undefined> {
  return getStore(store).get(key) as T | undefined;
}

export async function set<T>(key: string, value: T, store?: CustomStore): Promise<void> {
  getStore(store).set(key, value);
}

export async function del(key: string, store?: CustomStore): Promise<void> {
  getStore(store).delete(key);
}

export async function keys(store?: CustomStore): Promise<string[]> {
  return [...getStore(store).keys()];
}

export async function clear(store?: CustomStore): Promise<void> {
  getStore(store).clear();
}

export async function getMany<T>(keys: string[], store?: CustomStore): Promise<(T | undefined)[]> {
  return keys.map((k) => getStore(store).get(k) as T | undefined);
}

export async function setMany(entries: [string, unknown][], store?: CustomStore): Promise<void> {
  entries.forEach(([k, v]) => getStore(store).set(k, v));
}

export async function update<T>(
  key: string,
  updater: (oldValue: T | undefined) => T,
  store?: CustomStore,
): Promise<void> {
  const old = getStore(store).get(key) as T | undefined;
  getStore(store).set(key, updater(old));
}
