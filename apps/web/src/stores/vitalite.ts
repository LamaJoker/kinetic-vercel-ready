import {
  REWARDS,
  awardXp,
  completeTask_usecase,
  createTask,
  syncDailyLog,
  undoTask_usecase,
} from '@kinetic/core';
import type { Task } from '@kinetic/core';
import { getDeps } from '../deps';

const DEFAULT_TASKS_SPEC = [
  { id: 'morning-stretch', title: 'Etirements matin', icon: '🧘', xp: 50, priority: 'high' as const },
  { id: 'cold-shower', title: 'Douche froide', icon: '🚿', xp: 50, priority: 'high' as const },
  { id: 'breakfast', title: 'Petit-dejeuner sain', icon: '🥗', xp: 50, priority: 'med' as const },
  { id: 'meditation', title: 'Meditation 5 min', icon: '🧠', xp: 50, priority: 'med' as const },
  { id: 'hydration', title: "Boire 2L d'eau", icon: '💧', xp: 50, priority: 'low' as const },
  { id: 'evening-walk', title: 'Promenade du soir', icon: '🚶', xp: 40, priority: 'low' as const },
  { id: 'reading', title: 'Lecture 20 min', icon: '📚', xp: 40, priority: 'low' as const },
  { id: 'journaling', title: 'Journaling', icon: '📝', xp: 40, priority: 'med' as const },
  { id: 'gratitude', title: '3 gratitudes', icon: '🙏', xp: 40, priority: 'med' as const },
  { id: 'sleep-routine', title: 'Routine sommeil', icon: '🌙', xp: 50, priority: 'high' as const },
];

export interface CustomTaskSpec {
  id: string;
  title: string;
  icon: string;
  xp: number;
  priority: 'high' | 'med' | 'low';
}

export interface HistoryDay {
  date: string;
  label: string;
  doneIds: string[];
  tasks: { id: string; title: string; icon: string }[];
}

const KEY_CUSTOM_TASKS = 'kinetic:vitalite:custom-tasks';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateIso(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return iso;
  }
}

function buildTasks(customSpecs: CustomTaskSpec[]): Task[] {
  const today = todayIso();
  return [...DEFAULT_TASKS_SPEC, ...customSpecs].map((spec) =>
    createTask({
      id: spec.id,
      title: spec.title,
      icon: spec.icon,
      xp: spec.xp,
      priority: spec.priority,
      type: 'recurring',
      createdAt: today,
    })
  );
}

function notify(kind: 'success' | 'error' | 'warning' | 'info', message: string): void {
  window.dispatchEvent(new CustomEvent('kinetic:notify', { detail: { kind, message } }));
}

