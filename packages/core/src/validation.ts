/**
 * packages/core/src/validation.ts
 *
 * Storage validation helpers — pure functions, no external deps.
 * Shared by packages/adapter-web (IdbStorage, HybridStorage) and
 * apps/web (security module) without creating a cross-package dependency.
 */

/**
 * validateStorageKey — checks key format before any write.
 * Pattern: alphanumeric, colons, hyphens, underscores. 1–200 chars.
 */
export function validateStorageKey(key: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,200}$/.test(key);
}

/**
 * validateStorageValue — checks that value is JSON-serialisable and < 1 MB.
 * Prevents silent QuotaExceededError surprises in production.
 */
export function validateStorageValue(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 1_024 * 1_024; // 1 MB max
  } catch {
    return false;
  }
}
