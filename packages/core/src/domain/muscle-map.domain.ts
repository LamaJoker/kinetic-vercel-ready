/**
 * Carte des muscles — volume de séries de travail par zone du corps sur une
 * période glissante (7 ou 30 jours), pour colorer une silhouette avant/arrière.
 * Pur, sans I/O.
 *
 * Méthode :
 *   - Chaque exercice liste ses muscles (catalogue), le premier étant le muscle
 *     principal. Une série de travail compte 1 pour les zones du muscle
 *     principal et 0,5 pour celles des muscles secondaires (convention
 *     courante des « séries effectives »). Une zone touchée deux fois par la
 *     même série garde le poids le plus fort.
 *   - Les étiquettes larges sont réparties sur leurs zones : « back » →
 *     grands dorsaux + haut du dos, « posterior » → ischios, fessiers,
 *     lombaires, « legs » → toute la jambe.
 *   - Les échauffements sont exclus ; cardio et « corps entier » ne sont pas
 *     localisables (comptés à part).
 *   - La couleur suit le rythme HEBDOMADAIRE (séries / semaine) pour que 7 j
 *     et 30 j se lisent avec la même échelle.
 */
import { workSetsOf } from './workout-sets.domain.js';

export type MuscleRegion =
  | 'chest'
  | 'shoulders'
  | 'biceps'
  | 'forearms'
  | 'core'
  | 'quads'
  | 'adductors'
  | 'calves'
  | 'traps'
  | 'upper_back'
  | 'lats'
  | 'rear_delts'
  | 'triceps'
  | 'lower_back'
  | 'glutes'
  | 'hamstrings';

export type MuscleView = 'front' | 'back';

export interface MuscleRegionInfo {
  key: MuscleRegion;
  label: string;
  /** Vues où la zone est dessinée. */
  views: readonly MuscleView[];
}

export const MUSCLE_REGIONS: readonly MuscleRegionInfo[] = [
  { key: 'chest', label: 'Pectoraux', views: ['front'] },
  { key: 'shoulders', label: 'Épaules', views: ['front'] },
  { key: 'biceps', label: 'Biceps', views: ['front'] },
  { key: 'forearms', label: 'Avant-bras', views: ['front', 'back'] },
  { key: 'core', label: 'Abdos', views: ['front'] },
  { key: 'quads', label: 'Quadriceps', views: ['front'] },
  { key: 'adductors', label: 'Adducteurs', views: ['front'] },
  { key: 'calves', label: 'Mollets', views: ['front', 'back'] },
  { key: 'traps', label: 'Trapèzes', views: ['front', 'back'] },
  { key: 'rear_delts', label: 'Arrière d’épaule', views: ['back'] },
  { key: 'upper_back', label: 'Haut du dos', views: ['back'] },
  { key: 'lats', label: 'Grands dorsaux', views: ['back'] },
  { key: 'triceps', label: 'Triceps', views: ['back'] },
  { key: 'lower_back', label: 'Lombaires', views: ['back'] },
  { key: 'glutes', label: 'Fessiers', views: ['back'] },
  { key: 'hamstrings', label: 'Ischios', views: ['back'] },
];

