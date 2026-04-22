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

export interface SyncDailyLogDeps {
  storage:        StoragePort;
  clock:          ClockPort;
  dailyLogSync:   DailyLogSyncPort;
}

export type SyncDailyLogResult =
  | { ok: true;  synced: true;  date: string }
  | { ok: true;  synced: false; reason: 'noop' | 'no_activity' }
  | { ok: false; error:  string };

const KEY_XP       = 'kinetic:xp';
const KEY_STREAK   = 'kinetic:streak';

function doneKeyFor(date: string): string {
  return `kinetic:vitalite:done:${date}`;
}

export async function syncDailyLog(deps: SyncDailyLogDeps): Promise<SyncDailyLogResult> {
  const { storage, clock, dailyLogSync } = deps;
  const date = clock.todayIsoDate();

  try {
    const [xp, streak, doneIds] = await Promise.all([
      storage.get<{ xp: number }>(KEY_XP),
      storage.get<StreakState>(KEY_STREAK),
      storage.get<string[]>(doneKeyFor(date)),
    ]);

    const tasksDone = doneIds?.length ?? 0;
    const xpEarned  = xp?.xp ?? 0;
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
