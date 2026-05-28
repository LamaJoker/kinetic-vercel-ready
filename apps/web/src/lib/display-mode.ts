/**
 * Display density (Simple / Avancé) — levier global de déclutter.
 *
 * Problème : un testeur débutant trouve toutes les pages trop chargées
 * (coach IA, périodisation, scores Wilks/IPF GL/DOTS, équilibre musculaire...).
 *
 * Solution : un attribut `data-density="simple|advanced"` sur <html>.
 * En mode `simple` (défaut), tout élément taggé `.adv-only` est masqué en CSS.
 * Pas besoin de toucher la logique des composants — juste un toggle + une
 * règle CSS. L'utilisateur avancé bascule sur `advanced` pour tout voir.
 *
 * Persistance : localStorage via STORAGE_KEYS.DISPLAY_DENSITY.
 * À appeler au boot via `initDisplayDensity()` (avant Alpine, pas de flash).
 */

import { STORAGE_KEYS } from '@kinetic/core';

export type DisplayDensity = 'simple' | 'advanced';

/** Lit la préférence. Défaut 'simple' — on protège le débutant par défaut. */
export function getDisplayDensity(): DisplayDensity {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.DISPLAY_DENSITY);
    if (v === 'simple' || v === 'advanced') return v;
  } catch {
    /* localStorage indisponible */
  }
  return 'simple';
}

/** Applique l'attribut data-density sur <html>. Idempotent. */
export function applyDisplayDensity(density: DisplayDensity): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-density', density);
  try {
    window.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_DENSITY_CHANGED, { detail: { density } }),
    );
  } catch {
    /* noop */
  }
}

/** Change + persiste + applique. */
export function setDisplayDensity(density: DisplayDensity): void {
  if (density !== 'simple' && density !== 'advanced') return;
  try {
    localStorage.setItem(STORAGE_KEYS.DISPLAY_DENSITY, density);
  } catch {
    /* noop */
  }
  applyDisplayDensity(density);
}

/** À appeler au boot, avant le premier paint Alpine. */
export function initDisplayDensity(): void {
  applyDisplayDensity(getDisplayDensity());
}
