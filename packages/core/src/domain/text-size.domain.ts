/**
 * Taille du texte (Profil › Préférences) : taille de base de la page, d'où
 * découlent toutes les mesures en rem (Tailwind). Pur, zéro I/O.
 *
 * - « Système » suit le réglage d'accessibilité de l'appareil. Sur iPhone
 *   (WKWebView), la police `-apple-system-body` vaut 17 px au réglage par
 *   défaut et suit « Taille du texte » (Dynamic Type) : la base est ramenée à
 *   l'échelle 16 px, bornée pour garder la mise en page. Ailleurs, la base reste
 *   celle du navigateur (sur Android, la WebView applique déjà l'échelle de
 *   police du système via son zoom de texte).
 * - Les autres choix fixent la base, quel que soit l'appareil.
 */

export type TextSizePref = 'system' | 'normal' | 'large' | 'xlarge';

export const TEXT_SIZE_PREFS: readonly TextSizePref[] = ['system', 'normal', 'large', 'xlarge'];

export const TEXT_SIZE_LABELS: Readonly<Record<TextSizePref, string>> = {
  system: 'Système',
  normal: 'Normal',
  large: 'Grand',
  xlarge: 'Très grand',
};

/** Taille de base de référence (rem du design). */
export const TEXT_BASE_PX = 16;
/** Taille de `-apple-system-body` au réglage iOS par défaut (« Grand »). */
export const APPLE_BODY_DEFAULT_PX = 17;
/** Bornes de la base en mode « Système » : lisible sans casser la mise en page. */
export const TEXT_BASE_MIN_PX = 14;
export const TEXT_BASE_MAX_PX = 20;

const FIXED_BASE_PX: Readonly<Record<Exclude<TextSizePref, 'system'>, number>> = {
  normal: 16,
  large: 18,
  xlarge: 20,
};

export function parseTextSizePref(raw: unknown): TextSizePref {
  return typeof raw === 'string' && (TEXT_SIZE_PREFS as readonly string[]).includes(raw)
    ? (raw as TextSizePref)
    : 'system';
}

/**
 * Taille de base en px, ou null pour laisser celle du navigateur.
 * `appleBodyPx` : taille calculée de `-apple-system-body` (null si non prise en charge).
 */
export function textBasePx(pref: TextSizePref, appleBodyPx: number | null): number | null {
  if (pref !== 'system') return FIXED_BASE_PX[pref];
  if (appleBodyPx === null || !Number.isFinite(appleBodyPx) || appleBodyPx <= 0) return null;
  const scaled = (appleBodyPx * TEXT_BASE_PX) / APPLE_BODY_DEFAULT_PX;
  const clamped = Math.min(TEXT_BASE_MAX_PX, Math.max(TEXT_BASE_MIN_PX, scaled));
  return Math.round(clamped * 4) / 4;
}

/** Valeur CSS de `font-size` sur <html> (en %, pour composer avec le zoom du navigateur). */
export function textBaseCss(px: number | null): string {
  if (px === null) return '';
  return `${Math.round((px / TEXT_BASE_PX) * 10000) / 100}%`;
}
