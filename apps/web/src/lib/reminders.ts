/**
 * Rappels programmés (application Android) — remis au système via
 * @capacitor/local-notifications : ils sonnent même quand l'application est fermée.
 *
 *   - Rappel de routine : chaque jour à l'heure choisie, tant que la routine du
 *     jour n'est pas terminée (reprogrammé à chaque tâche cochée).
 *   - Bilan de la semaine : dimanche 18 h, avec les chiffres de la semaine.
 *
 * Sur le web, voir streak-reminder.ts (rappel « au mieux », onglet ouvert).
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { STORAGE_KEYS, buildWeeklyReview } from '@kinetic/core';
import type { AnalyticsSet, WeeklyReview } from '@kinetic/core';
import { getDeps } from '../deps';
import { loadSessions } from './training/storage';
import type { RoutineProgress } from './widget';

export interface ReminderPrefs {
  routine: boolean;
  /** Heure locale « HH:MM ». */
  routineTime: string;
  weekly: boolean;
}

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {
  routine: true,
  routineTime: '20:00',
  weekly: true,
};

export const ROUTINE_NOTIF_ID = 1001;
export const WEEKLY_NOTIF_ID = 1002;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function getReminderPrefs(): ReminderPrefs {
  try {
    const raw = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.REMINDER_PREFS) ?? '{}',
    ) as Partial<ReminderPrefs>;
    return {
      routine: typeof raw.routine === 'boolean' ? raw.routine : DEFAULT_REMINDER_PREFS.routine,
      routineTime:
        typeof raw.routineTime === 'string' && TIME_RE.test(raw.routineTime)
          ? raw.routineTime
          : DEFAULT_REMINDER_PREFS.routineTime,
      weekly: typeof raw.weekly === 'boolean' ? raw.weekly : DEFAULT_REMINDER_PREFS.weekly,
    };
  } catch {
    return { ...DEFAULT_REMINDER_PREFS };
  }
}

export function setReminderPrefs(patch: Partial<ReminderPrefs>): ReminderPrefs {
  const next = { ...getReminderPrefs(), ...patch };
  if (!TIME_RE.test(next.routineTime)) next.routineTime = DEFAULT_REMINDER_PREFS.routineTime;
  try {
    localStorage.setItem(STORAGE_KEYS.REMINDER_PREFS, JSON.stringify(next));
  } catch {
    /* localStorage indisponible : réglage valable pour la session seulement */
  }
  return next;
}

/** Prochain rappel de routine : aujourd'hui si elle reste à faire et l'heure à venir, sinon demain. */
export function nextRoutineReminderAt(now: Date, time: string, routineDone: boolean): Date {
  const [h, m] = (TIME_RE.test(time) ? time : DEFAULT_REMINDER_PREFS.routineTime)
    .split(':')
    .map(Number) as [number, number];
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (routineDone || at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** Prochain dimanche 18 h (celui de la semaine suivante si l'heure est passée). */
export function nextWeeklyRecapAt(now: Date): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + ((7 - at.getDay()) % 7));
  at.setHours(18, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 7);
  return at;
}

export function weeklyRecapBody(review: WeeklyReview): string {
  if (review.sessions === 0) {
    return 'Aucune séance cette semaine. Une nouvelle semaine commence demain.';
  }
  const parts = [
    `${review.sessions} séance${review.sessions > 1 ? 's' : ''}`,
    `${review.tonnageKg.toLocaleString('fr-FR')} kg soulevés`,
  ];
  if (review.prCount > 0) parts.push(`${review.prCount} record${review.prCount > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

async function canNotify(): Promise<boolean> {
  try {
    return (await LocalNotifications.checkPermissions()).display === 'granted';
  } catch {
    return false;
  }
}

/** Vrai si l'application Android a le droit d'afficher des notifications. */
export async function remindersPermitted(): Promise<boolean> {
  return Capacitor.isNativePlatform() && (await canNotify());
}

/** Demande l'autorisation système. Vrai si les notifications sont autorisées. */
export async function requestReminderPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    if (await canNotify()) return true;
    return (await LocalNotifications.requestPermissions()).display === 'granted';
  } catch {
    return false;
  }
}

export async function syncRoutineReminder(
  routine: RoutineProgress,
  now: Date = new Date(),
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: ROUTINE_NOTIF_ID }] });
    const prefs = getReminderPrefs();
    if (!prefs.routine || routine.total === 0 || !(await canNotify())) return;

    const remaining = routine.total - routine.done;
    const done = remaining <= 0;
    const at = nextRoutineReminderAt(now, prefs.routineTime, done);
    const today = at.getDate() === now.getDate();
    await LocalNotifications.schedule({
      notifications: [
        {
          id: ROUTINE_NOTIF_ID,
          title: 'Ta routine du jour',
          body: today
            ? `Encore ${remaining} tâche${remaining > 1 ? 's' : ''} pour garder ta série.`
            : 'Quelques minutes suffisent pour garder ta série.',
          smallIcon: 'ic_stat_kinetic',
          iconColor: '#F2C230',
          schedule: { at, allowWhileIdle: true },
          extra: { route: '/vitalite' },
        },
      ],
    });
  } catch (err) {
    console.warn('[reminders] routine reminder failed:', err);
  }
}

export async function syncWeeklyRecap(now: Date = new Date()): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: WEEKLY_NOTIF_ID }] });
    if (!getReminderPrefs().weekly || !(await canNotify())) return;

    const at = nextWeeklyRecapAt(now);
    const deps = await getDeps();
    const sessions = await loadSessions(deps.storage);
    const sets: AnalyticsSet[] = sessions.flatMap((session) =>
      session.entries.flatMap((entry) =>
        entry.sets.map((set) => ({
          sessionId: session.id,
          exerciseId: entry.exerciseId,
          muscles: [],
          reps: set.reps,
          weightKg: set.weightKg,
          rpe: set.rpe,
          performedAt: set.performedAt,
        })),
      ),
    );
    await LocalNotifications.schedule({
      notifications: [
        {
          id: WEEKLY_NOTIF_ID,
          title: 'Ton bilan de la semaine',
          body: weeklyRecapBody(buildWeeklyReview(sets, at.toISOString())),
          smallIcon: 'ic_stat_kinetic',
          iconColor: '#F2C230',
          schedule: { at, allowWhileIdle: true },
          extra: { route: '/progression' },
        },
      ],
    });
  } catch (err) {
    console.warn('[reminders] weekly recap failed:', err);
  }
}
