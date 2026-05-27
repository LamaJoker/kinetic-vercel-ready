/**
 * Exercise Substitution — propose des alternatives quand l'équipement manque,
 * qu'on est blessé, ou qu'on veut varier le stimulus.
 *
 * Stratégie : score chaque candidat par recouvrement musculaire avec
 * l'exercice cible, pondéré par la similarité de l'équipement requis.
 *
 * Pur — aucune dépendance, aucun I/O.
 */

export interface ExerciseLike {
  id: string;
  name: string;
  muscles: readonly string[];
  /** Liste de mots-clés équipement : "barbell" | "dumbbell" | "cable" | etc. */
  equipment?: readonly string[];
  /** Pattern moteur de référence (push, pull, hinge, squat, lunge, carry, core). */
  pattern?: string;
}

export interface SubstitutionInput {
  /** Exercice à remplacer. */
  target: ExerciseLike;
  /** Catalogue de candidats (typiquement les exercices du catalogue Kinetic). */
  candidates: readonly ExerciseLike[];
  /**
   * Équipement disponible. Si fourni et non-vide, on filtre : seuls les
   * candidats dont l'équipement est inclus dans cette liste sont considérés.
   */
  availableEquipment?: readonly string[];
  /**
   * Muscles à éviter (blessure). Tout candidat qui sollicite l'un de ces
   * muscles est exclu, même partiellement.
   */
  avoidMuscles?: readonly string[];
  /** Max de suggestions retournées (défaut 3). */
  limit?: number;
}

export interface SubstitutionResult {
  exercise: ExerciseLike;
  score: number; // 0–1
  rationale: string;
}

/**
 * suggestSubstitutions — retourne les meilleurs candidats triés par score.
 *
 * Scoring (somme pondérée) :
 *   - Recouvrement musculaire (Jaccard primaire) : 0.7
 *   - Bonus si même pattern moteur                : 0.2
 *   - Bonus si équipement identique               : 0.1
 *
 * Le candidat-cible lui-même est toujours exclu de la sortie.
 */
export function suggestSubstitutions(input: SubstitutionInput): SubstitutionResult[] {
  const { target, candidates, availableEquipment, avoidMuscles, limit = 3 } = input;

  const targetMuscles = new Set(target.muscles);
  const targetEquipment = new Set(target.equipment ?? []);
  const avoid = new Set(avoidMuscles ?? []);
  const available =
    availableEquipment && availableEquipment.length > 0 ? new Set(availableEquipment) : null;

  const scored: SubstitutionResult[] = [];

  for (const c of candidates) {
    if (c.id === target.id) continue;

    // Filtre équipement (disponibilité)
    if (available && c.equipment && c.equipment.length > 0) {
      const hasAccess = c.equipment.every((eq) => available.has(eq));
      if (!hasAccess) continue;
    }

    // Exclusion zone interdite (blessure)
    if (avoid.size > 0 && c.muscles.some((m) => avoid.has(m))) continue;

    const candidateMuscles = new Set(c.muscles);
    const jaccard = jaccardIndex(targetMuscles, candidateMuscles);
    if (jaccard === 0) continue; // pas de recouvrement = non substituable

    const patternBonus = target.pattern && c.pattern && target.pattern === c.pattern ? 0.2 : 0;
    const equipBonus = c.equipment && c.equipment.some((eq) => targetEquipment.has(eq)) ? 0.1 : 0;

    const score = Math.min(1, jaccard * 0.7 + patternBonus + equipBonus);

    scored.push({
      exercise: c,
      score: Math.round(score * 100) / 100,
      rationale: buildRationale(target, c, jaccard, patternBonus > 0, equipBonus > 0),
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function jaccardIndex<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildRationale(
  target: ExerciseLike,
  _candidate: ExerciseLike,
  jaccard: number,
  samePattern: boolean,
  sameEquipment: boolean,
): string {
  const bits: string[] = [];
  const overlapPct = Math.round(jaccard * 100);
  bits.push(`${overlapPct} % muscles communs`);
  if (samePattern) bits.push('même pattern moteur');
  if (sameEquipment) bits.push('équipement identique');
  return `Remplace "${target.name}" : ${bits.join(' · ')}.`;
}