export function vitaliteStore() {
  return {
    tasks: [] as Task[],
    customSpecs: [] as CustomTaskSpec[],
    loading: true,
    completingId: null as string | null,
    _pendingIds: [] as string[],

    showAddForm: false,
    newTaskTitle: '',
    newTaskIcon: '⭐',
    newTaskXp: 40,
    newTaskPriority: 'med' as 'high' | 'med' | 'low',
    addFormError: '',

    showHistory: false,
    historyDays: [] as HistoryDay[],
    historyLoading: false,
    detailDay: null as HistoryDay | null,

    emojiSuggestions: ['⭐', '🏋️', '🧘', '🚶', '🥗', '💧', '📚', '📝', '🎯', '🔥', '💪', '🏃', '🧠', '😴', '🚴', '🤸', '🥦', '🫁', '⚡', '🎸'],

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const today = todayIso();
        this.customSpecs = (await deps.storage.get<CustomTaskSpec[]>(KEY_CUSTOM_TASKS)) ?? [];
        const doneIds = (await deps.storage.get<string[]>(`kinetic:vitalite:done:${today}`)) ?? [];
        this.tasks = buildTasks(this.customSpecs).map((task) =>
          doneIds.includes(task.id)
            ? { ...task, done: true, completedAt: today, completionCount: 1 }
            : task
        );
      } catch (err) {
        console.error('[vitalite] init failed:', err);
        this.tasks = buildTasks([]);
      } finally {
        this.loading = false;
      }
    },

    async complete(taskId: string): Promise<void> {
      if (this._pendingIds.includes(taskId)) return;
      const task = this.tasks.find((entry) => entry.id === taskId);
      if (!task || task.done) return;

      this._pendingIds = [...this._pendingIds, taskId];
      this.completingId = taskId;

      try {
        const deps = await getDeps();
        const today = todayIso();
        const result = await completeTask_usecase(
          { storage: deps.storage, clock: deps.clock, notifier: deps.notifier },
          { task, idempotencyKey: `vitalite:${taskId}:${today}` },
        );

        if (!result.ok) {
          if (result.reason === 'already_completed_today' || result.reason === 'already_done') {
            this.tasks = this.tasks.map((entry) =>
              entry.id === taskId
                ? { ...entry, done: true, completedAt: today, completionCount: entry.completionCount + 1 }
                : entry
            );
          }
          return;
        }

        this.tasks = this.tasks.map((entry) =>
          entry.id === taskId
            ? { ...entry, done: true, completedAt: today, completionCount: entry.completionCount + 1 }
            : entry
        );

        const doneKey = `kinetic:vitalite:done:${today}`;
        const doneIds = (await deps.storage.get<string[]>(doneKey)) ?? [];
        if (!doneIds.includes(taskId)) {
          await deps.storage.set(doneKey, [...doneIds, taskId]);
        }

        if (this._hasXpBonus()) {
          const bonusXp = Math.round(task.xp * 0.2);
          try {
            await awardXp(
              { storage: deps.storage, notifier: deps.notifier },
              {
                amount: bonusXp,
                idempotencyKey: `vitalite:bonus:${taskId}:${today}`,
                silent: true,
              },
            );
          } catch {
            // keep primary completion successful even if bonus write fails
          }
        }

        await this._refreshXpStore();
        void syncDailyLog({ storage: deps.storage, clock: deps.clock, dailyLogSync: deps.dailyLogSync })
          .catch((err) => console.warn('[vitalite] sync failed:', err));

        if (result.leveledUp && result.newLevel !== undefined) {
          const reward = REWARDS.find((entry) => entry.level === result.newLevel);
          window.dispatchEvent(new CustomEvent('kinetic:levelup', {
            detail: { level: result.newLevel, title: reward?.title ?? '' },
          }));
        }
      } catch (err) {
        console.error('[vitalite] complete failed:', err);
        notify('error', 'Impossible de valider la tache. Reessaie.');
      } finally {
        this._pendingIds = this._pendingIds.filter((id) => id !== taskId);
        this.completingId = null;
      }
    },

    async undo(taskId: string): Promise<void> {
      if (this._pendingIds.includes(taskId)) return;
      const task = this.tasks.find((entry) => entry.id === taskId);
      if (!task || !task.done) return;

      this._pendingIds = [...this._pendingIds, taskId];
      this.completingId = taskId;

      try {
        const deps = await getDeps();
        const today = todayIso();
        const bonusXp = this._hasXpBonus() ? Math.round(task.xp * 0.2) : 0;
        const undoInput = {
          task,
          idempotencyKey: `vitalite:${taskId}:${today}`,
          bonusXp,
          ...(bonusXp > 0 ? { bonusIdempotencyKey: `vitalite:bonus:${taskId}:${today}` } : {}),
        };
        const result = await undoTask_usecase(
          { storage: deps.storage, clock: deps.clock, notifier: deps.notifier },
          undoInput,
        );

        if (!result.ok) {
          notify('error', 'Impossible d\'annuler. Reessaie.');
          return;
        }
        if (!result.undone) {
          notify('info', 'Cette tache n\'etait plus completee.');
          return;
        }

        this.tasks = this.tasks.map((entry) =>
          entry.id === taskId
            ? { ...entry, done: false, completedAt: null, completionCount: Math.max(0, entry.completionCount - 1) }
            : entry
        );

        await this._refreshXpStore();
        void syncDailyLog({ storage: deps.storage, clock: deps.clock, dailyLogSync: deps.dailyLogSync })
          .catch((err) => console.warn('[vitalite] sync failed after undo:', err));
      } catch (err) {
        console.error('[vitalite] undo failed:', err);
        notify('error', 'Impossible d\'annuler. Reessaie.');
      } finally {
        this._pendingIds = this._pendingIds.filter((id) => id !== taskId);
        this.completingId = null;
      }
    },

    async addCustomTask(): Promise<void> {
      this.addFormError = '';
      const title = this.newTaskTitle.trim();
      if (!title) {
        this.addFormError = 'Le titre est requis.';
        return;
      }
      if (title.length > 60) {
        this.addFormError = 'Titre trop long (max 60 car.).';
        return;
      }

      const spec: CustomTaskSpec = {
        id: `custom-${Date.now()}`,
        title,
        icon: this.newTaskIcon || '⭐',
        xp: Math.max(10, Math.min(200, Number(this.newTaskXp) || 40)),
        priority: this.newTaskPriority,
      };

      try {
        const deps = await getDeps();
        this.customSpecs = [...this.customSpecs, spec];
        await deps.storage.set(KEY_CUSTOM_TASKS, this.customSpecs);

        const newTask = createTask({
          id: spec.id,
          title: spec.title,
          icon: spec.icon,
          xp: spec.xp,
          priority: spec.priority,
          type: 'recurring',
          createdAt: todayIso(),
        });
        this.tasks = [...this.tasks, newTask];

        this.newTaskTitle = '';
        this.newTaskIcon = '⭐';
        this.newTaskXp = 40;
        this.newTaskPriority = 'med';
        this.showAddForm = false;
        notify('success', `Tache "${spec.title}" ajoutee`);
      } catch (err) {
        console.error('[vitalite] addCustomTask failed:', err);
        notify('error', 'Impossible d\'ajouter la tache.');
      }
    },

    async deleteCustomTask(id: string): Promise<void> {
      try {
        const deps = await getDeps();
        this.customSpecs = this.customSpecs.filter((entry) => entry.id !== id);
        await deps.storage.set(KEY_CUSTOM_TASKS, this.customSpecs);
        this.tasks = this.tasks.filter((entry) => entry.id !== id);
        notify('info', 'Tache supprimee');
      } catch (err) {
        console.error('[vitalite] deleteCustomTask failed:', err);
        notify('error', 'Impossible de supprimer la tache.');
      }
    },

    isCustom(id: string): boolean {
      return this.customSpecs.some((entry) => entry.id === id);
    },

    async loadHistory(): Promise<void> {
      if (this.historyLoading) return;
      this.historyLoading = true;
      try {
        const deps = await getDeps();
        const taskMap = new Map(
          [...DEFAULT_TASKS_SPEC, ...this.customSpecs].map((entry) => [entry.id, {
            id: entry.id,
            title: entry.title,
            icon: entry.icon,
          }]),
        );
        const dates = Array.from({ length: this._rewardsHistoryDays() }, (_, index) => dateIso(-(index + 1)));
        const allDoneIds = await Promise.all(
          dates.map((date) => deps.storage.get<string[]>(`kinetic:vitalite:done:${date}`)),
        );
        this.historyDays = dates.map((date, index) => {
          const doneIds = allDoneIds[index] ?? [];
          return {
            date,
            label: dateLabel(date),
            doneIds,
            tasks: doneIds.map((id) => taskMap.get(id) ?? { id, title: id, icon: '✓' }),
          };
        });
      } catch (err) {
        console.error('[vitalite] loadHistory failed:', err);
      } finally {
        this.historyLoading = false;
      }
    },

    async toggleHistory(): Promise<void> {
      this.showHistory = !this.showHistory;
      if (this.showHistory && this.historyDays.length === 0) {
        await this.loadHistory();
      }
    },

    async _refreshXpStore(): Promise<void> {
      const Alpine = (window as unknown as { Alpine: { store: (name: string) => unknown } }).Alpine;
      const xp = Alpine.store('xp') as { reload?: () => Promise<void> } | undefined;
      await xp?.reload?.();
    },

    get doneCount(): number {
      return this.tasks.filter((entry) => entry.done).length;
    },

    get totalCount(): number {
      return this.tasks.length;
    },

    get progress(): number {
      return this.totalCount === 0 ? 0 : Math.round((this.doneCount / this.totalCount) * 100);
    },

    get allDone(): boolean {
      return this.totalCount > 0 && this.doneCount === this.totalCount;
    },

    isLocked(id: string): boolean {
      return this._pendingIds.includes(id);
    },

    destroy(): void {
      this._pendingIds = [];
      this.completingId = null;
    },

    _hasXpBonus(): boolean {
      try {
        const Alpine = (window as unknown as { Alpine: { store: (name: string) => { currentLevel?: number } } }).Alpine;
        return (Alpine?.store('xp')?.currentLevel ?? 1) >= 5;
      } catch {
        return false;
      }
    },

    _rewardsHistoryDays(): number {
      try {
        const Alpine = (window as unknown as { Alpine: { store: (name: string) => { historyDays?: number } } }).Alpine;
        return (Alpine?.store('rewards') as { historyDays?: number })?.historyDays ?? 7;
      } catch {
        return 7;
      }
    },
  };
}
