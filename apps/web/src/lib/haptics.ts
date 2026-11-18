/**
 * Vibrations (retour haptique) — application native uniquement.
 *
 * - Natif (Capacitor iOS / Android) : plugin @capacitor/haptics, chargé à la
 *   demande (import dynamique : rien dans le bundle principal ni sur le web).
 * - Web : aucune vibration (no-op). navigator.vibrate() n'existe pas sur iOS et
 *   donne sur Android un bourdonnement grossier, loin d'un retour « natif ».
 *   (Le chrono de repos garde sa propre alerte, voir training/rest-timer.ts.)
 * - Réglage : Profil > Préférences > « Vibrations » (localStorage, activé par
 *   défaut). Coupé → toutes les fonctions ci-dessous ne font rien.
 * - Jamais en boucle : un même retour ne peut pas repartir moins de
 *   HAPTIC_MIN_GAP_MS après le précédent (appuis répétés, gestes, etc.).
 *
 * Fonctions sémantiques à utiliser :
 *   hapticTap()       sélection : onglet, pastille, seuil de geste franchi
 *   hapticSuccess()   série validée, séance sauvegardée, tâche cochée
 *   hapticCelebrate() record battu, niveau gagné (impact fort)
 *   hapticWarning()/hapticError() alertes
 * hapticLight/Medium/Heavy restent exportées pour les appels existants.
 *
 * Toujours « fire-and-forget » : n'attend rien, ne lève jamais.
 */
import { Capacitor } from '@capacitor/core';
import { STORAGE_KEYS } from '@kinetic/core';

/** Clé localStorage du réglage : '0' = coupé ; absent ou '1' = actif. */
export const HAPTICS_PREF_KEY = STORAGE_KEYS.HAPTICS_ENABLED;
/** Écart minimal entre deux retours du même type (anti-rafale). */
export const HAPTIC_MIN_GAP_MS = 80;

type HapticsModule = typeof import('@capacitor/haptics');
type HapticKind = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

let modulePromise: Promise<HapticsModule> | null = null;
const lastFiredAt: Partial<Record<HapticKind, number>> = {};

/** Vrai si l'utilisateur n'a pas coupé les vibrations (défaut : actif). */
export function hapticsEnabled(): boolean {
  try {
    return localStorage.getItem(HAPTICS_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Enregistre le réglage « Vibrations ». */
export function setHapticsEnabled(on: boolean): void {
  try {
    localStorage.setItem(HAPTICS_PREF_KEY, on ? '1' : '0');
  } catch {
    /* localStorage indisponible : le réglage reste celui par défaut */
  }
}

/** Les vibrations ne sont proposées (et le réglage affiché) que dans l'app native. */
export function hapticsSupported(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Décide si un retour de type `kind` peut partir à l'instant `now` et, si oui,
 * le note comme parti. Exporté pour les tests.
 */
export function _takeSlot(kind: HapticKind, now: number): boolean {
  const last = lastFiredAt[kind];
  if (last !== undefined && now - last < HAPTIC_MIN_GAP_MS) return false;
  lastFiredAt[kind] = now;
  return true;
}

/** Remet à zéro l'anti-rafale et le module en cache (tests). */
export function _resetHapticsForTests(): void {
  modulePromise = null;
  for (const k of Object.keys(lastFiredAt)) delete lastFiredAt[k as HapticKind];
}

function fire(kind: HapticKind, run: (m: HapticsModule) => Promise<void>): void {
  if (!hapticsSupported() || !hapticsEnabled()) return;
  if (!_takeSlot(kind, Date.now())) return;
  modulePromise ??= import('@capacitor/haptics');
  void modulePromise.then(run).catch(() => {
    /* plugin absent ou refus de l'OS : on ignore */
  });
}

const impact = (kind: HapticKind, style: 'Light' | 'Medium' | 'Heavy') => (): void =>
  fire(kind, (m) => m.Haptics.impact({ style: m.ImpactStyle[style] }));

const notify = (kind: HapticKind, type: 'Success' | 'Warning' | 'Error') => (): void =>
  fire(kind, (m) => m.Haptics.notification({ type: m.NotificationType[type] }));

/** Impact léger — sélection (onglet, pastille), petite confirmation. */
export const hapticLight = impact('light', 'Light');
/** Impact moyen — démarrage du repos, action importante. */
export const hapticMedium = impact('medium', 'Medium');
/** Impact fort — fin du repos, alerte. */
export const hapticHeavy = impact('heavy', 'Heavy');
/** Notification « succès » — série validée, séance sauvegardée, tâche cochée. */
export const hapticSuccess = notify('success', 'Success');
/** Notification « attention ». */
export const hapticWarning = notify('warning', 'Warning');
/** Notification « erreur ». */
export const hapticError = notify('error', 'Error');

/** Sélection : onglet de la barre, pastille, seuil d'un geste franchi. */
export const hapticTap = hapticLight;
/** Célébration : record battu, niveau gagné (impact fort, une seule fois). */
export const hapticCelebrate = hapticHeavy;
