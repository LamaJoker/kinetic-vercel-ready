/**
 * Achievements Domain — système de badges/milestones débloqués par l'activité.
 *
 * Distinct du système REWARDS qui suit les paliers XP (récompenses linéaires).
 * Les achievements ici sont déclenchés par des EXPLOITS spécifiques :
 *   - "Première séance"
 *   - "10/50/100 séances complétées"
 *   - "Première PR" → "10 PR" → "50 PR"
 *   - "Bench 60 / 80 / 100 / 140 kg" (etc. pour squat, deadlift)
 *   - "Streak 7 / 30 / 100 jours"
 *   - "Volume 10/50/100 t cumulé"
 *
 * Pur, déterministe. L'appelant fournit les inputs (sessions, e1rm best,
 * streak) et reçoit la liste des IDs débloqués. La persistance des unlocks
 * vit côté store (idempotence par diff entre l'ancien set et le nouveau).
 */

// ─── Définition d'un achievement ─────────────────────────────────────────────

export interface Achievement {
  id: string;
  title: string;
  description: string;
  emoji: string;
  /** Catégorie pour le tri / affichage. */
  category: 'milestone' | 'strength' | 'streak' | 'volume' | 'pr';
  /** Difficulté indicative (1=facile, 5=très dur). */
  tier: 1 | 2 | 3 | 4 | 5;
}

// ─── Catalogue ───────────────────────────────────────────────────────────────

const SESSION_MILESTONES: Array<{ count: number; tier: 1 | 2 | 3 | 4 | 5; emoji: string }> = [
  { count: 1, tier: 1, emoji: '🥇' },
  { count: 10, tier: 1, emoji: '🔟' },
  { count: 25, tier: 2, emoji: '🎯' },
  { count: 50, tier: 3, emoji: '🏅' },
  { count: 100, tier: 4, emoji: '💯' },
  { count: 250, tier: 5, emoji: '🏆' },
];

const STREAK_MILESTONES: Array<{ days: number; tier: 1 | 2 | 3 | 4 | 5; emoji: string }> = [
  { days: 3, tier: 1, emoji: '🔥' },
  { days: 7, tier: 2, emoji: '⚡' },
  { days: 14, tier: 3, emoji: '⚔️' },
  { days: 30, tier: 4, emoji: '🐉' },
  { days: 100, tier: 5, emoji: '👑' },
];

const PR_MILESTONES: Array<{ count: number; tier: 1 | 2 | 3 | 4 | 5; emoji: string }> = [
  { count: 1, tier: 1, emoji: '✨' },
  { count: 5, tier: 2, emoji: '🌟' },
  { count: 10, tier: 3, emoji: '💫' },
  { count: 25, tier: 4, emoji: '🌠' },
  { count: 50, tier: 5, emoji: '🪐' },
];

const VOLUME_MILESTONES: Array<{ tonnes: number; tier: 1 | 2 | 3 | 4 | 5; emoji: string }> = [
  { tonnes: 1, tier: 1, emoji: '🏋️' },
  { tonnes: 10, tier: 2, emoji: '🏗️' },
  { tonnes: 50, tier: 3, emoji: '🪨' },
  { tonnes: 100, tier: 4, emoji: '🗿' },
  { tonnes: 500, tier: 5, emoji: '⚒️' },
];

// Paliers de force par "lift signature" — pourquoi ces 3 : ce sont les Big Three
// du powerlifting (bench, squat, deadlift). On les détecte par mots-clés dans
// le nom de l'exercice (les imports Strong/Hevy n'ont pas d'id stable).
type LiftKey = 'bench' | 'squat' | 'deadlift';
const STRENGTH_TARGETS: Record<LiftKey, number[]> = {
  bench: [60, 80, 100, 120, 140, 180],
  squat: [80, 100, 140, 180, 220, 260],
  deadlift: [100, 140, 180, 220, 260, 300],
};
const LIFT_PATTERNS: Record<LiftKey, RegExp> = {
  bench: /(bench\s*press|développé\s*couché)/i,
  squat: /(back\s*squat|^squat|squat\s*barre)/i,
  deadlift: /(dead\s*lift|deadlift|soulevé\s*de\s*terre)/i,
};

const STRENGTH_TIERS: (1 | 2 | 3 | 4 | 5)[] = [1, 2, 3, 4, 5, 5];
const STRENGTH_EMOJIS: Record<LiftKey, string> = {
  bench: '💪',
  squat: '🦵',
  deadlift: '🏋️‍♂️',
};
const STRENGTH_LABELS: Record<LiftKey, string> = {
  bench: 'Bench',
  squat: 'Squat',
  deadlift: 'Deadlift',
};

