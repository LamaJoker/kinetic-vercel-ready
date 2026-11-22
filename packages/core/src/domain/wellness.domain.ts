/**
 * Forme du jour et hydratation — pur, sans I/O.
 *
 * CHECK-IN DU MATIN (3 touches) : sommeil, énergie, courbatures → score 0–100.
 *   - Sommeil (40 %) : heures précises si saisies (4 h → 0, 8 h et plus → 1,
 *     linéaire entre les deux), sinon la qualité déclarée (mauvais 0,25 ;
 *     moyen 0,6 ; bon 0,95). « Bon » correspond à 7 h et plus.
 *   - Énergie (35 %) : 1 à 5, ramenée à 0–1.
 *   - Courbatures (25 %) : aucune 1 ; légères 0,6 ; fortes 0,15.
 *   Paliers : 70 et plus « En forme », 45–69 « Correcte », moins de 45
 *   « Forme basse » (la séance propose alors de s'alléger).
 *
 * HYDRATATION : verres ajoutés au fil de la journée (ml), objectif réglable ou
 *   calculé depuis le poids (35 ml/kg, arrondi à 250 ml, entre 1,5 et 4 L ; 2 L
 *   sans poids connu).
 */

export type SleepQuality = 'bad' | 'ok' | 'good';
export type Soreness = 'none' | 'light' | 'heavy';
export type FormLevel = 'good' | 'ok' | 'low';

export interface CheckIn {
  /** Jour local « AAAA-MM-JJ ». */
  date: string;
  sleep: SleepQuality;
  /** Heures de sommeil précises (facultatif, prioritaire sur la qualité). */
  sleepHours?: number;
  /** 1 (vidé) à 5 (au top). */
  energy: number;
  soreness: Soreness;
  /** Horodatage ISO de la dernière modification. */
  at?: string;
}

/** Check-ins par jour (« AAAA-MM-JJ » → check-in). */
export type CheckInLog = Record<string, CheckIn>;

export const FORM_LOW_THRESHOLD = 45;
export const FORM_GOOD_THRESHOLD = 70;
/** Sommeil suffisant pour cocher la tâche « Dormir 7 h ou plus ». */
export const SLEEP_TASK_HOURS = 7;

const SLEEP_QUALITY_SCORE: Readonly<Record<SleepQuality, number>> = {
  bad: 0.25,
  ok: 0.6,
  good: 0.95,
};
const SORENESS_SCORE: Readonly<Record<Soreness, number>> = { none: 1, light: 0.6, heavy: 0.15 };

export const SLEEP_LABELS: Readonly<Record<SleepQuality, string>> = {
  bad: 'Mauvais',
  ok: 'Moyen',
  good: 'Bon',
};
export const SORENESS_LABELS: Readonly<Record<Soreness, string>> = {
  none: 'Aucune',
  light: 'Légères',
  heavy: 'Fortes',
};
export const FORM_LEVEL_LABELS: Readonly<Record<FormLevel, string>> = {
  good: 'En forme',
  ok: 'Correcte',
  low: 'Forme basse',
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

function validHours(h: unknown): h is number {
  return typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= 16;
}

/** Qualité correspondant à des heures de sommeil (< 6 h mauvais, < 7 h moyen). */
export function sleepQualityFromHours(hours: number): SleepQuality {
  if (hours < 6) return 'bad';
  return hours < SLEEP_TASK_HOURS ? 'ok' : 'good';
}

/** Part du sommeil dans le score (0–1). */
export function sleepScore(c: Pick<CheckIn, 'sleep' | 'sleepHours'>): number {
  if (validHours(c.sleepHours)) return clamp((c.sleepHours - 4) / 4, 0, 1);
  return SLEEP_QUALITY_SCORE[c.sleep] ?? SLEEP_QUALITY_SCORE.ok;
}

/** Score de forme du jour, 0–100. */
export function formScore(
  c: Pick<CheckIn, 'sleep' | 'sleepHours' | 'energy' | 'soreness'>,
): number {
  const energy = clamp((Math.round(Number(c.energy) || 3) - 1) / 4, 0, 1);
  const soreness = SORENESS_SCORE[c.soreness] ?? SORENESS_SCORE.light;
  return Math.round(100 * (0.4 * sleepScore(c) + 0.35 * energy + 0.25 * soreness));
}

export function formLevel(score: number): FormLevel {
  if (score >= FORM_GOOD_THRESHOLD) return 'good';
  return score >= FORM_LOW_THRESHOLD ? 'ok' : 'low';
}

/** Vrai si le check-in permet de cocher la tâche de sommeil (7 h et plus, ou « Bon »). */
export function sleepGoalReached(c: Pick<CheckIn, 'sleep' | 'sleepHours'>): boolean {
  if (validHours(c.sleepHours)) return c.sleepHours >= SLEEP_TASK_HOURS;
  return c.sleep === 'good';
}

/** Check-in nettoyé (données importées ou saisies), ou null s'il est inutilisable. */
export function normalizeCheckIn(raw: unknown): CheckIn | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  const sleep = r.sleep as SleepQuality;
  const soreness = r.soreness as Soreness;
  if (!(sleep in SLEEP_QUALITY_SCORE) || !(soreness in SORENESS_SCORE)) return null;
  const energy = Math.round(Number(r.energy));
  if (!Number.isFinite(energy) || energy < 1 || energy > 5) return null;
  const out: CheckIn = { date: r.date, sleep, energy, soreness };
  if (validHours(r.sleepHours)) out.sleepHours = Math.round(r.sleepHours * 4) / 4;
  if (typeof r.at === 'string') out.at = r.at;
  return out;
}

