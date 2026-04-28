/**
 * Goals Domain — objectifs hebdomadaires d'entraînement.
 *
 * Calcule l'état des objectifs (séances + tonnage) pour la semaine courante,
 * basé uniquement sur des entrées brutes (sessions). Pure, sans I/O.
 *
 * La règle d'attribution du bonus XP (+100 si all goals atteints) est isolée
 * dans `shouldAwardWeeklyBonusXp` — testable indépendamment du stockage.
 */

export interface WeeklyGoalTargets {
  targetSessions:  number;
  targetTonnageKg: number;
}

export interface SessionLike {
  startedAt: string;
  endedAt?:  string;
  entries: ReadonlyArray<{
    sets: ReadonlyArray<{ reps: number; weightKg: number }>;
  }>;
}

export interface WeeklyGoalsState {
  weekKey:         string;       // ISO date du lundi de la semaine
  doneSessions:    number;
  doneTonnageKg:   number;
  sessionsPercent: number;       // 0..100
  tonnagePercent:  number;       // 0..100 (100 si target=0)
  sessionsOk:      boolean;
  tonnageOk:       boolean;
  allOk:           boolean;
}

/** Date du lundi 00:00:00 UTC de la semaine contenant `now`. */
export function startOfWeek(now: Date = new Date()): Date {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;       // lundi=0
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Identifiant compact de la semaine (yyyy-mm-dd du lundi). */
export function weekKey(now: Date = new Date()): string {
  return startOfWeek(now).toISOString().slice(0, 10);
}

/** État courant des objectifs hebdo, dérivé des sessions terminées. */
export function evaluateWeeklyGoals(
  sessions: readonly SessionLike[],
  targets:  WeeklyGoalTargets,
  now:      Date = new Date(),
): WeeklyGoalsState {
  const weekStartMs = startOfWeek(now).getTime();
  const weekSessions = sessions.filter(s =>
    Boolean(s.endedAt) && Date.parse(s.startedAt) >= weekStartMs
  );

  const doneSessions = weekSessions.length;
  const doneTonnageKg = Math.round(
    weekSessions.reduce((acc, s) =>
      acc + s.entries.reduce((a2, e) =>
        a2 + e.sets.reduce((a3, set) => a3 + set.reps * set.weightKg, 0), 0), 0)
  );

  const sessionsPercent = targets.targetSessions <= 0
    ? 100
    : Math.min(100, Math.round((doneSessions / targets.targetSessions) * 100));
  const tonnagePercent  = targets.targetTonnageKg <= 0
    ? 100
    : Math.min(100, Math.round((doneTonnageKg / targets.targetTonnageKg) * 100));

  // A disabled target (≤ 0) is vacuously satisfied — we don't penalise the
  // user for not hitting a goal they never set.  But allOk additionally
  // requires that at least ONE target is active, otherwise an empty config
  // would mint a free weekly XP bonus.
  const sessionsOk = targets.targetSessions  <= 0 || doneSessions  >= targets.targetSessions;
  const tonnageOk  = targets.targetTonnageKg <= 0 || doneTonnageKg >= targets.targetTonnageKg;

  const hasActiveTarget = targets.targetSessions > 0 || targets.targetTonnageKg > 0;

  return {
    weekKey: weekKey(now),
    doneSessions,
    doneTonnageKg,
    sessionsPercent,
    tonnagePercent,
    sessionsOk,
    tonnageOk,
    allOk: hasActiveTarget && sessionsOk && tonnageOk,
  };
}

/**
 * Renvoie true si on doit créditer le bonus XP +100 pour la semaine.
 * Idempotent : ne re-crédite pas si `lastAwardedWeekKey` correspond déjà.
 */
export function shouldAwardWeeklyBonusXp(
  state: Pick<WeeklyGoalsState, 'allOk' | 'weekKey'>,
  lastAwardedWeekKey: string,
): boolean {
  return state.allOk && lastAwardedWeekKey !== state.weekKey;
}

export const WEEKLY_GOAL_BONUS_XP = 100;
