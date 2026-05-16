/**
 * apps/web/src/lib/sync.ts
 *
 * CRDT Vector Clock — re-exports depuis @kinetic/core pour les consommateurs
 * tiers et tests legacy. Le runtime utilise HybridStorage (cf. adapter-web)
 * comme moteur de sync ; cet ancien SyncManager class a été retiré pour
 * éviter le dead code et la confusion (deux moteurs de sync coexistants).
 */

import {
  createClock,
  incrementClock,
  mergeClock,
  compareClocks,
  resolveConflict,
  STORAGE_KEYS,
} from '@kinetic/core';
import type { VectorClock, ClockComparison, CRDTValue } from '@kinetic/core';

export { createClock, incrementClock, mergeClock, compareClocks, resolveConflict };
export type { ClockComparison };
export type { VectorClock, ClockComparison as CausalOrder };
// Alias rétro-compat : CRDTValue était nommé SyncedValue ici
export type { CRDTValue as SyncedValue };

// ── Device Identity ───────────────────────────────────────────────────────

export type DeviceId = string;

/**
 * getOrCreateDeviceId — retourne le device ID persisté en localStorage.
 * Note : localStorage est utilisé intentionnellement (pas IDB) pour survivre
 * à un clear() IndexedDB et être synchrone (utilisable pré-init des stores).
 */
export function getOrCreateDeviceId(): DeviceId {
  if (typeof window === 'undefined') {
    return 'server-0000-0000-0000-000000000000';
  }
  try {
    let id = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEYS.DEVICE_ID, id);
    }
    return id;
  } catch {
    // localStorage indisponible (mode privé iOS, quota plein) → ID volatile
    // pour la session courante. Pas idéal pour le multi-device mais évite le crash.
    return crypto.randomUUID();
  }
}
