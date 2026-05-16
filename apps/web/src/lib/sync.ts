/**
 * apps/web/src/lib/sync.ts
 *
 * Device identity for multi-device sync.
 * CRDT vector clock utilities live in @kinetic/core and can be imported directly.
 */

import { STORAGE_KEYS } from '@kinetic/core';

export type DeviceId = string;

/**
 * Returns a stable device UUID persisted in localStorage.
 * localStorage is used intentionally (not IDB) so the ID survives an IDB clear()
 * and is available synchronously before store initialisation.
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
    // localStorage unavailable (iOS private mode, quota full) → volatile ID for this session.
    return crypto.randomUUID();
  }
}
