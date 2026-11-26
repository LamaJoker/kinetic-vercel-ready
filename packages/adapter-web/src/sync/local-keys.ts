import { STORAGE_KEYS } from '@kinetic/core';

/**
 * Clés purement locales : jamais poussées, jamais tirées, jamais dans l'outbox
 * (sync.md § 4.2). Même liste que les règles `device` du registre de fusion du core
 * (`isDeviceLocalKey`), recopiée ici pour ne pas charger ce registre au démarrage ;
 * un test vérifie qu'elles restent identiques.
 */
export const LOCAL_ONLY_KEYS: ReadonlySet<string> = new Set([
  STORAGE_KEYS.SYNC_OUTBOX,
  STORAGE_KEYS.SYNC_CURSOR,
  STORAGE_KEYS.SYNC_LAST_AT,
  STORAGE_KEYS.SYNC_INITIAL_DONE,
  STORAGE_KEYS.SYNC_MIGRATED_TO,
  STORAGE_KEYS.SYNC_FALLBACK_JOURNAL,
  STORAGE_KEYS.SCHEMA_VERSION,
  STORAGE_KEYS.SCHEMA_MIGRATION_LOCK,
  // Brouillon de la séance en cours : propre à cet appareil (écrit à chaque série).
  STORAGE_KEYS.TRAINING_ACTIVE_SESSION,
  // Journal d'écriture anticipée d'une mutation de tâche : rejoué sur CET appareil.
  STORAGE_KEYS.PENDING_TASK_MUTATION,
  // Valeurs d'avant la dernière restauration d'une sauvegarde (annulation sur CET appareil).
  STORAGE_KEYS.BACKUP_RESTORE_UNDO,
]);

export function isLocalOnlyKey(key: string): boolean {
  return LOCAL_ONLY_KEYS.has(key);
}
