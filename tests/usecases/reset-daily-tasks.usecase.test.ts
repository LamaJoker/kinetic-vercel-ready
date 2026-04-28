/**
 * tests/unit/usecases/reset-daily-tasks.usecase.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDailyTasks, createTask, completeTask } from '@kinetic/core';
import type { Task } from '@kinetic/core';
import { makeTestDeps, FakeClock } from '@test-helpers/stubs.ts';
import type { TestDeps } from '@test-helpers/stubs.ts';

const KEY_TASKS      = 'kinetic:vitalite:tasks';
const KEY_LAST_RESET = 'kinetic:vitalite:last-reset';

function makeTasks(): Task[] {
  return [
    createTask({ id: 'a', title: 'Étirements',   type: 'recurring', xp: 50, createdAt: '2026-04-20' }),
    createTask({ id: 'b', title: 'Méditation',   type: 'recurring', xp: 50, createdAt: '2026-04-20' }),
    createTask({ id: 'c', title: 'Onboarding',   type: 'one-time',  xp: 100, createdAt: '2026-04-20' }),
  ];
}

describe('resetDailyTasks', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeTestDeps({ clock: new FakeClock('2026-04-20') });
  });

  it('effectue le reset si jamais fait', async () => {
    const tasks = makeTasks().map((t) => completeTask(t, '2026-04-19'));
    await deps.storage.set(KEY_TASKS, tasks);

    const result = await resetDailyTasks(deps);

    expect(result.reset).toBe(true);
    expect(result.date).toBe('2026-04-20');
  });

  it('remet les tâches recurring à done:false', async () => {
    const tasks = [
      completeTask(createTask({ id: 'a', title: 'A', type: 'recurring', xp: 50, createdAt: '2026-04-19' }), '2026-04-19'),
      completeTask(createTask({ id: 'b', title: 'B', type: 'recurring', xp: 50, createdAt: '2026-04-19' }), '2026-04-19'),
    ];
    await deps.storage.set(KEY_TASKS, tasks);

    await resetDailyTasks(deps);

    const saved = await deps.storage.get<Task[]>(KEY_TASKS);
    expect(saved?.every((t) => !t.done)).toBe(true);
  });

  it('ne remet pas les tâches one-time à zéro', async () => {
    const base      = createTask({ id: 'c', title: 'One-time', type: 'one-time', xp: 100, createdAt: '2026-04-19' });
    const completed = completeTask(base, '2026-04-19');
    await deps.storage.set(KEY_TASKS, [completed]);

    await resetDailyTasks(deps);

    const saved = await deps.storage.get<Task[]>(KEY_TASKS);
    expect(saved?.[0]?.done).toBe(true); // Inchangée
  });

  it('ne reset pas si déjà fait aujourd\'hui', async () => {
    await deps.storage.set(KEY_LAST_RESET, '2026-04-20');
    await deps.storage.set(KEY_TASKS, makeTasks());

    const result = await resetDailyTasks(deps);
    expect(result.reset).toBe(false);
    expect(result.tasksReset).toBe(0);
  });

  it('reset le lendemain d\'un reset précédent', async () => {
    const tasks = makeTasks().map((t) =>
      t.type === 'recurring' ? completeTask(t, '2026-04-20') : t
    );
    await deps.storage.set(KEY_TASKS, tasks);
    await deps.storage.set(KEY_LAST_RESET, '2026-04-20');

    deps.clock.advanceDays(1);
    const result = await resetDailyTasks(deps);

    expect(result.reset).toBe(true);
    expect(result.date).toBe('2026-04-21');
  });

  it('persiste la date du dernier reset', async () => {
    await deps.storage.set(KEY_TASKS, makeTasks());
    await resetDailyTasks(deps);

    const lastReset = await deps.storage.get<string>(KEY_LAST_RESET);
    expect(lastReset).toBe('2026-04-20');
  });

  it('gère le cas sans tâches (storage vide)', async () => {
    const result = await resetDailyTasks(deps);
    expect(result.reset).toBe(true);
    expect(result.tasksReset).toBe(0);
  });
});
