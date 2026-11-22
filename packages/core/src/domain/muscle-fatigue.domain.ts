/**
 * Fatigue par muscle — estimation simple de la récupération de chaque zone de
 * la carte des muscles. Pur, sans I/O. Ce n'est pas une mesure : un repère.
 *
 * Modèle :
 *   1. Chaque série de travail des 7 derniers jours charge les zones de son
 *      exercice : 1 pour le muscle principal, ½ pour les secondaires (comme la
 *      carte des muscles), multiplié par l'intensité :
 *      intensité = (RPE − 4) / 4, bornée à [0,5 ; 1,5] → RPE 8 = 1, RPE 10 = 1,5,
 *      RPE 6 = 0,5 (RPE absent : 8). Les échauffements ne comptent pas.
 *   2. Cette charge décroît de façon exponentielle avec une demi-vie selon la
 *      taille du muscle : 16 h (petits : bras, mollets, avant-bras, abdos…),
 *      20 h (moyens : épaules, trapèzes, haut du dos), 24 h (grands : jambes,
 *      pectoraux, dorsaux, lombaires). Trois demi-vies ≈ récupéré : 48 h, 60 h
 *      ou 72 h après une séance normale.
 *   3. Fatigue % = charge restante ÷ capacité (séries « dures » qui fatiguent
 *      complètement la zone : 6 petits, 8 moyens, 10 grands), bornée à 100.
 *   4. Courbatures déclarées au check-in du jour : la fatigue des zones encore
 *      chargées est multipliée par 1,2 (légères) ou 1,5 (fortes).
 *   États : moins de 30 % → récupéré (turquoise) ; 30–65 % → en cours (ambre) ;
 *   plus de 65 % → fatigué (corail). « Prêt » = fatigue sous 30 %.
 */
import { MUSCLE_REGIONS, regionWeights, type MuscleRegion } from './muscle-map.domain.js';
import { workSetsOf } from './workout-sets.domain.js';

export type RecoveryState = 'fresh' | 'recovering' | 'tired';
export type MuscleSize = 'small' | 'medium' | 'large';

const SIZE: Readonly<Record<MuscleRegion, MuscleSize>> = {
  chest: 'large',
  quads: 'large',
  hamstrings: 'large',
  glutes: 'large',
  lats: 'large',
  lower_back: 'large',
  shoulders: 'medium',
  traps: 'medium',
  upper_back: 'medium',
  rear_delts: 'small',
  biceps: 'small',
  triceps: 'small',
  forearms: 'small',
  calves: 'small',
  core: 'small',
  adductors: 'small',
};

export const HALF_LIFE_H: Readonly<Record<MuscleSize, number>> = {
  small: 16,
  medium: 20,
  large: 24,
};
const CAPACITY: Readonly<Record<MuscleSize, number>> = { small: 6, medium: 8, large: 10 };
const SORENESS_FACTOR = { none: 1, light: 1.2, heavy: 1.5 } as const;
/** Sous ce seuil (%), la zone est récupérée. */
export const FRESH_BELOW = 30;
/** Au-dessus de ce seuil (%), la zone est fatiguée. */
export const TIRED_ABOVE = 65;
const WINDOW_MS = 7 * 86_400_000;
const HOUR = 3_600_000;

export function muscleSize(region: MuscleRegion): MuscleSize {
  return SIZE[region] ?? 'medium';
}

/** Intensité d'une série d'après son RPE (8 par défaut). */
export function rpeIntensity(rpe: number | undefined): number {
  const r = Number(rpe);
  const v = Number.isFinite(r) && r > 0 ? r : 8;
  return Math.max(0.5, Math.min(1.5, (v - 4) / 4));
}

export function recoveryState(fatiguePct: number): RecoveryState {
  if (fatiguePct < FRESH_BELOW) return 'fresh';
  return fatiguePct > TIRED_ABOVE ? 'tired' : 'recovering';
}

export interface FatigueSession {
  startedAt: string;
  entries: ReadonlyArray<{
    exerciseId: string;
    sets: ReadonlyArray<{
      weightKg: number;
      reps: number;
      rpe?: number;
      performedAt?: string;
      kind?: string | undefined;
    }>;
  }>;
}

export interface RegionFatigue {
  key: MuscleRegion;
  label: string;
  /** Fatigue estimée, 0–100. */
  fatigue: number;
  /** Récupération, 0–100 (100 − fatigue). */
  recovery: number;
  state: RecoveryState;
  /** Heures avant de repasser sous le seuil « récupéré » (0 : prêt). */
  readyInHours: number;
}

export interface FatigueMap {
  regions: Record<MuscleRegion, RegionFatigue>;
  /** Au moins une zone chargée sur 7 jours. */
  hasData: boolean;
}

/**
 * Fatigue de chaque zone à `now`. `soreness` : courbatures déclarées au
 * check-in du jour (absent : aucune).
 */
