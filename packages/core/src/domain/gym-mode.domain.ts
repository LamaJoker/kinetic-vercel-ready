/**
 * « Mode salle » de la séance en cours : écran épuré, lisible téléphone posé au
 * sol. Logique d'état (vue affichée, exercice suivant, titres) indépendante
 * de l'interface. Pur, zéro I/O.
 */
import {
  formatSetShort,
  isTimedSet,
  isWarmupSet,
  workSetsOf,
  warmupSetsOf,
  type KindedSet,
  type LoadedSet,
  type TimedFields,
} from './workout-sets.domain.js';

/** Ce que montre le mode salle. */
export type GymView = 'empty' | 'rest' | 'reps' | 'time' | 'distance';

export interface GymViewInput {
  /** Un exercice est ouvert à la saisie. */
  hasEntry: boolean;
  restRemainingSec: number;
  measure: 'reps' | 'time' | 'distance';
}

/** Repos en cours → minuteur géant ; sinon la saisie de l'exercice selon sa mesure. */
export function gymView(input: GymViewInput): GymView {
  if (input.restRemainingSec > 0) return 'rest';
  if (!input.hasEntry) return 'empty';
  return input.measure;
}

interface GymEntry {
  exerciseId: string;
  sets: readonly KindedSet[];
}

/**
 * « Exercice suivant » : le prochain exercice de la séance encore sans série
 * de travail (en partant de l'exercice courant, en boucle) ; à défaut, le
 * suivant dans l'ordre. null s'il n'y a pas d'autre exercice.
 */
export function nextGymExercise(
  entries: readonly GymEntry[],
  currentId: string | null,
): string | null {
  if (entries.length < 2) return null;
  const at = Math.max(
    0,
    entries.findIndex((e) => e.exerciseId === currentId),
  );
  const ordered = [...entries.slice(at + 1), ...entries.slice(0, at)];
  const fresh = ordered.find((e) => workSetsOf(e.sets).length === 0);
  return (fresh ?? ordered[0])?.exerciseId ?? null;
}

/** « Série 3 · A1 », « Échauffement 2 » : ce que sera la prochaine série. */
export function gymSetTitle(sets: readonly KindedSet[], warmup: boolean, supersetTag = ''): string {
  const base = warmup
    ? `Échauffement ${warmupSetsOf(sets).length + 1}`
    : `Série ${workSetsOf(sets).length + 1}`;
  return supersetTag ? `${base} · ${supersetTag}` : base;
}

/** « Exercice 2/5 » (position dans la séance). */
export function gymProgressLabel(entries: readonly GymEntry[], currentId: string | null): string {
  const i = entries.findIndex((e) => e.exerciseId === currentId);
  return i < 0 ? '' : `Exercice ${i + 1}/${entries.length}`;
}

/**
 * « Dernière : 80 kg × 8 », « Dernière : 1:30 », « Dernière : 40 kg × 10
 * (échauffement) » : la dernière série faite de l'exercice. Vide avant la première.
 */
export function gymLastLabel(sets: readonly (LoadedSet & TimedFields)[]): string {
  const last = sets[sets.length - 1];
  if (!last) return '';
  const tag = isWarmupSet(last) ? ' (échauffement)' : '';
  if (isTimedSet(last)) return `Dernière : ${formatSetShort(last)}${tag}`;
  const kg = Math.round((Number(last.weightKg) || 0) * 100) / 100;
  const main = kg > 0 ? `${String(kg).replace('.', ',')} kg × ${last.reps}` : `${last.reps} reps`;
  return `Dernière : ${main}${tag}`;
}

/** Réglage mémorisé (localStorage) : '1' = mode salle actif. */
export function parseGymModePref(raw: string | null | undefined): boolean {
  return raw === '1';
}
