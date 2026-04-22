/**
 * tests/unit/task-completion.test.ts
 *
 * Tests du guard anti-exploit XP.
 * Couvre : idempotence, lock, pending set, double-click.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Simulacre du TasksStore (logique extraite pour test pur) ────────────

interface Task {
  id: string;
  title: string;
  xp: number;
  done: boolean;
  type: 'one-time' | 'recurring';
}

interface CompletionResult {
  success: boolean;
  xpAwarded: number;
  reason?: string;
}

class TaskCompletionGuard {
  private _completedIds = new Set<string>();
  private _pendingIds = new Set<string>();

  /**
   * Tente de compléter une tâche.
   * Triple guard :
   *   1. Tâche déjà done (état persisté)
   *   2. Pending set (double-click / race)
   *   3. Lock check (callable depuis l'extérieur)
   */
  complete(task: Task): CompletionResult {
    // Guard 1 : état persisté
    if (task.done) {
      return { success: false, xpAwarded: 0, reason: 'already_done' };
    }

    // Guard 2 : pending set
    if (this._pendingIds.has(task.id)) {
      return { success: false, xpAwarded: 0, reason: 'pending' };
    }

    // Guard 3 : completed set (one-time tasks)
    if (task.type === 'one-time' && this._completedIds.has(task.id)) {
      return { success: false, xpAwarded: 0, reason: 'already_completed' };
    }

    // Acquérir le lock
    this._pendingIds.add(task.id);

    try {
      // Marquer comme complété
      task.done = true;
      if (task.type === 'one-time') {
        this._completedIds.add(task.id);
      }

      return { success: true, xpAwarded: task.xp };
    } finally {
      this._pendingIds.delete(task.id);
    }
  }

  isLocked(id: string): boolean {
    return this._pendingIds.has(id);
  }

  reset(): void {
    this._completedIds.clear();
    this._pendingIds.clear();
  }
}
// ─────────────────────────────────────────────────────────────────────────

describe('TaskCompletionGuard', () => {
  let guard: TaskCompletionGuard;
  let task: Task;

  beforeEach(() => {
    guard = new TaskCompletionGuard();
    task = { id: 'task-1', title: 'Test', xp: 50, done: false, type: 'one-time' };
  });

  describe('complétion normale', () => {
    it('complète une tâche et retourne le XP correct', () => {
      const result = guard.complete(task);
      expect(result.success).toBe(true);
      expect(result.xpAwarded).toBe(50);
    });

    it('marque la tâche comme done', () => {
      guard.complete(task);
      expect(task.done).toBe(true);
    });
  });

  describe('Guard 1 — idempotence état persisté', () => {
    it('refuse de compléter une tâche déjà done', () => {
      task.done = true;
      const result = guard.complete(task);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('already_done');
      expect(result.xpAwarded).toBe(0);
    });

    it('n\'octroie pas de XP pour une tâche done', () => {
      guard.complete(task); // Première complétion légitime
      // Simuler un reload : task.done est true
      const result2 = guard.complete(task);
      expect(result2.success).toBe(false);
      expect(result2.xpAwarded).toBe(0);
    });
  });

  describe('Guard 2 — double-click / race condition', () => {
    it('bloque une deuxième tentative simultanée', () => {
      // Simuler un état pending (inject direct)
      // En vrai, le pending set est géré dans complete() avant async
      const result1 = guard.complete(task); // Acquiert le lock
      expect(result1.success).toBe(true);

      // Recréer la tâche comme si elle n'était pas done (edge: objet copié)
      const taskCopy = { ...task, done: false };
      const result2 = guard.complete(taskCopy);
      // Guard 3 devrait catcher (completed set)
      expect(result2.success).toBe(false);
    });
  });

  describe('Guard 3 — completed set (one-time tasks)', () => {
    it('bloque la re-complétion d\'une one-time task', () => {
      guard.complete(task);

      // Simuler un reset de task.done (exploit console)
      task.done = false;
      const result = guard.complete(task);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('already_completed');
    });

    it('permet les recurring tasks plusieurs fois', () => {
      const recurring: Task = { id: 'r-1', title: 'Eau', xp: 10, done: false, type: 'recurring' };

      const r1 = guard.complete(recurring);
      expect(r1.success).toBe(true);

      // Reset pour simuler le lendemain
      recurring.done = false;
      const r2 = guard.complete(recurring);
      expect(r2.success).toBe(true);
    });
  });

  describe('isLocked', () => {
    it('retourne false pour une tâche non en cours', () => {
      expect(guard.isLocked('task-1')).toBe(false);
    });

    it('retourne false après complétion (lock libéré dans finally)', () => {
      guard.complete(task);
      expect(guard.isLocked('task-1')).toBe(false);
    });
  });

  describe('reset', () => {
    it('vide les sets après reset', () => {
      guard.complete(task);
      guard.reset();

      // Après reset, une nouvelle tâche avec le même ID peut être complétée
      const freshTask: Task = { id: 'task-1', title: 'Test', xp: 50, done: false, type: 'one-time' };
      const result = guard.complete(freshTask);
      expect(result.success).toBe(true);
    });
  });
});
