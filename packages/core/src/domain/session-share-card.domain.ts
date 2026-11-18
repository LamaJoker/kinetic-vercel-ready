/**
 * Carte « Partager en image » d'une séance terminée : ce qu'elle affiche (nom,
 * date, durée, tonnage, séries, records battus, exercices phares), déjà mis en
 * forme en français. Pur, zéro I/O : le dessin (canvas) et le partage restent
 * dans apps/web (lib/session-share-image.ts, chargé à la demande).
 *
 * Mêmes règles que le reste de l'app : les échauffements sont exclus de tout
 * (tonnage, séries, records) ; une série chronométrée (reps = 0) compte comme
 * série mais n'a ni tonnage ni record de charge.
 */

export type ShareCardFormat = 'post' | 'story';

/** Dimensions en pixels : publication 4:5 (1080×1350) ou story 9:16 (1080×1920). */
export const SHARE_CARD_SIZES: Readonly<
  Record<ShareCardFormat, { width: number; height: number }>
> = {
  post: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
};

/** Nombre d'exercices phares affichés selon le format. */
export const SHARE_CARD_TOP_COUNT: Readonly<Record<ShareCardFormat, number>> = {
  post: 4,
  story: 6,
};

interface ShareSet {
  weightKg: number;
  reps: number;
  kind?: string | undefined;
  durationSec?: number | undefined;
  distanceM?: number | undefined;
}

export interface ShareSessionInput {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string | undefined;
  durationMin?: number | undefined;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly ShareSet[] }>;
}

export interface ShareCardRecord {
  exerciseId: string;
  name: string;
  /** « 100 kg × 5 » */
  label: string;
}

export interface ShareCardExercise {
  exerciseId: string;
  name: string;
  /** « 4 séries · 2,4 t » */
  detail: string;
  tonnageKg: number;
  /** Part du tonnage de l'exercice le plus chargé (0 à 1), pour la barre. */
  share: number;
}

export interface ShareCardSummary {
  title: string;
  /** « Mardi 17 novembre 2026 » */
  dateLabel: string;
  /** Valeur et unité séparées : { value: '1 h 05', unit: '' } ou { value: '52', unit: 'min' }. */
  duration: { value: string; unit: string };
  tonnage: { value: string; unit: 'kg' | 't' };
  setCount: number;
  exerciseCount: number;
  records: ShareCardRecord[];
  top: ShareCardExercise[];
}

const isWarmup = (s: ShareSet): boolean => s.kind === 'warmup';
const isTimed = (s: ShareSet): boolean => Number(s.durationSec) > 0 || Number(s.distanceM) > 0;

/** e1RM (Epley), comme lib/training/rpe.ts : 0 sans répétition. */
function e1rm(weightKg: number, reps: number): number {
  const w = Number(weightKg);
  if (!(reps >= 1) || !(w > 0)) return 0;
  const r = Math.max(1, Math.min(20, Math.floor(reps)));
  return w * (1 + r / 30);
}

function frNumber(n: number, digits = 1): string {
  return n.toLocaleString('fr-FR', { maximumFractionDigits: digits });
}

/** « 840 kg » ou « 12,4 t » (à partir d'une tonne). */
export function shareTonnageParts(kg: number): { value: string; unit: 'kg' | 't' } {
  const v = Number.isFinite(kg) ? Math.max(0, kg) : 0;
  if (v >= 1000) return { value: frNumber(v / 1000), unit: 't' };
  return { value: frNumber(Math.round(v), 0), unit: 'kg' };
}

/** Durée d'une séance en minutes (champ enregistré, sinon début → fin). */
export function sessionDurationMin(session: ShareSessionInput): number {
  const stored = Number(session.durationMin);
  if (Number.isFinite(stored) && stored > 0) return Math.round(stored);
  const start = Date.parse(session.startedAt);
  const end = session.endedAt ? Date.parse(session.endedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 60000);
}

/** « 52 min », « 1 h 05 ». */
export function shareDurationParts(min: number): { value: string; unit: string } {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return { value: String(m), unit: 'min' };
  return { value: `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`, unit: '' };
}

