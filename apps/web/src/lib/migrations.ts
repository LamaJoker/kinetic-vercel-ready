/**
 * Schema migrations for Kinetic IDB data.
 *
 * How to add a migration:
 *   1. Increment SCHEMA_VERSION.
 *   2. Add a case to the switch below for the new version.
 *   3. Read/transform/write the affected keys via `storage`.
 *
 * Invariant: each migration runs exactly once per device.
 * The runner is idempotent — calling it multiple times is safe.
 */
import type { StoragePort } from '@kinetic/core';

const SCHEMA_VERSION = 1;
const KEY = 'kinetic:schema-version';

async function snapshotStorage(storage: StoragePort): Promise<Map<string, unknown>> {
  const snapshot = new Map<string, unknown>();
  const keys = await storage.keys();
  await Promise.all(keys.map(async (key) => {
    snapshot.set(key, await storage.get(key));
  }));
  return snapshot;
}

async function restoreSnapshot(storage: StoragePort, snapshot: Map<string, unknown>): Promise<void> {
  const currentKeys = await storage.keys();
  await Promise.all(currentKeys.map(async (key) => {
    if (!snapshot.has(key)) {
      await storage.remove(key);
    }
  }));
  await Promise.all([...snapshot.entries()].map(async ([key, value]) => {
    if (value === null) {
      await storage.remove(key);
      return;
    }
    await storage.set(key, value);
  }));
}

export async function runMigrationsIfNeeded(storage: StoragePort): Promise<void> {
  let stored = await storage.get<number>(KEY);
  // Fresh install: no key → treat as version 0
  if (typeof stored !== 'number') stored = 0;
  if (stored >= SCHEMA_VERSION) return;

  for (let v = stored + 1; v <= SCHEMA_VERSION; v++) {
    const snapshot = await snapshotStorage(storage);
    try {
      await runMigration(v, storage);
      await storage.set(KEY, v);
    } catch (err) {
      try {
        await restoreSnapshot(storage, snapshot);
      } catch (restoreErr) {
        console.error('[migrations] restoreSnapshot échoué — données potentiellement corrompues:', restoreErr);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('kinetic:notify', {
            detail: {
              kind: 'error',
              message: 'Migration échouée. Sauvegardez vos données et rechargez l\'application.',
            },
          }));
        }
      }
      throw err;
    }
  }
}

async function runMigration(version: number, _storage: StoragePort): Promise<void> {
  switch (version) {
    case 1:
      // Baseline: existing data written before versioning is already
      // in the correct shape — nothing to transform.
      break;

    default:
      console.warn(`[migrations] unknown version ${version}, skipping`);
  }
}