// ─── Construction du catalogue plat ──────────────────────────────────────────

export function buildAchievementCatalog(): Achievement[] {
  const list: Achievement[] = [];

  for (const m of SESSION_MILESTONES) {
    list.push({
      id: `sessions:${m.count}`,
      title: `${m.count} séance${m.count > 1 ? 's' : ''}`,
      description:
        m.count === 1 ? 'Première séance complétée — bienvenue !' : `${m.count} séances terminées.`,
      emoji: m.emoji,
      category: 'milestone',
      tier: m.tier,
    });
  }

  for (const m of STREAK_MILESTONES) {
    list.push({
      id: `streak:${m.days}`,
      title: `Streak ${m.days} j`,
      description: `${m.days} jours d'activité consécutifs.`,
      emoji: m.emoji,
      category: 'streak',
      tier: m.tier,
    });
  }

  for (const m of PR_MILESTONES) {
    list.push({
      id: `pr:${m.count}`,
      title: m.count === 1 ? 'Premier record' : `${m.count} PR`,
      description: `${m.count} record${m.count > 1 ? 's' : ''} personnel${m.count > 1 ? 's' : ''} atteint${m.count > 1 ? 's' : ''}.`,
      emoji: m.emoji,
      category: 'pr',
      tier: m.tier,
    });
  }

  for (const m of VOLUME_MILESTONES) {
    list.push({
      id: `volume:${m.tonnes}t`,
      title: `${m.tonnes}t cumulés`,
      description: `${m.tonnes} tonnes de volume total soulevé.`,
      emoji: m.emoji,
      category: 'volume',
      tier: m.tier,
    });
  }

  for (const lift of ['bench', 'squat', 'deadlift'] as LiftKey[]) {
    STRENGTH_TARGETS[lift].forEach((kg, i) => {
      list.push({
        id: `strength:${lift}:${kg}`,
        title: `${STRENGTH_LABELS[lift]} ${kg} kg`,
        description: `e1RM ${STRENGTH_LABELS[lift].toLowerCase()} ≥ ${kg} kg.`,
        emoji: STRENGTH_EMOJIS[lift],
        category: 'strength',
        tier: STRENGTH_TIERS[i] ?? 3,
      });
    });
  }

  return list;
}

// ─── Détection ───────────────────────────────────────────────────────────────

export interface AchievementInput {
  totalCompletedSessions: number;
  bestStreak: number;
  totalPRs: number;
  totalTonnageKg: number;
  /** Pour chaque pattern de lift (bench/squat/deadlift), le meilleur e1RM observé. */
  bestE1rmByLift: Partial<Record<LiftKey, number>>;
}

/**
 * detectLiftKey — classifie un nom d'exercice en LiftKey si reconnu.
 * Utilisé par l'appelant pour construire bestE1rmByLift à partir des
 * exercises + sessions.
 */
export function detectLiftKey(exerciseName: string): LiftKey | null {
  for (const [key, pattern] of Object.entries(LIFT_PATTERNS) as Array<[LiftKey, RegExp]>) {
    if (pattern.test(exerciseName)) return key;
  }
  return null;
}

/**
 * computeUnlocked — liste les achievement IDs débloqués par l'état actuel.
 * Pur ; à appeler avec l'état actuel et comparer au précédent pour détecter
 * les nouveaux unlocks (à afficher en toast).
 */
export function computeUnlocked(input: AchievementInput): string[] {
  const unlocked: string[] = [];

  for (const m of SESSION_MILESTONES) {
    if (input.totalCompletedSessions >= m.count) unlocked.push(`sessions:${m.count}`);
  }
  for (const m of STREAK_MILESTONES) {
    if (input.bestStreak >= m.days) unlocked.push(`streak:${m.days}`);
  }
  for (const m of PR_MILESTONES) {
    if (input.totalPRs >= m.count) unlocked.push(`pr:${m.count}`);
  }
  for (const m of VOLUME_MILESTONES) {
    if (input.totalTonnageKg >= m.tonnes * 1000) unlocked.push(`volume:${m.tonnes}t`);
  }

  for (const lift of ['bench', 'squat', 'deadlift'] as LiftKey[]) {
    const best = input.bestE1rmByLift[lift] ?? 0;
    for (const kg of STRENGTH_TARGETS[lift]) {
      if (best >= kg) unlocked.push(`strength:${lift}:${kg}`);
    }
  }

  return unlocked;
}

/** newlyUnlocked — diff entre l'état précédent et le nouveau (ordre préservé). */
export function newlyUnlocked(previous: readonly string[], current: readonly string[]): string[] {
  const prev = new Set(previous);
  return current.filter((id) => !prev.has(id));
}
