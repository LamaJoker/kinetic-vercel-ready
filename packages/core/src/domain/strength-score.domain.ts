/**
 * Strength Scores — formules normalisées qui permettent de comparer la force
 * relative entre athlètes de poids et de sexes différents.
 *
 * Trois formules :
 *   - Wilks (2020 update) : référence historique IPF
 *   - IPF GL Points (2020) : remplace officiellement Wilks à l'IPF
 *   - DOTS : alternative open-source plus simple à computer
 *
 * Sources :
 *   - International Powerlifting Federation — IPF GL Coefficients (2020)
 *   - Robert Wilks — Wilks Coefficient formula (1994, révisé 2020)
 *   - Tim Konertz — DOTS Score (2019, openpowerlifting.org)
 *
 * Pur — aucune dépendance, aucun I/O. Tous les inputs en kg.
 */

export type StrengthSex = 'male' | 'female';

// ─── Wilks 2020 ─────────────────────────────────────────────────────────────

/**
 * Coefficients Wilks 2020 (Polynôme degré 5 en bodyweight, kg).
 * Source : https://www.ironcompany.com/blogs/news/calculate-your-wilks-score
 *           (officiels IPF jusqu'en 2020, encore largement utilisés).
 */
const WILKS_COEF_MALE_2020 = {
  a: 47.46178854,
  b: 8.472061379,
  c: 0.07369410346,
  d: -0.001395833811,
  e: 7.07665973070743e-6,
  f: -1.20804336482315e-8,
};

const WILKS_COEF_FEMALE_2020 = {
  a: -125.4255398,
  b: 13.71219419,
  c: -0.03307250631,
  d: -0.001050400051,
  e: 9.38773881462799e-6,
  f: -2.3334613884954e-8,
};

/**
 * wilks2020 — retourne le score Wilks pour un total (en kg) et un bodyweight.
 *
 * Domaine valide : 40 ≤ bodyweight ≤ 200 kg. Hors plage on retourne 0
 * (le polynôme n'est pas calibré, valeur sans sens).
 */
export function wilks2020(totalKg: number, bodyweightKg: number, sex: StrengthSex): number {
  if (!Number.isFinite(totalKg) || totalKg <= 0) return 0;
  if (!Number.isFinite(bodyweightKg) || bodyweightKg < 40 || bodyweightKg > 200) return 0;
  const c = sex === 'female' ? WILKS_COEF_FEMALE_2020 : WILKS_COEF_MALE_2020;
  const x = bodyweightKg;
  const denom = c.a + c.b * x + c.c * x ** 2 + c.d * x ** 3 + c.e * x ** 4 + c.f * x ** 5;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  const score = totalKg * (500 / denom);
  return Math.round(score * 100) / 100;
}

// ─── IPF GL Points 2020 ─────────────────────────────────────────────────────

/**
 * Coefficients IPF GL (Goodlift Points), discipline RAW Powerlifting.
 * Formule : GL = totalKg × (100 / (A − B × exp(−C × bw)))
 *
 * Source officielle : IPF Technical Rules 2020, Annexe 7.
 * NB : il existe aussi des coefficients pour bench-only, deadlift-only,
 * et pour single-ply ; on n'expose que RAW classique pour rester focus.
 */
const IPF_GL_RAW_MALE = { A: 1199.72839, B: 1025.18162, C: 0.00921 };
const IPF_GL_RAW_FEMALE = { A: 610.32796, B: 1045.59282, C: 0.03048 };

export function ipfGoodlift(totalKg: number, bodyweightKg: number, sex: StrengthSex): number {
  if (!Number.isFinite(totalKg) || totalKg <= 0) return 0;
  if (!Number.isFinite(bodyweightKg) || bodyweightKg < 35 || bodyweightKg > 250) return 0;
  const k = sex === 'female' ? IPF_GL_RAW_FEMALE : IPF_GL_RAW_MALE;
  const denom = k.A - k.B * Math.exp(-k.C * bodyweightKg);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  const score = totalKg * (100 / denom);
  return Math.round(score * 100) / 100;
}

// ─── DOTS Score ─────────────────────────────────────────────────────────────

/**
 * DOTS (Dynamic Objective Team Scoring) — Tim Konertz, 2019.
 * Alternative simple à Wilks. Polynôme degré 4 en bodyweight.
 *
 * Source : openpowerlifting.org/changelog#dots
 */
const DOTS_COEF_MALE = [-307.75076, 24.0900756, -0.1918759221, 0.0007391293, -1.093e-6];
const DOTS_COEF_FEMALE = [-57.96288, 13.6175032, -0.1126655495, 0.0005158568, -1.0706e-6];

export function dotsScore(totalKg: number, bodyweightKg: number, sex: StrengthSex): number {
  if (!Number.isFinite(totalKg) || totalKg <= 0) return 0;
  if (!Number.isFinite(bodyweightKg) || bodyweightKg < 40 || bodyweightKg > 200) return 0;
  const c = sex === 'female' ? DOTS_COEF_FEMALE : DOTS_COEF_MALE;
  const x = Math.min(210, Math.max(40, bodyweightKg));
  const denom = c[0]! + c[1]! * x + c[2]! * x ** 2 + c[3]! * x ** 3 + c[4]! * x ** 4;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  const score = totalKg * (500 / denom);
  return Math.round(score * 100) / 100;
}

// ─── Classification verbale ─────────────────────────────────────────────────

export type StrengthTier = 'beginner' | 'novice' | 'intermediate' | 'advanced' | 'elite';

/**
 * tierFromIpfGl — classification simple par tranches IPF GL.
 * Approximative — les seuils exacts varient par fédération.
 */
export function tierFromIpfGl(score: number): StrengthTier {
  if (score >= 90) return 'elite';
  if (score >= 75) return 'advanced';
  if (score >= 60) return 'intermediate';
  if (score >= 45) return 'novice';
  return 'beginner';
}
