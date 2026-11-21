/**
 * Alerte de stagnation par exercice : plateau détecté quand ni l'e1RM ni la
 * meilleure série (charge la plus lourde, puis reps à cette charge) n'ont
 * progressé depuis plusieurs séances. Échauffements, séries chronométrées et
 * séances de plus de 8 semaines ignorés. Pur, zéro I/O.
 */
import { e1rm } from './progression.domain.js';
import { isTimedSet, workSetsOf, type LoadedSet, type TimedFields } from './workout-sets.domain.js';

type PlateauSet = LoadedSet & TimedFields & { rpe?: number };
export interface PlateauSession {
  startedAt: string;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly PlateauSet[] }>;
}

export type PlateauSuggestionId = 'deload' | 'reps-range' | 'micro-load' | 'variant';

export interface PlateauSuggestion {
  id: PlateauSuggestionId;
  title: string;
  detail: string;
}

export interface PlateauReport {
  exerciseId: string;
  /** Séances au même niveau, celle du meilleur résultat comprise (≥ 4). */
  sessions: number;
  /** Séance du meilleur résultat (début du plateau). */
  since: string;
  bestE1rm: number;
  topKg: number;
  topReps: number;
  /** RPE moyen des séries de travail du plateau (null si non saisi). */
  avgRpe: number | null;
  suggestions: PlateauSuggestion[];
}

export interface PlateauOptions {
  now: number;
  /** Pas de charge de l'exercice (défaut 2,5 kg). */
  incrementKg?: number;
  /** Séances sans progrès pour parler de plateau, meilleure comprise (défaut 4). */
  minSessions?: number;
}

const DAY = 86_400_000;
/** Séances plus anciennes ignorées. */
const WINDOW_DAYS = 56;
/** Dernière séance plus ancienne : pas d'alerte (reprise après une pause). */
const STALE_DAYS = 28;
/** Durée minimale du plateau (première → dernière séance au même niveau). */
const MIN_SPAN_DAYS = 10;
/** Gain d'e1RM sous lequel on parle de bruit (1 %). */
const TOLERANCE = 0.01;

const fmt = (n: number): string =>
  n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ');
const roundTo = (n: number, step: number): number => Math.round(n / step) * step;

