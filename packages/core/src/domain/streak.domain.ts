/**
 * Streak Domain — moteur de séries de jours consécutifs.
 *
 * Règles métier :
 *   - Un streak s'incrémente si l'utilisateur est actif le jour suivant.
 *   - Un streak est maintenu si l'utilisateur est actif le même jour.
 *   - Un streak se réinitialise à 1 si plus d'un jour s'est écoulé.
 *   - Le best streak ne diminue jamais.
 *   - Les dates sont comparées en jours calendaires locaux (pas en ms).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StreakState {
  count:          number;          // Streak actuel
  best:           number;          // Meilleur streak historique
  lastActiveDate: string | null;   // "YYYY-MM-DD" en TZ locale
}

// ─── Fonctions pures ──────────────────────────────────────────────────────────

/**
 * createStreak — état initial vide.
 */
export function createStreak(): StreakState {
  return { count: 0, best: 0, lastActiveDate: null };
}

/**
 * processActivity — met à jour le streak pour une date d'activité.
 *
 * @param state    État courant du streak
 * @param todayIso Date locale "YYYY-MM-DD"
 * @returns        Nouvel état (immutable)
 */
export function processActivity(state: StreakState, todayIso: string): StreakState {
  validateIsoDate(todayIso);

  const { lastActiveDate } = state;

  // Premier enregistrement
  if (!lastActiveDate) {
    return { count: 1, best: Math.max(state.best, 1), lastActiveDate: todayIso };
  }

  const diffDays = daysBetween(lastActiveDate, todayIso);

  if (diffDays < 0) {
    // Date dans le passé — ignorer (protection contre les manipulations)
    return state;
  }

  if (diffDays === 0) {
    // Même jour — streak déjà compté
    return state;
  }

  if (diffDays === 1) {
    // Jour consécutif — incrémente
    const newCount = state.count + 1;
    return {
      count:          newCount,
      best:           Math.max(state.best, newCount),
      lastActiveDate: todayIso,
    };
  }

  // Gap > 1 jour — streak brisé, repart à 1
  return {
    count:          1,
    best:           state.best, // Best intact
    lastActiveDate: todayIso,
  };
}

/**
 * isStreakAlive — retourne true si le streak est encore actif.
 * Un streak meurt si l'utilisateur n'a pas été actif hier ou aujourd'hui.
 */
export function isStreakAlive(state: StreakState, todayIso: string): boolean {
  if (!state.lastActiveDate) return false;
  const diff = daysBetween(state.lastActiveDate, todayIso);
  return diff <= 1;
}

/**
 * getStreakStatus — retour enrichi pour l'UI.
 */
export type StreakStatus = 'active' | 'at_risk' | 'dead' | 'none';

export function getStreakStatus(state: StreakState, todayIso: string): StreakStatus {
  if (!state.lastActiveDate || state.count === 0) return 'none';

  const diff = daysBetween(state.lastActiveDate, todayIso);

  if (diff === 0) return 'active';      // Actif aujourd'hui
  if (diff === 1) return 'at_risk';     // Pas encore actif aujourd'hui
  return 'dead';                        // Streak perdu
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/**
 * daysBetween — nombre de jours calendaires entre deux dates ISO.
 * Toujours positif ou nul si from ≤ to.
 */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = parseIsoDate(fromIso);
  const to   = parseIsoDate(toIso);
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((to - from) / msPerDay);
}

function parseIsoDate(iso: string): number {
  // Date(YYYY-MM-DD) est interprété en UTC → ajouter T00:00 force le local
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

function validateIsoDate(iso: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new TypeError(`Format de date invalide : "${iso}". Attendu "YYYY-MM-DD".`);
  }
}
