/**
 * Progression vers le prochain palier d'un succès (page Succès).
 *
 * Le store `achievements` garde les mesures qui servent à débloquer
 * (`metrics` : séances, meilleure série, PR, tonnage, e1RM des Big Three) ;
 * ce module, pur, en déduit pour un succès verrouillé « où on en est ».
 *
 * Seul le PROCHAIN palier de chaque série (premier verrouillé dans l'ordre du
 * catalogue : sessions, streak, pr, volume, strength:<lift>) montre une
 * barre ; les suivants restent en silhouette.
 */

export interface AchievementMetrics {
  totalCompletedSessions: number;
  bestStreak: number;
  totalPRs: number;
  totalTonnageKg: number;
  bestE1rmByLift: Partial<Record<'bench' | 'squat' | 'deadlift', number>>;
}

export interface AchievementProgress {
  current: number;
  target: number;
  /** 0 → 1 */
  ratio: number;
  /** « 32 / 50 séances », « 4,2 / 10 t », « 92 / 100 kg »… */
  label: string;
}

const fmt = (n: number, digits = 0): string =>
  n.toLocaleString('fr-FR', { maximumFractionDigits: digits }).replace(/[\u202f\u00a0]/g, '\u202f');

/** Série d'un succès : « sessions », « streak », « pr », « volume », « strength:bench »… */
export function achievementSeries(id: string): string {
  const i = id.lastIndexOf(':');
  return i > 0 ? id.slice(0, i) : id;
}

/** Mesure courante / cible d'un succès d'après son id ; null si inconnu. */
export function achievementProgress(
  id: string,
  m: AchievementMetrics | null | undefined,
): AchievementProgress | null {
  if (!m) return null;
  const parts = id.split(':');
  const kind = parts[0];
  let current: number;
  let target: number;
  let label: (c: number, t: number) => string;
  switch (kind) {
    case 'sessions':
      target = Number(parts[1]);
      current = m.totalCompletedSessions;
      label = (c, t) => `${fmt(c)} / ${fmt(t)} séance${t > 1 ? 's' : ''}`;
      break;
    case 'streak':
      target = Number(parts[1]);
      current = m.bestStreak;
      label = (c, t) => `${fmt(c)} / ${fmt(t)} jours`;
      break;
    case 'pr':
      target = Number(parts[1]);
      current = m.totalPRs;
      label = (c, t) => `${fmt(c)} / ${fmt(t)} PR`;
      break;
    case 'volume':
      target = Number(String(parts[1]).replace(/t$/, ''));
      current = m.totalTonnageKg / 1000;
      label = (c, t) => `${fmt(c, c < 10 ? 1 : 0)} / ${fmt(t)} t`;
      break;
    case 'strength': {
      const lift = parts[1] as keyof AchievementMetrics['bestE1rmByLift'];
      target = Number(parts[2]);
      current = m.bestE1rmByLift[lift] ?? 0;
      label = (c, t) => `e1RM ${fmt(c)} / ${fmt(t)}\u00a0kg`;
      break;
    }
    default:
      return null;
  }
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(current)) return null;
  const shown = Math.max(0, Math.min(current, target));
  return { current: shown, target, ratio: shown / target, label: label(shown, target) };
}

/**
 * Vrai si `id` est le premier succès verrouillé de sa série (ordre du
 * catalogue = ordre croissant des paliers).
 */
export function isNextTier(
  id: string,
  catalogIds: readonly string[],
  isUnlocked: (id: string) => boolean,
): boolean {
  if (isUnlocked(id)) return false;
  const series = achievementSeries(id);
  for (const other of catalogIds) {
    if (achievementSeries(other) !== series) continue;
    if (!isUnlocked(other)) return other === id;
  }
  return false;
}
