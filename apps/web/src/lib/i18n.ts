/**
 * i18n minimal — pas de dépendance externe, juste un dictionnaire keys → string
 * + détection automatique de la langue + helper Alpine.
 *
 * Pourquoi pas i18next ? Bundle de 60+ ko juste pour une app à 3 langues.
 * Ce module pèse < 2 ko gzipped.
 *
 * Usage TS :
 *   import { t, setLocale } from '@/lib/i18n';
 *   t('login.title')           // → "Connexion" en FR, "Sign in" en EN
 *   t('xp.level', { level: 7 }) // interpolation {level}
 *
 * Usage Alpine HTML :
 *   <span x-text="$t('login.title')"></span>
 *
 * Persistance : la locale choisie est stockée en localStorage. Au boot,
 * on lit localStorage > navigator.language > fallback 'fr'.
 */

import { STORAGE_KEYS } from '@kinetic/core';
import { fr } from './i18n/fr';
import { en } from './i18n/en';

export type Locale = 'fr' | 'en';

const DICTIONARIES: Record<Locale, Record<string, string>> = { fr, en };

let currentLocale: Locale = detectLocale();

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.LOCALE);
    if (stored === 'fr' || stored === 'en') return stored;
  } catch {
    /* localStorage indisponible */
  }
  try {
    const nav = navigator.language?.slice(0, 2).toLowerCase();
    if (nav === 'en') return 'en';
  } catch {
    /* noop */
  }
  return 'fr';
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale !== 'fr' && locale !== 'en') return;
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEYS.LOCALE, locale);
  } catch {
    /* noop */
  }
  // Dispatch un event pour que les composants Alpine re-rendent
  try {
    window.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_LOCALE_CHANGED, { detail: { locale } }),
    );
  } catch {
    /* noop */
  }
  // Met à jour l'attribut lang du document pour l'a11y
  try {
    document.documentElement.lang = locale;
  } catch {
    /* noop */
  }
}

/**
 * t(key, vars?) — résout une clé. Si la clé n'existe pas dans la locale
 * courante, on retombe sur EN, puis sur la clé elle-même (debuggable).
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTIONARIES[currentLocale];
  const fallback = DICTIONARIES.en;
  let value = dict[key] ?? fallback[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return value;
}

/**
 * Installer Alpine magic helper : disponible via `$t` dans les templates.
 * Appeler une seule fois au bootstrap, avant `Alpine.start()`.
 */
export function installAlpineI18nMagic(alpine: unknown): void {
  const a = alpine as { magic?: (name: string, cb: () => unknown) => void };
  if (typeof a.magic !== 'function') return;
  a.magic('t', () => t);
  a.magic('locale', () => getLocale);
}
