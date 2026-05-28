export type IsoDateTime = string;

export type ExerciseId = string;
export type WorkoutTemplateId = string;
export type WorkoutSessionId = string;

export interface Exercise {
  id: ExerciseId;
  name: string;
  muscles: readonly string[];
  equipment: 'barbell' | 'dumbbell' | 'machine' | 'bodyweight' | 'cable' | 'other';
  incrementKg: number;
}

export interface TemplateExercise {
  exerciseId: ExerciseId;
  sets: number;
  targetReps: number;
  targetRpe: number; // 6-10
}

export interface WorkoutTemplate {
  id: WorkoutTemplateId;
  name: string;
  createdAt: IsoDateTime;
  exercises: readonly TemplateExercise[];
}

export interface SetEntry {
  setIndex: number;
  reps: number;
  weightKg: number;
  rpe: number; // 6-10 (roughly)
  performedAt: IsoDateTime;
  /**
   * Note libre par set (≤ 200 caractères) — utile pour traçabilité technique
   * ("barre déséquilibrée à droite", "talons relevés", "ceinture nécessaire").
   * Champ optionnel pour rester rétrocompatible avec les séances historiques.
   */
  note?: string;
}

export interface SessionExerciseEntry {
  exerciseId: ExerciseId;
  sets: readonly SetEntry[];
}

export interface WorkoutSession {
  id: WorkoutSessionId;
  name: string;
  templateId?: WorkoutTemplateId;
  startedAt: IsoDateTime;
  endedAt?: IsoDateTime;
  entries: readonly SessionExerciseEntry[];

  // Derived/optional fields (stored for convenience; can be recomputed)
  durationMin?: number;
  avgRpe?: number;
  caloriesKcal?: number;
}
