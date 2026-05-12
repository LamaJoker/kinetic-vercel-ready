/**
 * Rappel streak — notification locale à 20h si la routine du jour n'est pas complète.
 * - Sur Android natif (Capacitor) : utilise @capacitor/local-notifications (vraies notifs Android).
 * - Sur Web (PWA) : utilise l'API Notification standard.
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../deps';

const KEY_REMINDER_DATE = STORAGE_KEYS.REMINDER_DATE;
const NOTIF_ID = 1001; // ID fixe pour le rappel streak

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Millisecondes jusqu'à 20h00 aujourd'hui (négatif si déjà passé). */
function msUntil20h(): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(20, 0, 0, 0);
  return target.getTime() - now.getTime();
}

async function shouldRemind(): Promise<boolean> {
  try {
    const deps = await getDeps();
    const lastDate = await deps.storage.get<string>(KEY_REMINDER_DATE);
    if (lastDate === todayIso()) return false;

    const dailyLog = await deps.storage.get<Record<string, unknown>>(STORAGE_KEYS.DAILY_LOG(todayIso()));
    if (dailyLog && Object.keys(dailyLog).length >= 5) return false;

    await deps.storage.set(KEY_REMINDER_DATE, todayIso());
    return true;
  } catch {
    return false;
  }
}

async function sendStreakNotificationNative(): Promise<void> {
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') return;

    await LocalNotifications.schedule({
      notifications: [{
        id: NOTIF_ID,
        title: '🔥 Garde ton streak !',
        body: 'Il reste moins de 4h pour valider ta routine du jour.',
        smallIcon: 'ic_stat_kinetic',
        iconColor: '#39FF14',
        schedule: { at: new Date(Date.now() + 500) }, // immédiat (déjà en callback 20h)
      }],
    });
  } catch (err) {
    console.warn('[streak-reminder] native notification failed:', err);
  }
}

function sendStreakNotificationWeb(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  new Notification('🔥 Garde ton streak !', {
    body: 'Il reste moins de 4h pour valider ta routine du jour.',
    icon: '/icons/icon-96.png',
    tag: 'streak-reminder',
    requireInteraction: false,
  });
}

export function scheduleStreakReminder(): void {
  if (typeof window === 'undefined') return;

  const delay = msUntil20h();
  if (delay < 0 || delay > 12 * 60 * 60 * 1000) return;

  setTimeout(async () => {
    const remind = await shouldRemind();
    if (!remind) return;

    if (Capacitor.isNativePlatform()) {
      await sendStreakNotificationNative();
    } else {
      sendStreakNotificationWeb();
    }
  }, delay);
}