/** Plateau en cours sur l'exercice, ou null. */
export function detectPlateau(
  sessions: readonly PlateauSession[],
  exerciseId: string,
  opts: PlateauOptions,
): PlateauReport | null {
  const { now, incrementKg = 2.5, minSessions = 4 } = opts;
  const perSession: Array<{ at: string; e1: number; kg: number; reps: number; rpes: number[] }> =
    [];
  for (const s of [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const t = Date.parse(s.startedAt);
    if (!(t >= now - WINDOW_DAYS * DAY && t <= now)) continue;
    const sets = s.entries
      .filter((e) => e.exerciseId === exerciseId)
      .flatMap((e) => workSetsOf(e.sets).filter((x) => !isTimedSet(x) && x.reps >= 1));
    if (sets.length === 0) continue;
    let e1 = 0,
      kg = -1,
      reps = 0;
    for (const x of sets) {
      e1 = Math.max(e1, e1rm(x.weightKg, x.reps));
      if (x.weightKg > kg || (x.weightKg === kg && x.reps > reps))
        [kg, reps] = [x.weightKg, x.reps];
    }
    perSession.push({ at: s.startedAt, e1, kg, reps, rpes: sets.map((x) => Number(x.rpe)) });
  }
  const last = perSession.at(-1);
  if (perSession.length < minSessions || !last || Date.parse(last.at) < now - STALE_DAYS * DAY)
    return null;

  let best = perSession[0]!;
  let start = 0;
  perSession.forEach((s, i) => {
    const progressed =
      s.e1 > best.e1 * (1 + TOLERANCE) ||
      s.kg > best.kg ||
      (s.kg === best.kg && s.reps > best.reps);
    if (i > 0 && progressed) {
      const heavier = s.kg > best.kg || (s.kg === best.kg && s.reps > best.reps);
      best = { ...(heavier ? s : best), e1: Math.max(s.e1, best.e1) };
      start = i;
    }
  });
  const flat = perSession.slice(start);
  // Plusieurs séances le même jour ou presque ne font pas un plateau : au moins 10 jours.
  if (
    flat.length < minSessions ||
    Date.parse(last.at) - Date.parse(flat[0]!.at) < MIN_SPAN_DAYS * DAY
  )
    return null;

  const rpes = flat.flatMap((s) => s.rpes).filter((r) => r >= 5 && r <= 10);
  const avgRpe = rpes.length
    ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10
    : null;
  const report: PlateauReport = {
    exerciseId,
    sessions: flat.length,
    since: perSession[start]!.at,
    bestE1rm: best.e1,
    topKg: best.kg,
    topReps: best.reps,
    avgRpe,
    suggestions: [],
  };
  report.suggestions = plateauSuggestions(
    report,
    incrementKg,
    flat.map((s) => s.reps),
  );
  return report;
}

/** Pistes concrètes et argumentées, de la plus pertinente à la moins. */
export function plateauSuggestions(
  p: Pick<PlateauReport, 'bestE1rm' | 'topKg' | 'sessions' | 'avgRpe'>,
  incrementKg = 2.5,
  topReps: readonly number[] = [],
): PlateauSuggestion[] {
  const inc = incrementKg > 0 ? incrementKg : 2.5;
  const loaded = p.topKg > 0;
  const out: PlateauSuggestion[] = [];
  const tired = (p.avgRpe ?? 0) >= 8.5;
  const deload: PlateauSuggestion = {
    id: 'deload',
    title: 'Semaine plus légère',
    detail: loaded
      ? `${tired ? `RPE moyen ${fmt(p.avgRpe!)} : la fatigue masque sans doute ta force. ` : ''}Une semaine vers ${fmt(roundTo(p.topKg * 0.9, inc))} kg (−10 %), mêmes reps, puis reprends : on repart souvent plus haut.`
      : `${tired ? `RPE moyen ${fmt(p.avgRpe!)} : la fatigue masque sans doute ta force. ` : ''}Une semaine avec un tiers de séries en moins, puis reprends : on repart souvent plus haut.`,
  };
  if (tired) out.push(deload);

  const sorted = [...topReps].sort((a, b) => a - b);
  const usual = sorted.length ? sorted[sorted.length >> 1]! : 8;
  if (loaded) {
    const heavy = usual >= 7;
    const [lo, hi] = heavy ? [4, 6] : [8, 10];
    const kgAt = roundTo(p.bestE1rm / (1 + (heavy ? 5 : 9) / 30), inc);
    out.push({
      id: 'reps-range',
      title: `Passe à ${lo}–${hi} reps`,
      detail: `Tu tournes autour de ${usual} reps. Trois ou quatre semaines en ${lo}–${hi} reps (≈ ${fmt(kgAt)} kg) changent le stimulus${heavy ? ' et font travailler la force' : ' et ajoutent du volume utile'}.`,
    });
    const micro = Math.max(0.5, roundTo(inc / 2, 0.25));
    out.push({
      id: 'micro-load',
      title: `Micro-charges : +${fmt(micro)} kg`,
      detail: `Plutôt que +${fmt(inc)} kg d'un coup, ajoute ${fmt(micro)} kg (micro-disques, haltères intermédiaires) ou une rep par séance : des petits pas que le corps suit.`,
    });
  } else {
    out.push({
      id: 'micro-load',
      title: 'Ajoute un lest léger',
      detail: `Tu plafonnes à ${usual} reps au poids du corps : un lest de 2,5 à 5 kg, ou une rep de plus par séance, relance la progression.`,
    });
  }
  out.push({
    id: 'variant',
    title: 'Change de variante quelques semaines',
    detail:
      'Une variante proche (autre prise, autre matériel) travaille les mêmes muscles sous un autre angle, puis tu reviens plus fort sur l’exercice de base.',
  });
  if (!tired) out.push(deload);
  return out;
}

// ─── « Masquer pour cet exercice » ──────────────────────────────────────────

/** Exercice → date (ISO) jusqu'à laquelle l'alerte reste masquée. */
export type PlateauDismissals = Record<string, string>;

/** Durée du masquage (semaines). */
export const PLATEAU_SNOOZE_WEEKS = 3;

export function isPlateauDismissed(
  dismissals: PlateauDismissals | null | undefined,
  exerciseId: string,
  now: number,
): boolean {
  const until = Date.parse(dismissals?.[exerciseId] ?? '');
  return Number.isFinite(until) && until > now;
}

/** Masque l'alerte de l'exercice quelques semaines ; retire les masquages expirés. */
export function dismissPlateau(
  dismissals: PlateauDismissals | null | undefined,
  exerciseId: string,
  now: number,
): PlateauDismissals {
  const next: PlateauDismissals = {};
  for (const [id, until] of Object.entries(dismissals ?? {}))
    if (Date.parse(until) > now) next[id] = until;
  next[exerciseId] = new Date(now + PLATEAU_SNOOZE_WEEKS * 7 * DAY).toISOString();
  return next;
}
