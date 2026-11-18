/**
 * Alerte de fin de repos quand le téléphone est verrouillé ou l'app en arrière-plan.
 *
 * Dans l'app (iOS/Android), le minuteur JavaScript se fige en arrière-plan et
 * l'API web Notification n'existe pas : on confie la fin du repos au système via
 * une notification locale programmée à l'heure de fin. Elle est annulée dès que
 * le repos est passé, modifié (reprogrammée) ou terminé dans l'app.
 *
 * Sur le web : rien ici, la page garde son minuteur et l'API Notification.
 * Le plugin est chargé à la demande (import dynamique) : aucun coût au démarrage.
 */
import { Capacitor } from '@capacitor/core';
import { STORAGE_KEYS } from '@kinetic/core';

/** Id réservé (rappels programmés : 1001-1004, cf. lib/reminders.ts). */
export const REST_NOTIF_ID = 1005;

/** Permission demandée une seule fois, au premier repos. */
const ASKED_KEY = STORAGE_KEYS.REST_ALERT_ASKED;

export function restAlertContent(exerciseName: string): { title: string; body: string } {
  const name = exerciseName.trim();
  return {
    title: name ? `Repos terminé · ${name}` : 'Repos terminé',
    body: 'Série suivante',
  };
}

function askedBefore(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    return true; // stockage indisponible : on ne harcèle pas à chaque repos
  }
}

function markAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    /* ignore */
  }
}

type Plugin = (typeof import('@capacitor/local-notifications'))['LocalNotifications'];

async function plugin(): Promise<Plugin | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return (await import('@capacitor/local-notifications')).LocalNotifications;
  } catch {
    return null;
  }
}

/** Dernière programmation : la plus récente l'emporte (annulation pendant la demande de permission). */
let generation = 0;

/**
 * Programme (ou reprogramme) l'alerte à `endsAtMs`. Demande la permission au
 * premier repos si elle n'a jamais été demandée. Sans effet sur le web.
 */
export async function scheduleRestAlert(endsAtMs: number, exerciseName: string): Promise<void> {
  const gen = ++generation;
  const ln = await plugin();
  if (!ln || !(endsAtMs > Date.now())) return;
  try {
    let granted = (await ln.checkPermissions()).display === 'granted';
    if (!granted && !askedBefore()) {
      markAsked();
      granted = (await ln.requestPermissions()).display === 'granted';
    }
    if (!granted || gen !== generation) return;
    const { title, body } = restAlertContent(exerciseName);
    await ln.schedule({
      notifications: [
        {
          id: REST_NOTIF_ID,
          title,
          body,
          smallIcon: 'ic_stat_kinetic',
          schedule: { at: new Date(endsAtMs), allowWhileIdle: true },
          extra: { route: '/seances' },
        },
      ],
    });
  } catch (err) {
    console.warn('[rest-alert] schedule failed:', err);
  }
}

/** Annule l'alerte programmée (repos passé, terminé ou séance sauvegardée). */
export async function cancelRestAlert(): Promise<void> {
  generation++;
  const ln = await plugin();
  if (!ln) return;
  try {
    await ln.cancel({ notifications: [{ id: REST_NOTIF_ID }] });
  } catch {
    /* ignore */
  }
}