/** « Mardi 17 novembre 2026 » (heure locale). */
export function shareDateLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const s = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDurationSec(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

function exerciseDetail(sets: readonly ShareSet[], tonnageKg: number): string {
  const head = plural(sets.length, 'série', 'séries');
  if (tonnageKg > 0) {
    const t = shareTonnageParts(tonnageKg);
    return `${head} · ${t.value} ${t.unit}`;
  }
  const timed = sets.filter(isTimed);
  if (timed.length) {
    const sec = timed.reduce((n, s) => n + Math.max(0, Number(s.durationSec) || 0), 0);
    const dist = timed.reduce((n, s) => n + Math.max(0, Number(s.distanceM) || 0), 0);
    // Distance d'abord (« 40 m en 0:35 », « 2,5 km ») : c'est la mesure de l'exercice.
    if (dist > 0) {
      const d = dist >= 1000 ? `${frNumber(dist / 1000, 2)} km` : `${frNumber(dist, 0)} m`;
      return timed.length === 1 && sec > 0
        ? `${head} · ${d} en ${formatDurationSec(sec)}`
        : `${head} · ${d}`;
    }
    if (sec > 0) return `${head} · ${formatDurationSec(sec)}`;
  }
  const reps = sets.reduce((n, s) => n + Math.max(0, Number(s.reps) || 0), 0);
  return reps > 0 ? `${head} · ${reps} rép.` : head;
}

/**
 * Meilleur e1RM d'un exercice dans les séances commencées AVANT `beforeMs`
 * (séances terminées seulement, la séance partagée exclue).
 */
function priorBestE1rm(
  history: readonly ShareSessionInput[],
  exerciseId: string,
  excludeId: string,
  beforeMs: number,
): number | null {
  let best: number | null = null;
  for (const s of history) {
    if (s.id === excludeId) continue;
    const t = Date.parse(s.startedAt);
    if (!Number.isFinite(t) || t >= beforeMs) continue;
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      for (const set of e.sets) {
        if (isWarmup(set) || isTimed(set)) continue;
        const v = e1rm(set.weightKg, set.reps);
        if (v > 0 && (best === null || v > best)) best = v;
      }
    }
  }
  return best;
}

/**
 * Résumé prêt à dessiner. `history` : toutes les séances connues (la séance
 * partagée peut y figurer, elle est ignorée). Un record n'est « battu » que s'il
 * existait déjà une référence (même règle que la célébration en séance).
 */
export function buildShareCardSummary(
  session: ShareSessionInput,
  history: readonly ShareSessionInput[],
  nameOf: (exerciseId: string) => string,
  format: ShareCardFormat = 'post',
): ShareCardSummary {
  const startMs = Date.parse(session.startedAt);
  const rows: Array<{ exerciseId: string; sets: ShareSet[]; tonnageKg: number }> = [];
  const records: ShareCardRecord[] = [];
  let tonnage = 0;
  let setCount = 0;

  for (const entry of session.entries) {
    const work = entry.sets.filter((s) => !isWarmup(s));
    if (!work.length) continue;
    const kg = work
      .filter((s) => !isTimed(s))
      .reduce((n, s) => n + Math.max(0, Number(s.weightKg) || 0) * Math.max(0, s.reps || 0), 0);
    tonnage += kg;
    setCount += work.length;
    rows.push({ exerciseId: entry.exerciseId, sets: work, tonnageKg: kg });

    let bestSet: ShareSet | null = null;
    let bestValue = 0;
    for (const s of work) {
      if (isTimed(s)) continue;
      const v = e1rm(s.weightKg, s.reps);
      if (v > bestValue) {
        bestValue = v;
        bestSet = s;
      }
    }
    if (bestSet && Number.isFinite(startMs)) {
      const prior = priorBestE1rm(history, entry.exerciseId, session.id, startMs);
      if (prior !== null && bestValue > prior + 0.05) {
        records.push({
          exerciseId: entry.exerciseId,
          name: nameOf(entry.exerciseId),
          label: `${frNumber(bestSet.weightKg, 2)} kg × ${bestSet.reps}`,
        });
      }
    }
  }

  const sorted = rows
    .slice()
    .sort((a, b) => b.tonnageKg - a.tonnageKg || b.sets.length - a.sets.length);
  const maxKg = sorted[0]?.tonnageKg ?? 0;
  const top = sorted.slice(0, SHARE_CARD_TOP_COUNT[format]).map((r) => ({
    exerciseId: r.exerciseId,
    name: nameOf(r.exerciseId),
    detail: exerciseDetail(r.sets, r.tonnageKg),
    tonnageKg: r.tonnageKg,
    share: maxKg > 0 ? r.tonnageKg / maxKg : 1,
  }));

  return {
    title: session.name.trim() || 'Séance',
    dateLabel: shareDateLabel(session.startedAt),
    duration: shareDurationParts(sessionDurationMin(session)),
    tonnage: shareTonnageParts(tonnage),
    setCount,
    exerciseCount: rows.length,
    records,
    top,
  };
}

/** Nom de fichier de l'image : « kinetic-seance-2026-11-17.png ». */
export function shareCardFileName(session: ShareSessionInput): string {
  const d = new Date(session.startedAt);
  if (!Number.isFinite(d.getTime())) return 'kinetic-seance.png';
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  return `kinetic-seance-${iso}.png`;
}
