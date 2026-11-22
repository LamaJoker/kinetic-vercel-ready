/**
 * Composition corporelle — logique pure des écrans Corps (Mensurations, Poids, Photos).
 *
 * 1. Taux de masse grasse estimé par la méthode de l'US Navy (Hodgdon & Beckett,
 *    1984), à partir des tours de cou, de taille (et de hanches chez la femme)
 *    et de la taille debout, en centimètres :
 *      homme : 495 / (1,0324 − 0,19077·log10(taille − cou) + 0,15456·log10(hauteur)) − 450
 *      femme : 495 / (1,29579 − 0,35004·log10(taille + hanches − cou) + 0,22100·log10(hauteur)) − 450
 *    C'est une estimation : ±3 à 4 points d'écart avec une mesure de référence (DEXA).
 * 2. Comparateur de photos avant / après : paire par défaut et écart lisible
 *    (« 12 semaines · −3,2 kg »).
 */

export type BodySex = 'male' | 'female';

/** Marge d'erreur typique de la méthode US Navy, en points de %. */
export const NAVY_MARGIN_PCT = 3.5;

export interface NavyInput {
  sex: BodySex;
  heightCm: number;
  waistCm: number;
  neckCm: number;
  /** Obligatoire pour une femme. */
  hipsCm?: number | null;
}

const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** % de masse grasse estimé (arrondi à 0,1), ou null si les mesures manquent ou sont incohérentes. */
export function navyBodyFatPct(m: NavyInput): number | null {
  if (!ok(m.heightCm) || !ok(m.waistCm) || !ok(m.neckCm)) return null;
  if (m.heightCm < 100 || m.heightCm > 250) return null;
  let denom: number;
  if (m.sex === 'female') {
    if (!ok(m.hipsCm)) return null;
    const girth = m.waistCm + m.hipsCm - m.neckCm;
    if (girth <= 0) return null;
    denom = 1.29579 - 0.35004 * Math.log10(girth) + 0.221 * Math.log10(m.heightCm);
  } else {
    const girth = m.waistCm - m.neckCm;
    if (girth <= 0) return null;
    denom = 1.0324 - 0.19077 * Math.log10(girth) + 0.15456 * Math.log10(m.heightCm);
  }
  const pct = 495 / denom - 450;
  // Hors de la plage physiologique : mesures probablement erronées.
  if (!Number.isFinite(pct) || pct < 2 || pct > 60) return null;
  return round1(pct);
}

export type BodyFatCategoryKey = 'essential' | 'athletic' | 'fitness' | 'average' | 'high';

export interface BodyFatCategory {
  key: BodyFatCategoryKey;
  label: string;
}

/** Seuils indicatifs (American Council on Exercise) : début de chaque catégorie. */
const CATEGORY_BOUNDS: Record<BodySex, readonly number[]> = {
  male: [6, 14, 18, 25],
  female: [14, 21, 25, 32],
};
const CATEGORIES: readonly BodyFatCategory[] = [
  { key: 'essential', label: 'Très sec' },
  { key: 'athletic', label: 'Athlétique' },
  { key: 'fitness', label: 'En forme' },
  { key: 'average', label: 'Moyen' },
  { key: 'high', label: 'Élevé' },
];

/** Catégorie indicative d'un % de masse grasse. */
export function bodyFatCategory(pct: number, sex: BodySex): BodyFatCategory {
  const bounds = CATEGORY_BOUNDS[sex];
  let i = 0;
  while (i < bounds.length && pct >= bounds[i]!) i++;
  return CATEGORIES[i]!;
}

/** Masse grasse et masse maigre (kg, arrondies à 0,1). */
export function bodyFatMasses(weightKg: number, pct: number): { fatKg: number; leanKg: number } {
  const fat = (weightKg * pct) / 100;
  return { fatKg: round1(fat), leanKg: round1(weightKg - fat) };
}

export interface BodyFatMeasurement {
  date: string;
  waist?: number;
  neck?: number;
  hips?: number;
}

export interface BodyWeightPoint {
  date: string;
  weight: number;
}

export interface BodyFatPoint {
  date: string;
  pct: number;
  weightKg: number | null;
  fatKg: number | null;
  leanKg: number | null;
}

const DAY = 86_400_000;
const dayMs = (iso: string): number => Date.parse(iso.slice(0, 10) + 'T12:00:00Z');

/** Pesée la plus proche d'une date (au plus `maxDays` jours d'écart), sinon null. */
export function nearestWeight(
  weights: readonly BodyWeightPoint[],
  date: string,
  maxDays = 10,
): number | null {
  const t = dayMs(date);
  let best: number | null = null;
  let bestGap = Infinity;
  for (const w of weights) {
    if (!ok(w.weight)) continue;
    const gap = Math.abs(dayMs(w.date) - t);
    if (gap < bestGap) {
      bestGap = gap;
      best = w.weight;
    }
  }
  return bestGap <= maxDays * DAY ? best : null;
}

/** Série chronologique du % estimé : une valeur par mesure complète, avec les masses si une pesée est proche. */
export function bodyFatSeries(
  measurements: readonly BodyFatMeasurement[],
  weights: readonly BodyWeightPoint[],
  profile: { sex: BodySex; heightCm: number } | null,
): BodyFatPoint[] {
  if (!profile) return [];
  const out: BodyFatPoint[] = [];
  for (const m of [...measurements].sort((a, b) => a.date.localeCompare(b.date))) {
    const pct = navyBodyFatPct({
      sex: profile.sex,
      heightCm: profile.heightCm,
      waistCm: m.waist ?? 0,
      neckCm: m.neck ?? 0,
      hipsCm: m.hips ?? null,
    });
    if (pct === null) continue;
    const weightKg = nearestWeight(weights, m.date);
    const masses = weightKg === null ? null : bodyFatMasses(weightKg, pct);
    out.push({
      date: m.date,
      pct,
      weightKg,
      fatKg: masses?.fatKg ?? null,
      leanKg: masses?.leanKg ?? null,
    });
  }
  return out;
}

