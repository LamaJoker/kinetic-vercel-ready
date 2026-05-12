/**
 * Storage maintenance — diagnose and reclaim IDB space.
 *
 * Two recurring sources of bloat:
 *   - kinetic:vitalite:done:YYYY-MM-DD  (one new key every day)
 *   - kinetic:xp:earned:YYYY-MM-DD      (one new key every day)
 *
 * Both keys are tiny but accumulate forever. After a year that's ~700 entries,
 * each adding overhead in IDB. We keep the last `RETENTION_DAYS` and drop the
 * rest. Sessions / exercises / profile are NEVER touched.
 */

import type { StoragePort } from '@kinetic/core';
import { STORAGE_KEYS } from '@kinetic/core';

const RETENTION_DAYS = 90;

const DAILY_KEY_PREFIXES = [
  STORAGE_KEYS.VITALITE_DONE_PREFIX,
  STORAGE_KEYS.XP_EARNED_PREFIX,
];

function dateFromDailyKey(key: string): string | null {
  for (const prefix of DAILY_KEY_PREFIXES) {
    if (key.startsWith(prefix)) {
      const date = key.slice(prefix.length);
      // Validate ISO date (YYYY-MM-DD)
      return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    }
  }
  return null;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Estimated bytes used by IDB for the current origin. */
export interface StorageUsage {
  usedBytes: number | null;
  quotaBytes: number | null;
  percent: number | null;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usedBytes: null, quotaBytes: null, percent: null };
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const usedBytes  = typeof usage  === 'number' ? usage  : null;
    const quotaBytes = typeof quota  === 'number' ? quota  : null;
    const percent = (usedBytes !== null && quotaBytes !== null && quotaBytes > 0)
      ? Math.round((usedBytes / quotaBytes) * 100)
      : null;
    return { usedBytes, quotaBytes, percent };
  } catch {
    return { usedBytes: null, quotaBytes: null, percent: null };
  }
}

export interface CompactReport {
  removedKeys: number;
  scannedKeys: number;
  cutoffDate:  string;
}

/**
 * Removes daily-bucketed keys older than RETENTION_DAYS.
 * Safe to call repeatedly — idempotent.
 */
export async function compactStorage(storage: StoragePort): Promise<CompactReport> {
  const cutoff = isoDaysAgo(RETENTION_DAYS);
  const keys = await storage.keys();
  let removed = 0;
  for (const key of keys) {
    const date = dateFromDailyKey(key);
    if (date && date < cutoff) {
      await storage.remove(key);
      removed++;
    }
  }
  return { removedKeys: removed, scannedKeys: keys.length, cutoffDate: cutoff };
}

/**
 * Best-effort, fire-and-forget cleanup at startup. Runs only once per
 * session via the in-memory flag below to avoid touching IDB on every
 * navigation.
 */
let _autoCompactRan = false;
export async function autoCompactOnStartup(storage: StoragePort): Promise<void> {
  if (_autoCompactRan) return;
  _autoCompactRan = true;
  try {
    const { removedKeys } = await compactStorage(storage);
    if (removedKeys > 0) {
      console.info(`[storage] auto-compact removed ${removedKeys} old daily key(s)`);
    }
  } catch (err) {
    console.warn('[storage] auto-compact failed:', err);
  }
}

export function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} Mo`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} Go`;
}
