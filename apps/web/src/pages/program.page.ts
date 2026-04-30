import { getDeps } from '../deps';

interface ProgramDay {
  dayOfWeek: number;
  label: string;
  focus: string;
  muscleGroups: string[];
  restDay: boolean;
}

interface ActiveProgram {
  id: string;
  name: string;
  splitType: 'ppl' | 'upper_lower' | 'full_body' | 'bro_split';
  daysPerWeek: number;
  goal: string;
  schedule: ProgramDay[];
  createdAt: string;
  active: boolean;
}

interface SplitOption {
  type: ActiveProgram['splitType'];
  name: string;
  description: string;
  daysPerWeek: number;
  goal: string;
}

interface TodoExercise {
  id: string;
  name: string;
  sets: number;
  targetReps: number;
  targetRpe: number;
  done: boolean;
}

interface ExerciseRecord {
  id: string;
  muscles?: string[];
}

interface TrainingTemplate {
  id: string;
  name: string;
  createdAt: string;
  exercises: Array<{
    exerciseId: string;
    sets: number;
    targetReps: number;
    targetRpe: number;
  }>;
}

const SPLIT_DEFINITIONS: Record<ActiveProgram['splitType'], Omit<ActiveProgram, 'id' | 'createdAt' | 'active'>> = {
  ppl: {
    name: 'Push Pull Legs', splitType: 'ppl', daysPerWeek: 6, goal: 'hypertrophie',
    schedule: [
      { dayOfWeek: 1, label: 'Lundi',    focus: 'Push A',   muscleGroups: ['pectoraux','épaules','triceps'], restDay: false },
      { dayOfWeek: 2, label: 'Mardi',    focus: 'Pull A',   muscleGroups: ['dos','biceps'],                  restDay: false },
      { dayOfWeek: 3, label: 'Mercredi', focus: 'Jambes A', muscleGroups: ['quadriceps','ischio','fessiers'], restDay: false },
      { dayOfWeek: 4, label: 'Jeudi',    focus: 'Push B',   muscleGroups: ['pectoraux','épaules','triceps'], restDay: false },
      { dayOfWeek: 5, label: 'Vendredi', focus: 'Pull B',   muscleGroups: ['dos','biceps'],                  restDay: false },
      { dayOfWeek: 6, label: 'Samedi',   focus: 'Jambes B', muscleGroups: ['quadriceps','ischio','fessiers'], restDay: false },
      { dayOfWeek: 0, label: 'Dimanche', focus: 'Repos',    muscleGroups: [],                                restDay: true },
    ],
  },
  upper_lower: {
    name: 'Haut / Bas', splitType: 'upper_lower', daysPerWeek: 4, goal: 'force',
    schedule: [
      { dayOfWeek: 1, label: 'Lundi',    focus: 'Haut A', muscleGroups: ['pectoraux','dos','épaules','bras'], restDay: false },
      { dayOfWeek: 2, label: 'Mardi',    focus: 'Bas A',  muscleGroups: ['quadriceps','ischio','fessiers'],   restDay: false },
      { dayOfWeek: 3, label: 'Mercredi', focus: 'Repos',  muscleGroups: [], restDay: true },
      { dayOfWeek: 4, label: 'Jeudi',    focus: 'Haut B', muscleGroups: ['pectoraux','dos','épaules','bras'], restDay: false },
      { dayOfWeek: 5, label: 'Vendredi', focus: 'Bas B',  muscleGroups: ['quadriceps','ischio','fessiers'],   restDay: false },
      { dayOfWeek: 6, label: 'Samedi',   focus: 'Repos',  muscleGroups: [], restDay: true },
      { dayOfWeek: 0, label: 'Dimanche', focus: 'Repos',  muscleGroups: [], restDay: true },
    ],
  },
  full_body: {
    name: 'Full Body', splitType: 'full_body', daysPerWeek: 3, goal: 'débutant',
    schedule: [
      { dayOfWeek: 1, label: 'Lundi',    focus: 'Full Body A', muscleGroups: ['corps entier'], restDay: false },
      { dayOfWeek: 2, label: 'Mardi',    focus: 'Repos',       muscleGroups: [], restDay: true },
      { dayOfWeek: 3, label: 'Mercredi', focus: 'Full Body B', muscleGroups: ['corps entier'], restDay: false },
      { dayOfWeek: 4, label: 'Jeudi',    focus: 'Repos',       muscleGroups: [], restDay: true },
      { dayOfWeek: 5, label: 'Vendredi', focus: 'Full Body C', muscleGroups: ['corps entier'], restDay: false },
      { dayOfWeek: 6, label: 'Samedi',   focus: 'Repos',       muscleGroups: [], restDay: true },
      { dayOfWeek: 0, label: 'Dimanche', focus: 'Repos',       muscleGroups: [], restDay: true },
    ],
  },
  bro_split: {
    name: 'Bro Split', splitType: 'bro_split', daysPerWeek: 5, goal: 'isolation',
    schedule: [
      { dayOfWeek: 1, label: 'Lundi',    focus: 'Pectoraux', muscleGroups: ['pectoraux'], restDay: false },
      { dayOfWeek: 2, label: 'Mardi',    focus: 'Dos',       muscleGroups: ['dos'],       restDay: false },
      { dayOfWeek: 3, label: 'Mercredi', focus: 'Épaules',   muscleGroups: ['épaules'],   restDay: false },
      { dayOfWeek: 4, label: 'Jeudi',    focus: 'Bras',      muscleGroups: ['biceps','triceps'], restDay: false },
      { dayOfWeek: 5, label: 'Vendredi', focus: 'Jambes',    muscleGroups: ['jambes'],    restDay: false },
      { dayOfWeek: 6, label: 'Samedi',   focus: 'Repos',     muscleGroups: [], restDay: true },
      { dayOfWeek: 0, label: 'Dimanche', focus: 'Repos',     muscleGroups: [], restDay: true },
    ],
  },
};

