/**
 * Système de programme d'entraînement (splits hebdomadaires)
 * Basé sur : Schoenfeld (2017) — fréquence 2×/sem par groupe musculaire optimale
 */

export type SplitType = 'ppl' | 'upper_lower' | 'full_body' | 'bro_split' | 'custom';

export interface ProgramDay {
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;  // 0=dim, 1=lun...
  label:     string;
  focus:     string;          // ex: "Push", "Jambes", "Full Body A"
  muscleGroups: string[];
  templateId?: string;        // lié à un WorkoutTemplate
  restDay:   boolean;
}

export interface TrainingProgram {
  id:          string;
  name:        string;
  splitType:   SplitType;
  daysPerWeek: number;
  goal:        string;
  schedule:    ProgramDay[];
  createdAt:   string;
  active:      boolean;
}

export const PRESET_SPLITS: Record<SplitType, Omit<TrainingProgram, 'id' | 'createdAt' | 'active' | 'name'>> = {
  ppl: {
    splitType: 'ppl', daysPerWeek: 6, goal: 'hypertrophie',
    schedule: [
      { dayOfWeek: 1, label: 'Lundi',    focus: 'Push A',   muscleGroups: ['pectoraux','épaules','triceps'], restDay: false },
      { dayOfWeek: 2, label: 'Mardi',    focus: 'Pull A',   muscleGroups: ['dos','biceps','trapèzes'], restDay: false },
      { dayOfWeek: 3, label: 'Mercredi', focus: 'Jambes A', muscleGroups: ['quadriceps','ischio','mollets','fessiers'], restDay: false },
      { dayOfWeek: 4, label: 'Jeudi',    focus: 'Push B',   muscleGroups: ['pectoraux','épaules','triceps'], restDay: false },
      { dayOfWeek: 5, label: 'Vendredi', focus: 'Pull B',   muscleGroups: ['dos','biceps','trapèzes'], restDay: false },
      { dayOfWeek: 6, label: 'Samedi',   focus: 'Jambes B', muscleGroups: ['quadriceps','ischio','mollets','fessiers'], restDay: false },
      { dayOfWeek: 0, label: 'Dimanche', focus: 'Repos',    muscleGroups: [], restDay: true },
    ],
  },
  upper_lower: {
    splitType: 'upper_lower', daysPerWeek: 4, goal: 'force + hypertrophie',
    schedule: [
      { dayOfWeek: 1, label: 'Lundi',    focus: 'Haut du corps A', muscleGroups: ['pectoraux','dos','épaules','bras'], restDay: false },
      { dayOfWeek: 2, label: 'Mardi',    focus: 'Bas du corps A',  muscleGroups: ['quadriceps','ischio','fessiers','mollets'], restDay: false },
      { dayOfWeek: 3, label: 'Mercredi', focus: 'Repos',           muscleGroups: [], restDay: true },
      { dayOfWeek: 4, label: 'Jeudi',    focus: 'Haut du corps B', muscleGroups: ['pectoraux','dos','épaules','bras'], restDay: false },
      { dayOfWeek: 5, label: 'Vendredi', focus: 'Bas du corps B',  muscleGroups: ['quadriceps','ischio','fessiers','mollets'], restDay: false },
      { dayOfWeek: 6, label: 'Samedi',   focus: 'Repos',           muscleGroups: [], restDay: true },
      { dayOfWeek: 0, label: 'Dimanche', focus: 'Repos',           muscleGroups: [], restDay: true },
    ],
  },
  full_body: {
    splitType: 'full_body', daysPerWeek: 3, goal: 'débutant / maintenance',
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
    splitType: 'bro_split', daysPerWeek: 5, goal: 'hypertrophie',
    schedule: [
      { dayOfWeek: 1, label: 'Lundi',    focus: 'Pectoraux',  muscleGroups: ['pectoraux'], restDay: false },
      { dayOfWeek: 2, label: 'Mardi',    focus: 'Dos',        muscleGroups: ['dos'], restDay: false },
      { dayOfWeek: 3, label: 'Mercredi', focus: 'Épaules',    muscleGroups: ['épaules'], restDay: false },
      { dayOfWeek: 4, label: 'Jeudi',    focus: 'Bras',       muscleGroups: ['biceps','triceps'], restDay: false },
      { dayOfWeek: 5, label: 'Vendredi', focus: 'Jambes',     muscleGroups: ['jambes'], restDay: false },
      { dayOfWeek: 6, label: 'Samedi',   focus: 'Repos',      muscleGroups: [], restDay: true },
      { dayOfWeek: 0, label: 'Dimanche', focus: 'Repos',      muscleGroups: [], restDay: true },
    ],
  },
  custom: {
    splitType: 'custom', daysPerWeek: 3, goal: 'personnalisé',
    schedule: [],
  },
};

export function todayFocus(program: TrainingProgram): ProgramDay | null {
  const today = new Date().getDay() as ProgramDay['dayOfWeek'];
  return program.schedule.find((d) => d.dayOfWeek === today) ?? null;
}

export function weekProgress(program: TrainingProgram, completedDays: number[]): number {
  const trainingDays = program.schedule.filter((d) => !d.restDay).length;
  if (trainingDays === 0) return 0;
  const done = completedDays.filter((d) => {
    const pd = program.schedule.find((s) => s.dayOfWeek === d);
    return pd && !pd.restDay;
  }).length;
  return Math.round((done / trainingDays) * 100);
}