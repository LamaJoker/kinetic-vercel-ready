/**
 * syncDailyLog — remonte l'activité du jour vers le backend si disponible.
 *
 * Appelé après chaque complétion de tâche. Idempotent côté backend grâce
 * à upsert_daily_log (ON CONFLICT (user_id, date)).
 *
 * Stratégie :
 *   - Calcule les totaux du jour depuis le storage local
 *   - Envoie via DailyLogSyncPort (peut être no-op en mode guest)
 *   - Les échecs réseau sont silencieux — le local reste la source de vérité
 */
import type { StoragePort }       from '../ports/storage.port.js';
import type { ClockPort }         from '../ports/clock.port.js';
import type { DailyLogSyncPort }  from '../ports/daily-log-sync.port.js';
import type { StreakState }       from '../domain/streak.domain.js';
import { STORAGE_KEYS } from '../constants/storage-keys.js';

export interface SyncDailyLogDeps {
  storage:        StoragePort;
  clock:          ClockPort;
  dailyLogSync:   DailyLogSyncPort;
}

export type SyncDailyLogResult =
  | { ok: true;  synced: true;  date: string }
  | { ok: true;  synced: false; reason: 'noop' | 'no_activity' }
  | { ok: false; error:  string };

const KEY_STREAK   = STORAGE_KEYS.STREAK;

function doneKeyFor(date: string): string {
  return `kinetic:vitalite:done:${date}`;
}

/** Daily XP key — must match `complete-task.usecase` */
function dailyXpKeyFor(date: string): string {
  return `kinetic:xp:earned:${date}`;
}

export async function syncDailyLog(deps: SyncDailyLogDeps): Promise<SyncDailyLogResult> {
  const { storage, clock, dailyLogSync } = deps;
  const date = clock.todayIsoDate();

  try {
    const [dailyXp, streak, doneIds] = await Promise.all([
      // Read XP EARNED today, not cumulative XP — daily_logs.xp_earned is a
      // per-day metric, sending the cumulative total would inflate it.
      storage.get<{ xp: number }>(dailyXpKeyFor(date)),
      storage.get<StreakState>(KEY_STREAK),
      storage.get<string[]>(doneKeyFor(date)),
    ]);

    const tasksDone = doneIds?.length ?? 0;
    const xpEarned  = dailyXp?.xp ?? 0;
    const streakDay = streak?.count ?? 0;

    if (tasksDone === 0 && xpEarned === 0) {
      return { ok: true, synced: false, reason: 'no_activity' };
    }

    await dailyLogSync.upsert({ date, xpEarned, tasksDone, streakDay });
    return { ok: true, synced: true, date };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
