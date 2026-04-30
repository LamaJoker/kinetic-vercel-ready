/**
 * XP Domain — moteur de progression par points d'expérience.
 *
 * Responsabilités :
 *   - Définir les niveaux et leurs seuils
 *   - Calculer le niveau courant depuis le total XP
 *   - Calculer la progression vers le niveau suivant
 *   - Valider les montants de XP accordés
 *
 * Aucune dépendance externe — logique pure et testable.
 */

// ─── Niveaux ────────────────────────────────────────────────────────────────

export interface Level {
  level:     number;
  title:     string;
  threshold: number; // XP minimum pour atteindre ce niveau
}

export const LEVELS: readonly Level[] = [
  { level: 1, title: 'Rookie',    threshold: 0     },
  { level: 2, title: 'Apprenti',  threshold: 200   },
  { level: 3, title: 'Confirmé',  threshold: 500   },
  { level: 4, title: 'Expert',    threshold: 1_000 },
  { level: 5, title: 'Elite',     threshold: 2_000 },
  { level: 6, title: 'Champion',  threshold: 3_500 },
  { level: 7, title: 'Maître',    threshold: 5_500 },
  { level: 8, title: 'Légende',   threshold: 8_000 },
] as const;

// ─── État XP ─────────────────────────────────────────────────────────────────

export interface XpState {
  xp:              number;
  currentLevel:    number;
  title:           string;
  progressPercent: number; // 0–100 vers le prochain niveau
  remaining:       number; // XP manquant pour le prochain niveau
  isMaxLevel:      boolean;
}

// ─── Fonctions pures ─────────────────────────────────────────────────────────

/**
 * computeXpState — calcule l'état complet depuis un total XP.
 * O(n) sur le nombre de niveaux (≤ 8), négligeable.
 */
export function computeXpState(totalXp: number): XpState {
  if (totalXp < 0) throw new RangeError(`XP ne peut pas être négatif : ${totalXp}`);

  let current: Level = LEVELS[0]!;
  let next:    Level | undefined;

  for (let i = 0; i < LEVELS.length; i++) {
    if (totalXp >= LEVELS[i]!.threshold) {
      current = LEVELS[i]!;
      next    = LEVELS[i + 1];
    }
  }

  const xpInLevel   = totalXp - current.threshold;
  const xpForNext   = next ? next.threshold - current.threshold : 1;
  const progressPct = next
    ? Math.min(100, Math.round((xpInLevel / xpForNext) * 100))
    : 100;

  return {
    xp:              totalXp,
    currentLevel:    current.level,
    title:           current.title,
    progressPercent: progressPct,
    remaining:       next ? next.threshold - totalXp : 0,
    isMaxLevel:      !next,
  };
}

/**
 * addXp — retourne le nouveau total après ajout.
 * Lance une erreur si le montant est invalide.
 */
export function addXp(currentXp: number, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RangeError(`Montant XP invalide : ${amount}`);
  }
  if (!Number.isFinite(currentXp) || currentXp < 0) {
    throw new RangeError(`XP courant invalide : ${currentXp}`);
  }
  return currentXp + amount;
}

/**
 * didLevelUp — retourne true si l'ajout de XP a causé un changement de niveau.
 */
export function didLevelUp(xpBefore: number, xpAfter: number): boolean {
  return computeXpState(xpBefore).currentLevel < computeXpState(xpAfter).currentLevel;
}

/**
 * getNewLevel — retourne le nouveau niveau si level-up, null sinon.
 */
export function getNewLevel(xpBefore: number, xpAfter: number): Level | null {
  const before = computeXpState(xpBefore);
  const after  = computeXpState(xpAfter);
  if (after.currentLevel > before.currentLevel) {
    return LEVELS.find((l) => l.level === after.currentLevel) ?? null;
  }
  return null;
}

// ─── Récompenses par niveau ──────────────────────────────────────────────────

export type RewardKind = 'base' | 'history' | 'coach' | 'xp_boost' | 'streak_freeze' | 'theme' | 'badge';

export interface Reward {
  /** Niveau requis pour débloquer cette récompense. */
  level:       number;
  emoji:       string;
  title:       string;
  description: string;
  kind:        RewardKind;
}

/**
 * REWARDS — une récompense concrète par niveau.
 * Les effets fonctionnels sont appliqués dans les stores Alpine
 * qui lisent `$store.rewards.*` ou `$store.xp.currentLevel`.
 */
export const REWARDS: readonly Reward[] = [
  {
    level: 1,
    emoji: '⚡',
    title: 'App débloquée',
    description: 'Accès à toutes les fonctionnalités de base de Kinetic.',
    kind: 'base',
  },
  {
    level: 2,
    emoji: '📅',
    title: 'Historique 14 jours',
    description: 'Remonte jusqu\'à 14 jours dans ton historique de routine vitalité.',
    kind: 'history',
  },
  {
    level: 3,
    emoji: '🎯',
    title: 'Coach Avancé',
    description: 'Le Coach IA affiche des notes de périodisation et l\'indice de fatigue RPE.',
    kind: 'coach',
  },
  {
    level: 4,
    emoji: '📊',
    title: 'Historique 30 jours',
    description: 'Visualise un mois complet d\'historique pour analyser tes tendances.',
    kind: 'history',
  },
  {
    level: 5,
    emoji: '⚡',
    title: 'Bonus XP +20 %',
    description: 'Toutes tes tâches vitalité accordent 20 % de XP en plus. Bien mérité.',
    kind: 'xp_boost',
  },
  {
    level: 6,
    emoji: '🧊',
    title: 'Gel de Streak',
    description: '1 jeton par semaine pour protéger ton streak sans activité ce jour-là.',
    kind: 'streak_freeze',
  },
  {
    level: 7,
    emoji: '🎨',
    title: 'Thèmes de couleur',
    description: '5 palettes de couleurs débloquées : Électrique, Cyber, Violet, Phoenix, Fantôme.',
    kind: 'theme',
  },
  {
    level: 8,
    emoji: '👑',
    title: 'Badge Légende',
    description: 'Profil doré. Tu as tout débloqué — tu es une légende Kinetic.',
    kind: 'badge',
  },
] as const;

/** Retourne la récompense associée à un niveau, ou undefined. */
export function getRewardForLevel(level: number): Reward | undefined {
  return REWARDS.find((r) => r.level === level);
}
