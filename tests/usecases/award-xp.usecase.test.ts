/**
 * tests/unit/usecases/award-xp.usecase.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { awardXp } from '@kinetic/core';
import { makeTestDeps } from '@test-helpers/stubs.ts';
import type { TestDeps } from '@test-helpers/stubs.ts';

describe('awardXp', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeTestDeps();
  });

  it('crédite le XP et le persiste', async () => {
    const result = await awardXp(deps, { amount: 100 });

    expect(result.ok).toBe(true);
    if (result.ok && !result.skipped) {
      expect(result.xpAfter).toBe(100);
      expect(result.xpBefore).toBe(0);
    }

    const saved = await deps.storage.get<{ xp: number }>('kinetic:xp');
    expect(saved?.xp).toBe(100);
  });

  it("s'accumule sur du XP existant", async () => {
    await deps.storage.set('kinetic:xp', { xp: 150 });
    await awardXp(deps, { amount: 75 });

    const saved = await deps.storage.get<{ xp: number }>('kinetic:xp');
    expect(saved?.xp).toBe(225);
  });

  it('est idempotent avec une clé', async () => {
    await awardXp(deps, { amount: 100, idempotencyKey: 'bonus-onboarding' });
    const result2 = await awardXp(deps, { amount: 100, idempotencyKey: 'bonus-onboarding' });

    expect(result2.ok).toBe(true);
    if (result2.ok) expect(result2.skipped).toBe(true);

    const saved = await deps.storage.get<{ xp: number }>('kinetic:xp');
    expect(saved?.xp).toBe(100); // pas 200
  });

  it("sans clé d'idempotence : toujours crédite", async () => {
    await awardXp(deps, { amount: 50 });
    await awardXp(deps, { amount: 50 });

    const saved = await deps.storage.get<{ xp: number }>('kinetic:xp');
    expect(saved?.xp).toBe(100);
  });

  it('retourne ok:false pour un montant invalide', async () => {
    const r1 = await awardXp(deps, { amount: 0 });
    expect(r1.ok).toBe(false);

    const r2 = await awardXp(deps, { amount: -50 });
    expect(r2.ok).toBe(false);
  });

  it('ne notifie pas en mode silent', async () => {
    await awardXp(deps, { amount: 50, silent: true });
    expect(deps.notifier.count).toBe(0);
  });

  it('notifie en mode normal', async () => {
    await awardXp(deps, { amount: 50 });
    expect(deps.notifier.count).toBe(1);
    expect(deps.notifier.last?.message).toContain('+50');
  });

  it('détecte et signale un level-up', async () => {
    await deps.storage.set('kinetic:xp', { xp: 180 });
    const result = await awardXp(deps, { amount: 50 });

    expect(result.ok).toBe(true);
    if (result.ok && !result.skipped) {
      expect(result.leveledUp).toBe(true);
      expect(result.newLevel).toBe(2);
    }
    expect(deps.notifier.last?.message).toContain('Niveau 2');
  });
});
