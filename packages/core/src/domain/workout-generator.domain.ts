/**
 * Workout Generator — construit une séance prête à l'emploi à partir d'un
 * objectif (force / hypertrophie / endurance) et d'un focus musculaire.
 *
 * Pur, sans I/O. L'appelant fournit le catalogue d'exercices, le générateur
 * choisit les meilleurs (compound first, puis isolation) et fixe les
 * schémas de sets/reps/RPE adaptés à l'objectif.
 *
 * Sources de paramétrage :
 *   - Schoenfeld (2017) — fréquence 2×/semaine par groupe musculaire optimale
 *   - Helms et al. (2018) — schémas reps/RPE par objectif
 *   - Prilepin (1974) — volume par intensité pour la force
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type WorkoutGoal = 'force' | 'hypertrophie' | 'endurance';

export type WorkoutFocus =
  | 'push' // Pecs, épaules, triceps
  | 'pull' // Dos, biceps
  | 'legs' // Jambes complètes
  | 'upper' // Haut du corps complet
  | 'lower' // Bas du corps complet
  | 'full'; // Full body

export interface GeneratorExercise {
  id: string;
  name: string;
  muscles: readonly string[];
  equipment: string;
}

export interface GeneratedExercise {
  exerciseId: string;
  sets: number;
  targetReps: number;
  targetRpe: number;
}

export interface GenerateWorkoutInput {
  goal: WorkoutGoal;
  focus: WorkoutFocus;
  exercises: readonly GeneratorExercise[];
  /** Nombre d'exercices visés (défaut: 5). */
  exerciseCount?: number;
}

export interface GeneratedWorkout {
  name: string;
  goal: WorkoutGoal;
  focus: WorkoutFocus;
  exercises: readonly GeneratedExercise[];
}

// ─── Schémas par objectif ────────────────────────────────────────────────────

interface GoalScheme {
  compoundSets: number;
  compoundReps: number;
  isolationSets: number;
  isolationReps: number;
  targetRpe: number;
}

const SCHEMES: Record<WorkoutGoal, GoalScheme> = {
  force: {
    compoundSets: 5,
    compoundReps: 4,
    isolationSets: 3,
    isolationReps: 6,
    targetRpe: 8.5,
  },
  hypertrophie: {
    compoundSets: 4,
    compoundReps: 8,
    isolationSets: 3,
    isolationReps: 12,
    targetRpe: 8,
  },
  endurance: {
    compoundSets: 3,
    compoundReps: 15,
    isolationSets: 3,
    isolationReps: 20,
    targetRpe: 7,
  },
};

// ─── Catalogue de muscles par focus ──────────────────────────────────────────

/**
 * Les noms utilisés ici correspondent aux conventions du seed.ts
 * (chest, back, quads, hamstrings, glutes, shoulders, triceps, biceps,
 *  posterior, calves, core).
 */
