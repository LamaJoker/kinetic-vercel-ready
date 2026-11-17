/**
 * Sauvegarde complète : copie de toutes les données de l'application (poids,
 * mensurations, nutrition, routine, niveau, programme…) jointe à l'export JSON,
 * et restauration depuis ce fichier. Les séances et exercices suivent leur propre
 * fusion (import.ts) ; les clés propres à cet appareil ne sont ni copiées ni restaurées.
 */
import { STORAGE_KEYS } from '@kinetic/core';
import type { StoragePort } from '@kinetic/core';

const SKIP_KEYS = new Set<string>([
  STORAGE_KEYS.SYNC_LAST_AT,
  STORAGE_KEYS.SYNC_CURSOR,
  STORAGE_KEYS.SYNC_OUTBOX,
  STORAGE_KEYS.TRAINING_SESSIONS,
  STORAGE_KEYS.TRAINING_EXERCISES,
  STORAGE_KEYS.DEVICE_ID,
  STORAGE_KEYS.DEMO_MANIFEST,
  STORAGE_KEYS.ENTITLEMENT_SERVER_CACHE,
]);

export function isBackedUpKey(key: string): boolean {
  return (
    key.startsWith('kinetic:') &&
    !SKIP_KEYS.has(key) &&
    !key.startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX)
  );
}

export async function snapshotStorage(storage: StoragePort): Promise<Record<string, unknown>> {
  const keys = (await storage.keys()).filter(isBackedUpKey).sort();
  const values = await Promise.all(keys.map((key) => storage.get<unknown>(key)));
  const data: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    if (values[i] !== null && values[i] !== undefined) data[key] = values[i];
  });
  return data;
}

/** Écrit les données d'une sauvegarde (remplace les valeurs existantes). Renvoie le nombre de clés. */
export async function restoreStorage(
  storage: StoragePort,
  data: Readonly<Record<string, unknown>>,
): Promise<number> {
  const entries = Object.entries(data).filter(
    ([key, value]) => isBackedUpKey(key) && value !== null && value !== undefined,
  );
  for (const [key, value] of entries) await storage.set(key, value);
  return entries.length;
}