const FALLBACK_EXERCISES: Record<string, TodoExercise[]> = {
  push: [
    { id: 'pp1', name: 'Développé couché',     sets: 4, targetReps: 8,  targetRpe: 8, done: false },
    { id: 'pp2', name: 'Développé incliné',    sets: 3, targetReps: 10, targetRpe: 8, done: false },
    { id: 'pp3', name: 'Élévations latérales', sets: 3, targetReps: 15, targetRpe: 8, done: false },
    { id: 'pp4', name: 'Extensions triceps',   sets: 3, targetReps: 12, targetRpe: 8, done: false },
  ],
  pull: [
    { id: 'pl1', name: 'Tractions',    sets: 4, targetReps: 8,  targetRpe: 8, done: false },
    { id: 'pl2', name: 'Rowing barre', sets: 4, targetReps: 8,  targetRpe: 8, done: false },
    { id: 'pl3', name: 'Curl biceps',  sets: 3, targetReps: 12, targetRpe: 8, done: false },
  ],
  jambes: [
    { id: 'j1', name: 'Squat',                     sets: 4, targetReps: 6,  targetRpe: 8, done: false },
    { id: 'j2', name: 'Leg press',                 sets: 3, targetReps: 12, targetRpe: 8, done: false },
    { id: 'j3', name: 'Soulevé de terre roumain',  sets: 3, targetReps: 10, targetRpe: 8, done: false },
    { id: 'j4', name: 'Mollets assis',             sets: 4, targetReps: 15, targetRpe: 8, done: false },
  ],
  'full body': [
    { id: 'fb1', name: 'Squat',              sets: 3, targetReps: 8, targetRpe: 7, done: false },
    { id: 'fb2', name: 'Développé couché',   sets: 3, targetReps: 8, targetRpe: 7, done: false },
    { id: 'fb3', name: 'Soulevé de terre',   sets: 3, targetReps: 6, targetRpe: 8, done: false },
    { id: 'fb4', name: 'Tractions',          sets: 3, targetReps: 8, targetRpe: 8, done: false },
  ],
};

const MUSCLE_TO_EXERCISE_IDS: Record<string, string[]> = {
  pectoraux:      ['bench_press','incline_bench','dips','cable_fly'],
  épaules:        ['shoulder_press','lateral_raise','front_raise'],
  triceps:        ['triceps_pushdown','skull_crusher','close_grip'],
  dos:            ['pull_ups','barbell_row','lat_pulldown','seated_row'],
  biceps:         ['barbell_curl','hammer_curl','preacher_curl'],
  quadriceps:     ['squat','leg_press','leg_extension','hack_squat'],
  ischio:         ['romanian_deadlift','leg_curl','good_morning'],
  fessiers:       ['hip_thrust','bulgarian_split_squat'],
  mollets:        ['standing_calf_raise','seated_calf_raise'],
  'corps entier': ['squat','bench_press','barbell_row','overhead_press'],
};

