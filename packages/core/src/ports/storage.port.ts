/**
 * StoragePort — interface de stockage clé-valeur async.
 *
 * Implémentations : IdbStorage (web), MemoryStorage (tests),
 *                   SupabaseStorage (cloud), HybridStorage (offline-first).
 *
 * Les clés sont des chaînes de la forme "kinetic:namespace:id".
 * Les valeurs sont sérialisables en JSON (pas de classes, pas de Date brutes).
 */
export type StorageKey = string;

export interface StoragePort {
  get<T>(key: StorageKey): Promise<T | null>;
  set<T>(key: StorageKey, value: T): Promise<void>;
  remove(key: StorageKey): Promise<void>;
  keys(): Promise<readonly StorageKey[]>;
  clear(): Promise<void>;
}
