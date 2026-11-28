/**
 * Journaux datés du corps (pesées, mensurations) : saisie à une date choisie, y compris
 * passée, sans toucher aux autres jours. Les dates sont des jours LOCAUX « AAAA-MM-JJ ».
 *
 * Module pur : la date du jour est toujours passée par l'appelant.
 */

/** Date la plus ancienne acceptée pour une saisie. */
export const MIN_LOG_DATE = '2000-01-01';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Jour LOCAL « AAAA-MM-JJ » de `d` (et non le jour UTC de `toISOString()`). */
export function localIsoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `Date` à minuit LOCAL du jour « AAAA-MM-JJ » (`null` si la chaîne n'est pas un jour valide). */
export function localDayDate(iso: string): Date | null {
  const m = DAY_RE.exec(iso);
  if (!m) return null;
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!);
  return d.getFullYear() === +m[1]! && d.getMonth() === +m[2]! - 1 && d.getDate() === +m[3]!
    ? d
    : null;
}

/**
 * Contrôle d'une date de saisie : message d'erreur en français, ou `null` si elle est
 * acceptée (jour valide, entre MIN_LOG_DATE et `today` inclus).
 */
export function logDateError(date: string, today: string): string | null {
  if (!localDayDate(date)) return 'Choisis une date valide.';
  if (date > today) return 'La date ne peut pas être dans le futur.';
  if (date < MIN_LOG_DATE) return 'La date doit être postérieure au 1er janvier 2000.';
  return null;
}

/** Copie triée par date croissante (tri stable : l'ordre est gardé à date égale). */
export function sortByDate<T extends { date: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Insère `entry` à sa place chronologique. Seules les entrées pour lesquelles `replaces`
 * renvoie vrai sont retirées (par défaut : celles du même jour) ; les autres jours,
 * antérieurs comme postérieurs, restent intacts.
 */
export function placeByDate<T extends { date: string }>(
  list: readonly T[],
  entry: T,
  replaces: (e: T) => boolean = (e) => e.date === entry.date,
): T[] {
  return sortByDate([...list.filter((e) => !replaces(e)), entry]);
}

/** Entrée la plus RÉCENTE par date (pas la dernière saisie) ; à date égale, la dernière du tableau. */
export function latestByDate<T extends { date: string }>(
  list: readonly T[] | null | undefined,
): T | null {
  let best: T | null = null;
  for (const e of list ?? []) {
    if (e && typeof e.date === 'string' && (!best || e.date >= best.date)) best = e;
  }
  return best;
}

/**
 * Poids actuel (kg) d'une liste de pesées lue du stockage : la pesée valide la plus récente
 * par date, `null` sans pesée exploitable. Une saisie dans le passé ne le fait pas reculer.
 */
export function currentBodyweightKg(entries: unknown): number | null {
  if (!Array.isArray(entries)) return null;
  const valid = entries.filter(
    (e): e is { date: string; weight: number } =>
      !!e &&
      typeof (e as { date?: unknown }).date === 'string' &&
      Number.isFinite(Number((e as { weight?: unknown }).weight)) &&
      Number((e as { weight?: unknown }).weight) > 0,
  );
  const last = latestByDate(valid);
  return last ? Number(last.weight) : null;
}