export function program() {
  return {
    activeProgram:   null as ActiveProgram | null,
    completedDayIds: [] as number[],
    todoStatus:      {} as Record<string, boolean>,
    generating:      false,
    generatedCount:  0,

    availableSplits: [
      { type: 'ppl',         name: 'Push / Pull / Legs', description: 'Optimal hypertrophie, 6j/sem', daysPerWeek: 6, goal: 'hypertrophie' },
      { type: 'upper_lower', name: 'Haut / Bas',          description: 'Force + masse, 4j/sem',       daysPerWeek: 4, goal: 'force' },
      { type: 'full_body',   name: 'Full Body',           description: 'Fréquence maximale, 3j/sem',  daysPerWeek: 3, goal: 'débutant' },
      { type: 'bro_split',   name: 'Bro Split',           description: '1 muscle / jour, 5j/sem',     daysPerWeek: 5, goal: 'isolation' },
    ] as SplitOption[],

    get todayFocus(): ProgramDay | null {
      if (!this.activeProgram) return null;
      const day = new Date().getDay();
      return this.activeProgram.schedule.find(d => d.dayOfWeek === day) ?? null;
    },

    get weekDays() {
      const days = ['D','L','M','M','J','V','S'];
      const today = new Date().getDay();
      return Array.from({ length: 7 }, (_, i) => {
        const pd = this.activeProgram?.schedule.find(d => d.dayOfWeek === i);
        return {
          short: days[i],
          isToday: i === today,
          rest: pd?.restDay ?? true,
          focus: pd?.focus ?? '—',
          done: this.completedDayIds.includes(i),
        };
      });
    },

    get todayExercises(): TodoExercise[] {
      const focus = this.todayFocus;
      if (!focus || focus.restDay) return [];
      return this.getExercisesForFocus(focus.focus);
    },

    get totalTrainingDays(): number {
      return this.activeProgram?.schedule.filter(d => !d.restDay).length ?? 0;
    },

    get completedTrainingDays(): number {
      return this.completedDayIds.filter(d => {
        const pd = this.activeProgram?.schedule.find(s => s.dayOfWeek === d);
        return pd && !pd.restDay;
      }).length;
    },

    get weekProgressPct(): number {
      if (this.totalTrainingDays === 0) return 0;
      return Math.round((this.completedTrainingDays / this.totalTrainingDays) * 100);
    },

    getExercisesForFocus(focus: string): TodoExercise[] {
      const focusLower = focus.toLowerCase();
      for (const [key, exs] of Object.entries(FALLBACK_EXERCISES)) {
        if (focusLower.includes(key)) {
          return exs.map(e => ({ ...e, done: this.todoStatus[e.id] ?? false }));
        }
      }
      return [];
    },

    async init(): Promise<void> {
      const deps = await getDeps();
      const stored = await deps.storage.get<ActiveProgram>('kinetic:program:active');
      if (stored) this.activeProgram = stored;
      const completed = await deps.storage.get<number[]>('kinetic:program:completedDays:' + this.weekKey());
      if (completed) this.completedDayIds = completed;
      const todo = await deps.storage.get<Record<string, boolean>>('kinetic:program:todoStatus:' + this.todayKey());
      if (todo) this.todoStatus = todo;
      const genCount = await deps.storage.get<number>('kinetic:program:generatedCount');
      if (typeof genCount === 'number') this.generatedCount = genCount;
    },

    async generateTemplates(): Promise<void> {
      if (!this.activeProgram || this.generating) return;
      this.generating = true;
      try {
        const deps = await getDeps();
        const exercises = (await deps.storage.get<ExerciseRecord[]>('kinetic:training:exercises')) ?? [];
        const existingTemplates = (await deps.storage.get<TrainingTemplate[]>('kinetic:training:templates')) ?? [];

        const allExIds = exercises.map(e => e.id);
        const newTemplates: TrainingTemplate[] = [];

        for (const day of this.activeProgram.schedule) {
          if (day.restDay) continue;
          if (existingTemplates.some(t => t.name === day.focus)) continue;

          const exIds = new Set<string>();
          for (const muscle of day.muscleGroups) {
            const candidates = MUSCLE_TO_EXERCISE_IDS[muscle.toLowerCase()] ?? [];
            for (const c of candidates) {
              if (allExIds.includes(c)) exIds.add(c);
            }
            if (exIds.size === 0) {
              const keyword = muscle.toLowerCase();
              exercises
                .filter(e => e.muscles?.some(m => m.toLowerCase().includes(keyword)))
                .slice(0, 4)
                .forEach(e => exIds.add(e.id));
            }
          }

          if (exIds.size === 0 && exercises.length > 0) {
            exercises.slice(0, 4).forEach(e => exIds.add(e.id));
          }

          const templateExercises = [...exIds].slice(0, 6).map((id, i) => ({
            exerciseId: id,
            sets: i === 0 ? 4 : 3,
            targetReps: [6, 8, 10, 12][i % 4]!,
            targetRpe: 8,
          }));

          if (templateExercises.length === 0) continue;

          newTemplates.push({
            id: crypto.randomUUID(),
            name: day.focus,
            createdAt: new Date().toISOString(),
            exercises: templateExercises,
          });
        }

        if (newTemplates.length > 0) {
          const merged = [...existingTemplates, ...newTemplates];
          await deps.storage.set('kinetic:training:templates', merged);
          this.generatedCount = newTemplates.length;
          await deps.storage.set('kinetic:program:generatedCount', this.generatedCount);
          window.dispatchEvent(new CustomEvent('kinetic:notify', {
            detail: { kind: 'success', message: newTemplates.length + ' templates créés ✓' },
          }));
        } else {
          window.dispatchEvent(new CustomEvent('kinetic:notify', {
            detail: { kind: 'info', message: 'Templates déjà existants pour ce programme' },
          }));
        }
      } catch (err) {
        console.error('[program] generateTemplates failed:', err);
      } finally {
        this.generating = false;
      }
    },

    weekKey(): string {
      const d = new Date();
      const week = Math.ceil(d.getDate() / 7);
      return `${d.getFullYear()}-W${d.getMonth()}-${week}`;
    },

    todayKey(): string {
      const d = new Date();
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    },

    async selectSplit(type: ActiveProgram['splitType']): Promise<void> {
      const deps = await getDeps();
      const def = SPLIT_DEFINITIONS[type];
      const prog: ActiveProgram = {
        id: crypto.randomUUID(),
        ...def,
        createdAt: new Date().toISOString(),
        active: true,
      };
      this.activeProgram = prog;
      await deps.storage.set('kinetic:program:active', prog);
      window.dispatchEvent(new CustomEvent('kinetic:notify', {
        detail: { kind: 'success', message: 'Programme activé ✓' },
      }));
    },

    async toggleExercise(exId: string): Promise<void> {
      const deps = await getDeps();
      this.todoStatus = { ...this.todoStatus, [exId]: !(this.todoStatus[exId] ?? false) };
      await deps.storage.set('kinetic:program:todoStatus:' + this.todayKey(), this.todoStatus);

      const exs = this.todayExercises;
      if (exs.length > 0 && exs.every(e => this.todoStatus[e.id])) {
        const today = new Date().getDay();
        if (!this.completedDayIds.includes(today)) {
          this.completedDayIds = [...this.completedDayIds, today];
          await deps.storage.set('kinetic:program:completedDays:' + this.weekKey(), this.completedDayIds);
          window.dispatchEvent(new CustomEvent('kinetic:notify', {
            detail: { kind: 'success', message: 'Séance complète ! 🏆 +50 XP' },
          }));
        }
      }
    },

    startExercise(_ex: TodoExercise): void {
      window.location.href = '/seances';
    },

    /**
     * Démarre la séance du jour en pré-chargeant le modèle correspondant
     * au focus du jour. Si aucun template n'est encore généré, on redirige
     * simplement vers la page séances en mode libre.
     */
    async startTodaySession(): Promise<void> {
      const focus = this.todayFocus;
      if (!focus || focus.restDay) {
        window.location.href = '/seances';
        return;
      }
      try {
        const deps = await getDeps();
        const templates = (await deps.storage.get<TrainingTemplate[]>('kinetic:training:templates')) ?? [];
        const match = templates.find(t =>
          t.name.toLowerCase() === focus.focus.toLowerCase() ||
          t.name.toLowerCase().includes(focus.focus.toLowerCase()) ||
          focus.focus.toLowerCase().includes(t.name.toLowerCase())
        );
        if (match) {
          // Passe le template ID via sessionStorage — seances.page.ts le récupère dans init()
          sessionStorage.setItem('kinetic:program:auto-template', match.id);
        }
      } catch {}
      window.location.href = '/seances';
    },
  };
}
