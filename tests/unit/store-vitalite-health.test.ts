import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn() }));
vi.mock('../../apps/web/src/lib/health.js', () => ({
  readHealthToday: vi.fn(),
  STEPS_GOAL: 8000,
  SLEEP_GOAL_MIN: 420,
}));

import { getDeps } from '../../apps/web/src/deps.js';
import { readHealthToday } from '../../apps/web/src/lib/health.js';
import { vitaliteStore } from '../../apps/web/src/stores/vitalite.js';
import type { Task } from '@kinetic/core';

function task(id: string, done = false): Task {
  return { id, title: id, xp: 40, priority: 'med', done } as unknown as Task;
}

describe('vitalité × Health Connect', () => {
  beforeEach(() => {
    vi.mocked(getDeps).mockResolvedValue({} as never);
  });

  it('affiche les pas et le sommeil sous les tâches concernées', () => {
    const store = vitaliteStore();
    expect(store.taskMeta(task('evening-walk'))).toBe('+40 XP · Priorité moyenne');
    expect(store.taskMeta(task('hydration', true))).toBe('Terminé');
    store.healthSteps = 6240;
    store.healthSleep = 400;
    expect(store.taskMeta(task('evening-walk'))).toBe("6 240 / 8 000 pas aujourd'hui");
    expect(store.taskMeta(task('sleep-routine'))).toBe('6 h 40 de sommeil cette nuit');
    store.healthSleep = 480;
    expect(store.taskMeta(task('sleep-routine'))).toBe('8 h de sommeil cette nuit');
  });

  it('coche les tâches dont l’objectif est atteint, une seule fois', async () => {
    const store = vitaliteStore();
    store.tasks = [task('evening-walk'), task('sleep-routine'), task('hydration')];
    const complete = vi.spyOn(store, 'complete').mockResolvedValue(undefined);

    vi.mocked(readHealthToday).mockResolvedValueOnce({ steps: 9100, sleepMinutes: 380 });
    await store.syncHealth();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('evening-walk', false); // false : pas de vibration (coche automatique)

    store.tasks = [task('evening-walk', true), task('sleep-routine')];
    vi.mocked(readHealthToday).mockResolvedValueOnce({ steps: 9500, sleepMinutes: 430 });
    await store.syncHealth();
    expect(complete).toHaveBeenLastCalledWith('sleep-routine', false);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
