/**
 * StoragePort — interface de stockage clé-valeur async.
 *
 * Implémentations : SyncedStorage (base IndexedDB par compte + synchro, web),
 *                   IdbStorage (ancienne base locale, repli), MemoryStorage (tests),
 *                   SupabaseStorage (cloud, ancien chemin), HybridStorage (ancien client).
 *
 * Les clés sont des chaînes de la forme "kinetic:namespace:id".
 * Les valeurs sont sérialisables en JSON (pas de classes, pas de Date brutes).
 *
 * Contrat de lecture : `get` renvoie `null` UNIQUEMENT si la clé est absente.
 * Un échec de lecture (base fermée, erreur IndexedDB…) DOIT être levé : le
 * confondre avec « absent » pousserait l'appelant à écrire une valeur par défaut
 * par-dessus les données de l'utilisateur.
 */
export type StorageKey = string;

/** Une écriture d'un lot `setMany` : valeur à écrire, ou suppression (`value` absent + `remove: true`). */
export type StorageWrite =
  | { readonly key: StorageKey; readonly value: unknown; readonly remove?: false }
  | { readonly key: StorageKey; readonly remove: true };

export interface StoragePort {
  get<T>(key: StorageKey): Promise<T | null>;
  set<T>(key: StorageKey, value: T): Promise<void>;
  /**
   * Écrit plusieurs clés de façon ATOMIQUE quand l'implémentation le permet
   * (une seule transaction IndexedDB pour SyncedStorage) : toutes les écritures
   * sont appliquées, ou aucune. Sert par exemple à écrire une collection et sa
   * clé sœur de suppressions d'éléments (`kinetic:deleted:<clé>`) ensemble.
   */
  setMany(writes: readonly StorageWrite[]): Promise<void>;
  remove(key: StorageKey): Promise<void>;
  keys(): Promise<readonly StorageKey[]>;
  clear(): Promise<void>;
}
