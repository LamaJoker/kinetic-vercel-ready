/**
 * Store Alpine `vitalite` — pilote la routine quotidienne.
 *
 * Délègue la logique métier aux use-cases du core :
 *   - completeTask_usecase (persiste XP, streak, idempotence)
 *
 * Trois guards anti-exploit :
 *   1. `_pendingIds`      — bloque le double-click
 *   2. `task.done`        — état UI
 *   3. idempotency key    — bloqué côté use-case (source de vérité)
 */
import { createTask, completeTask_usecase, syncDailyLog } from '@kinetic/core';
import type { Task } from '@kinetic/core';
import { getDeps } from '../deps';

const DEFAULT_TASKS_SPEC = [
  { id: 'morning-stretch', title: 'Étirements matin',    icon: '🧘', xp: 50, priority: 'high' as const },
  { id: 'cold-shower',     title: 'Douche froide',       icon: '🚿', xp: 50, priority: 'high' as const },
  { id: 'breakfast',       title: 'Petit-déjeuner sain', icon: '🥗', xp: 50, priority: 'med'  as const },
  { id: 'meditation',      title: 'Méditation 5 min',    icon: '🧠', xp: 50, priority: 'med'  as const },
  { id: 'hydration',       title: "Boire 2L d'eau",      icon: '💧', xp: 50, priority: 'low'  as const },
];

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function buildDefaultTasks(): Task[] {
  const today = todayIso();
  return DEFAULT_TASKS_SPEC.map((spec) =>
    createTask({
      id:        spec.id,
      title:     spec.title,
      icon:      spec.icon,
      xp:        spec.xp,
      priority:  spec.priority,
      type:      'recurring',
      createdAt: today,
    }),
  );
}

export function vitaliteStore() {
  return {
    tasks:        [] as Task[],
    loading:      true,
    completingId: null as string | null,
    _pendingIds:  new Set<string>(),

    async init(): Promise<void> {
      try {
        const deps  = await getDeps();
        const today = todayIso();
        const doneKey = `kinetic:vitalite:done:${today}`;
        const doneIds = (await deps.storage.get<string[]>(doneKey)) ?? [];

        this.tasks = buildDefaultTasks().map((t) =>
          doneIds.includes(t.id)
            ? { ...t, done: true, completedAt: today, completionCount: 1 }
            : t,
        );
      } catch (err) {
        console.error('[vitalite] init failed:', err);
        this.tasks = buildDefaultTasks();
      } finally {
        this.loading = false;
      }
    },

    async complete(taskId: string): Promise<void> {
      if (this._pendingIds.has(taskId)) return;
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task || task.done) return;

      this._pendingIds.add(taskId);
      this.completingId = taskId;

      try {
        const deps     = await getDeps();
        const today    = todayIso();
        const idempKey = `vitalite:${taskId}:${today}`;

        const result = await completeTask_usecase(
          { storage: deps.storage, clock: deps.clock, notifier: deps.notifier },
          { task, idempotencyKey: idempKey },
        );

        if (!result.ok) {
          if (result.reason === 'already_completed_today' || result.reason === 'already_done') {
            // Re-sync état UI — la tâche est déjà validée côté storage
            this.tasks = this.tasks.map((t) =>
              t.id === taskId
                ? { ...t, done: true, completedAt: today, completionCount: t.completionCount + 1 }
                : t,
            );
          }
          return;
        }

        // Succès → update UI (spread pour réactivité Alpine)
        this.tasks = this.tasks.map((t) =>
          t.id === taskId
            ? { ...t, done: true, completedAt: today, completionCount: t.completionCount + 1 }
            : t,
        );

        // Mettre à jour la liste "done ids du jour" (historique activity graph)
        const doneKey = `kinetic:vitalite:done:${today}`;
        const doneIds = (await deps.storage.get<string[]>(doneKey)) ?? [];
        if (!doneIds.includes(taskId)) {
          await deps.storage.set(doneKey, [...doneIds, taskId]);
        }

        // Rafraîchir le store XP (le use-case a déjà persisté, on relit)
        await this._refreshXpStore();

        // Remonter l'activité du jour vers Supabase (no-op en mode guest)
        void syncDailyLog({
          storage:      deps.storage,
          clock:        deps.clock,
          dailyLogSync: deps.dailyLogSync,
        }).catch((err) => console.warn('[vitalite] daily log sync failed:', err));

        if (result.leveledUp && result.newLevel !== undefined) {
          window.dispatchEvent(new CustomEvent('kinetic:levelup', {
            detail: { level: result.newLevel, title: '' },
          }));
        }
      } catch (err) {
        console.error('[vitalite] complete failed:', err);
        deps_notify('error', 'Impossible de valider la tâche. Réessaie.');
      } finally {
        this._pendingIds.delete(taskId);
        this.completingId = null;
      }
    },

    async _refreshXpStore(): Promise<void> {
      // Délègue au store xp pour recalculer depuis le storage
      const Alpine = (window as unknown as { Alpine: { store: (n: string) => unknown } }).Alpine;
      const xp = Alpine.store('xp') as { reload: () => Promise<void> } | undefined;
      await xp?.reload();
    },

    get doneCount():  number  { return this.tasks.filter((t) => t.done).length; },
    get totalCount(): number  { return this.tasks.length; },
    get progress():   number  { return this.totalCount === 0 ? 0 : Math.round((this.doneCount / this.totalCount) * 100); },
    get allDone():    boolean { return this.totalCount > 0 && this.doneCount === this.totalCount; },

    isLocked(id: string): boolean {
      return this._pendingIds.has(id) || (this.tasks.find((t) => t.id === id)?.done ?? false);
    },
  };
}

function deps_notify(kind: 'success' | 'error' | 'warning' | 'info', message: string): void {
  window.dispatchEvent(new CustomEvent('kinetic:notify', { detail: { kind, message } }));
}
