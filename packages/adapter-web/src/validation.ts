/**
 * Validation helpers — partagés entre IdbStorage et HybridStorage.
 * Extraits de apps/web/src/lib/security.ts pour être utilisables
 * dans le package adapter-web sans dépendre de l'app web.
 */

/**
 * validateStorageKey — vérifie que la clé est dans le format attendu.
 * Pattern : caractères alphanumériques, deux-points, tirets, underscores.
 * Longueur : 1 à 200 caractères.
 */
export function validateStorageKey(key: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,200}$/.test(key);
}

/**
 * validateStorageValue — vérifie que la valeur est sérialisable et < 1 MB.
 * Évite les QuotaExceededError surprises en production.
 */
export function validateStorageValue(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 1_024 * 1_024; // 1 MB max
  } catch {
    return false;
  }
}