/** Mesures qui manquent pour l'estimation (libellés français), vide si tout est là. */
export function missingNavyInputs(
  latest: BodyFatMeasurement | null,
  profile: { sex: BodySex; heightCm: number } | null,
): string[] {
  const missing: string[] = [];
  if (!profile || !ok(profile.heightCm)) missing.push('ta taille (profil)');
  if (!ok(latest?.neck)) missing.push('le tour de cou');
  if (!ok(latest?.waist)) missing.push('le tour de taille');
  if (profile?.sex === 'female' && !ok(latest?.hips)) missing.push('le tour de hanches');
  return missing;
}

/**
 * Mesures complètes mais inutilisables (taille ≤ cou, taille de profil
 * improbable, résultat hors plage) : message clair, sinon null.
 */
export function navyInputIssue(
  latest: BodyFatMeasurement | null,
  profile: { sex: BodySex; heightCm: number } | null,
): string | null {
  if (!latest || !profile || missingNavyInputs(latest, profile).length) return null;
  const input: NavyInput = {
    sex: profile.sex,
    heightCm: profile.heightCm,
    waistCm: latest.waist!,
    neckCm: latest.neck!,
    hipsCm: latest.hips ?? null,
  };
  if (navyBodyFatPct(input) !== null) return null;
  if (profile.heightCm < 100 || profile.heightCm > 250)
    return `Ta taille de profil (${Math.round(profile.heightCm)} cm) semble incorrecte : corrige-la pour obtenir l'estimation.`;
  const girth = profile.sex === 'female' ? input.waistCm + (input.hipsCm ?? 0) : input.waistCm;
  if (girth <= input.neckCm)
    return 'Le tour de taille doit être plus grand que le tour de cou : vérifie ta dernière mesure.';
  return 'Ta dernière mesure donne un résultat improbable : vérifie le cou et la taille.';
}

// ─── Comparateur de photos ──────────────────────────────────────────────────

export interface ComparablePhoto {
  id: string;
  takenAt: string;
  label?: string;
  bodyweightKg?: number;
}

/**
 * Paire par défaut : la plus ancienne et la plus récente d'une même pose —
 * celle de la dernière photo si elle en a au moins deux, sinon la pose la plus
 * fournie ; à défaut, la plus ancienne et la plus récente toutes poses confondues.
 */
export function defaultComparePair(
  photos: readonly ComparablePhoto[],
): { beforeId: string; afterId: string } | null {
  if (photos.length < 2) return null;
  const sorted = [...photos].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const byPose = new Map<string, ComparablePhoto[]>();
  for (const p of sorted) {
    const k = p.label ?? '';
    byPose.set(k, [...(byPose.get(k) ?? []), p]);
  }
  const last = sorted.at(-1)!;
  let group = byPose.get(last.label ?? '')!;
  if (group.length < 2) {
    group = [...byPose.values()].reduce((a, b) => (b.length > a.length ? b : a), group);
  }
  if (group.length < 2) group = sorted;
  return { beforeId: group[0]!.id, afterId: group.at(-1)!.id };
}

/** Durée entre deux dates : « 5 jours », « 12 semaines », « 7 mois ». */
export function durationLabel(fromIso: string, toIso: string): string {
  const days = Math.round(Math.abs(dayMs(toIso) - dayMs(fromIso)) / DAY);
  if (days === 0) return 'le même jour';
  if (days < 14) return days === 1 ? '1 jour' : `${days} jours`;
  if (days < 182) return `${Math.round(days / 7)} semaines`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} mois`;
  return `${Math.round(days / 365.25)} ans`;
}

/** Variation signée en français : « −3,2 kg », « +0,4 kg », « 0,0 kg ». */
export function signedKg(delta: number): string {
  const abs = Math.abs(delta).toFixed(1).replace('.', ',');
  if (abs === '0,0') return '0,0 kg';
  return (delta > 0 ? '+' : '−') + abs + ' kg';
}

/**
 * Écart entre deux photos : « 12 semaines · −3,2 kg ». Le poids vient de la
 * photo, sinon de la pesée la plus proche ; absent si l'un des deux manque.
 */
export function photoGapLabel(
  before: ComparablePhoto,
  after: ComparablePhoto,
  weights: readonly BodyWeightPoint[] = [],
): string {
  const parts = [durationLabel(before.takenAt, after.takenAt)];
  const wOf = (p: ComparablePhoto) =>
    ok(p.bodyweightKg) ? p.bodyweightKg : nearestWeight(weights, p.takenAt, 4);
  const wb = wOf(before);
  const wa = wOf(after);
  if (wb !== null && wa !== null) parts.push(signedKg(wa - wb));
  return parts.join(' · ');
}

/** Position du curseur du comparateur (0–100 %) depuis une abscisse dans le cadre. */
export function splitPercent(x: number, left: number, width: number): number {
  if (!(width > 0)) return 50;
  const p = ((x - left) / width) * 100;
  return Math.round(Math.max(0, Math.min(100, p)) * 10) / 10;
}
