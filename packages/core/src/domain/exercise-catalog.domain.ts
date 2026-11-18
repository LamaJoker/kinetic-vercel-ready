/**
 * Exercise Catalog Domain — mise à jour du catalogue d'exercices déjà stocké.
 *
 * Le catalogue (exercises.v1.json) est copié dans le stockage au premier lancement.
 * Quand sa version change, on fusionne par id : les ajouts et corrections du
 * catalogue sont appliqués, tout le reste est conservé (exercices perso ou importés,
 * préférences posées sur un exercice comme `hidden`).
 *
 * Pur — aucune dépendance externe, aucun I/O.
 */

/**
 * Version du catalogue livré avec l'app. À incrémenter à chaque modification
 * de apps/web/public/exercises.v1.json (ajout, renommage, correction).
 */
export const EXERCISE_CATALOG_VERSION = 2;

/** Vrai si le catalogue stocké (version `stored`, absente = ancien format) doit être mis à jour. */
export function needsCatalogUpdate(stored: unknown): boolean {
  return typeof stored !== 'number' || stored < EXERCISE_CATALOG_VERSION;
}

/**
 * mergeCatalog — applique le catalogue `fresh` sur la liste `stored`.
 * Ordre : celui du catalogue, puis les exercices absents du catalogue dans leur ordre.
 * Pour un même id, les champs du catalogue l'emportent ; les champs propres à
 * l'utilisateur (absents du catalogue) sont gardés. Un exercice perso (custom) n'est
 * jamais écrasé.
 */
export function mergeCatalog<T extends { id: string; custom?: boolean }>(
  stored: readonly T[],
  fresh: readonly T[],
): T[] {
  const byId = new Map(stored.map((e) => [e.id, e]));
  const freshIds = new Set<string>();
  const merged: T[] = [];
  for (const f of fresh) {
    if (freshIds.has(f.id)) continue;
    freshIds.add(f.id);
    const old = byId.get(f.id);
    merged.push(old?.custom ? old : { ...old, ...f });
  }
  for (const e of stored) if (!freshIds.has(e.id)) merged.push(e);
  return merged;
}
