/**
 * strengthGoals — « Mes objectifs » de force (Progression) et aperçu compact
 * de l'objectif le plus proche (accueil, `data-compact`). Chargé à la demande
 * (lib/lazy-component.ts). Logique dans @kinetic/core (strength-goals.domain).
 *
 * Ouvrir la feuille de création depuis ailleurs : `/progression?goal=<exerciceId>`
 * (ou `?goal=new`), ou l'événement `k-goal-new` (détail = exerciceId).
 */
import {
  STORAGE_KEYS,
  closestGoal,
  evaluateGoal,
  goalEtaLabel,
  goalLabel,
  normalizeGoals,
  sessionBestE1rms,
  syncAchievedGoals,
  validateGoalInput,
  type GoalStatus,
  type StrengthGoal,
  type StrengthGoalKind,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { loadExercises, loadSessions } from '../lib/training/storage';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { celebrate } from '../lib/celebration';
import { hapticLight, hapticSuccess } from '../lib/haptics';
import type { ContextMenuRequest } from '../lib/context-menu';
import { notify as toast, type NotifyKind } from '../lib/notify';

const notify = (message: string, kind: NotifyKind = 'success'): void => toast(kind, message);
const kg = (n: number): string => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

/** Objectif atteint : même carte que les records. */
export function celebrateGoal(goal: StrengthGoal, exerciseName: string): void {
  celebrate({
    kind: 'record',
    title: 'Objectif atteint !',
    subtitle: goalLabel(goal, exerciseName),
  });
}

export function strengthGoals() {
  return {
    compact: false,
    goals: [] as StrengthGoal[],
    statuses: [] as GoalStatus[],
    sessions: [] as WorkoutSession[],
    exercises: [] as Exercise[],
    sheet: false,
    form: {
      id: '',
      exerciseId: '',
      kind: 'weight' as StrengthGoalKind,
      targetKg: '',
      targetReps: '8',
    },
    formError: '',
    $el: null as unknown as HTMLElement,

    async init(): Promise<void> {
      this.compact = this.$el.hasAttribute('data-compact');
      const deps = await getDeps();
      this.goals = normalizeGoals(await deps.storage.get(STORAGE_KEYS.STRENGTH_GOALS));
      if (this.compact && this.goals.length === 0) return;
      [this.sessions, this.exercises] = await Promise.all([
        loadSessions(deps.storage),
        loadExercises(deps.storage),
      ]);
      const sync = syncAchievedGoals(this.goals, this.sessions);
      if (sync.changed) {
        this.goals = sync.goals;
        await this._save();
        for (const g of sync.newly) celebrateGoal(g, this.name(g.exerciseId));
      }
      this._refresh();
      const wanted = new URLSearchParams(window.location?.search ?? '').get('goal');
      if (!this.compact && wanted) this.openNew(wanted === 'new' ? '' : wanted);
    },

    _refresh(): void {
      const now = Date.now();
      this.statuses = this.goals
        .map((g) => evaluateGoal(g, this.sessions, now))
        .sort(
          (a, b) =>
            Number(a.state === 'achieved') - Number(b.state === 'achieved') || b.pct - a.pct,
        );
    },

    async _save(): Promise<void> {
      const deps = await getDeps();
      await deps.storage.set(STORAGE_KEYS.STRENGTH_GOALS, this.goals);
    },

    // ─── Affichage ───────────────────────────────────────────

    get closest(): GoalStatus | null {
      return closestGoal(this.statuses);
    },

    name(exerciseId: string): string {
      return this.exercises.find((e) => e.id === exerciseId)?.name ?? exerciseId;
    },

    label(st: GoalStatus): string {
      return goalLabel(st.goal, this.name(st.goal.exerciseId));
    },

    eta(st: GoalStatus): string {
      return goalEtaLabel(st, Date.now());
    },

    etaClass(st: GoalStatus): string {
      if (st.state === 'achieved' || st.state === 'on-track') return 'text-kinetic-teal';
      return st.state === 'ready' ? 'text-kinetic-neon' : 'text-gray-500';
    },

    /**
     * « e1RM récente 128 / 145 kg · +1,2 kg/sem. » ; atteint : l'e1RM seule (la cible
     * d'un objectif de charge est son e1RM équivalente, pas la charge affichée).
     */
    detail(st: GoalStatus): string {
      if (st.state === 'no-data') return `Il faut une e1RM d'environ ${kg(st.target)} kg`;
      if (st.state === 'achieved') return `e1RM récente ${kg(st.current)} kg`;
      const pace = st.perWeek > 0.05 ? ` · +${kg(st.perWeek)} kg/sem.` : '';
      return `e1RM récente ${kg(st.current)} / ${kg(st.target)} kg${pace}`;
    },

    ringStyle(st: GoalStatus): string {
      return `--p: ${st.pct}`;
    },

    // ─── Feuille créer / modifier ────────────────────────────

    /** Exercices en reps × charge, ceux déjà pratiqués d'abord. */
    get options(): Array<{ id: string; name: string }> {
      const done = new Set(this.sessions.flatMap((s) => s.entries.map((e) => e.exerciseId)));
      return this.exercises
        .filter((e) => (!e.hidden || done.has(e.id)) && (e.measure ?? 'reps') === 'reps')
        .sort(
          (a, b) =>
            Number(done.has(b.id)) - Number(done.has(a.id)) || a.name.localeCompare(b.name, 'fr'),
        )
        .map((e) => ({ id: e.id, name: e.name }));
    },

    /** « Ton e1RM récente : 128 kg » sous le choix d'exercice. */
    get formHint(): string {
      const pts = sessionBestE1rms(this.sessions, this.form.exerciseId);
      if (!this.form.exerciseId) return '';
      if (pts.length === 0) return 'Pas encore de séance sur cet exercice.';
      return `Ton e1RM récente : ${kg(pts.at(-1)!.e1rm)} kg (meilleure : ${kg(Math.max(...pts.map((p) => p.e1rm)))} kg)`;
    },

    get sheetTitle(): string {
      return this.form.id ? "Modifier l'objectif" : 'Nouvel objectif';
    },

    setKind(kind: StrengthGoalKind): void {
      this.form.kind = kind;
    },

    kindPressed(kind: StrengthGoalKind): string {
      return String(this.form.kind === kind);
    },

    openNew(exerciseId?: string): void {
      const id = typeof exerciseId === 'string' ? exerciseId : '';
      this.form = { id: '', exerciseId: id, kind: 'weight', targetKg: '', targetReps: '8' };
      this.formError = '';
      this.sheet = true;
    },

    edit(id: string): void {
      const g = this.goals.find((x) => x.id === id);
      if (!g) return;
      this.form = {
        id: g.id,
        exerciseId: g.exerciseId,
        kind: g.kind,
        targetKg: String(g.targetKg),
        targetReps: String(g.targetReps ?? 8),
      };
      this.formError = '';
      this.sheet = true;
    },

    close(): void {
      this.sheet = false;
    },

    async save(): Promise<void> {
      const input = {
        exerciseId: this.form.exerciseId,
        kind: this.form.kind,
        targetKg: Number(String(this.form.targetKg).replace(',', '.')),
        ...(this.form.kind === 'reps' ? { targetReps: Number(this.form.targetReps) } : {}),
      };
      const error = validateGoalInput(input);
      this.formError = error ?? '';
      if (error) return;
      const old = this.goals.find((g) => g.id === this.form.id);
      const goal: StrengthGoal = {
        ...input,
        id: old?.id ?? `sg-${Date.now().toString(36)}`,
        createdAt: new Date().toISOString(),
      };
      const sync = syncAchievedGoals([goal], this.sessions);
      this.goals = old
        ? this.goals.map((g) => (g === old ? sync.goals[0]! : g))
        : [...this.goals, sync.goals[0]!];
      await this._save();
      this._refresh();
      this.sheet = false;
      hapticSuccess();
      notify(
        sync.changed
          ? 'Objectif déjà atteint dans ton historique : vise plus haut !'
          : 'Objectif enregistré.',
        sync.changed ? 'info' : 'success',
      );
    },

    async remove(id: string): Promise<void> {
      this.goals = this.goals.filter((g) => g.id !== id);
      await this._save();
      this._refresh();
      this.sheet = false;
      hapticLight();
      notify('Objectif supprimé.');
    },

    removeEdited(): Promise<void> {
      return this.remove(this.form.id);
    },

    /** Appui long sur un objectif : modifier, supprimer. */
    goalMenu(menu: ContextMenuRequest, id: string): void {
      menu.show([
        { label: 'Modifier', icon: 'edit', run: () => this.edit(id) },
        {
          label: 'Supprimer',
          icon: 'trash',
          danger: true,
          confirm: 'Supprimer',
          run: () => this.remove(id),
        },
      ]);
    },
  };
}
