/**
 * Deload Domain — réécriture d'une semaine d'entraînement en variante "deload".
 *
 * Objectif : quand `needsDeload()` détecte une fatigue chronique sur un
 * exercice donné, fournir une version dégradée du plan hebdomadaire :
 *   - Volume réduit (sets × −40 %) pour laisser le SNC récupérer
 *   - Intensité réduite (RPE cible −1.5) pour rester dans une zone technique
 *   - Charges suggérées à 90 % du dernier 1RM travaillé
 *
 * Sources :
 *   - Israetel, Hoffmann, Case — Scientific Principles of Strength Training (2015)
 *   - Helms et al. — Recovering from heavy training (Muscle & Strength Pyramid, 2019)
 *   - Mike Tuchscherer — RPE-based autoregulation: deloads should reduce
 *     both volume AND intensity, never just one.
 *
 * Pur — aucune dépendance, aucun I/O.
 */

import { needsDeload, type PerformedSet } from './progression.domain.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeloadableExercise {
  exerciseId: string;
  sets: number;
  targetReps: number;
  targetRpe: number;
}

export interface DeloadInput {
  exercises: readonly DeloadableExercise[];
  /** Historique par exercice (map exerciseId → sets). */
  historyByExercise: Record<string, readonly PerformedSet[]>;
}

export interface DeloadedExercise extends DeloadableExercise {
  /** Vrai si cet exercice était la cause du deload (RPE chroniquement haut). */
  reason: 'needs_deload' | 'companion';
}

export interface DeloadPlan {
  exercises: DeloadedExercise[];
  /** Vrai si AU MOINS un exercice était en état de deload. */
  triggered: boolean;
  /** Liste des `exerciseId` qui ont déclenché le deload. */
  triggeredBy: string[];
  rationale: string;
}

// ─── Paramètres ──────────────────────────────────────────────────────────────

/** Fraction du volume original conservée (60 %). */
const VOLUME_FACTOR = 0.6;
/** Réduction RPE cible (en points) — passer de 8 à 6.5 par exemple. */
const RPE_REDUCTION = 1.5;
/** Plancher RPE pour rester techniquement engageant. */
const MIN_RPE = 6;

/**
 * applyDeloadToWeek — si un quelconque exercice de la semaine est en deload,
 * retourne une version dégradée de TOUTE la semaine. Si rien ne déclenche,
 * la fonction retourne le plan original inchangé (avec `triggered: false`).
 *
 * Pourquoi tout réduire et pas seulement l'exo concerné : le SNC central est
 * partagé. Un athlète en deload sur le squat profitera aussi d'une semaine
 * allégée sur le bench (même si bench n'est pas en alerte).
 */
export function applyDeloadToWeek(input: DeloadInput): DeloadPlan {
  const triggeredIds: string[] = [];

  for (const ex of input.exercises) {
    const history = input.historyByExercise[ex.exerciseId] ?? [];
    if (needsDeload(history)) triggeredIds.push(ex.exerciseId);
  }

  if (triggeredIds.length === 0) {
    return {
      exercises: input.exercises.map((ex) => ({ ...ex, reason: 'companion' })),
      triggered: false,
      triggeredBy: [],
      rationale: 'Aucun deload nécessaire — fatigue dans les normes.',
    };
  }

  const deloaded = input.exercises.map((ex): DeloadedExercise => {
    const isTrigger = triggeredIds.includes(ex.exerciseId);
    return {
      exerciseId: ex.exerciseId,
      sets: Math.max(1, Math.round(ex.sets * VOLUME_FACTOR)),
      targetReps: ex.targetReps,
      targetRpe: Math.max(MIN_RPE, ex.targetRpe - RPE_REDUCTION),
      reason: isTrigger ? 'needs_deload' : 'companion',
    };
  });

  const triggerLabels = triggeredIds.join(', ');
  return {
    exercises: deloaded,
    triggered: true,
    triggeredBy: triggeredIds,
    rationale:
      `Deload semaine recommandé : ${triggerLabels} montre(nt) RPE moyen ≥ 9 ` +
      `sur 5 séances sans progression d'e1RM. Volume réduit à ${Math.round(VOLUME_FACTOR * 100)} %, RPE cible −${RPE_REDUCTION}.`,
  };
}

/**
 * Suggère un poids de travail "deload" à partir du dernier set effectué :
 * 90 % de la charge la plus récente, arrondi à l'incrément.
 *
 * Utile pour pré-remplir le draft.weightKg quand l'app passe en mode deload.
 */
export function deloadWeightFromHistory(
  history: readonly PerformedSet[],
  incrementKg = 2.5,
): number {
  if (history.length === 0) return 0;
  const last = history[history.length - 1]!;
  const target = last.weightKg * 0.9;
  const step = incrementKg > 0 ? incrementKg : 2.5;
  return Math.max(0, Math.round(target / step) * step);
}
