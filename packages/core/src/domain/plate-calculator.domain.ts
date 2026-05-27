/**
 * Plate Calculator — calcule la combinaison de disques à charger sur une barre
 * pour atteindre une charge cible, en utilisant les disques disponibles.
 *
 * Pur, zéro I/O. Algorithme glouton décroissant : on commence par le plus
 * gros disque qui rentre encore, on l'empile, on recommence — c'est optimal
 * pour un set de plates standardisé (toutes les puissances de 2 / 5).
 *
 * Cas particuliers gérés :
 *   - Cible < poids de la barre → on signale qu'il faut une barre plus légère
 *     (ou descendre la cible).
 *   - Cible non atteignable exactement avec les plates dispos → on charge au
 *     plus près en dessous et on retourne le delta non chargé.
 *   - Plates impaires gérées (1.25 kg, 0.5 kg).
 *
 * Note : par convention, on calcule pour UN côté de la barre (l'autre côté
 * est miroir). C'est la convention utilisée par Strong, Hevy, FitBod.
 */

// ─── Sets de plates par défaut (gym standard) ────────────────────────────────

/**
 * Plates métriques disponibles dans 95% des salles européennes.
 * Bumpers olympiques 20/15/10/5 + fractionnels 2.5/1.25/0.5.
 */
export const DEFAULT_PLATES_METRIC: readonly number[] = [25, 20, 15, 10, 5, 2.5, 1.25, 0.5];

/** Plates impériales (lbs) pour conversion future. */
export const DEFAULT_PLATES_IMPERIAL: readonly number[] = [45, 35, 25, 10, 5, 2.5];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlateLoad {
  /** Disque par valeur (ex: 20 kg). */
  plateKg: number;
  /** Nombre de disques de cette valeur, par côté. */
  count: number;
}

export interface CalculatePlatesInput {
  /** Charge totale visée (barre + tous les disques, deux côtés). */
  targetKg: number;
  /** Poids de la barre seule (20 kg olympique, 15 kg féminin, 7-12 kg EZ-bar). */
  barKg: number;
  /** Disques disponibles, en kg. Si vide, on utilise DEFAULT_PLATES_METRIC. */
  availablePlates?: readonly number[];
}

export interface PlateCalculation {
  /** Disques à charger par côté (du plus gros au plus petit). */
  perSide: readonly PlateLoad[];
  /** Charge totale réellement obtenue (peut être < targetKg si pas exact). */
  achievedKg: number;
  /** Différence entre targetKg et achievedKg. 0 si parfait, > 0 si on n'a pas pu charger assez. */
  deltaKg: number;
  /** True si la barre seule est déjà trop lourde pour la cible. */
  underBar: boolean;
  /** True si la cible n'est pas atteignable exactement (deltaKg > 0). */
  inexact: boolean;
}

// ─── Algorithme ──────────────────────────────────────────────────────────────

/**
 * calculatePlates — glouton décroissant.
 *
 * Pourquoi glouton et non programmation dynamique :
 *   Les sets de plates standard ont la propriété que chaque plate vaut
 *   exactement 2× ou 2.5× la plate juste en dessous. Dans ce cas, le glouton
 *   atteint toujours l'optimum (preuve : par récurrence sur la valeur). Pour
 *   des sets exotiques, le glouton peut être sous-optimal — mais on
 *   ne ciblera jamais que des combinaisons rondes à 0.25 kg près en pratique.
 */
export function calculatePlates(input: CalculatePlatesInput): PlateCalculation {
  const { targetKg, barKg } = input;
  const available = (input.availablePlates ?? DEFAULT_PLATES_METRIC)
    .filter((p) => Number.isFinite(p) && p > 0)
    .slice()
    .sort((a, b) => b - a);

  if (!Number.isFinite(targetKg) || targetKg < 0 || !Number.isFinite(barKg) || barKg < 0) {
    return {
      perSide: [],
      achievedKg: 0,
      deltaKg: targetKg,
      underBar: true,
      inexact: true,
    };
  }

  // Charge nette demandée (hors barre)
  const netKg = targetKg - barKg;
  if (netKg <= 0) {
    // La barre seule est déjà ≥ targetKg
    return {
      perSide: [],
      achievedKg: barKg,
      deltaKg: barKg - targetKg,
      underBar: netKg < 0,
      inexact: barKg !== targetKg,
    };
  }

  // Charge par côté (deux côtés miroir)
  let remainingPerSide = netKg / 2;
  const epsilon = 0.001; // tolérance flottante
  const perSide: PlateLoad[] = [];

  for (const plate of available) {
    if (plate > remainingPerSide + epsilon) continue;
    const count = Math.floor((remainingPerSide + epsilon) / plate);
    if (count > 0) {
      perSide.push({ plateKg: plate, count });
      remainingPerSide -= count * plate;
      if (remainingPerSide < epsilon) break;
    }
  }

  const loadedPerSide = perSide.reduce((sum, p) => sum + p.plateKg * p.count, 0);
  const achievedKg = barKg + loadedPerSide * 2;
  const deltaKg = Math.round((targetKg - achievedKg) * 100) / 100;

  return {
    perSide,
    achievedKg: Math.round(achievedKg * 100) / 100,
    deltaKg,
    underBar: false,
    inexact: Math.abs(deltaKg) > epsilon,
  };
}

/**
 * formatPlateLoad — version texte pour partage / affichage compact.
 *   formatPlateLoad([{plateKg:20,count:2}, {plateKg:5,count:1}]) → "20×2, 5×1"
 */
export function formatPlateLoad(perSide: readonly PlateLoad[]): string {
  if (perSide.length === 0) return 'barre seule';
  return perSide.map((p) => `${p.plateKg}×${p.count}`).join(', ');
}
