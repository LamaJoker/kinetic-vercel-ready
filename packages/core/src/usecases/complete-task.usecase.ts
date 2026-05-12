import type { StoragePort } from '../ports/storage.port.js';
import type { ClockPort }   from '../ports/clock.port.js';
import type { NotifierPort } from '../ports/notifier.port.js';

import { STORAGE_KEYS } from '../constants/storage-keys.js';
import { canComplete } from '../domain/task.domain.js';
import type { Task }                 from '../domain/task.domain.js';
import { addXp, computeXpState, didLevelUp } from '../domain/xp.domain.js';
import { processActivity }           from '../domain/streak.domain.js';
import type { StreakState }          from '../domain/streak.domain.js';
import {
  commitTaskMutationPlan,
  recoverPendingTaskMutation,
  type TaskMutationPlan,
} from './task-mutation.shared.js';

export interface CompleteTaskDeps {
  storage:  StoragePort;
  clock:    ClockPort;
  notifier: NotifierPort;
}

export interface CompleteTaskInput {
  task:           Task;
  idempotencyKey: string;
}

export type CompleteTaskResult =
  | { ok: true;  xpAwarded: number; leveledUp: boolean; newLevel?: number | undefined }
  | { ok: false; reason: 'already_done' | 'already_completed_today' | 'invalid_task' };

const KEY_XP           = STORAGE_KEYS.XP;
const KEY_STREAK       = STORAGE_KEYS.STREAK;
const KEY_COMPLETED    = STORAGE_KEYS.COMPLETED_KEYS;
const COMPLETED_KEYS_TTL_DAYS = 90;

/** Daily XP counter — separate from cumulative `kinetic:xp` so we can
 *  report accurate per-day XP in the daily log. Reset implicitly every day
 *  by namespacing the key with the ISO date. */
function dailyXpKeyFor(date: string): string {
  return `kinetic:xp:earned:${date}`;
}

function parseTrailingIsoDate(value: string): Date | null {
  const match = value.match(/(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function pruneCompletedKeys(
  completedKeys: readonly string[],
  todayIso: string,
): string[] {
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  const cutoffMs = todayMs - COMPLETED_KEYS_TTL_DAYS * 24 * 60 * 60 * 1_000;

  return completedKeys.filter((key) => {
    const dated = parseTrailingIsoDate(key);
    return dated === null || dated.getTime() >= cutoffMs;
  });
}

export async function completeTask_usecase(
  deps:  CompleteTaskDeps,
  input: CompleteTaskInput,
): Promise<CompleteTaskResult> {
  const { storage, clock, notifier } = deps;
  const { task, idempotencyKey }     = input;

  await recoverPendingTaskMutation(storage);

  if (!canComplete(task)) {
    return { ok: false, reason: 'already_done' };
  }

  const today = clock.todayIsoDate();
  const rawCompletedKeys = await storage.get<string[]>(KEY_COMPLETED) ?? [];
  const completedKeys = pruneCompletedKeys(rawCompletedKeys, today);
  if (completedKeys.includes(idempotencyKey)) {
    return { ok: false, reason: 'already_completed_today' };
  }

  const xpData     = await storage.get<{ xp: number }>(KEY_XP);
  const streakData = await storage.get<StreakState>(KEY_STREAK);

  const currentXp     = xpData?.xp ?? 0;
  const currentStreak = streakData ?? { count: 0, best: 0, lastActiveDate: null };

  const newXp      = addXp(currentXp, task.xp);
  const leveledUp  = didLevelUp(currentXp, newXp);
  const newLevel   = leveledUp ? computeXpState(newXp).currentLevel : undefined;

  const newStreak = processActivity(currentStreak, today);

  // Track XP earned today so daily-log sync can report per-day stats
  // accurately (instead of cumulative XP).
  const dailyXpKey   = dailyXpKeyFor(today);
  const xpEarnedToday = ((await storage.get<{ xp: number }>(dailyXpKey))?.xp ?? 0) + task.xp;

  // Idempotency key written LAST: a crash between writes leaves the user
  // able to retry, but `completedKeys` already containing `idempotencyKey`
  // would silently skip XP. Persisting the key last keeps the user safe.
  const mutation: TaskMutationPlan = {
    kind: 'complete_task',
    idempotencyKey,
    set: [
      [KEY_XP, { xp: newXp }],
      [KEY_STREAK, newStreak],
      [dailyXpKey, { xp: xpEarnedToday }],
      [KEY_COMPLETED, [...completedKeys, idempotencyKey]],
    ],
  };
  await commitTaskMutationPlan(storage, mutation);

  notifier.notify({
    kind:    'success',
    message: leveledUp
      ? `🎉 Niveau ${newLevel} atteint ! +${task.xp} XP`
      : `+${task.xp} XP — ${task.title} ✓`,
  });

  return { ok: true, xpAwarded: task.xp, leveledUp, newLevel };
}
