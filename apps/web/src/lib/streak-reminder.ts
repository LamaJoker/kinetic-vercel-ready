/**
 * Rappel streak — notification locale à 20h si la routine du jour n'est pas complète.
 * Ne nécessite pas VAPID : utilise Notification API directement.
 * Planifié une fois par session au démarrage de l'app.
 */
import { getDeps } from '../deps';

const KEY_REMINDER_DATE = 'kinetic:reminder:lastDate';

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

    // Vérifier si la routine vitalité est complète
    const dailyLog = await deps.storage.get<Record<string, unknown>>(`kinetic:dailyLog:${todayIso()}`);
    if (dailyLog && Object.keys(dailyLog).length >= 5) return false;

    await deps.storage.set(KEY_REMINDER_DATE, todayIso());
    return true;
  } catch {
    return false;
  }
}

function sendStreakNotification(): void {
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
    if (remind) sendStreakNotification();
  }, delay);
}
