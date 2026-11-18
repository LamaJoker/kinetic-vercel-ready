/**
 * Éditeur de modèles de séance et exercices personnalisés — logique pure.
 * L'interface (apps/web/src/pages/template-editor.page.ts) ne fait qu'appeler ces fonctions.
 */

export interface TemplateLine {
  exerciseId: string;
  sets: number;
  targetReps: number;
  targetRpe: number;
}

export const TEMPLATE_LINE_DEFAULTS: Readonly<Omit<TemplateLine, 'exerciseId'>> = {
  sets: 3,
  targetReps: 10,
  targetRpe: 8,
};

const NAME_MAX = 60;

function clamp(value: unknown, min: number, max: number, fallback: number, step = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n / step) * step));
}

/** Nom nettoyé : espaces superflus retirés, 60 caractères au plus. */
export function cleanLabel(name: string): string {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

/** Séries 1-10, répétitions 1-50, RPE 5-10 par demi-point. */
export function clampTemplateLine(line: TemplateLine): TemplateLine {
  const d = TEMPLATE_LINE_DEFAULTS;
  return {
    exerciseId: line.exerciseId,
    sets: clamp(line.sets, 1, 10, d.sets),
    targetReps: clamp(line.targetReps, 1, 50, d.targetReps),
    targetRpe: clamp(line.targetRpe, 5, 10, d.targetRpe, 0.5),
  };
}

/** Déplace l'élément `index` de `delta` cases (copie ; inchangé si hors bornes). */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const out = [...list];
  const to = index + delta;
  if (index < 0 || index >= out.length || to < 0 || to >= out.length) return out;
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item as T);
  return out;
}

/** Ajoute un exercice en fin de modèle (ignoré s'il y figure déjà : une ligne par exercice). */
export function addTemplateLine(
  lines: readonly TemplateLine[],
  exerciseId: string,
): TemplateLine[] {
  if (!exerciseId || lines.some((l) => l.exerciseId === exerciseId)) return [...lines];
  return [...lines, { exerciseId, ...TEMPLATE_LINE_DEFAULTS }];
}

/** Message d'erreur (français) ou null si le modèle peut être enregistré. */
export function validateTemplateDraft(name: string, lines: readonly TemplateLine[]): string | null {
  if (!cleanLabel(name)) return 'Donne un nom au modèle.';
  if (lines.length === 0) return 'Ajoute au moins un exercice.';
  return null;
}

// ─── Exercices personnalisés ────────────────────────────────────────────────

export type ExerciseEquipment =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'bodyweight'
  | 'cable'
  | 'other';

export interface CustomExerciseInput {
  name: string;
  muscles: readonly string[];
  equipment: ExerciseEquipment;
  incrementKg: number;
}

export interface LabeledOption {
  key: string;
  label: string;
}

/** Groupes musculaires du catalogue (clés stockées) et leur libellé. */
export const MUSCLE_OPTIONS: readonly LabeledOption[] = [
  { key: 'chest', label: 'Pectoraux' },
  { key: 'back', label: 'Dos' },
  { key: 'shoulders', label: 'Épaules' },
  { key: 'rear_delts', label: 'Arrière d’épaule' },
  { key: 'biceps', label: 'Biceps' },
  { key: 'triceps', label: 'Triceps' },
  { key: 'forearms', label: 'Avant-bras' },
  { key: 'traps', label: 'Trapèzes' },
  { key: 'quads', label: 'Quadriceps' },
  { key: 'hamstrings', label: 'Ischios' },
  { key: 'glutes', label: 'Fessiers' },
  { key: 'calves', label: 'Mollets' },
  { key: 'adductors', label: 'Adducteurs' },
  { key: 'core', label: 'Abdos' },
  { key: 'lower_back', label: 'Lombaires' },
  { key: 'full_body', label: 'Corps entier' },
  { key: 'conditioning', label: 'Cardio' },
];

