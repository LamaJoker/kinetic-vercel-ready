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
import { STORAGE_KEYS } from '@kinetic/core';
import { foldLegacySessions } from './training/storage';
import { journalWrites, undoJournal } from './write-journal';
import { LOCAL_SCHEMA_VERSION } from './schema-version';

const SCHEMA_VERSION = LOCAL_SCHEMA_VERSION;
const KEY = STORAGE_KEYS.SCHEMA_VERSION;

export async function runMigrationsIfNeeded(storage: StoragePort): Promise<void> {
  // navigator.locks prevents concurrent migration runs across tabs opening simultaneously.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    await navigator.locks.request(STORAGE_KEYS.SCHEMA_MIGRATION_LOCK, async () => {
      await _runMigrationsCore(storage);
    });
  } else {
    await _runMigrationsCore(storage);
  }
}

async function _runMigrationsCore(storage: StoragePort): Promise<void> {
  let stored = await storage.get<number>(KEY);
  // Fresh install: no key → treat as version 0
  if (typeof stored !== 'number') stored = 0;
  if (stored >= SCHEMA_VERSION) return;

  for (let v = stored + 1; v <= SCHEMA_VERSION; v++) {
    // Retour arrière limité aux clés que CETTE migration a écrites (journal) : une clé
    // écrite en parallèle par l'app (séance terminée pendant la migration) n'est jamais
    // supprimée ni remise à une valeur ancienne (audit stockage local F2).
    const journal = journalWrites(storage);
    try {
      await runMigration(v, journal.storage);
      await storage.set(KEY, v);
    } catch (err) {
      try {
        await undoJournal(storage, journal.entries());
      } catch (restoreErr) {
        console.error(
          '[migrations] retour arrière échoué — données potentiellement incohérentes:',
          restoreErr,
        );
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: {
                kind: 'error',
                message: "Migration échouée. Sauvegardez vos données et rechargez l'application.",
              },
            }),
          );
        }
      }
      throw err;
    }
  }
}

async function runMigration(version: number, storage: StoragePort): Promise<void> {
  switch (version) {
    case 1:
      // Baseline: existing data written before versioning is already
      // in the correct shape — nothing to transform.
      break;

    case 2:
      // Séances : tableau unique `kinetic:training:sessions` → une clé par séance.
      await foldLegacySessions(storage);
      break;

    default:
      console.warn(`[migrations] unknown version ${version}, skipping`);
  }
}
