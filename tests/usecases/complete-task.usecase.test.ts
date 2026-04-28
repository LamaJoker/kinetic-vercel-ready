/**
 * tests/unit/usecases/complete-task.usecase.test.ts
 *
 * Tests du use case completeTask.
 * Couvre : flux nominal, guards idempotence, XP, streak, notifications.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { completeTask_usecase } from '@kinetic/core';
import { createTask }           from '@kinetic/core';
import { makeTestDeps }         from '@test-helpers/stubs.ts';
import type { TestDeps }        from '@test-helpers/stubs.ts';
import type { Task }            from '@kinetic/core';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeRecurringTask(): Task {
  return createTask({
    id:        'vitalite-stretch',
    title:     'Étirements',
    type:      'recurring',
    xp:        50,
    priority:  'high',
    createdAt: '2026-04-20',
  });
}

function makeOneTimeTask(): Task {
  return createTask({
    id:        'onboarding-done',
    title:     'Compléter l\'onboarding',
    type:      'one-time',
    xp:        100,
    priority:  'high',
    createdAt: '2026-04-20',
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('completeTask_usecase', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeTestDeps();
  });

  // ── Flux nominal ────────────────────────────────────────────────────────────

  describe('flux nominal', () => {
    it('retourne ok:true avec xpAwarded correct', async () => {
      const task   = makeRecurringTask();
      const result = await completeTask_usecase(deps, {
        task,
        idempotencyKey: 'vitalite-stretch:2026-04-20',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.xpAwarded).toBe(50);
        expect(result.leveledUp).toBe(false);
      }
    });

    it('persiste le nouveau XP dans le storage', async () => {
      const task = makeRecurringTask();
      await completeTask_usecase(deps, {
        task,
        idempotencyKey: 'vitalite-stretch:2026-04-20',
      });

      const saved = await deps.storage.get<{ xp: number }>('kinetic:xp');
      expect(saved?.xp).toBe(50);
    });

    it('persiste la clé d\'idempotence', async () => {
      const task = makeRecurringTask();
      await completeTask_usecase(deps, {
        task,
        idempotencyKey: 'vitalite-stretch:2026-04-20',
      });

      const keys = await deps.storage.get<string[]>('kinetic:completed-keys');
      expect(keys).toContain('vitalite-stretch:2026-04-20');
    });

    it('incrémente le XP du jour (séparé du cumul)', async () => {
      const today = deps.clock.todayIsoDate();
      // XP cumulé déjà à 200 (jours précédents)
      await deps.storage.set('kinetic:xp', { xp: 200 });

      const task = makeRecurringTask(); // 50 XP
      await completeTask_usecase(deps, { task, idempotencyKey: 'k1' });

      // Cumul = 250, daily = 50
      const cumul = await deps.storage.get<{ xp: number }>('kinetic:xp');
      const daily = await deps.storage.get<{ xp: number }>(`kinetic:xp:earned:${today}`);
      expect(cumul?.xp).toBe(250);
      expect(daily?.xp).toBe(50);
    });

    it('le XP du jour s\'accumule sur plusieurs tâches', async () => {
      const today = deps.clock.todayIsoDate();
      const task = makeRecurringTask(); // 50 XP

      await completeTask_usecase(deps, { task, idempotencyKey: 'k1' });
      await completeTask_usecase(deps, { task, idempotencyKey: 'k2' });
      await completeTask_usecase(deps, { task, idempotencyKey: 'k3' });

      const daily = await deps.storage.get<{ xp: number }>(`kinetic:xp:earned:${today}`);
      expect(daily?.xp).toBe(150);
    });

    it('émet une notification de succès', async () => {
      const task = makeRecurringTask();
      await completeTask_usecase(deps, {
        task,
        idempotencyKey: 'vitalite-stretch:2026-04-20',
      });

      expect(deps.notifier.count).toBe(1);
      expect(deps.notifier.last?.kind).toBe('success');
      expect(deps.notifier.last?.message).toContain('+50 XP');
    });
  });

  // ── Guard : déjà done ───────────────────────────────────────────────────────

  describe('guard : tâche déjà done', () => {
    it('retourne ok:false / already_done pour one-time done', async () => {
      const { completeTask } = await import('@kinetic/core');
      const base = makeOneTimeTask();
      const done = completeTask(base, '2026-04-20');

      const result = await completeTask_usecase(deps, {
        task:           done,
        idempotencyKey: 'onboarding-done:2026-04-20',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('already_done');
    });

    it('ne crédite pas de XP pour une tâche already_done', async () => {
      const { completeTask } = await import('@kinetic/core');
      const done = completeTask(makeOneTimeTask(), '2026-04-20');

      await completeTask_usecase(deps, { task: done, idempotencyKey: 'k' });

      const saved = await deps.storage.get<{ xp: number }>('kinetic:xp');
      expect(saved).toBeNull();
    });
  });

  // ── Guard : idempotence ─────────────────────────────────────────────────────

  describe('guard : idempotence', () => {
    it('bloque une deuxième complétion avec la même clé', async () => {
      const task = makeRecurringTask();
      const key  = 'vitalite-stretch:2026-04-20';

      await completeTask_usecase(deps, { task, idempotencyKey: key });
      const result2 = await completeTask_usecase(deps, { task, idempotencyKey: key });

      expect(result2.ok).toBe(false);
      if (!result2.ok) expect(result2.reason).toBe('already_completed_today');
    });

    it('ne double pas le XP', async () => {
      const task = makeRecurringTask();
      const key  = 'vitalite-stretch:2026-04-20';

      await completeTask_usecase(deps, { task, idempotencyKey: key });
      await completeTask_usecase(deps, { task, idempotencyKey: key });

      const saved = await deps.storage.get<{ xp: number }>('kinetic:xp');
      expect(saved?.xp).toBe(50); // Une seule fois, pas 100
    });

    it('permet une clé différente le lendemain', async () => {
      const task = makeRecurringTask();

      await completeTask_usecase(deps, {
        task,
        idempotencyKey: 'vitalite-stretch:2026-04-20',
      });

      deps.clock.advanceDays(1);

      const result2 = await completeTask_usecase(deps, {
        task,
        idempotencyKey: 'vitalite-stretch:2026-04-21',
      });

      expect(result2.ok).toBe(true);
      if (result2.ok) expect(result2.xpAwarded).toBe(50);

      const saved = await deps.storage.get<{ xp: number }>('kinetic:xp');
      expect(saved?.xp).toBe(100); // 2 × 50
    });
  });

  // ── XP et level-up ─────────────────────────────────────────────────────────

  describe('level-up', () => {
    it('détecte le passage de niveau et l\'indique dans le résultat', async () => {
      // Positionner à 180 XP (proche du niveau 2 à 200)
      await deps.storage.set('kinetic:xp', { xp: 180 });

      const task   = createTask({ id: 't', title: 'Big task', xp: 50, createdAt: '2026-04-20' });
      const result = await completeTask_usecase(deps, {
        task,
        idempotencyKey: 't:2026-04-20',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.leveledUp).toBe(true);
        expect(result.newLevel).toBe(2);
      }
    });

    it('la notification mentionne le nouveau niveau', async () => {
      await deps.storage.set('kinetic:xp', { xp: 180 });

      const task = createTask({ id: 't', title: 'Big task', xp: 50, createdAt: '2026-04-20' });
      await completeTask_usecase(deps, { task, idempotencyKey: 't:2026-04-20' });

      expect(deps.notifier.last?.message).toContain('Niveau 2');
    });
  });

  // ── Streak ─────────────────────────────────────────────────────────────────

  describe('streak', () => {
    it('initialise le streak au premier jour', async () => {
      const task = makeRecurringTask();
      await completeTask_usecase(deps, {
        task,
        idempotencyKey: 'vitalite-stretch:2026-04-20',
      });

      const streak = await deps.storage.get<{ count: number }>('kinetic:streak');
      expect(streak?.count).toBe(1);
    });

    it('incrémente le streak le lendemain', async () => {
      const key1 = 'task:2026-04-20';
      const key2 = 'task:2026-04-21';
      const task = makeRecurringTask();

      await completeTask_usecase(deps, { task, idempotencyKey: key1 });

      deps.clock.advanceDays(1);
      await completeTask_usecase(deps, { task, idempotencyKey: key2 });

      const streak = await deps.storage.get<{ count: number; best: number }>('kinetic:streak');
      expect(streak?.count).toBe(2);
      expect(streak?.best).toBe(2);
    });
  });
});
