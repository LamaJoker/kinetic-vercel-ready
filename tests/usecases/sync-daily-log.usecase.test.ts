/**
 * tests/usecases/sync-daily-log.usecase.test.ts
 * Couvre : collecte des totaux locaux + appel DailyLogSyncPort.upsert.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { syncDailyLog } from '@kinetic/core';
import type { DailyLogSyncPort, DailyLogEntry } from '@kinetic/core';
import { makeTestDeps } from '@test-helpers/stubs.ts';
import type { TestDeps } from '@test-helpers/stubs.ts';

class SpyDailyLogSync implements DailyLogSyncPort {
  calls: DailyLogEntry[] = [];
  shouldThrow = false;

  async upsert(entry: DailyLogEntry): Promise<void> {
    if (this.shouldThrow) throw new Error('network down');
    this.calls.push(entry);
  }
}

describe('syncDailyLog use-case', () => {
  let deps: TestDeps;
  let spy:  SpyDailyLogSync;

  beforeEach(() => {
    deps = makeTestDeps();
    spy  = new SpyDailyLogSync();
  });

  it("retourne no_activity si rien n'a été fait aujourd'hui", async () => {
    const result = await syncDailyLog({
      storage:      deps.storage,
      clock:        deps.clock,
      dailyLogSync: spy,
    });

    expect(result).toEqual({ ok: true, synced: false, reason: 'no_activity' });
    expect(spy.calls).toHaveLength(0);
  });

  it('remonte les totaux du jour au backend', async () => {
    const today = deps.clock.todayIsoDate();
    await deps.storage.set('kinetic:xp',      { xp: 150 });
    await deps.storage.set('kinetic:streak',  { count: 3, best: 5, lastActiveDate: today });
    await deps.storage.set(`kinetic:vitalite:done:${today}`, ['t1', 't2']);

    const result = await syncDailyLog({
      storage:      deps.storage,
      clock:        deps.clock,
      dailyLogSync: spy,
    });

    expect(result).toEqual({ ok: true, synced: true, date: today });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toEqual({
      date:      today,
      xpEarned:  150,
      tasksDone: 2,
      streakDay: 3,
    });
  });

  it("retourne ok:false sans jeter si le backend plante", async () => {
    const today = deps.clock.todayIsoDate();
    await deps.storage.set('kinetic:xp', { xp: 50 });
    await deps.storage.set(`kinetic:vitalite:done:${today}`, ['t1']);
    spy.shouldThrow = true;

    const result = await syncDailyLog({
      storage:      deps.storage,
      clock:        deps.clock,
      dailyLogSync: spy,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('network down');
  });

  it('utilise bien la date du clock (pas Date.now)', async () => {
    const today = deps.clock.todayIsoDate();
    await deps.storage.set('kinetic:xp', { xp: 10 });
    await deps.storage.set(`kinetic:vitalite:done:${today}`, ['t']);

    const result = await syncDailyLog({
      storage:      deps.storage,
      clock:        deps.clock,
      dailyLogSync: spy,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.synced) {
      expect(result.date).toBe(today);
      expect(spy.calls[0]?.date).toBe(today);
    }
  });
});
