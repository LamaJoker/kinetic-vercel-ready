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
  targetSessions: number;
  targetTonnageKg: number;
}

export interface SessionLike {
  startedAt: string;
  endedAt?: string;
  entries: ReadonlyArray<{
    sets: ReadonlyArray<{ reps: number; weightKg: number }>;
  }>;
}

export interface WeeklyGoalsState {
  weekKey: string; // ISO date du lundi de la semaine (fuseau local)
  doneSessions: number;
  doneTonnageKg: number;
  sessionsPercent: number; // 0..100
  tonnagePercent: number; // 0..100 (100 si target=0)
  sessionsOk: boolean;
  tonnageOk: boolean;
  allOk: boolean;
}

/**
 * localIsoDate — formate une Date en "YYYY-MM-DD" dans le fuseau LOCAL.
 *
 * On n'utilise PAS toISOString() qui retourne UTC — en UTC+14 (Kiribati) ou
 * UTC-12 (Baker Island), le lundi local peut être dimanche ou mardi UTC.
 * ClockPort.todayIsoDate() retourne déjà la date locale ; startOfWeek() doit
 * rester cohérent avec cette convention.
 */
function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * startOfWeek — retourne le lundi 00:00:00 LOCAL de la semaine contenant `now`.
 *
 * BUG FIX #4 : l'ancienne implémentation utilisait `d.getUTCDay()` pour
 * déterminer le jour de la semaine, mais travaillait ensuite avec `setDate()`
 * (fuseau local). Ce mélange UTC/local produisait le mauvais lundi pour tous
 * les fuseaux décalés de ±N jours entiers par rapport à UTC (ex: UTC+14,
 * UTC-12). On utilise désormais `getDay()` (fuseau local) de façon cohérente.
 *
 * getDay() : 0 = dimanche, 1 = lundi, …, 6 = samedi (norme JS).
 * Formule : (getDay() + 6) % 7 → 0 = lundi, …, 6 = dimanche (norme ISO 8601).
 */
export function startOfWeek(now: Date = new Date()): Date {
  const d = new Date(now);
  // Nombre de jours à reculer pour atteindre le lundi (fuseau LOCAL)
  const dayOffset = (d.getDay() + 6) % 7; // lundi = 0, dimanche = 6
  d.setDate(d.getDate() - dayOffset);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Identifiant compact de la semaine (YYYY-MM-DD du lundi, fuseau local). */
export function weekKey(now: Date = new Date()): string {
  return localIsoDate(startOfWeek(now));
}

/** État courant des objectifs hebdo, dérivé des sessions terminées. */
export function evaluateWeeklyGoals(
  sessions: readonly SessionLike[],
  targets: WeeklyGoalTargets,
  now: Date = new Date(),
): WeeklyGoalsState {
  // startOfWeek retourne un Date en fuseau local, .getTime() est donc correct
  // pour comparer avec Date.parse(session.startedAt) qui est aussi en ms UTC.
  const weekStartMs = startOfWeek(now).getTime();
  const weekSessions = sessions.filter(
    (s) => Boolean(s.endedAt) && Date.parse(s.startedAt) >= weekStartMs,
  );

  const doneSessions = weekSessions.length;
  const doneTonnageKg = Math.round(
    weekSessions.reduce(
      (acc, s) =>
        acc +
        s.entries.reduce(
          (a2, e) => a2 + e.sets.reduce((a3, set) => a3 + set.reps * set.weightKg, 0),
          0,
        ),
      0,
    ),
  );

  const sessionsPercent =
    targets.targetSessions <= 0
      ? 100
      : Math.min(100, Math.round((doneSessions / targets.targetSessions) * 100));
  const tonnagePercent =
    targets.targetTonnageKg <= 0
      ? 100
      : Math.min(100, Math.round((doneTonnageKg / targets.targetTonnageKg) * 100));

  const sessionsOk = targets.targetSessions <= 0 || doneSessions >= targets.targetSessions;
  const tonnageOk = targets.targetTonnageKg <= 0 || doneTonnageKg >= targets.targetTonnageKg;

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
