import { get, set, del, keys, clear, createStore } from 'idb-keyval';
import type { StoragePort, StorageKey } from '@kinetic/core';
import { validateStorageKey, validateStorageValue } from './validation.js';

/**
 * IdbStorage — StoragePort implemented with idb-keyval (IndexedDB wrapper).
 *
 * Notes:
 * - We use a dedicated store (createStore) to avoid collisions if multiple apps share the domain.
 * - Defaults keep idb-keyval's "keyval-store" / "keyval" names to preserve existing data.
 * - All keys/values are validated before write to prevent silent corruption.
 */
export class IdbStorage implements StoragePort {
  private readonly store: ReturnType<typeof createStore>;

  constructor(dbName = 'keyval-store', storeName = 'keyval') {
    this.store = createStore(dbName, storeName);
  }

  async get<T>(key: StorageKey): Promise<T | null> {
    try {
      const value = await get<T>(key, this.store);
      return value ?? null;
    } catch (err) {
      console.error(`[IdbStorage] get failed for key "${key}":`, err);
      return null;
    }
  }

  async set<T>(key: StorageKey, value: T): Promise<void> {
    // Validate key format before write to catch typos early
    if (!validateStorageKey(key)) {
      throw new Error(
        `IdbStorage: invalid key format "${key}" — expected /^[a-zA-Z0-9:_-]{1,200}$/`,
      );
    }

    // Validate value size to prevent QuotaExceededError surprises
    if (!validateStorageValue(value)) {
      throw new Error(
        `IdbStorage: value for key "${key}" exceeds 1 MB limit or is not serialisable`,
      );
    }

    try {
      await set(key, value, this.store);
    } catch (err) {
      // Surface the REAL DOM error name (QuotaExceededError, DataCloneError,
      // InvalidStateError…) so callers can show an accurate user-facing
      // message instead of guessing.  Common cases:
      //   QuotaExceededError → user storage is full or in private browsing
      //   DataCloneError     → value contains non-serialisable types
      //   InvalidStateError  → DB connection closed / browser bug
      const name = err instanceof Error && err.name ? err.name : 'UnknownError';
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[IdbStorage] set failed for key "${key}" (${name}):`, err);
      const wrapped = new Error(`IdbStorage[${name}]: ${msg || 'failed to write'}`);
      wrapped.name = name;
      throw wrapped;
    }
  }

  async remove(key: StorageKey): Promise<void> {
    try {
      await del(key, this.store);
    } catch (err) {
      console.error(`[IdbStorage] remove failed for key "${key}":`, err);
    }
  }

  async keys(): Promise<readonly StorageKey[]> {
    try {
      const allKeys = await keys(this.store);
      return allKeys as string[];
    } catch (err) {
      console.error('[IdbStorage] keys() failed:', err);
      return [];
    }
  }

  async clear(): Promise<void> {
    try {
      await clear(this.store);
    } catch (err) {
      console.error('[IdbStorage] clear() failed:', err);
      throw err;
    }
  }
}
