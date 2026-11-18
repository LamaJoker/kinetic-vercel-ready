/**
 * Palette « Nuit profonde & corail » côté TypeScript.
 *
 * Les couleurs vivent dans les variables CSS de styles.css (sombre, clair,
 * thème d'accent) : ce module ne renvoie que des références `rgb(var(--x))`
 * pour les styles en ligne et les SVG générés, sauf là où une couleur fixe
 * est obligatoire (barre d'état native, meta theme-color, notifications).
 */

/** Référence CSS à une variable "R G B", avec opacité facultative. */
export function cssVar(name: string, alpha?: number): string {
  return alpha === undefined ? `rgb(var(${name}))` : `rgb(var(${name}) / ${alpha})`;
}

export type MacroKey = 'proteinG' | 'carbsG' | 'fatG';

/**
 * Couleurs des trois macros, partagées par le store (barres) et la page
 * Nutrition (anneaux, légende) : protéines violet, glucides turquoise,
 * lipides ambre. Le corail reste celui des calories (accent).
 */
export const MACRO_COLORS: Record<MacroKey, { from: string; to: string; glow: string }> = {
  proteinG: {
    from: cssVar('--k-macro-p'),
    to: cssVar('--k-macro-p-2'),
    glow: cssVar('--k-macro-p', 0.5),
  },
  carbsG: {
    from: cssVar('--k-macro-c'),
    to: cssVar('--k-macro-c-2'),
    glow: cssVar('--k-macro-c', 0.5),
  },
  fatG: {
    from: cssVar('--k-macro-f'),
    to: cssVar('--k-macro-f-2'),
    glow: cssVar('--k-macro-f', 0.5),
  },
};

/** Rôles sémantiques (variante graphique) pour les SVG générés en TS. */
export const ROLE_COLORS = {
  accent: cssVar('--kinetic-neon'),
  accent2: cssVar('--kinetic-electric'),
  success: cssVar('--k-success'),
  info: cssVar('--k-info'),
  warning: cssVar('--k-warning'),
  danger: cssVar('--k-danger'),
  muted: 'var(--tx2)',
  onAccent: cssVar('--k-on-accent'),
} as const;

/**
 * Couleurs fixes (hors CSS) : fond de page pour la barre d'état native et la
 * meta theme-color, et accent corail des notifications locales.
 * Doivent rester égales à --ink (sombre / clair) et --kinetic-neon (styles.css).
 */
export const PAGE_BG_DARK = '#0B0E1A';
export const PAGE_BG_LIGHT = '#F4F3FA';
export const ACCENT_HEX = '#FF7A66';

/** Couleur du fond de page pour la barre d'état / theme-color. */
export function pageBackground(mode: 'light' | 'dark'): string {
  return mode === 'light' ? PAGE_BG_LIGHT : PAGE_BG_DARK;
}