const FOCUS_MUSCLES: Record<WorkoutFocus, readonly string[]> = {
  push: ['chest', 'shoulders', 'triceps'],
  pull: ['back', 'biceps', 'rear_delts', 'upper_back', 'traps'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves', 'posterior'],
  upper: ['chest', 'back', 'shoulders', 'triceps', 'biceps', 'upper_back', 'traps'],
  lower: ['quads', 'hamstrings', 'glutes', 'calves', 'posterior'],
  full: [], // signifie "tous" — l'algo sélectionne 1 par grand groupe
};

const FOCUS_LABEL: Record<WorkoutFocus, string> = {
  push: 'Push',
  pull: 'Pull',
  legs: 'Jambes',
  upper: 'Haut du corps',
  lower: 'Bas du corps',
  full: 'Full body',
};

// ─── Heuristiques de scoring ─────────────────────────────────────────────────

/**
 * isCompound — un mouvement est "composé" s'il sollicite ≥ 2 muscles distincts
 * incluant au moins 1 groupe majeur (chest/back/quads/hams/shoulders/posterior).
 * Bench (chest+triceps), Row (back+biceps), Squat (quads+glutes) → compound.
 * Curls (biceps seul), Calf raise (calves seul) → isolation.
 */
export function isCompound(muscles: readonly string[]): boolean {
  if (muscles.length < 2) {
    // Polyarticulaires marqués explicitement (deadlift = ['posterior'], clean…)
    return muscles.includes('full_body') || muscles.includes('posterior');
  }
  const majorGroups = new Set(['chest', 'back', 'quads', 'hamstrings', 'shoulders', 'posterior']);
  for (const m of muscles) {
    if (majorGroups.has(m)) return true;
  }
  return muscles.includes('full_body');
}

/**
 * scoreExercise — score de pertinence d'un exercice pour un focus donné.
 * Plus le score est haut, plus l'exercice doit apparaître tôt dans la séance.
 *   +10 par muscle ciblé matchant le focus
 *   +5 si compound
 *   +3 si équipement barbell (charges progressives faciles)
 */
export function scoreExercise(ex: GeneratorExercise, focusMuscles: readonly string[]): number {
  let score = 0;
  if (focusMuscles.length === 0) {
    // full body : score = nombre de muscles travaillés (favorise les compounds)
    score += ex.muscles.length * 4;
  } else {
    for (const m of ex.muscles) {
      if (focusMuscles.includes(m)) score += 10;
    }
  }
  if (score === 0) return 0; // l'exercice ne touche aucun muscle ciblé → exclu
  if (isCompound(ex.muscles)) score += 5;
  if (ex.equipment === 'barbell') score += 3;
  return score;
}

// ─── Génération ──────────────────────────────────────────────────────────────

/**
 * generateWorkout — sélectionne ~5 exercices pertinents et applique le schéma
 * de sets/reps/RPE adapté à l'objectif. Compound first.
 *
 * Algorithme :
 *   1. Score chaque exercice (filtre les non-pertinents).
 *   2. Tri par score décroissant.
 *   3. Pour le full body, force la diversité musculaire (max 2 exercices par
 *      groupe principal pour éviter "5 squats variations").
 *   4. Applique le schéma : compound → schéma compound, sinon isolation.
 */
export function generateWorkout(input: GenerateWorkoutInput): GeneratedWorkout {
  const { goal, focus, exercises, exerciseCount = 5 } = input;
  const scheme = SCHEMES[goal];
  const focusMuscles = FOCUS_MUSCLES[focus];

  const scored = exercises
    .map((ex) => ({ ex, score: scoreExercise(ex, focusMuscles) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Diversité musculaire : éviter les triplons sur le même muscle principal.
  const picks: GeneratorExercise[] = [];
  const musclePrimaryCount = new Map<string, number>();
  const MAX_PER_PRIMARY = focus === 'full' ? 1 : 2;

  for (const { ex } of scored) {
    if (picks.length >= exerciseCount) break;
    const primary = ex.muscles[0] ?? 'other';
    const cur = musclePrimaryCount.get(primary) ?? 0;
    if (cur >= MAX_PER_PRIMARY) continue;
    picks.push(ex);
    musclePrimaryCount.set(primary, cur + 1);
  }

  // Fallback : si pas assez d'exercices après filtre diversité, compléter
  // dans l'ordre de score initial.
  if (picks.length < exerciseCount) {
    for (const { ex } of scored) {
      if (picks.length >= exerciseCount) break;
      if (!picks.includes(ex)) picks.push(ex);
    }
  }

  const generated: GeneratedExercise[] = picks.map((ex) => {
    const compound = isCompound(ex.muscles);
    return {
      exerciseId: ex.id,
      sets: compound ? scheme.compoundSets : scheme.isolationSets,
      targetReps: compound ? scheme.compoundReps : scheme.isolationReps,
      targetRpe: scheme.targetRpe,
    };
  });

  return {
    name: `${FOCUS_LABEL[focus]} · ${goalLabel(goal)}`,
    goal,
    focus,
    exercises: generated,
  };
}

function goalLabel(goal: WorkoutGoal): string {
  return goal === 'force' ? 'Force' : goal === 'hypertrophie' ? 'Hypertrophie' : 'Endurance';
}
