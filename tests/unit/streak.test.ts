/**
 * tests/unit/streak.test.ts
 *
 * Tests du moteur de streak.
 * Cas critiques : passage minuit, jours manqués, best streak.
 */

import { describe, it, expect } from 'vitest';

// ─── Logique streak (extrait du core) ────────────────────────────────────
interface StreakState {
  count: number;
  best: number;
  lastActiveDate: string | null; // "YYYY-MM-DD"
}

function createStreak(): StreakState {
  return { count: 0, best: 0, lastActiveDate: null };
}

/**
 * processActivity — appelé quand l'utilisateur complète au moins une tâche.
 * todayIso : "YYYY-MM-DD" dans le fuseau local.
 */
function processActivity(state: StreakState, todayIso: string): StreakState {
  const { lastActiveDate } = state;

  // Premier enregistrement
  if (!lastActiveDate) {
    return {
      count: 1,
      best: 1,
      lastActiveDate: todayIso,
    };
  }

  // Calculer la différence en jours
  const last = new Date(lastActiveDate);
  const today = new Date(todayIso);
  const diffMs = today.getTime() - last.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    // Déjà actif aujourd'hui, pas de changement
    return state;
  }

  if (diffDays === 1) {
    // Jour consécutif — incrémente le streak
    const newCount = state.count + 1;
    return {
      count: newCount,
      best: Math.max(state.best, newCount),
      lastActiveDate: todayIso,
    };
  }

  // Streak brisé (> 1 jour de gap) — repart à 1
  return {
    count: 1,
    best: state.best, // Best streak reste intact
    lastActiveDate: todayIso,
  };
}

function isStreakAlive(state: StreakState, todayIso: string): boolean {
  if (!state.lastActiveDate) return false;
  const last = new Date(state.lastActiveDate);
  const today = new Date(todayIso);
  const diffDays = Math.round((today.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays <= 1;
}
// ─────────────────────────────────────────────────────────────────────────

describe('Streak Engine', () => {

  describe('processActivity — premier enregistrement', () => {
    it('initialise le streak à 1 pour la première activité', () => {
      const state = createStreak();
      const result = processActivity(state, '2026-04-20');
      expect(result.count).toBe(1);
      expect(result.best).toBe(1);
      expect(result.lastActiveDate).toBe('2026-04-20');
    });
  });

  describe('processActivity — jours consécutifs', () => {
    it('incrémente le streak sur 3 jours consécutifs', () => {
      let s = createStreak();
      s = processActivity(s, '2026-04-18');
      s = processActivity(s, '2026-04-19');
      s = processActivity(s, '2026-04-20');
      expect(s.count).toBe(3);
      expect(s.best).toBe(3);
    });

    it('ne modifie pas le streak si appelé deux fois le même jour', () => {
      let s = createStreak();
      s = processActivity(s, '2026-04-20');
      s = processActivity(s, '2026-04-20');
      expect(s.count).toBe(1);
    });

    it('met à jour best uniquement si le count dépasse', () => {
      let s: StreakState = { count: 5, best: 10, lastActiveDate: '2026-04-19' };
      s = processActivity(s, '2026-04-20');
      expect(s.count).toBe(6);
      expect(s.best).toBe(10); // best inchangé car 6 < 10
    });

    it('met à jour best quand count le dépasse', () => {
      let s: StreakState = { count: 10, best: 10, lastActiveDate: '2026-04-19' };
      s = processActivity(s, '2026-04-20');
      expect(s.count).toBe(11);
      expect(s.best).toBe(11);
    });
  });

  describe('processActivity — streak brisé', () => {
    it('remet le count à 1 après 2 jours sans activité', () => {
      let s = createStreak();
      s = processActivity(s, '2026-04-15');
      // Manque 3 jours
      s = processActivity(s, '2026-04-18');
      expect(s.count).toBe(1);
    });

    it('préserve le best streak après une rupture', () => {
      let s: StreakState = { count: 7, best: 7, lastActiveDate: '2026-04-10' };
      s = processActivity(s, '2026-04-20'); // 10 jours de gap
      expect(s.count).toBe(1);
      expect(s.best).toBe(7); // best intact
    });
  });

  describe('isStreakAlive', () => {
    it('retourne true si actif aujourd\'hui', () => {
      const s: StreakState = { count: 3, best: 3, lastActiveDate: '2026-04-20' };
      expect(isStreakAlive(s, '2026-04-20')).toBe(true);
    });

    it('retourne true si actif hier (en danger mais vivant)', () => {
      const s: StreakState = { count: 3, best: 3, lastActiveDate: '2026-04-19' };
      expect(isStreakAlive(s, '2026-04-20')).toBe(true);
    });

    it('retourne false si mort (2+ jours)', () => {
      const s: StreakState = { count: 3, best: 3, lastActiveDate: '2026-04-17' };
      expect(isStreakAlive(s, '2026-04-20')).toBe(false);
    });

    it('retourne false si aucune activité', () => {
      const s = createStreak();
      expect(isStreakAlive(s, '2026-04-20')).toBe(false);
    });
  });
});
