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

export async function runMigrationsIfNeeded(storage: StoragePort): Promise<void> {
  let stored = await storage.get<number>(KEY);
  // Fresh install: no key → treat as version 0
  if (typeof stored !== 'number') stored = 0;
  if (stored >= SCHEMA_VERSION) return;

  for (let v = stored + 1; v <= SCHEMA_VERSION; v++) {
    await runMigration(v, storage);
    await storage.set(KEY, v);
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
