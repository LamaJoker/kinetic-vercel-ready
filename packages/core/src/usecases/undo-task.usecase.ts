import type { StoragePort } from '../ports/storage.port.js';
import type { ClockPort } from '../ports/clock.port.js';
import type { NotifierPort } from '../ports/notifier.port.js';
import type { Task } from '../domain/task.domain.js';
import { STORAGE_KEYS } from '../constants/storage-keys.js';
import {
  commitTaskMutationPlan,
  recoverPendingTaskMutation,
  type TaskMutationPlan,
} from './task-mutation.shared.js';

export interface UndoTaskDeps {
  storage: StoragePort;
  clock: ClockPort;
  notifier: NotifierPort;
}

export interface UndoTaskInput {
  task: Task;
  idempotencyKey: string;
  bonusXp?: number;
  bonusIdempotencyKey?: string;
}

export type UndoTaskResult =
  | { ok: true; undone: true; xpRemoved: number }
  | { ok: true; undone: false; reason: 'not_completed' }
  | { ok: false; reason: 'invalid_bonus' };

const KEY_XP = STORAGE_KEYS.XP;
const KEY_COMPLETED = STORAGE_KEYS.COMPLETED_KEYS;
const KEY_AWARDED_IDS = STORAGE_KEYS.AWARDED_IDS;

function doneKeyFor(date: string): string {
  return STORAGE_KEYS.VITALITE_DONE(date);
}

function dailyXpKeyFor(date: string): string {
  return STORAGE_KEYS.XP_EARNED(date);
}

export async function undoTask_usecase(
  deps: UndoTaskDeps,
  input: UndoTaskInput,
): Promise<UndoTaskResult> {
  const { storage, clock, notifier } = deps;
  const { task, idempotencyKey, bonusXp = 0, bonusIdempotencyKey } = input;

  await recoverPendingTaskMutation(storage);

  if (bonusXp < 0) {
    return { ok: false, reason: 'invalid_bonus' };
  }

  const today = clock.todayIsoDate();
  const [doneIds, completedKeys, awardedIds, xpData, dailyXpData] = await Promise.all([
    storage.get<string[]>(doneKeyFor(today)),
    storage.get<string[]>(KEY_COMPLETED),
    storage.get<string[]>(KEY_AWARDED_IDS),
    storage.get<{ xp: number }>(KEY_XP),
    storage.get<{ xp: number }>(dailyXpKeyFor(today)),
  ]);

  const safeDoneIds = doneIds ?? [];
  const safeCompletedKeys = completedKeys ?? [];
  const safeAwardedIds = awardedIds ?? [];

  const wasCompleted = safeDoneIds.includes(task.id) || safeCompletedKeys.includes(idempotencyKey);
  if (!wasCompleted) {
    return { ok: true, undone: false, reason: 'not_completed' };
  }

  const bonusApplied = Boolean(bonusIdempotencyKey && safeAwardedIds.includes(bonusIdempotencyKey));
  const xpRemoved = task.xp + (bonusApplied ? bonusXp : 0);
  const currentXp = xpData?.xp ?? 0;
  const currentDailyXp = dailyXpData?.xp ?? 0;

  const nextDoneIds = safeDoneIds.filter((id) => id !== task.id);
  const nextCompletedKeys = safeCompletedKeys.filter((key) => key !== idempotencyKey);
  const nextAwardedIds = bonusIdempotencyKey
    ? safeAwardedIds.filter((key) => key !== bonusIdempotencyKey)
    : safeAwardedIds;

  const mutation: TaskMutationPlan = {
    kind: 'undo_task',
    idempotencyKey,
    set: [
      [doneKeyFor(today), nextDoneIds],
      [KEY_COMPLETED, nextCompletedKeys],
      [KEY_AWARDED_IDS, nextAwardedIds],
      [KEY_XP, { xp: Math.max(0, currentXp - xpRemoved) }],
      [dailyXpKeyFor(today), { xp: Math.max(0, currentDailyXp - task.xp) }],
    ],
  };

  await commitTaskMutationPlan(storage, mutation);

  notifier.notify({
    kind: 'info',
    message: `Tache "${task.title}" annulee - ${xpRemoved} XP retires`,
  });

  return { ok: true, undone: true, xpRemoved };
}
