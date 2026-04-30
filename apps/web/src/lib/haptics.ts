/**
 * Abstraction haptique — Capacitor sur natif, navigator.vibrate() sur le web.
 * Toujours importé en mode async/fire-and-forget pour ne jamais bloquer l'UI.
 */
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/** Vibration courte — confirmation d'action (ex: série enregistrée). */
export function hapticLight(): void {
  void (async () => {
    if (Capacitor.isNativePlatform()) {
      try { await Haptics.impact({ style: ImpactStyle.Light }); } catch {}
    } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(40);
    }
  })();
}

/** Vibration moyenne — démarrage repos, action importante. */
export function hapticMedium(): void {
  void (async () => {
    if (Capacitor.isNativePlatform()) {
      try { await Haptics.impact({ style: ImpactStyle.Medium }); } catch {}
    } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(80);
    }
  })();
}

/** Vibration forte — fin de repos, alerte. */
export function hapticHeavy(): void {
  void (async () => {
    if (Capacitor.isNativePlatform()) {
      try { await Haptics.impact({ style: ImpactStyle.Heavy }); } catch {}
    } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(150);
    }
  })();
}

/** Notification succès — PR, objectif atteint. */
export function hapticSuccess(): void {
  void (async () => {
    if (Capacitor.isNativePlatform()) {
      try { await Haptics.notification({ type: NotificationType.Success }); } catch {}
    } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([50, 40, 100]);
    }
  })();
}

/** Notification erreur. */
export function hapticError(): void {
  void (async () => {
    if (Capacitor.isNativePlatform()) {
      try { await Haptics.notification({ type: NotificationType.Error }); } catch {}
    } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([100, 50, 100, 50, 100]);
    }
  })();
}
