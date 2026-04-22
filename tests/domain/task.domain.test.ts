/**
 * tests/unit/domain/task.domain.test.ts
 *
 * Tests du domaine Task : création, validation, complétion, reset.
 */

import { describe, it, expect } from 'vitest';
import {
  createTask,
  completeTask,
  resetRecurringTask,
  canComplete,
  sortByPriority,
  validateTask,
} from '@kinetic/core';
import type { Task } from '@kinetic/core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}): Task {
  return createTask({
    id:        'task-001',
    title:     'Test task',
    createdAt: '2026-04-20',
    ...overrides,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createTask', () => {
  it('crée une tâche avec les valeurs par défaut', () => {
    const task = makeTask();
    expect(task.id).toBe('task-001');
    expect(task.title).toBe('Test task');
    expect(task.type).toBe('recurring');
    expect(task.xp).toBe(50);
    expect(task.priority).toBe('med');
    expect(task.done).toBe(false);
    expect(task.completedAt).toBeNull();
    expect(task.completionCount).toBe(0);
  });

  it('trim le titre', () => {
    const task = makeTask({ title: '  Espacé  ' });
    expect(task.title).toBe('Espacé');
  });

  it('accepte tous les types valides', () => {
    for (const type of ['one-time', 'recurring', 'habit'] as const) {
      expect(() => makeTask({ type })).not.toThrow();
    }
  });

  it('lève une erreur si titre vide', () => {
    expect(() => makeTask({ title: '' })).toThrow();
    expect(() => makeTask({ title: '   ' })).toThrow();
  });

  it('lève une erreur si titre > 100 caractères', () => {
    expect(() => makeTask({ title: 'a'.repeat(101) })).toThrow();
  });

  it('lève une erreur si xp invalide', () => {
    expect(() => makeTask({ xp: 0 })).toThrow();
    expect(() => makeTask({ xp: -10 })).toThrow();
    expect(() => makeTask({ xp: 1001 })).toThrow();
  });
});

describe('validateTask', () => {
  it('retourne un tableau vide pour une tâche valide', () => {
    expect(validateTask({ title: 'OK', xp: 50, type: 'recurring', priority: 'med' })).toHaveLength(0);
  });

  it('détecte un titre manquant', () => {
    const errors = validateTask({ title: '' });
    expect(errors.some((e) => e.field === 'title')).toBe(true);
  });

  it('détecte un XP hors plage', () => {
    const errors = validateTask({ xp: 9999 });
    expect(errors.some((e) => e.field === 'xp')).toBe(true);
  });

  it('détecte un type invalide', () => {
    const errors = validateTask({ type: 'invalid' as never });
    expect(errors.some((e) => e.field === 'type')).toBe(true);
  });
});

describe('canComplete', () => {
  it('true pour une tâche recurring non done', () => {
    const task = makeTask({ type: 'recurring' });
    expect(canComplete(task)).toBe(true);
  });

  it('true pour one-time non done', () => {
    const task = makeTask({ type: 'one-time' });
    expect(canComplete(task)).toBe(true);
  });

  it('false pour one-time déjà done', () => {
    const task = completeTask(makeTask({ type: 'one-time' }), '2026-04-20');
    expect(canComplete(task)).toBe(false);
  });

  it('true pour recurring même si done (peut être re-complété)', () => {
    const task = completeTask(makeTask({ type: 'recurring' }), '2026-04-20');
    expect(canComplete(task)).toBe(true);
  });
});

describe('completeTask', () => {
  it('retourne une tâche done avec la bonne date', () => {
    const task      = makeTask();
    const completed = completeTask(task, '2026-04-20');
    expect(completed.done).toBe(true);
    expect(completed.completedAt).toBe('2026-04-20');
    expect(completed.completionCount).toBe(1);
  });

  it('incrémente completionCount à chaque complétion (recurring)', () => {
    let task = makeTask({ type: 'recurring' });
    task = completeTask(task, '2026-04-20');
    task = resetRecurringTask(task);
    task = completeTask(task, '2026-04-21');
    expect(task.completionCount).toBe(2);
  });

  it('est immutable — ne mute pas la tâche originale', () => {
    const original = makeTask();
    completeTask(original, '2026-04-20');
    expect(original.done).toBe(false);
  });

  it('lève une erreur pour une tâche one-time déjà done', () => {
    const task = completeTask(makeTask({ type: 'one-time' }), '2026-04-20');
    expect(() => completeTask(task, '2026-04-21')).toThrow();
  });
});

describe('resetRecurringTask', () => {
  it('remet done à false et completedAt à null', () => {
    const done  = completeTask(makeTask({ type: 'recurring' }), '2026-04-20');
    const reset = resetRecurringTask(done);
    expect(reset.done).toBe(false);
    expect(reset.completedAt).toBeNull();
    expect(reset.completionCount).toBe(1); // conservé
  });

  it('lève une erreur pour une tâche one-time', () => {
    const task = makeTask({ type: 'one-time' });
    expect(() => resetRecurringTask(task)).toThrow();
  });

  it('est immutable', () => {
    const done = completeTask(makeTask({ type: 'recurring' }), '2026-04-20');
    resetRecurringTask(done);
    expect(done.done).toBe(true); // original inchangé
  });
});

describe('sortByPriority', () => {
  it('trie high avant med avant low', () => {
    const tasks: Task[] = [
      makeTask({ id: '1', priority: 'low' }),
      makeTask({ id: '2', priority: 'high' }),
      makeTask({ id: '3', priority: 'med' }),
    ];
    const sorted = [...tasks].sort(sortByPriority);
    expect(sorted[0]!.priority).toBe('high');
    expect(sorted[1]!.priority).toBe('med');
    expect(sorted[2]!.priority).toBe('low');
  });

  it('place les non-done avant les done à priorité égale', () => {
    const notDone = makeTask({ id: '1', priority: 'med' });
    const done    = completeTask(makeTask({ id: '2', priority: 'med' }), '2026-04-20');
    const sorted  = [done, notDone].sort(sortByPriority);
    expect(sorted[0]!.id).toBe('1');
  });
});