export const EQUIPMENT_OPTIONS: readonly LabeledOption[] = [
  { key: 'barbell', label: 'Barre' },
  { key: 'dumbbell', label: 'Haltères' },
  { key: 'machine', label: 'Machine' },
  { key: 'cable', label: 'Poulie' },
  { key: 'bodyweight', label: 'Poids du corps' },
  { key: 'other', label: 'Autre' },
];

function fold(s: string): string {
  return cleanLabel(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Normalise la saisie (nom, muscles connus, matériel, incrément 0,25-50 kg). */
export function normalizeCustomExercise(input: CustomExerciseInput): CustomExerciseInput {
  const known = new Set(MUSCLE_OPTIONS.map((m) => m.key));
  const equipment = EQUIPMENT_OPTIONS.some((e) => e.key === input.equipment)
    ? input.equipment
    : 'other';
  return {
    name: cleanLabel(input.name),
    muscles: [...new Set(input.muscles)].filter((m) => known.has(m)),
    equipment,
    incrementKg: clamp(input.incrementKg, 0.25, 50, 2.5, 0.25),
  };
}

/**
 * Message d'erreur ou null. `otherNames` : noms des autres exercices (doublon refusé,
 * sans tenir compte de la casse ni des accents).
 */
export function validateCustomExercise(
  input: CustomExerciseInput,
  otherNames: readonly string[],
): string | null {
  const name = fold(input.name);
  if (!name) return 'Donne un nom à l’exercice.';
  if (otherNames.some((n) => fold(n) === name)) return 'Un exercice porte déjà ce nom.';
  if (input.muscles.length === 0) return 'Choisis au moins un groupe musculaire.';
  const inc = Number(input.incrementKg);
  if (!Number.isFinite(inc) || inc <= 0 || inc > 50) return 'Incrément de charge invalide.';
  return null;
}

/** Identifiant stable et unique : `custom-<nom-simplifié>[-n]`. */
export function customExerciseId(name: string, existingIds: readonly string[]): string {
  const slug =
    fold(name)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'exercice';
  const taken = new Set(existingIds);
  let id = `custom-${slug}`;
  for (let n = 2; taken.has(id); n++) id = `custom-${slug}-${n}`;
  return id;
}

interface WithEntries {
  entries: readonly { exerciseId: string }[];
}
interface WithExercises {
  exercises: readonly { exerciseId: string }[];
}

/** Vrai si l'exercice apparaît dans une séance (historique ou en cours) ou un modèle. */
export function isExerciseInUse(
  id: string,
  sessions: readonly WithEntries[],
  templates: readonly WithExercises[],
): boolean {
  return (
    sessions.some((s) => s.entries.some((e) => e.exerciseId === id)) ||
    templates.some((t) => t.exercises.some((e) => e.exerciseId === id))
  );
}

/** Catalogue + exercices perso (un exercice perso remplace l'entrée de même id). */
export function mergeExerciseLists<T extends { id: string }>(
  catalog: readonly T[],
  custom: readonly T[],
): T[] {
  const byId = new Map(custom.map((c) => [c.id, c]));
  const merged = catalog.map((c) => byId.get(c.id) ?? c);
  const seen = new Set(catalog.map((c) => c.id));
  for (const c of custom) if (!seen.has(c.id)) merged.push(c);
  return merged;
}

/** Recherche (sans casse ni accents) parmi les exercices visibles, `limit` résultats au plus. */
export function searchExercises<T extends { id: string; name: string; hidden?: boolean }>(
  list: readonly T[],
  query: string,
  excludeIds: readonly string[] = [],
  limit = 40,
): T[] {
  const q = fold(query);
  const skip = new Set(excludeIds);
  const out: T[] = [];
  for (const e of list) {
    if (out.length >= limit) break;
    if (e.hidden || skip.has(e.id)) continue;
    if (!q || fold(e.name).includes(q)) out.push(e);
  }
  return out;
}

/** Remplace l'exercice de même id, ou l'ajoute. */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const out = [...list];
  out[i] = item;
  return out;
}
