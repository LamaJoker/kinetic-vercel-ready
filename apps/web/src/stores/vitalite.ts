/**
 * Store Alpine `vitalite` — routine quotidienne.
 *
 * Nouveautés :
 *  - Tâches personnalisées (ajout / suppression)
 *  - Annuler une tâche cochée par erreur (undo)
 *  - Historique des 7 derniers jours
 */
import { createTask, completeTask_usecase, syncDailyLog } from '@kinetic/core';
import type { Task } from '@kinetic/core';
import { getDeps } from '../deps';

// ─── Spec tâches par défaut ──────────────────────────────────────────────────
const DEFAULT_TASKS_SPEC = [
  { id: 'morning-stretch', title: 'Étirements matin',    icon: '🧘', xp: 50, priority: 'high' as const },
  { id: 'cold-shower',     title: 'Douche froide',       icon: '🚿', xp: 50, priority: 'high' as const },
  { id: 'breakfast',       title: 'Petit-déjeuner sain', icon: '🥗', xp: 50, priority: 'med'  as const },
  { id: 'meditation',      title: 'Méditation 5 min',    icon: '🧠', xp: 50, priority: 'med'  as const },
  { id: 'hydration',       title: "Boire 2L d'eau",      icon: '💧', xp: 50, priority: 'low'  as const },
  { id: 'evening-walk',    title: 'Promenade du soir',   icon: '🚶', xp: 40, priority: 'low'  as const },
  { id: 'reading',         title: 'Lecture 20 min',      icon: '📚', xp: 40, priority: 'low'  as const },
  { id: 'journaling',      title: 'Journaling',          icon: '📝', xp: 40, priority: 'med'  as const },
  { id: 'gratitude',       title: '3 gratitudes',        icon: '🙏', xp: 40, priority: 'med'  as const },
  { id: 'sleep-routine',   title: 'Routine sommeil',     icon: '🌙', xp: 50, priority: 'high' as const },
];

// ─── Types ───────────────────────────────────────────────────────────────────
export interface CustomTaskSpec {
  id:       string;
  title:    string;
  icon:     string;
  xp:       number;
  priority: 'high' | 'med' | 'low';
}

export interface HistoryDay {
  date:    string;          // YYYY-MM-DD
  label:   string;          // ex: "lun. 28 avr."
  doneIds: string[];
  tasks:   { id: string; title: string; icon: string }[];
}

// ─── Clés storage ────────────────────────────────────────────────────────────
const KEY_CUSTOM_TASKS = 'kinetic:vitalite:custom-tasks';
const KEY_XP           = 'kinetic:xp';
const KEY_AWARDED_IDS  = 'kinetic:awarded-ids';

// ─── Utils ───────────────────────────────────────────────────────────────────
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
  } catch { return iso; }
}

function buildTasks(customSpecs: CustomTaskSpec[]): Task[] {
  const today = todayIso();
  const allSpecs = [
    ...DEFAULT_TASKS_SPEC,
    ...customSpecs.map(s => ({ ...s, type: 'recurring' as const, createdAt: today })),
  ];
  return allSpecs.map(spec =>
    createTask({ id: spec.id, title: spec.title, icon: spec.icon, xp: spec.xp, priority: spec.priority, type: 'recurring', createdAt: today })
  );
}

