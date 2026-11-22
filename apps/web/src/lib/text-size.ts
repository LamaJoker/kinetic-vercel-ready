/**
 * Taille du texte (Dynamic Type sur iPhone + réglage Profil › Préférences).
 *
 * Toutes les mesures Tailwind sont en rem : régler la taille de police de <html>
 * agrandit texte ET espacements, sans casser les proportions.
 *
 * - iPhone (WKWebView) : `font: -apple-system-body` donne la taille choisie dans
 *   Réglages › Accessibilité › Affichage et taille du texte. On la lit sur un
 *   élément témoin, puis la base est ramenée à l'échelle 16 px et bornée
 *   (text-size.domain.ts). Relu au retour au premier plan (réglage changé entre-temps).
 * - Android (WebView) : le zoom de texte de la WebView suit déjà l'échelle de
 *   police du système (Capacitor ne le force pas à 100 %) ; « Système » n'y
 *   touche donc pas. Les autres choix s'ajoutent à ce zoom.
 *
 * Appelé au démarrage (main.ts), avant le premier rendu.
 */
import {
  STORAGE_KEYS,
  parseTextSizePref,
  textBaseCss,
  textBasePx,
  type TextSizePref,
} from '@kinetic/core';

export function getTextSizePref(): TextSizePref {
  try {
    return parseTextSizePref(localStorage.getItem(STORAGE_KEYS.TEXT_SIZE));
  } catch {
    return 'system';
  }
}

/** iPhone / iPad (Safari, WKWebView). Sur Mac, `-apple-system-body` ne suit pas Dynamic Type. */
export function isAppleTouchDevice(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>): boolean {
  return (
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1)
  );
}

/** Taille de `-apple-system-body` en px, ou null hors iPhone / iPad. */
export function readAppleBodyPx(): number | null {
  if (typeof document === 'undefined' || !document.body) return null;
  try {
    if (typeof navigator === 'undefined' || !isAppleTouchDevice(navigator)) return null;
    if (typeof CSS === 'undefined' || !CSS.supports('font', '-apple-system-body')) return null;
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
    probe.style.font = '-apple-system-body';
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch {
    return null;
  }
}

/** Applique la taille de base sur <html> (data-text-size pour les ajustements CSS). */
export function applyTextSize(pref: TextSizePref = getTextSizePref()): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const px = textBasePx(pref, pref === 'system' ? readAppleBodyPx() : null);
  root.style.fontSize = textBaseCss(px);
  root.dataset.textSize = px !== null && px >= 18.5 ? 'xl' : px !== null && px >= 17 ? 'l' : 'n';
}

export function setTextSizePref(pref: TextSizePref): void {
  try {
    localStorage.setItem(STORAGE_KEYS.TEXT_SIZE, pref);
  } catch {
    /* localStorage indisponible : appliqué pour la session */
  }
  applyTextSize(pref);
}

let listening = false;

export function initTextSize(): void {
  applyTextSize();
  if (listening || typeof document === 'undefined') return;
  listening = true;
  // Réglage iOS modifié pendant que l'app était en arrière-plan.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applyTextSize();
  });
}
