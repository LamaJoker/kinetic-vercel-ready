/**
 * Rappels programmés (application Android) — remis au système via
 * @capacitor/local-notifications : ils sonnent même quand l'application est fermée.
 *
 *   - Rappel de routine : chaque jour à l'heure choisie, tant que la routine du
 *     jour n'est pas terminée (reprogrammé à chaque tâche cochée).
 *   - Bilan de la semaine : dimanche 18 h, avec les chiffres de la semaine.
 *   - Rappel de séance : les jours choisis, sauf si une séance est déjà enregistrée.
 *   - Rappel de sauvegarde : 30 jours après le dernier export, sans compte synchronisé.
 *
 * Sur le web, voir streak-reminder.ts (rappel « au mieux », onglet ouvert).
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { STORAGE_KEYS, buildWeeklyReview } from '@kinetic/core';
import type { AnalyticsSet, WeeklyReview } from '@kinetic/core';
import { getDeps } from '../deps';
import { loadSessions, loadTemplates } from './training/storage';
import { buildTrainingSnapshot } from './training/next-session';
import type { RoutineProgress } from './widget';

export interface ReminderPrefs {
  routine: boolean;
  /** Heure locale « HH:MM ». */
  routineTime: string;
  weekly: boolean;
  session: boolean;
  sessionTime: string;
  /** Jours d'entraînement, 0 = dimanche … 6 = samedi (comme Date.getDay). */
  sessionDays: number[];
  backup: boolean;
}

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {
  routine: true,
  routineTime: '20:00',
  weekly: true,
  session: true,
  sessionTime: '18:00',
  sessionDays: [1, 3, 5],
  backup: true,
};

export const ROUTINE_NOTIF_ID = 1001;
export const WEEKLY_NOTIF_ID = 1002;
export const SESSION_NOTIF_ID = 1003;
export const BACKUP_NOTIF_ID = 1004;

export const BACKUP_INTERVAL_DAYS = 30;
const DAY_MS = 86_400_000;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isDayList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

export function getReminderPrefs(): ReminderPrefs {
  const d = DEFAULT_REMINDER_PREFS;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.REMINDER_PREFS) ?? '{}') as Partial<
      Record<keyof ReminderPrefs, unknown>
    >;
    const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
    const time = (v: unknown, fallback: string) =>
      typeof v === 'string' && TIME_RE.test(v) ? v : fallback;
    return {
      routine: bool(raw.routine, d.routine),
      routineTime: time(raw.routineTime, d.routineTime),
      weekly: bool(raw.weekly, d.weekly),
      session: bool(raw.session, d.session),
      sessionTime: time(raw.sessionTime, d.sessionTime),
      sessionDays: isDayList(raw.sessionDays)
        ? [...new Set(raw.sessionDays)].sort()
        : [...d.sessionDays],
      backup: bool(raw.backup, d.backup),
    };
  } catch {
    return { ...d, sessionDays: [...d.sessionDays] };
  }
}

/** Vrai si l'utilisateur a déjà choisi ses jours d'entraînement. */
export function hasChosenSessionDays(): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.REMINDER_PREFS) ?? '{}') as {
      sessionDays?: unknown;
    };
    return isDayList(raw.sessionDays);
  } catch {
    return false;
  }
}

export function setReminderPrefs(patch: Partial<ReminderPrefs>): ReminderPrefs {
  const next = { ...getReminderPrefs(), ...patch };
  if (!TIME_RE.test(next.routineTime)) next.routineTime = DEFAULT_REMINDER_PREFS.routineTime;
  if (!TIME_RE.test(next.sessionTime)) next.sessionTime = DEFAULT_REMINDER_PREFS.sessionTime;
  next.sessionDays = isDayList(next.sessionDays) ? [...new Set(next.sessionDays)].sort() : [];
  try {
    localStorage.setItem(STORAGE_KEYS.REMINDER_PREFS, JSON.stringify(next));
  } catch {
    /* localStorage indisponible : réglage valable pour la session seulement */
  }
  return next;
}

function atTime(day: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const at = new Date(day);
  at.setHours(h, m, 0, 0);
  return at;
}

/**
 * Prochain rappel de séance : le premier jour choisi dont l'heure est à venir,
 * en sautant aujourd'hui si une séance y est déjà enregistrée. null sans jour choisi.
 */
