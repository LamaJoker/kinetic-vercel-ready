import { beforeEach, describe, expect, it } from 'vitest';
import { createTask, undoTask_usecase } from '@kinetic/core';
import { makeTestDeps } from '@test-helpers/stubs.ts';
import type { TestDeps } from '@test-helpers/stubs.ts';

describe('undoTask_usecase', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeTestDeps();
  });

  it('retire la tache du jour et decremente le XP', async () => {
    const today = deps.clock.todayIsoDate();
    const task = createTask({ id: 'stretch', title: 'Stretch', xp: 50, createdAt: today });

    await deps.storage.set(`kinetic:vitalite:done:${today}`, ['stretch']);
    await deps.storage.set('kinetic:completed-keys', ['vitalite:stretch:' + today]);
    await deps.storage.set('kinetic:xp', { xp: 80 });
    await deps.storage.set(`kinetic:xp:earned:${today}`, { xp: 50 });

    const result = await undoTask_usecase(
      { storage: deps.storage, clock: deps.clock, notifier: deps.notifier },
      { task, idempotencyKey: `vitalite:stretch:${today}` },
    );

    expect(result).toEqual({ ok: true, undone: true, xpRemoved: 50 });
    expect(await deps.storage.get(`kinetic:vitalite:done:${today}`)).toEqual([]);
    expect(await deps.storage.get('kinetic:completed-keys')).toEqual([]);
    expect(await deps.storage.get('kinetic:xp')).toEqual({ xp: 30 });
    expect(await deps.storage.get(`kinetic:xp:earned:${today}`)).toEqual({ xp: 0 });
  });

  it('retire aussi le bonus si son idempotency key existe', async () => {
    const today = deps.clock.todayIsoDate();
    const task = createTask({ id: 'stretch', title: 'Stretch', xp: 50, createdAt: today });

    await deps.storage.set(`kinetic:vitalite:done:${today}`, ['stretch']);
    await deps.storage.set('kinetic:completed-keys', ['vitalite:stretch:' + today]);
    await deps.storage.set('kinetic:awarded-ids', ['vitalite:bonus:stretch:' + today]);
    await deps.storage.set('kinetic:xp', { xp: 90 });
    await deps.storage.set(`kinetic:xp:earned:${today}`, { xp: 50 });

    const result = await undoTask_usecase(
      { storage: deps.storage, clock: deps.clock, notifier: deps.notifier },
      {
        task,
        idempotencyKey: `vitalite:stretch:${today}`,
        bonusXp: 10,
        bonusIdempotencyKey: `vitalite:bonus:stretch:${today}`,
      },
    );

    expect(result).toEqual({ ok: true, undone: true, xpRemoved: 60 });
    expect(await deps.storage.get('kinetic:xp')).toEqual({ xp: 30 });
    expect(await deps.storage.get('kinetic:awarded-ids')).toEqual([]);
    expect(await deps.storage.get(`kinetic:xp:earned:${today}`)).toEqual({ xp: 0 });
  });

  it('retourne undone:false si rien a annuler', async () => {
    const today = deps.clock.todayIsoDate();
    const task = createTask({ id: 'stretch', title: 'Stretch', xp: 50, createdAt: today });

    const result = await undoTask_usecase(
      { storage: deps.storage, clock: deps.clock, notifier: deps.notifier },
      { task, idempotencyKey: `vitalite:stretch:${today}` },
    );

    expect(result).toEqual({ ok: true, undone: false, reason: 'not_completed' });
  });
});
