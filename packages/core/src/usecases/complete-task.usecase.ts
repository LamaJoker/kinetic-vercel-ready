import type { StoragePort } from '../ports/storage.port.js';
import type { ClockPort }   from '../ports/clock.port.js';
import type { NotifierPort } from '../ports/notifier.port.js';

import { canComplete, completeTask } from '../domain/task.domain.js';
import type { Task }                 from '../domain/task.domain.js';
import { addXp, computeXpState, didLevelUp } from '../domain/xp.domain.js';
import { processActivity }           from '../domain/streak.domain.js';
import type { StreakState }          from '../domain/streak.domain.js';

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

const KEY_XP           = 'kinetic:xp';
const KEY_STREAK       = 'kinetic:streak';
const KEY_COMPLETED    = 'kinetic:completed-keys';

export async function completeTask_usecase(
  deps:  CompleteTaskDeps,
  input: CompleteTaskInput,
): Promise<CompleteTaskResult> {
  const { storage, clock, notifier } = deps;
  const { task, idempotencyKey }     = input;

  if (!canComplete(task)) {
    return { ok: false, reason: 'already_done' };
  }

  const completedKeys = await storage.get<string[]>(KEY_COMPLETED) ?? [];
  if (completedKeys.includes(idempotencyKey)) {
    return { ok: false, reason: 'already_completed_today' };
  }

  const today = clock.todayIsoDate();

  const xpData     = await storage.get<{ xp: number }>(KEY_XP);
  const streakData = await storage.get<StreakState>(KEY_STREAK);

  const currentXp     = xpData?.xp ?? 0;
  const currentStreak = streakData ?? { count: 0, best: 0, lastActiveDate: null };

  const newXp      = addXp(currentXp, task.xp);
  const leveledUp  = didLevelUp(currentXp, newXp);
  const newLevel   = leveledUp ? computeXpState(newXp).currentLevel : undefined;

  const newStreak = processActivity(currentStreak, today);

  await storage.set(KEY_XP, { xp: newXp });
  await storage.set(KEY_STREAK, newStreak);
  await storage.set(KEY_COMPLETED, [...completedKeys, idempotencyKey]);

  notifier.notify({
    kind:    'success',
    message: leveledUp
      ? `🎉 Niveau ${newLevel} atteint ! +${task.xp} XP`
      : `+${task.xp} XP — ${task.title} ✓`,
  });

  return { ok: true, xpAwarded: task.xp, leveledUp, newLevel };
}