export function nextSessionReminderAt(
  now: Date,
  time: string,
  days: readonly number[],
  trainedToday: boolean,
): Date | null {
  if (days.length === 0) return null;
  const safeTime = TIME_RE.test(time) ? time : DEFAULT_REMINDER_PREFS.sessionTime;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    if (!days.includes(day.getDay())) continue;
    if (offset === 0 && trainedToday) continue;
    const at = atTime(day, safeTime);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/**
 * Rappel de sauvegarde : 30 jours après la dernière sauvegarde (ou le premier
 * lancement, ou le dernier rappel déjà passé), à 19 h ; s'il est en retard,
 * le soir même (ou le lendemain si 19 h est passé).
 */
export function nextBackupReminderAt(now: Date, lastBackupMs: number): Date {
  const due = atTime(new Date(lastBackupMs + BACKUP_INTERVAL_DAYS * DAY_MS), '19:00');
  if (due.getTime() > now.getTime()) return due;
  const tonight = atTime(now, '19:00');
  if (tonight.getTime() > now.getTime()) return tonight;
  return atTime(new Date(now.getTime() + DAY_MS), '19:00');
}

function readTime(key: string): number | null {
  try {
    const value = Date.parse(localStorage.getItem(key) ?? '');
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeTime(key: string, at: Date): void {
  try {
    localStorage.setItem(key, at.toISOString());
  } catch {
    /* ignore */
  }
}

/** Note une sauvegarde (export) : repousse le rappel de 30 jours. */
export function recordBackup(now: Date = new Date()): void {
  writeTime(STORAGE_KEYS.BACKUP_LAST_AT, now);
}

/** Date de la dernière sauvegarde, null si aucune. */
export function lastBackupAt(): Date | null {
  const at = readTime(STORAGE_KEYS.BACKUP_LAST_AT);
  return at === null ? null : new Date(at);
}

/** Jours depuis la dernière sauvegarde, ou depuis le premier lancement si aucune. */
export function daysSinceBackup(now: Date = new Date()): number {
  let since = readTime(STORAGE_KEYS.BACKUP_LAST_AT) ?? readTime(STORAGE_KEYS.FIRST_SEEN_AT);
  if (since === null) {
    writeTime(STORAGE_KEYS.FIRST_SEEN_AT, now);
    since = now.getTime();
  }
  return Math.max(0, Math.floor((now.getTime() - since) / DAY_MS));
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

export async function syncSessionReminder(now: Date = new Date()): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: SESSION_NOTIF_ID }] });
    const prefs = getReminderPrefs();
    if (!prefs.session || !(await canNotify())) return;

    const deps = await getDeps();
    const [sessions, templates] = await Promise.all([
      loadSessions(deps.storage),
      loadTemplates(deps.storage),
    ]);
    const snapshot = buildTrainingSnapshot(sessions, templates, now);
    const trainedToday = snapshot.week.days.some((day) => day.isToday && day.trained);
    const at = nextSessionReminderAt(now, prefs.sessionTime, prefs.sessionDays, trainedToday);
    if (!at) return;

    const next = snapshot.next;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: SESSION_NOTIF_ID,
          title: "C'est jour d'entraînement",
          body: next ? `Au programme : ${next.name}.` : 'Ta séance du jour t’attend.',
          smallIcon: 'ic_stat_kinetic',
          iconColor: '#F2C230',
          schedule: { at, allowWhileIdle: true },
          extra: { route: '/seances' },
        },
      ],
    });
  } catch (err) {
    console.warn('[reminders] session reminder failed:', err);
  }
}

/** @param cloudSynced vrai si un compte synchronise déjà les données (pas besoin de rappel). */
export async function syncBackupReminder(
  cloudSynced: boolean,
  now: Date = new Date(),
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: BACKUP_NOTIF_ID }] });
    if (cloudSynced || !getReminderPrefs().backup || !(await canNotify())) return;

    daysSinceBackup(now);
    const reminded = readTime(STORAGE_KEYS.BACKUP_REMINDED_AT);
    const base = Math.max(
      readTime(STORAGE_KEYS.BACKUP_LAST_AT) ?? 0,
      readTime(STORAGE_KEYS.FIRST_SEEN_AT) ?? 0,
      reminded !== null && reminded <= now.getTime() ? reminded : 0,
    );
    const at = nextBackupReminderAt(now, base);
    writeTime(STORAGE_KEYS.BACKUP_REMINDED_AT, at);
    await LocalNotifications.schedule({
      notifications: [
        {
          id: BACKUP_NOTIF_ID,
          title: 'Sauvegarde tes données',
          body: 'Exporte ton historique ou connecte un compte pour ne rien perdre.',
          smallIcon: 'ic_stat_kinetic',
          iconColor: '#F2C230',
          schedule: { at, allowWhileIdle: true },
          extra: { route: '/profile' },
        },
      ],
    });
  } catch (err) {
    console.warn('[reminders] backup reminder failed:', err);
  }
}
