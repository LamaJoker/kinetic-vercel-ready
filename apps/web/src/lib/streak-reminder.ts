/**
 * Rappel de série (web) — notification à 20 h si la routine du jour n'est pas complète.
 * Ne fonctionne que si l'application est ouverte : sur Android, les rappels sont
 * programmés auprès du système (voir reminders.ts) et ce module ne fait rien.
 */
import { Capacitor } from '@capacitor/core';
import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../deps';

const KEY_REMINDER_DATE = STORAGE_KEYS.REMINDER_DATE;

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

    const dailyLog = await deps.storage.get<Record<string, unknown>>(
      STORAGE_KEYS.DAILY_LOG(todayIso()),
    );
    if (dailyLog && Object.keys(dailyLog).length >= 5) return false;

    return true;
  } catch {
    return false;
  }
}

async function markReminderSentToday(): Promise<void> {
  try {
    const deps = await getDeps();
    await deps.storage.set(KEY_REMINDER_DATE, todayIso());
  } catch {
    /* non-critical */
  }
}

function sendStreakNotificationWeb(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  new Notification('Garde ta série', {
    body: 'Il reste moins de 4h pour valider ta routine du jour.',
    icon: '/icons/icon-96.png',
    tag: 'streak-reminder',
    requireInteraction: false,
  });
}

export function scheduleStreakReminder(): void {
  if (typeof window === 'undefined' || Capacitor.isNativePlatform()) return;

  const delay = msUntil20h();
  if (delay < 0 || delay > 12 * 60 * 60 * 1000) return;

  setTimeout(async () => {
    const remind = await shouldRemind();
    if (!remind) return;

    sendStreakNotificationWeb();
    // Only record "reminded today" after the notification was actually sent
    await markReminderSentToday();
  }, delay);
}
