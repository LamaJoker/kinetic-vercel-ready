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
  /** Créé par l'utilisateur (stocké à part du catalogue). */
  custom?: boolean;
  /** Masqué des listes de choix (exercice perso déjà utilisé, conservé pour l'historique). */
  hidden?: boolean;
  /**
   * Mesure : `time` (gainage, chaise…), `distance` (farmer walk, cardio). Absente :
   * déduite de l'id ou du nom (exerciseMeasure, @kinetic/core), sinon reps × charge.
   */
  measure?: 'reps' | 'time' | 'distance';
}

export interface TemplateExercise {
  exerciseId: ExerciseId;
  sets: number;
  targetReps: number;
  targetRpe: number; // 6-10
  /** Superset : même identifiant sur 2 ou 3 exercices consécutifs. Absent = exercice seul. */
  group?: string;
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
  /**
   * Type de série : absent = travail. Les échauffements (« warmup ») sont exclus
   * du tonnage, des records, de l'e1RM, des statistiques et de la progression.
   */
  kind?: 'work' | 'warmup';
  /**
   * Série chronométrée (s) : gainage, chaise, cardio… `reps` vaut alors 0 (aucun
   * tonnage ni e1RM). Absent = série en répétitions.
   */
  durationSec?: number;
  /** Série de distance (m) : farmer walk, traîneau, cardio. `reps` vaut alors 0. */
  distanceM?: number;
}

export interface SessionExerciseEntry {
  exerciseId: ExerciseId;
  sets: readonly SetEntry[];
  /**
   * Superset / circuit : même identifiant sur 2 ou 3 exercices consécutifs
   * (normalizeSupersets, @kinetic/core). Absent = exercice seul.
   */
  group?: string;
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
  /** Séance faite en version allégée (« Forme basse ») : ignorée pour les charges de référence. */
  lightened?: boolean;
}
