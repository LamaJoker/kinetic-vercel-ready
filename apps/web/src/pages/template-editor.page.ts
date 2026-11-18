/**
 * Éditeur de modèle de séance (/modele) et exercices personnalisés (/exercices).
 * Logique pure : @kinetic/core (template-editor.domain). Ici, l'état d'écran et le stockage.
 */
import {
  STORAGE_KEYS,
  EQUIPMENT_OPTIONS,
  MUSCLE_OPTIONS,
  addTemplateLine,
  clampTemplateLine,
  cleanLabel,
  customExerciseId,
  isExerciseInUse,
  moveItem,
  normalizeCustomExercise,
  searchExercises,
  upsertById,
  validateCustomExercise,
  validateTemplateDraft,
  canLinkWithNext,
  exerciseMeasure,
  linkWithNext,
  normalizeSupersets,
  supersetLabel,
  unlinkSuperset,
  MEASURE_OPTIONS,
  type ExerciseEquipment,
  type ExerciseMeasure,
  type TemplateLine,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { navigate } from '../router';
import { loadActiveSession } from '../lib/training/active-session';
import { readEditedTemplateId } from '../lib/training/template-editor-nav';
import {
  loadCustomExercises,
  loadExercises,
  loadSessions,
  loadTemplates,
  saveCustomExercises,
  saveTemplates,
} from '../lib/training/storage';
import type { Exercise, WorkoutTemplate } from '../lib/training/types';

const EDIT_KEY = STORAGE_KEYS.TEMPLATE_EDITOR_ID;

type View = 'template' | 'exercises' | 'exercise';
type LineField = 'sets' | 'targetReps' | 'targetRpe';

function notify(kind: 'success' | 'error', message: string): void {
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind, message } }));
}

function blankForm() {
  return {
    id: '',
    name: '',
    muscles: [] as string[],
    equipment: 'other' as ExerciseEquipment,
    incrementKg: 2.5,
    measure: 'reps' as ExerciseMeasure,
  };
}

