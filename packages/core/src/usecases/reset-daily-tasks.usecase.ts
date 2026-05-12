/**
 * ResetDailyTasks Use Case — réinitialise les tâches récurrentes pour un nouveau jour.
 *
 * Appelé au démarrage de l'app si le dernier reset était un jour différent.
 * Garantit que la liste de tâches est propre chaque matin.
 */

import type { StoragePort } from '../ports/storage.port.js';
import type { ClockPort }   from '../ports/clock.port.js';
import type { Task }        from '../domain/task.domain.js';
import { resetRecurringTask } from '../domain/task.domain.js';
import { STORAGE_KEYS } from '../constants/storage-keys.js';

export interface ResetDailyTasksDeps {
  storage: StoragePort;
  clock:   ClockPort;
}

export interface ResetDailyTasksResult {
  reset:      boolean;
  tasksReset: number;
  date:       string;
}

const KEY_VITALITE_TASKS      = STORAGE_KEYS.VITALITE_TASKS;
const KEY_VITALITE_LAST_RESET = STORAGE_KEYS.VITALITE_LAST_RESET;
const KEY_COMPLETED           = STORAGE_KEYS.COMPLETED_KEYS;

export async function resetDailyTasks(
  deps: ResetDailyTasksDeps,
): Promise<ResetDailyTasksResult> {
  const { storage, clock } = deps;
  const today = clock.todayIsoDate();

  // Vérifier si déjà reseté aujourd'hui
  const lastReset = await storage.get<string>(KEY_VITALITE_LAST_RESET);
  if (lastReset === today) {
    return { reset: false, tasksReset: 0, date: today };
  }

  // Charger les tâches
  const tasks = await storage.get<Task[]>(KEY_VITALITE_TASKS);
  if (!tasks || tasks.length === 0) {
    await storage.set(KEY_VITALITE_LAST_RESET, today);
    return { reset: true, tasksReset: 0, date: today };
  }

  // Réinitialiser les tâches récurrentes et habits
  const resetTasks = tasks.map((task) => {
    if (task.type === 'recurring' || task.type === 'habit') {
      return resetRecurringTask(task);
    }
    return task;
  });

  const tasksReset = resetTasks.filter((t, i) => t.done !== tasks[i]!.done).length;

  // Nettoyer les clés d'idempotence du jour précédent
  // (Garder uniquement les clés non-journalières)
  const completedKeys = await storage.get<string[]>(KEY_COMPLETED) ?? [];
  const keysToKeep    = completedKeys.filter((k) => !k.includes(':' + (lastReset ?? '')));
  await storage.set(KEY_COMPLETED, keysToKeep);

  // Persister
  await storage.set(KEY_VITALITE_TASKS,      resetTasks);
  await storage.set(KEY_VITALITE_LAST_RESET, today);

  return { reset: true, tasksReset, date: today };
}
