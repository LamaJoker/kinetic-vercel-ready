/**
 * PWA install — capture l'évènement `beforeinstallprompt` (Chrome/Android)
 * et propose une bannière custom. Pour iOS Safari, où il n'y a pas
 * d'évènement, on détecte le navigateur et on affiche une instruction
 * "Partager → Sur l'écran d'accueil".
 *
 * Persistance : si l'utilisateur clique "Plus tard", on n'affiche plus la
 * bannière pendant 14 jours.
 */

import { STORAGE_KEYS } from '@kinetic/core';

const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

export function initPwaInstallPrompt(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
  });
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) && !(window as Window & { MSStream?: unknown }).MSStream;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  return isIos && isSafari;
}

function isStandaloneInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS legacy
  const navStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (navStandalone) return true;
  // Tous les autres
  try {
    return window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

function dismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PWA_INSTALL_DISMISSED);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < DISMISS_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/**
 * pwaInstallPrompt — composant Alpine pour la bannière.
 *
 * Visibilité conditionnée à :
 *   - Pas déjà installé en standalone
 *   - Pas dismissé dans les 14 derniers jours
 *   - ET (deferredPrompt dispo OU iOS Safari)
 */
export function pwaInstallPrompt() {
  return {
    visible: false,
    isIos: false,

    init(): void {
      // Délai léger pour laisser le user atterir avant le pop-up
      setTimeout(() => this._evaluate(), 4000);
    },

    _evaluate(): void {
      if (isStandaloneInstalled()) return;
      if (dismissedRecently()) return;
      this.isIos = isIosSafari();
      if (deferredPrompt || this.isIos) this.visible = true;
    },

    async install(): Promise<void> {
      if (!deferredPrompt) {
        // iOS : on n'a pas de prompt programmable, on laisse l'instruction visible
        return;
      }
      try {
        await deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (outcome === 'accepted') {
          this.visible = false;
        } else {
          this._markDismissed();
          this.visible = false;
        }
      } catch (err) {
        console.warn('[pwa] install prompt failed:', err);
        this.visible = false;
      }
    },

    dismiss(): void {
      this._markDismissed();
      this.visible = false;
    },

    _markDismissed(): void {
      try {
        localStorage.setItem(STORAGE_KEYS.PWA_INSTALL_DISMISSED, String(Date.now()));
      } catch {
        /* noop */
      }
    },
  };
}
