/**
 * Theme (light / dark) — gestion du mode visuel.
 *
 * 3 valeurs possibles côté préférence utilisateur :
 *   - 'system' : suit `prefers-color-scheme` du navigateur (défaut effectif : dark)
 *   - 'dark'   : forcé sombre (defaut explicite)
 *   - 'light'  : forcé clair
 *
 * En interne, on applique uniquement `dark` ou `light` sur l'attribut
 * `data-mode` de <html>. L'option 'system' déclenche un listener sur le
 * media query pour réagir si l'OS bascule.
 *
 * Pourquoi `data-mode` et pas `class="dark"` (Tailwind classique) :
 *   - On a déjà `data-theme` pour les couleurs d'accent (electrique, cyber...)
 *   - Garder les deux dimensions orthogonales évite d'écraser la sélection
 *     `data-theme` quand on switch en mode clair.
 *
 * Persistance : `localStorage` via STORAGE_KEYS.THEME_MODE.
 *
 * À appeler une fois au boot (avant l'init Alpine) via `initTheme()` pour
 * éviter le flash sombre→clair au chargement.
 */

import { STORAGE_KEYS } from '@kinetic/core';

export type ThemeMode = 'system' | 'dark' | 'light';

const DARK_MEDIA = '(prefers-color-scheme: dark)';

let _systemListenerInstalled = false;

/** Lit la préférence persistée. Retourne 'dark' par défaut (cohérent app). */
export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.THEME_MODE);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* localStorage indisponible (mode privé iOS) */
  }
  return 'dark';
}

/** Résout 'system' en valeur effective basée sur OS / browser. */
export function resolveThemeMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'dark' || mode === 'light') return mode;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia(DARK_MEDIA).matches ? 'dark' : 'light';
}

/**
 * Applique le mode résolu sur <html>. Idempotent.
 * Dispatch un CustomEvent pour que les composants Alpine puissent réagir
 * (par ex. recharger un SVG meta theme-color du manifeste).
 */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const effective = resolveThemeMode(mode);
  document.documentElement.setAttribute('data-mode', effective);
  // Met à jour aussi <meta name="theme-color"> pour la status bar mobile.
  try {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = effective === 'light' ? '#f8f9fc' : '#050508';
  } catch {
    /* noop */
  }
  try {
    window.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_THEME_CHANGED, {
        detail: { mode, effective },
      }),
    );
  } catch {
    /* noop */
  }
}

/** Change la préférence + persiste + applique. */
export function setThemeMode(mode: ThemeMode): void {
  if (mode !== 'system' && mode !== 'dark' && mode !== 'light') return;
  try {
    localStorage.setItem(STORAGE_KEYS.THEME_MODE, mode);
  } catch {
    /* noop */
  }
  applyThemeMode(mode);
  installSystemListenerIfNeeded(mode);
}

/**
 * À appeler dans main.ts AVANT que le contenu Alpine ne s'affiche, pour
 * éviter un flash de couleurs (FOUC) si l'utilisateur a choisi light.
 */
export function initTheme(): void {
  const mode = getThemeMode();
  applyThemeMode(mode);
  installSystemListenerIfNeeded(mode);
}

/**
 * Ré-applique le thème quand le système bascule. Ne se déclenche que si
 * l'utilisateur est sur 'system'.
 */
function installSystemListenerIfNeeded(mode: ThemeMode): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (_systemListenerInstalled) return;
  _systemListenerInstalled = true;
  const mq = window.matchMedia(DARK_MEDIA);
  const handler = (): void => {
    // On relit la préférence — si l'utilisateur a changé entre temps
    // pour 'dark' ou 'light', on ne fait rien.
    const current = getThemeMode();
    if (current === 'system') applyThemeMode('system');
  };
  // Compat Safari < 14 (addListener au lieu de addEventListener)
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
  } else if (
    typeof (mq as MediaQueryList & { addListener?: typeof handler }).addListener === 'function'
  ) {
    (mq as MediaQueryList & { addListener: typeof handler }).addListener(handler);
  }
  void mode;
}
