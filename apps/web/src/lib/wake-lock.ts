/**
 * Écran toujours allumé pendant une séance en cours (Screen Wake Lock API).
 *
 * - Disponible sans plugin dans la WebView Android, Chrome et WKWebView
 *   (iOS 16.4+) ; ailleurs, rien ne se passe (aucun message).
 * - Verrou demandé tant qu'une séance est en cours ET que l'app est visible ;
 *   relâché à la sauvegarde ou à l'abandon. Le système le relâche lui-même
 *   quand l'app passe en arrière-plan : on le redemande au retour.
 * - Source : l'événement EVENT_ACTIVE_SESSION_CHANGED de la page Séances (et
 *   la séance enregistrée, lue au démarrage), donc aucun code dans la saisie.
 * - Réglage : Profil › Préférences › « Garder l'écran allumé en séance »
 *   (localStorage, activé par défaut).
 *
 * Chargé par import() depuis main.ts, après le démarrage.
 */
import { STORAGE_KEYS } from '@kinetic/core';

export const WAKE_LOCK_PREF_KEY = STORAGE_KEYS.WAKE_LOCK_ENABLED;
/** Événement interne : le réglage vient de changer (Profil). */
export const WAKE_LOCK_PREF_EVENT = STORAGE_KEYS.EVENT_WAKE_LOCK_CHANGED;

/** Vrai si l'utilisateur n'a pas coupé le réglage (défaut : actif). */
export function wakeLockEnabled(): boolean {
  try {
    return localStorage.getItem(WAKE_LOCK_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setWakeLockEnabled(on: boolean): void {
  try {
    localStorage.setItem(WAKE_LOCK_PREF_KEY, on ? '1' : '0');
  } catch {
    /* localStorage indisponible : réglage par défaut */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(WAKE_LOCK_PREF_EVENT, { detail: on }));
  }
}

/** Le navigateur ou la WebView propose l'API (sinon le réglage est masqué). */
export function wakeLockSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator && !!navigator.wakeLock;
  } catch {
    return false;
  }
}

export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

export interface WakeLockEnv {
  request(): Promise<WakeLockSentinelLike>;
  isVisible(): boolean;
}

export interface SessionWakeLock {
  setSessionActive(active: boolean): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  /** À appeler sur `visibilitychange`. */
  refresh(): Promise<void>;
  isHeld(): boolean;
}

/**
 * Logique du verrou, indépendante du navigateur (testée sous Node). Chaque
 * changement réévalue l'état voulu ; les appels se suivent sans se chevaucher.
 */
export function createSessionWakeLock(env: WakeLockEnv, enabled = true): SessionWakeLock {
  let sessionActive = false;
  let on = enabled;
  let sentinel: WakeLockSentinelLike | null = null;
  let queue: Promise<void> = Promise.resolve();

  const wanted = (): boolean => sessionActive && on && env.isVisible();

  async function apply(): Promise<void> {
    if (wanted()) {
      if (sentinel && !sentinel.released) return;
      try {
        const s = await env.request();
        s.addEventListener?.('release', () => {
          if (sentinel === s) sentinel = null;
        });
        sentinel = s;
      } catch {
        sentinel = null; // refusé (batterie faible, page cachée…) : silencieux
      }
      // L'état a pu changer pendant la demande.
      if (!wanted()) await releaseHeld();
    } else {
      await releaseHeld();
    }
  }

  async function releaseHeld(): Promise<void> {
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) {
      try {
        await s.release();
      } catch {
        /* déjà relâché */
      }
    }
  }

  const sync = (): Promise<void> => (queue = queue.then(apply, apply));

  return {
    setSessionActive(active) {
      sessionActive = active;
      return sync();
    },
    setEnabled(value) {
      on = value;
      return sync();
    },
    refresh: sync,
    isHeld: () => !!sentinel && !sentinel.released,
  };
}

let started = false;

/** Branche le verrou sur la séance en cours (une seule fois, silencieux si non supporté). */
export async function initSessionWakeLock(): Promise<SessionWakeLock | null> {
  if (started || !wakeLockSupported()) return null;
  started = true;
  const lock = createSessionWakeLock(
    {
      request: () => navigator.wakeLock.request('screen'),
      isVisible: () => document.visibilityState === 'visible',
    },
    wakeLockEnabled(),
  );
  // Version : un événement reçu pendant la lecture du stockage a le dernier mot.
  let version = 0;
  window.addEventListener(STORAGE_KEYS.EVENT_ACTIVE_SESSION_CHANGED, (e: Event) => {
    version++;
    void lock.setSessionActive(!!(e as CustomEvent<unknown>).detail);
  });
  window.addEventListener(WAKE_LOCK_PREF_EVENT, (e: Event) => {
    void lock.setEnabled((e as CustomEvent<boolean>).detail !== false);
  });
  document.addEventListener('visibilitychange', () => void lock.refresh());

  const before = version;
  try {
    const [{ getDeps }, { loadActiveSession }] = await Promise.all([
      import('../deps'),
      import('./training/active-session'),
    ]);
    const snap = await loadActiveSession((await getDeps()).storage);
    if (version === before) await lock.setSessionActive(!!snap);
  } catch {
    /* stockage indisponible : on attend l'événement de la page Séances */
  }
  return lock;
}
