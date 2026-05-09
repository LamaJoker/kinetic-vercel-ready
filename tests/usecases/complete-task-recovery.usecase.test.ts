import { beforeEach, describe, expect, it } from 'vitest';
import { completeTask_usecase, createTask } from '@kinetic/core';
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

    await expect(completeTask_usecase(
      { storage: deps.storage, clock: deps.clock, notifier: deps.notifier },
      { task, idempotencyKey: `vitalite:stretch:${today}` },
    )).rejects.toThrow(/Injected failure/);

    expect(await deps.storage.get('kinetic:pending:task-mutation')).not.toBeNull();

    const retry = makeTestDeps({ storage: deps.storage, clock: deps.clock, notifier: deps.notifier });
    const result = await completeTask_usecase(
      { storage: retry.storage, clock: retry.clock, notifier: retry.notifier },
      { task, idempotencyKey: `vitalite:stretch:${today}` },
    );

    expect(result).toEqual({ ok: false, reason: 'already_completed_today' });
    expect(await retry.storage.get('kinetic:pending:task-mutation')).toBeNull();
    expect(await retry.storage.get('kinetic:xp')).toEqual({ xp: 50 });
    expect(await retry.storage.get(`kinetic:xp:earned:${today}`)).toEqual({ xp: 50 });
    expect(await retry.storage.get('kinetic:completed-keys')).toEqual([`vitalite:stretch:${today}`]);
  });
});
