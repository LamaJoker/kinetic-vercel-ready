import type { StoragePort } from '@kinetic/core';
import type { LegacyFallbackStorageOptions } from './fallback-storage.js';

/**
 * Repli (base du compte impossible à ouvrir) chargé à la demande : hors du bundle de
 * démarrage, il ne sert qu'en cas de panne.
 */
export async function openLegacyFallbackStorage(
  opts: LegacyFallbackStorageOptions,
): Promise<StoragePort> {
  const { LegacyFallbackStorage } = await import('./fallback-storage.js');
  return new LegacyFallbackStorage(opts);
}
