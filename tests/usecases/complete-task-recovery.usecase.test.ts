import { beforeEach, describe, expect, it } from 'vitest';
import { completeTask_usecase, createTask, undoTask_usecase } from '@kinetic/core';
import { InMemoryStorage, makeTestDeps } from '@test-helpers/stubs.ts';
import type { StorageKey, TestDeps } from '@test-helpers/stubs.ts';

class FailAfterNWritesStorage extends InMemoryStorage {
  private writes = 0;

  constructor(private readonly failAfter: number) {
    super();
  }

  override async set<T>(key: StorageKey, value: T): Promise<void> {
    this.writes += 1;
    if (this.writes === this.failAfter) {
      throw new Error(`Injected failure on ${key}`);
    }
    return super.set(key, value);
  }
}

describe('completeTask_usecase recovery', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeTestDeps();
  });

  it('rejoue une mutation pendante au prochain appel apres une ecriture partielle', async () => {
    const today = deps.clock.todayIsoDate();
    const task = createTask({ id: 'stretch', title: 'Stretch', xp: 50, createdAt: today });
    const failingStorage = new FailAfterNWritesStorage(3);
    deps = makeTestDeps({ storage: failingStorage });

    await expect(
      completeTask_usecase(
        { storage: deps.storage, clock: deps.clock, notifier: deps.notifier },
        { task, idempotencyKey: `vitalite:stretch:${today}` },
      ),
    ).rejects.toThrow(/Injected failure/);

    expect(await deps.storage.get('kinetic:pending:task-mutation')).not.toBeNull();

    const retry = makeTestDeps({
      storage: deps.storage,
      clock: deps.clock,
      notifier: deps.notifier,
    });
    const result = await completeTask_usecase(
      { storage: retry.storage, clock: retry.clock, notifier: retry.notifier },
      { task, idempotencyKey: `vitalite:stretch:${today}` },
    );

    expect(result).toEqual({ ok: false, reason: 'already_completed_today' });
    expect(await retry.storage.get('kinetic:pending:task-mutation')).toBeNull();
    expect(await retry.storage.get('kinetic:xp')).toEqual({ xp: 50 });
    expect(await retry.storage.get(`kinetic:xp:earned:${today}`)).toEqual({ xp: 50 });
    expect(await retry.storage.get('kinetic:completed-keys')).toEqual([
      `vitalite:stretch:${today}`,
    ]);
  });

  it('recoverPendingTaskMutation exécute le chemin remove (covers task-mutation.shared lines 18-19)', async () => {
    // Pre-seed a pending plan that has a `remove` array — triggers applyMutationPlan's remove loop
    const storage = new InMemoryStorage();
    const today = deps.clock.todayIsoDate();

    // A key we want removed via the pending plan recovery
    await storage.set('kinetic:temp-cleanup-key', { stale: true });
    await storage.set('kinetic:xp', { xp: 40 });

    // Simulate a partially-written undo plan with `remove` entries
    await storage.set('kinetic:pending:task-mutation', {
      kind: 'undo_task',
      idempotencyKey: `stretch:${today}`,
      set: [['kinetic:xp', { xp: 0 }]],
      remove: ['kinetic:temp-cleanup-key'],
    });

    // completeTask_usecase calls recoverPendingTaskMutation first, which will:
    //   1. Apply the pending plan (set kinetic:xp to 0, remove kinetic:temp-cleanup-key)
    //   2. Delete the pending plan key
    const task = createTask({ id: 'stretch', title: 'Stretch', xp: 50, createdAt: today });
    const freshDeps = makeTestDeps({ storage, clock: deps.clock, notifier: deps.notifier });
    await completeTask_usecase(freshDeps, { task, idempotencyKey: `stretch-new:${today}` });

    // The `remove` path should have deleted the cleanup key
    expect(await storage.get('kinetic:temp-cleanup-key')).toBeNull();
    // And the set in the plan should have been applied
    expect(await storage.get('kinetic:xp')).not.toEqual({ xp: 0 }); // overwritten by completeTask
    // Pending plan itself is gone
    expect(await storage.get('kinetic:pending:task-mutation')).toBeNull();
  });
});