/** Ajoute ou remplace le check-in de son jour, en ne gardant que les `keepDays` derniers jours. */
export function upsertCheckIn(
  log: CheckInLog | null | undefined,
  c: CheckIn,
  keepDays = 120,
): CheckInLog {
  const next: CheckInLog = { ...(log ?? {}), [c.date]: c };
  const dates = Object.keys(next).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - keepDays))) delete next[d];
  return next;
}

/** Jour local « AAAA-MM-JJ ». */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Les `days` derniers jours (le plus ancien d'abord, aujourd'hui en dernier). */
export function lastDays(today: Date, days: number): string[] {
  return Array.from({ length: Math.max(0, days) }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i));
    return localDay(d);
  });
}

export interface FormPoint {
  date: string;
  score: number | null;
}

/** Historique des scores sur `days` jours (null : pas de check-in ce jour-là). */
export function formHistory(
  log: CheckInLog | null | undefined,
  today: Date,
  days = 30,
): FormPoint[] {
  return lastDays(today, days).map((date) => {
    const c = normalizeCheckIn(log?.[date]);
    return { date, score: c ? formScore(c) : null };
  });
}

/** Moyenne des scores présents (arrondie), ou null. */
export function averageForm(points: readonly FormPoint[]): number | null {
  const s = points.map((p) => p.score).filter((v): v is number => v !== null);
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
}

// ─── Allègement de séance ────────────────────────────────────────────────────

/** Charge allégée de 10 %, arrondie vers le bas au pas de l'exercice. */
export function lightenWeight(weightKg: number, incrementKg = 2.5): number {
  const w = Number(weightKg);
  if (!Number.isFinite(w) || w <= 0) return 0;
  const step = Number(incrementKg) > 0 ? Number(incrementKg) : 2.5;
  const out = Math.floor((w * 0.9 + 1e-9) / step) * step;
  return Math.round(out * 100) / 100;
}

/** Une série de moins (au moins une). */
export function lightenSetCount(sets: number): number {
  const n = Math.round(Number(sets) || 0);
  return n <= 1 ? Math.max(0, n) : n - 1;
}

// ─── Hydratation ─────────────────────────────────────────────────────────────

export const DEFAULT_WATER_GOAL_ML = 2000;
export const DEFAULT_GLASS_ML = 250;

/** Verres bus par jour (ml de chaque ajout, dans l'ordre). */
export type WaterLog = Record<string, number[]>;

export interface WaterPrefs {
  /** Objectif choisi (ml) ; absent ou null : calculé depuis le poids. */
  goalMl?: number | null;
  /** Taille d'un verre (ml). */
  glassMl?: number;
}

/** Objectif conseillé : 35 ml/kg, arrondi à 250 ml, entre 1,5 et 4 L (2 L sans poids). */
export function waterGoalFromWeight(weightKg: number | null | undefined): number {
  const w = Number(weightKg);
  if (!Number.isFinite(w) || w < 30 || w > 300) return DEFAULT_WATER_GOAL_ML;
  return clamp(Math.round((w * 35) / 250) * 250, 1500, 4000);
}

export function waterGoal(prefs: WaterPrefs | null | undefined, weightKg?: number | null): number {
  const g = Number(prefs?.goalMl);
  if (Number.isFinite(g) && g >= 500 && g <= 6000) return Math.round(g);
  return waterGoalFromWeight(weightKg);
}

export function glassSize(prefs: WaterPrefs | null | undefined): number {
  const g = Number(prefs?.glassMl);
  return Number.isFinite(g) && g >= 50 && g <= 1000 ? Math.round(g) : DEFAULT_GLASS_ML;
}

function cleanDrinks(v: unknown): number[] {
  return Array.isArray(v)
    ? v.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 2000)
    : [];
}

export function waterTotal(log: WaterLog | null | undefined, date: string): number {
  return cleanDrinks(log?.[date]).reduce((a, b) => a + b, 0);
}

/** Ajoute un verre au jour donné ; garde les `keepDays` derniers jours. */
export function addWater(
  log: WaterLog | null | undefined,
  date: string,
  ml: number,
  keepDays = 60,
): WaterLog {
  const amount = Math.round(Number(ml));
  if (!Number.isFinite(amount) || amount <= 0) return { ...(log ?? {}) };
  const next: WaterLog = { ...(log ?? {}), [date]: [...cleanDrinks(log?.[date]), amount] };
  const dates = Object.keys(next).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - keepDays))) delete next[d];
  return next;
}

/** Retire le dernier verre du jour (rien s'il n'y en a pas). */
export function undoWater(log: WaterLog | null | undefined, date: string): WaterLog {
  const drinks = cleanDrinks(log?.[date]);
  const next: WaterLog = { ...(log ?? {}) };
  if (drinks.length <= 1) delete next[date];
  else next[date] = drinks.slice(0, -1);
  return next;
}

/** « 1,25 L » ; « 750 ml ». */
export function formatWater(ml: number): string {
  if (ml < 1000) return `${Math.round(ml)} ml`;
  return `${(Math.round(ml / 10) / 100).toLocaleString('fr-FR')} L`;
}

export interface WaterDay {
  date: string;
  ml: number;
  /** Part de l'objectif, 0–100 (bornée). */
  percent: number;
  reached: boolean;
}

/** Les `days` derniers jours, le plus ancien d'abord. */
export function waterHistory(
  log: WaterLog | null | undefined,
  today: Date,
  goalMl: number,
  days = 7,
): WaterDay[] {
  const goal = goalMl > 0 ? goalMl : DEFAULT_WATER_GOAL_ML;
  return lastDays(today, days).map((date) => {
    const ml = waterTotal(log, date);
    return {
      date,
      ml,
      percent: clamp(Math.round((ml / goal) * 100), 0, 100),
      reached: ml >= goal,
    };
  });
}