/** Étiquettes du catalogue → zones de la silhouette. */
const TAG_REGIONS: Readonly<Record<string, readonly MuscleRegion[]>> = {
  chest: ['chest'],
  shoulders: ['shoulders'],
  rear_delts: ['rear_delts'],
  rotator_cuff: ['rear_delts'],
  biceps: ['biceps'],
  brachialis: ['biceps'],
  triceps: ['triceps'],
  forearms: ['forearms'],
  grip: ['forearms'],
  traps: ['traps'],
  upper_back: ['upper_back'],
  back: ['lats', 'upper_back'],
  lower_back: ['lower_back'],
  posterior: ['hamstrings', 'glutes', 'lower_back'],
  core: ['core'],
  abs: ['core'],
  quads: ['quads'],
  hip_flexors: ['quads'],
  hamstrings: ['hamstrings'],
  glutes: ['glutes'],
  abductors: ['glutes'],
  adductors: ['adductors'],
  calves: ['calves'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves'],
};

/** Zones travaillées par une série et leur poids (1 principal, 0,5 secondaire). */
export function regionWeights(muscles: readonly string[]): Map<MuscleRegion, number> {
  const out = new Map<MuscleRegion, number>();
  muscles.forEach((tag, i) => {
    const w = i === 0 ? 1 : 0.5;
    // Étiquette inconnue (exercice perso, import) : ignorée. hasOwn évite les
    // clés héritées (« toString », « constructor »…) venues de données importées.
    const regions =
      typeof tag === 'string' && Object.prototype.hasOwnProperty.call(TAG_REGIONS, tag)
        ? TAG_REGIONS[tag]!
        : [];
    for (const r of regions) out.set(r, Math.max(out.get(r) ?? 0, w));
  });
  return out;
}

export type MuscleLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Paliers de couleur en séries par semaine : léger (< 4), modéré (4-9),
 * élevé (10-19), très élevé (20 et plus).
 */
export const MUSCLE_LEVELS: ReadonlyArray<{ level: MuscleLevel; min: number; label: string }> = [
  { level: 1, min: 0, label: '1-3' },
  { level: 2, min: 4, label: '4-9' },
  { level: 3, min: 10, label: '10-19' },
  { level: 4, min: 20, label: '20+' },
];

/** Palier de couleur d'un rythme hebdomadaire (séries / semaine). */
export function muscleLevel(setsPerWeek: number): MuscleLevel {
  if (!Number.isFinite(setsPerWeek) || setsPerWeek <= 0) return 0;
  let level: MuscleLevel = 1;
  for (const l of MUSCLE_LEVELS) if (setsPerWeek >= l.min) level = l.level;
  return level;
}

export interface MuscleMapSession {
  startedAt: string;
  entries: ReadonlyArray<{
    exerciseId: string;
    sets: ReadonlyArray<{
      weightKg: number;
      reps: number;
      performedAt?: string;
      kind?: string | undefined;
    }>;
  }>;
}

export interface RegionStats {
  key: MuscleRegion;
  label: string;
  /** Séries effectives (pondérées) sur la période. */
  sets: number;
  /** Rythme hebdomadaire (séries / semaine). */
  setsPerWeek: number;
  /** Tonnage pondéré comme les séries (kg). */
  tonnageKg: number;
  level: MuscleLevel;
  /** Exercices qui l'ont travaillée : séries de travail réelles, les plus nombreuses d'abord. */
  exercises: Array<{ exerciseId: string; sets: number }>;
}

export interface MuscleMap {
  days: number;
  regions: Record<MuscleRegion, RegionStats>;
  /** Zones travaillées, de la plus sollicitée à la moins sollicitée. */
  ranked: RegionStats[];
  /** Séries de travail sur la période (toutes, localisables ou non). */
  totalSets: number;
  /** Séries d'exercices sans zone (cardio, corps entier, muscles absents). */
  unmappedSets: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Agrège les séries de travail des `days` derniers jours (jusqu'à `now`).
 * La date d'une série est la sienne, ou le début de la séance à défaut.
 */
export function buildMuscleMap(input: {
  sessions: readonly MuscleMapSession[];
  musclesOf: (exerciseId: string) => readonly string[];
  days: number;
  now?: Date;
}): MuscleMap {
  const days = Math.max(1, Math.floor(input.days));
  const nowMs = (input.now ?? new Date()).getTime();
  const since = nowMs - days * 86_400_000;
  const weeks = days / 7;

  const acc = new Map<MuscleRegion, { sets: number; kg: number; ex: Map<string, number> }>();
  let totalSets = 0;
  let unmappedSets = 0;
  const weightsCache = new Map<string, Map<MuscleRegion, number>>();

  for (const session of input.sessions) {
    const sessionMs = Date.parse(session.startedAt);
    for (const entry of session.entries) {
      let weights = weightsCache.get(entry.exerciseId);
      if (!weights) {
        weights = regionWeights(input.musclesOf(entry.exerciseId));
        weightsCache.set(entry.exerciseId, weights);
      }
      for (const set of workSetsOf(entry.sets)) {
        const parsed = set.performedAt ? Date.parse(set.performedAt) : NaN;
        const t = Number.isFinite(parsed) ? parsed : sessionMs;
        if (!Number.isFinite(t) || t < since || t > nowMs) continue;
        totalSets += 1;
        if (weights.size === 0) {
          unmappedSets += 1;
          continue;
        }
        const kg = (Number(set.weightKg) || 0) * (Number(set.reps) || 0);
        for (const [region, w] of weights) {
          const a = acc.get(region) ?? { sets: 0, kg: 0, ex: new Map<string, number>() };
          a.sets += w;
          a.kg += kg * w;
          a.ex.set(entry.exerciseId, (a.ex.get(entry.exerciseId) ?? 0) + 1);
          acc.set(region, a);
        }
      }
    }
  }

  const regions = {} as Record<MuscleRegion, RegionStats>;
  for (const info of MUSCLE_REGIONS) {
    const a = acc.get(info.key);
    const sets = round1(a?.sets ?? 0);
    const setsPerWeek = round1((a?.sets ?? 0) / weeks);
    regions[info.key] = {
      key: info.key,
      label: info.label,
      sets,
      setsPerWeek,
      tonnageKg: Math.round(a?.kg ?? 0),
      level: muscleLevel(setsPerWeek),
      exercises: a
        ? [...a.ex.entries()]
            .map(([exerciseId, n]) => ({ exerciseId, sets: n }))
            .sort((x, y) => y.sets - x.sets || x.exerciseId.localeCompare(y.exerciseId))
        : [],
    };
  }
  const ranked = Object.values(regions)
    .filter((r) => r.sets > 0)
    .sort((a, b) => b.sets - a.sets || a.label.localeCompare(b.label));

  return { days, regions, ranked, totalSets, unmappedSets };
}
