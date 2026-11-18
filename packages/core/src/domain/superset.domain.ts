/**
 * Supersets / circuits : 2 ou 3 exercices consécutifs d'une séance (ou d'un
 * modèle) enchaînés sans repos, le repos ne venant qu'à la fin du tour.
 *
 * Stockage : un champ optionnel `group` (identifiant court, ex. « ss1 ») sur
 * chaque exercice lié. Absent = exercice seul : les séances, modèles, exports et
 * données synchronisées d'avant restent valables tels quels.
 *
 * Un groupe n'est valable que si ses membres se suivent et sont 2 ou 3 :
 * `normalizeSupersets` retire le champ des exercices qui ne remplissent plus ces
 * conditions (exercice retiré, déplacé, séance réimportée…). Pur, zéro I/O.
 */
import { workSetsOf, type KindedSet } from './workout-sets.domain.js';

export interface Groupable {
  exerciseId: string;
  group?: string | undefined;
}

/** Taille maximale d'un superset (au-delà, un circuit devient illisible à l'écran). */
export const SUPERSET_MAX = 3;

export interface SupersetBlock<T extends Groupable = Groupable> {
  /** Identifiant du groupe, ou null pour un exercice seul. */
  group: string | null;
  /** Lettre affichée (A, B, C…) ; vide pour un exercice seul. */
  letter: string;
  /** Position du premier exercice du bloc dans la liste. */
  start: number;
  items: T[];
}

function withoutGroup<T extends Groupable>(item: T): T {
  if (item.group === undefined) return item;
  const copy = { ...item };
  delete copy.group;
  return copy;
}

function validGroup(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 40;
}

/**
 * Retire le groupe des exercices isolés, des membres au-delà du 3e et des
 * groupes qui réapparaissent plus loin (membres non consécutifs). Les objets
 * inchangés sont conservés tels quels.
 */
export function normalizeSupersets<T extends Groupable>(items: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < items.length) {
    const g = items[i]!.group;
    if (!validGroup(g)) {
      out.push(withoutGroup(items[i]!));
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && items[j]!.group === g) j++;
    const run = items.slice(i, j);
    const keep = !seen.has(g) && run.length >= 2;
    seen.add(g);
    run.forEach((item, k) => out.push(keep && k < SUPERSET_MAX ? item : withoutGroup(item)));
    i = j;
  }
  return out;
}

/** Lettre d'un bloc : A…Z, puis AA, AB… (jamais atteint en pratique). */
function letterAt(n: number): string {
  const A = 65;
  return n < 26
    ? String.fromCharCode(A + n)
    : String.fromCharCode(A + Math.floor(n / 26) - 1) + String.fromCharCode(A + (n % 26));
}

/** Découpe la liste en blocs : chaque superset forme un bloc, chaque exercice seul aussi. */
export function supersetBlocks<T extends Groupable>(items: readonly T[]): SupersetBlock<T>[] {
  const list = normalizeSupersets(items);
  const blocks: SupersetBlock<T>[] = [];
  let letters = 0;
  let i = 0;
  while (i < list.length) {
    const g = list[i]!.group;
    if (!g) {
      blocks.push({ group: null, letter: '', start: i, items: [list[i]!] });
      i++;
      continue;
    }
    let j = i;
    while (j < list.length && list[j]!.group === g) j++;
    blocks.push({ group: g, letter: letterAt(letters++), start: i, items: list.slice(i, j) });
    i = j;
  }
  return blocks;
}

/** « A1 », « A2 », « B1 »… ; vide si l'exercice n'est pas dans un superset. */
export function supersetLabel(items: readonly Groupable[], exerciseId: string): string {
  for (const b of supersetBlocks(items)) {
    if (!b.group) continue;
    const k = b.items.findIndex((x) => x.exerciseId === exerciseId);
    if (k >= 0) return `${b.letter}${k + 1}`;
  }
  return '';
}

function blockAt<T extends Groupable>(
  items: readonly T[],
  index: number,
): SupersetBlock<T> | undefined {
  return supersetBlocks(items).find((b) => index >= b.start && index < b.start + b.items.length);
}

/** Identifiant libre : ss1, ss2… */
export function newSupersetId(items: readonly Groupable[]): string {
  const used = new Set(items.map((x) => x.group));
  let n = 1;
  while (used.has(`ss${n}`)) n++;
  return `ss${n}`;
}

/** Vrai si l'exercice `index` peut être lié au suivant (blocs différents, 3 exercices au plus). */
export function canLinkWithNext(items: readonly Groupable[], index: number): boolean {
  if (index < 0 || index + 1 >= items.length) return false;
  const a = blockAt(items, index);
  const b = blockAt(items, index + 1);
  if (!a || !b || a === b || a.start === b.start) return false;
  return a.items.length + b.items.length <= SUPERSET_MAX;
}

/**
 * Lie l'exercice `index` au suivant : leurs blocs (exercice seul ou superset
 * existant) fusionnent en un seul superset. Liste inchangée si impossible.
 */
export function linkWithNext<T extends Groupable>(items: readonly T[], index: number): T[] {
  const list = normalizeSupersets(items);
  if (!canLinkWithNext(list, index)) return list;
  const a = blockAt(list, index)!;
  const b = blockAt(list, index + 1)!;
  const id = a.group ?? b.group ?? newSupersetId(list);
  const from = a.start;
  const to = b.start + b.items.length;
  return list.map((x, i) => (i >= from && i < to ? { ...x, group: id } : x));
}

/** Délie tout le superset qui contient l'exercice `index` (chaque exercice redevient seul). */
export function unlinkSuperset<T extends Groupable>(items: readonly T[], index: number): T[] {
  const list = normalizeSupersets(items);
  const block = blockAt(list, index);
  if (!block?.group) return list;
  const end = block.start + block.items.length;
  return list.map((x, i) => (i >= block.start && i < end ? withoutGroup(x) : x));
}

/** Position d'un exercice par son id (−1 si absent). */
export function indexOfExercise(items: readonly Groupable[], exerciseId: string): number {
  return items.findIndex((x) => x.exerciseId === exerciseId);
}

export interface SupersetStep {
  /** Exercice sur lequel ouvrir la saisie, ou null (exercice seul : on reste dessus). */
  nextExerciseId: string | null;
  /** Vrai s'il faut lancer le repos (fin du tour, ou exercice seul). */
  rest: boolean;
}

/**
 * Après une série de travail sur `exerciseId` : dans un superset, la saisie passe
 * au membre suivant qui n'a pas encore fait ce tour, sans repos ; quand tous les
 * membres ont fait le tour, le repos se lance et la saisie revient au premier.
 * Les échauffements ne comptent pas dans les tours.
 */
export function supersetNextStep(
  entries: ReadonlyArray<Groupable & { sets: readonly KindedSet[] }>,
  exerciseId: string,
): SupersetStep {
  const index = indexOfExercise(entries, exerciseId);
  const block = index >= 0 ? blockAt(entries, index) : undefined;
  if (!block?.group) return { nextExerciseId: null, rest: true };
  const members = block.items;
  const k = index - block.start;
  const done = workSetsOf(members[k]!.sets).length;
  for (let step = 1; step < members.length; step++) {
    const m = members[(k + step) % members.length]!;
    if (workSetsOf(m.sets).length < done) return { nextExerciseId: m.exerciseId, rest: false };
  }
  return { nextExerciseId: members[0]!.exerciseId, rest: true };
}