export function templateEditor() {
  return {
    view: 'template' as View,
    backView: 'exercises' as View,
    loading: true,
    saving: false,
    templateId: '',
    name: '',
    lines: [] as TemplateLine[],
    error: '',
    query: '',
    picking: false,
    exercises: [] as Exercise[],
    customs: [] as Exercise[],
    templates: [] as WorkoutTemplate[],
    usedIds: [] as string[],
    form: blankForm(),
    formError: '',
    muscleOptions: MUSCLE_OPTIONS,
    equipmentOptions: EQUIPMENT_OPTIONS,
    incrementOptions: [0.5, 1, 1.25, 2, 2.5, 5],
    measureOptions: MEASURE_OPTIONS,

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const [exercises, customs, templates] = await Promise.all([
          loadExercises(deps.storage),
          loadCustomExercises(deps.storage),
          loadTemplates(deps.storage),
        ]);
        this.exercises = exercises;
        this.customs = customs;
        this.templates = templates;
        if (window.location.pathname.startsWith('/exercices')) {
          this.view = 'exercises';
          await this.refreshUsage();
        } else {
          const id = readEditedTemplateId();
          const t = templates.find((x) => x.id === id);
          if (t) {
            this.templateId = t.id;
            this.name = t.name;
            this.lines = normalizeSupersets(t.exercises.map((e) => clampTemplateLine({ ...e })));
          }
          this.picking = this.lines.length === 0;
        }
      } catch (err) {
        console.error('[template-editor] init failed:', err);
      } finally {
        this.loading = false;
      }
    },

    get title(): string {
      if (this.view === 'exercises') return 'Mes exercices';
      if (this.view === 'exercise') return this.form.id ? 'Modifier l’exercice' : 'Nouvel exercice';
      return this.templateId ? 'Modifier le modèle' : 'Nouveau modèle';
    },
    get isTemplateView(): boolean {
      return this.view === 'template';
    },
    get isExercisesView(): boolean {
      return this.view === 'exercises';
    },
    get isExerciseView(): boolean {
      return this.view === 'exercise';
    },

    exerciseName(id: string): string {
      return this.exercises.find((e) => e.id === id)?.name ?? id;
    },

    // ─── Modèle ─────────────────────────────────────────────────
    get results(): Exercise[] {
      return searchExercises(
        this.exercises,
        this.query,
        this.lines.map((l) => l.exerciseId),
      );
    },
    get canCreateFromQuery(): boolean {
      const q = cleanLabel(this.query).toLowerCase();
      return q.length > 1 && !this.exercises.some((e) => e.name.toLowerCase() === q);
    },
    togglePicker(): void {
      this.picking = !this.picking;
    },
    addLine(id: string): void {
      this.lines = addTemplateLine(this.lines, id);
      this.query = '';
      this.error = '';
    },
    removeLine(i: number): void {
      this.lines = normalizeSupersets(this.lines.filter((_, j) => j !== i));
    },
    moveUp(i: number): void {
      this.lines = normalizeSupersets(moveItem(this.lines, i, -1));
    },
    moveDown(i: number): void {
      this.lines = normalizeSupersets(moveItem(this.lines, i, 1));
    },

    // ─── Supersets (2 ou 3 lignes consécutives) ─────────────────
    /** « A1 », « A2 »… ; vide hors superset. */
    lineTag(i: number): string {
      const line = this.lines[i];
      return line ? supersetLabel(this.lines, line.exerciseId) : '';
    },
    /** La ligne et la suivante sont dans le même superset. */
    linkedWithNext(i: number): boolean {
      const a = this.lines[i];
      const b = this.lines[i + 1];
      return !!a?.group && a.group === b?.group && !!this.lineTag(i) && !!this.lineTag(i + 1);
    },
    canLink(i: number): boolean {
      return canLinkWithNext(this.lines, i);
    },
    linkNext(i: number): void {
      this.lines = linkWithNext(this.lines, i);
    },
    unlinkAt(i: number): void {
      this.lines = unlinkSuperset(this.lines, i);
    },
    lineCardClass(i: number): string {
      return this.lineTag(i) ? 'k-card ring-1 ring-inset ring-kinetic-purple/40' : 'k-card';
    },
    step(i: number, field: LineField, delta: number): void {
      const line = this.lines[i];
      if (!line) return;
      const next = [...this.lines];
      next[i] = clampTemplateLine({ ...line, [field]: line[field] + delta });
      this.lines = next;
    },
    isLast(i: number): boolean {
      return i === this.lines.length - 1;
    },
    decimal(v: number): string {
      return String(v).replace('.', ',');
    },

    async saveTemplate(): Promise<void> {
      const error = validateTemplateDraft(this.name, this.lines);
      this.error = error ?? '';
      if (error || this.saving) return;
      this.saving = true;
      try {
        const deps = await getDeps();
        const current = await loadTemplates(deps.storage);
        const previous = current.find((t) => t.id === this.templateId);
        const template: WorkoutTemplate = {
          id: previous?.id ?? `tpl_${Date.now().toString(36)}`,
          name: cleanLabel(this.name),
          createdAt: previous?.createdAt ?? new Date().toISOString(),
          exercises: normalizeSupersets(this.lines.map((l) => clampTemplateLine(l))),
        };
        await saveTemplates(deps.storage, upsertById(current, template));
        notify('success', previous ? 'Modèle mis à jour.' : 'Modèle créé.');
        try {
          sessionStorage.removeItem(EDIT_KEY);
        } catch {
          /* ignore */
        }
        navigate('/seances');
      } catch (err) {
        console.error('[template-editor] save failed:', err);
        this.error = 'Enregistrement impossible. Réessaie.';
      } finally {
        this.saving = false;
      }
    },

    // ─── Exercices perso ────────────────────────────────────────
    async refreshUsage(): Promise<void> {
      const deps = await getDeps();
      const [sessions, active] = await Promise.all([
        loadSessions(deps.storage),
        loadActiveSession(deps.storage),
      ]);
      const all = active ? [...sessions, active.session] : sessions;
      this.usedIds = this.customs
        .filter((c) => isExerciseInUse(c.id, all, this.templates))
        .map((c) => c.id);
    },
    isUsed(id: string): boolean {
      return this.usedIds.includes(id);
    },
    customMeta(ex: Exercise): string {
      const muscles = ex.muscles
        .map((m) => MUSCLE_OPTIONS.find((o) => o.key === m)?.label ?? m)
        .join(', ');
      const eq = EQUIPMENT_OPTIONS.find((o) => o.key === ex.equipment)?.label ?? '';
      const m = exerciseMeasure(ex);
      const measure = m === 'reps' ? '' : (MEASURE_OPTIONS.find((o) => o.key === m)?.label ?? '');
      return [muscles, eq, measure, ex.hidden ? 'masqué' : ''].filter(Boolean).join(' · ');
    },
    newExercise(): void {
      this.backView = this.view;
      const name = this.view === 'template' ? cleanLabel(this.query) : '';
      // Mesure proposée d'après le nom (« Gainage » → durée), modifiable.
      this.form = { ...blankForm(), name, measure: exerciseMeasure({ id: '', name }) };
      this.formError = '';
      this.view = 'exercise';
    },
    editExercise(id: string): void {
      const ex = this.customs.find((c) => c.id === id);
      if (!ex) return;
      this.backView = 'exercises';
      this.form = {
        id: ex.id,
        name: ex.name,
        muscles: [...ex.muscles],
        equipment: ex.equipment,
        incrementKg: ex.incrementKg,
        measure: exerciseMeasure(ex),
      };
      this.formError = '';
      this.view = 'exercise';
    },
    cancelExercise(): void {
      this.view = this.backView;
    },
    hasMuscle(key: string): boolean {
      return this.form.muscles.includes(key);
    },
    toggleMuscle(key: string): void {
      const m = this.form.muscles;
      this.form.muscles = m.includes(key) ? m.filter((x) => x !== key) : [...m, key];
    },
    setEquipment(key: ExerciseEquipment): void {
      this.form.equipment = key;
    },
    isEquipment(key: string): boolean {
      return this.form.equipment === key;
    },
    isMeasure(key: string): boolean {
      return this.form.measure === key;
    },
    setMeasure(key: ExerciseMeasure): void {
      this.form.measure = key;
    },
    isIncrement(kg: number): boolean {
      return this.form.incrementKg === kg;
    },
    setIncrement(kg: number): void {
      this.form.incrementKg = kg;
    },
    kgLabel(kg: number): string {
      return `${this.decimal(kg)} kg`;
    },
    hideLabel(ex: Exercise): string {
      return ex.hidden ? 'Afficher' : 'Masquer';
    },

    async saveExercise(): Promise<void> {
      const input = normalizeCustomExercise(this.form);
      const others = this.exercises.filter((e) => e.id !== this.form.id).map((e) => e.name);
      const error = validateCustomExercise(input, others);
      this.formError = error ?? '';
      if (error) return;
      const previous = this.customs.find((c) => c.id === this.form.id);
      const exercise: Exercise = {
        ...previous,
        ...input,
        id:
          previous?.id ??
          customExerciseId(
            input.name,
            this.exercises.map((e) => e.id),
          ),
        custom: true,
      };
      // Revenir à « Reps × charge » efface la mesure enregistrée auparavant.
      if (!input.measure) exercise.measure = 'reps';
      await this.writeCustoms(upsertById(this.customs, exercise));
      if (this.backView === 'template') {
        this.addLine(exercise.id);
        this.picking = false;
      }
      this.view = this.backView;
      notify('success', previous ? 'Exercice mis à jour.' : 'Exercice créé.');
    },

    async toggleHidden(id: string): Promise<void> {
      await this.writeCustoms(
        this.customs.map((c) => (c.id === id ? { ...c, hidden: !c.hidden } : c)),
      );
    },

    async deleteExercise(id: string): Promise<void> {
      await this.refreshUsage();
      if (this.isUsed(id)) {
        notify('error', 'Exercice utilisé : masque-le plutôt.');
        return;
      }
      if (!window.confirm('Supprimer cet exercice ?')) return;
      await this.writeCustoms(this.customs.filter((c) => c.id !== id));
    },

    async writeCustoms(list: Exercise[]): Promise<void> {
      try {
        const deps = await getDeps();
        await saveCustomExercises(deps.storage, list);
        this.customs = list;
        this.exercises = await loadExercises(deps.storage);
      } catch (err) {
        console.error('[template-editor] custom exercises save failed:', err);
        notify('error', 'Enregistrement impossible. Réessaie.');
      }
    },
  };
}