// ─── Store ───────────────────────────────────────────────────────────────────
export function vitaliteStore() {
  return {
    tasks:        [] as Task[],
    customSpecs:  [] as CustomTaskSpec[],
    loading:      true,
    completingId: null as string | null,
    _pendingIds:  new Set<string>(),

    // ── Formulaire nouvelle tâche ──
    showAddForm:      false,
    newTaskTitle:     '',
    newTaskIcon:      '⭐',
    newTaskXp:        40,
    newTaskPriority:  'med' as 'high' | 'med' | 'low',
    addFormError:     '',

    // ── Historique ──
    showHistory: false,
    historyDays: [] as HistoryDay[],
    historyLoading: false,

    // ── Détail journée ──
    detailDay: null as HistoryDay | null,

    // ─────────────────────────────────────────────────────────────────────────
    async init(): Promise<void> {
      try {
        const deps  = await getDeps();
        const today = todayIso();

        // Charger tâches custom
        this.customSpecs = (await deps.storage.get<CustomTaskSpec[]>(KEY_CUSTOM_TASKS)) ?? [];

        // Charger état du jour
        const doneKey = `kinetic:vitalite:done:${today}`;
        const doneIds = (await deps.storage.get<string[]>(doneKey)) ?? [];

        this.tasks = buildTasks(this.customSpecs).map(t =>
          doneIds.includes(t.id)
            ? { ...t, done: true, completedAt: today, completionCount: 1 }
            : t,
        );
      } catch (err) {
        console.error('[vitalite] init failed:', err);
        this.tasks = buildTasks([]);
      } finally {
        this.loading = false;
      }
    },

    // ─── Compléter une tâche ─────────────────────────────────────────────────
    async complete(taskId: string): Promise<void> {
      if (this._pendingIds.has(taskId)) return;
      const task = this.tasks.find(t => t.id === taskId);
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
            this.tasks = this.tasks.map(t =>
              t.id === taskId ? { ...t, done: true, completedAt: today, completionCount: t.completionCount + 1 } : t,
            );
          }
          return;
        }

        this.tasks = this.tasks.map(t =>
          t.id === taskId ? { ...t, done: true, completedAt: today, completionCount: t.completionCount + 1 } : t,
        );

        const doneKey = `kinetic:vitalite:done:${today}`;
        const doneIds = (await deps.storage.get<string[]>(doneKey)) ?? [];
        if (!doneIds.includes(taskId)) {
          await deps.storage.set(doneKey, [...doneIds, taskId]);
        }

        await this._refreshXpStore();

        void syncDailyLog({ storage: deps.storage, clock: deps.clock, dailyLogSync: deps.dailyLogSync })
          .catch(err => console.warn('[vitalite] sync failed:', err));

        if (result.leveledUp && result.newLevel !== undefined) {
          window.dispatchEvent(new CustomEvent('kinetic:levelup', { detail: { level: result.newLevel, title: '' } }));
        }
      } catch (err) {
        console.error('[vitalite] complete failed:', err);
        notify('error', 'Impossible de valider la tâche. Réessaie.');
      } finally {
        this._pendingIds.delete(taskId);
        this.completingId = null;
      }
    },

    // ─── Annuler une tâche ───────────────────────────────────────────────────
    async undo(taskId: string): Promise<void> {
      if (this._pendingIds.has(taskId)) return;
      const task = this.tasks.find(t => t.id === taskId);
      if (!task || !task.done) return;

      this._pendingIds.add(taskId);
      this.completingId = taskId;

      try {
        const deps    = await getDeps();
        const today   = todayIso();
        const idempKey = `vitalite:${taskId}:${today}`;

        // 1. Retirer de la liste des tâches du jour
        const doneKey = `kinetic:vitalite:done:${today}`;
        const doneIds = (await deps.storage.get<string[]>(doneKey)) ?? [];
        await deps.storage.set(doneKey, doneIds.filter(id => id !== taskId));

        // 2. Décrémenter XP
        const xpData  = await deps.storage.get<{ xp: number }>(KEY_XP);
        const newXp   = Math.max(0, (xpData?.xp ?? 0) - task.xp);
        await deps.storage.set(KEY_XP, { xp: newXp });

        // 3. Supprimer la clé d'idempotence pour permettre re-completion
        const awardedIds = (await deps.storage.get<string[]>(KEY_AWARDED_IDS)) ?? [];
        await deps.storage.set(KEY_AWARDED_IDS, awardedIds.filter(k => k !== idempKey));

        // 4. Mettre à jour UI
        this.tasks = this.tasks.map(t =>
          t.id === taskId ? { ...t, done: false, completedAt: undefined, completionCount: Math.max(0, t.completionCount - 1) } : t,
        );

        await this._refreshXpStore();
        notify('info', `Tâche "${task.title}" annulée — XP retiré`);
      } catch (err) {
        console.error('[vitalite] undo failed:', err);
        notify('error', 'Impossible d\'annuler. Réessaie.');
      } finally {
        this._pendingIds.delete(taskId);
        this.completingId = null;
      }
    },

    // ─── Tâches personnalisées ───────────────────────────────────────────────
    async addCustomTask(): Promise<void> {
      this.addFormError = '';
      const title = this.newTaskTitle.trim();
      if (!title) { this.addFormError = 'Le titre est requis.'; return; }
      if (title.length > 60) { this.addFormError = 'Titre trop long (max 60 car.).'; return; }

      const id = `custom-${Date.now()}`;
      const spec: CustomTaskSpec = {
        id,
        title,
        icon:     this.newTaskIcon || '⭐',
        xp:       Math.max(10, Math.min(200, Number(this.newTaskXp) || 40)),
        priority: this.newTaskPriority,
      };

      try {
        const deps = await getDeps();
        this.customSpecs = [...this.customSpecs, spec];
        await deps.storage.set(KEY_CUSTOM_TASKS, this.customSpecs);

        // Ajouter à la liste active (non cochée)
        const today = todayIso();
        const newTask = createTask({ id, title: spec.title, icon: spec.icon, xp: spec.xp, priority: spec.priority, type: 'recurring', createdAt: today });
        this.tasks = [...this.tasks, newTask];

        // Reset form
        this.newTaskTitle    = '';
        this.newTaskIcon     = '⭐';
        this.newTaskXp       = 40;
        this.newTaskPriority = 'med';
        this.showAddForm     = false;
        notify('success', `Tâche "${spec.title}" ajoutée`);
      } catch (err) {
        console.error('[vitalite] addCustomTask failed:', err);
        notify('error', 'Impossible d\'ajouter la tâche.');
      }
    },

    async deleteCustomTask(id: string): Promise<void> {
      try {
        const deps = await getDeps();
        this.customSpecs = this.customSpecs.filter(s => s.id !== id);
        await deps.storage.set(KEY_CUSTOM_TASKS, this.customSpecs);
        this.tasks = this.tasks.filter(t => t.id !== id);
        notify('info', 'Tâche supprimée');
      } catch (err) {
        console.error('[vitalite] deleteCustomTask failed:', err);
        notify('error', 'Impossible de supprimer la tâche.');
      }
    },

    isCustom(id: string): boolean {
      return this.customSpecs.some(s => s.id === id);
    },

    // ─── Historique ──────────────────────────────────────────────────────────
    async loadHistory(): Promise<void> {
      if (this.historyLoading) return;
      this.historyLoading = true;
      try {
        const deps   = await getDeps();
        const allSpecs = [
          ...DEFAULT_TASKS_SPEC,
          ...this.customSpecs,
        ];
        const taskMap = new Map(allSpecs.map(s => [s.id, { id: s.id, title: s.title, icon: s.icon }]));

        const days: HistoryDay[] = [];
        // Charger les 7 derniers jours (excluant aujourd'hui)
        for (let i = 1; i <= 7; i++) {
          const date   = dateIso(-i);
          const doneIds = (await deps.storage.get<string[]>(`kinetic:vitalite:done:${date}`)) ?? [];
          days.push({
            date,
            label:   dateLabel(date),
            doneIds,
            tasks:   doneIds.map(id => taskMap.get(id) ?? { id, title: id, icon: '✓' }),
          });
        }
        this.historyDays = days;
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

    // ─── Helpers ─────────────────────────────────────────────────────────────
    async _refreshXpStore(): Promise<void> {
      const Alpine = (window as unknown as { Alpine: { store: (n: string) => unknown } }).Alpine;
      const xp = Alpine.store('xp') as { reload: () => Promise<void> } | undefined;
      await xp?.reload();
    },

    get doneCount():  number  { return this.tasks.filter(t => t.done).length; },
    get totalCount(): number  { return this.tasks.length; },
    get progress():   number  { return this.totalCount === 0 ? 0 : Math.round((this.doneCount / this.totalCount) * 100); },
    get allDone():    boolean { return this.totalCount > 0 && this.doneCount === this.totalCount; },

    isLocked(id: string): boolean {
      return this._pendingIds.has(id);
    },

    // Emojis proposés pour les tâches custom
    emojiSuggestions: ['⭐','🏋️','🧘','🚶','🥗','💧','📚','📝','🎯','🔥','💪','🏃','🧠','😴','🚴','🤸','🥦','🫁','⚡','🎸'],
  };
}

function notify(kind: 'success' | 'error' | 'warning' | 'info', message: string): void {
  window.dispatchEvent(new CustomEvent('kinetic:notify', { detail: { kind, message } }));
}