export function buildFatigueMap(input: {
  sessions: readonly FatigueSession[];
  musclesOf: (exerciseId: string) => readonly string[];
  now?: Date;
  soreness?: 'none' | 'light' | 'heavy' | null;
}): FatigueMap {
  const nowMs = (input.now ?? new Date()).getTime();
  const load = new Map<MuscleRegion, number>();
  const cache = new Map<string, Map<MuscleRegion, number>>();

  for (const s of input.sessions) {
    const sessionMs = Date.parse(s.startedAt);
    if (Number.isFinite(sessionMs) && sessionMs < nowMs - WINDOW_MS - 6 * HOUR) continue;
    for (const entry of s.entries) {
      let weights = cache.get(entry.exerciseId);
      if (!weights) {
        weights = regionWeights(input.musclesOf(entry.exerciseId));
        cache.set(entry.exerciseId, weights);
      }
      if (weights.size === 0) continue;
      for (const set of workSetsOf(entry.sets)) {
        const parsed = set.performedAt ? Date.parse(set.performedAt) : NaN;
        const t = Number.isFinite(parsed) ? parsed : sessionMs;
        if (!Number.isFinite(t) || t > nowMs || t < nowMs - WINDOW_MS) continue;
        const ageH = (nowMs - t) / HOUR;
        const intensity = rpeIntensity(set.rpe);
        for (const [region, w] of weights) {
          const decay = Math.pow(0.5, ageH / HALF_LIFE_H[muscleSize(region)]);
          load.set(region, (load.get(region) ?? 0) + w * intensity * decay);
        }
      }
    }
  }

  const factor = SORENESS_FACTOR[input.soreness ?? 'none'] ?? 1;
  const regions = {} as Record<MuscleRegion, RegionFatigue>;
  let hasData = false;
  for (const info of MUSCLE_REGIONS) {
    const size = muscleSize(info.key);
    const raw = load.get(info.key) ?? 0;
    if (raw > 0) hasData = true;
    const pct = Math.min(100, (raw / CAPACITY[size]) * 100 * (raw > 0.05 ? factor : 1));
    const fatigue = Math.round(pct);
    const readyInHours =
      pct < FRESH_BELOW ? 0 : Math.ceil(HALF_LIFE_H[size] * Math.log2(pct / FRESH_BELOW));
    regions[info.key] = {
      key: info.key,
      label: info.label,
      fatigue,
      recovery: 100 - fatigue,
      state: recoveryState(pct),
      readyInHours,
    };
  }
  return { regions, hasData };
}

/** Accord des libellés : « Haut du dos » (masc. sing.), « Épaules » (fém. plur.)… */
const AGREEMENT: Partial<Record<MuscleRegion, '' | 'es'>> = {
  upper_back: '',
  rear_delts: '',
  shoulders: 'es',
  lower_back: 'es',
};

function agree(word: string, region: MuscleRegion): string {
  const s = AGREEMENT[region] ?? 's';
  return word + s;
}

/** « prêts maintenant » / « prêts dans ~6 h » / « prêts demain » / « prêts dans 2 jours ». */
export function readyLabel(
  readyInHours: number,
  now: Date = new Date(),
  region: MuscleRegion = 'chest',
): string {
  const ready = agree('prêt', region);
  if (readyInHours <= 0) return `${ready} maintenant`;
  if (readyInHours <= 8) return `${ready} dans ~${readyInHours} h`;
  const at = new Date(now.getTime() + readyInHours * HOUR);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayDiff = Math.floor((at.getTime() - startToday) / 86_400_000);
  if (dayDiff <= 0) return `${ready} ce soir`;
  if (dayDiff === 1) return `${ready} demain`;
  return `${ready} dans ${dayDiff} jours`;
}

/** « Pectoraux : récupérés à ~80 %, prêts demain ». */
export function fatigueSentence(r: RegionFatigue, now: Date = new Date()): string {
  const pct = Math.max(0, Math.min(100, Math.round(r.recovery / 5) * 5));
  const done = agree('récupéré', r.key);
  if (r.state === 'fresh') return `${r.label} : ${done} à ~${pct} %, ${readyLabel(0, now, r.key)}`;
  return `${r.label} : ${done} à ~${pct} %, ${readyLabel(r.readyInHours, now, r.key)}`;
}

/** Grands groupes proposés à l'entraînement quand toutes leurs zones sont récupérées. */
export const FATIGUE_GROUPS: ReadonlyArray<{ label: string; regions: readonly MuscleRegion[] }> = [
  { label: 'pectoraux', regions: ['chest'] },
  { label: 'dos', regions: ['lats', 'upper_back'] },
  { label: 'épaules', regions: ['shoulders', 'rear_delts'] },
  { label: 'bras', regions: ['biceps', 'triceps'] },
  { label: 'jambes', regions: ['quads', 'hamstrings', 'glutes'] },
];

/** Groupes entièrement récupérés (dans l'ordre de FATIGUE_GROUPS). */
export function freshGroups(map: FatigueMap): string[] {
  return FATIGUE_GROUPS.filter((g) => g.regions.every((r) => map.regions[r].state === 'fresh')).map(
    (g) => g.label,
  );
}

/** « Muscles frais : dos, jambes » ; « Tout est récupéré » ; « Tout récupère encore ». */
export function freshSuggestion(map: FatigueMap): string {
  const fresh = freshGroups(map);
  if (fresh.length === FATIGUE_GROUPS.length) return 'Tout est récupéré : à toi de choisir';
  if (fresh.length === 0) return 'Tout récupère encore : séance légère ou mobilité';
  return `Muscles frais : ${fresh.join(', ')}`;
}
