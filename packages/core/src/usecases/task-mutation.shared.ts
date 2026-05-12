import type { StorageKey, StoragePort } from '../ports/storage.port.js';

const KEY_PENDING_TASK_MUTATION = 'kinetic:pending:task-mutation';

export interface TaskMutationPlan {
  kind: 'complete_task' | 'undo_task';
  idempotencyKey: string;
  set: ReadonlyArray<readonly [StorageKey, unknown]>;
  remove?: readonly StorageKey[];
}

async function applyMutationPlan(
  storage: StoragePort,
  plan: TaskMutationPlan,
): Promise<void> {
  for (const [key, value] of plan.set) {
    await storage.set(key, value);
  }
  for (const key of plan.remove ?? []) {
    await storage.remove(key);
  }
}

export async function recoverPendingTaskMutation(storage: StoragePort): Promise<TaskMutationPlan | null> {
  const pending = await storage.get<TaskMutationPlan>(KEY_PENDING_TASK_MUTATION);
  if (!pending) return null;

  await applyMutationPlan(storage, pending);
  await storage.remove(KEY_PENDING_TASK_MUTATION);
  return pending;
}

export async function commitTaskMutationPlan(
  storage: StoragePort,
  plan: TaskMutationPlan,
): Promise<void> {
  await storage.set(KEY_PENDING_TASK_MUTATION, plan);
  await applyMutationPlan(storage, plan);
  await storage.remove(KEY_PENDING_TASK_MUTATION);
}
