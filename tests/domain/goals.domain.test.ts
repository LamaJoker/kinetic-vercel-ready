import { describe, it, expect } from 'vitest';
import {
  evaluateWeeklyGoals,
  shouldAwardWeeklyBonusXp,
  startOfWeek,
  weekKey,
  WEEKLY_GOAL_BONUS_XP,
  type SessionLike,
} from '@kinetic/core';

// Réf : mercredi 15 janv. 2025 12:00 UTC
const NOW = new Date('2025-01-15T12:00:00Z');

function session(
  dayOffsetFromMonday: number,
  sets: Array<[number, number]>,
  ended = true,
): SessionLike {
  const start = new Date('2025-01-13T18:00:00Z'); // lundi de la semaine
  start.setUTCDate(start.getUTCDate() + dayOffsetFromMonday);
  return {
    startedAt: start.toISOString(),
    endedAt: ended ? new Date(start.getTime() + 60 * 60_000).toISOString() : undefined,
    entries: [
      {
        sets: sets.map(([reps, weightKg]) => ({ reps, weightKg })),
      },
    ],
  };
}

describe('startOfWeek', () => {
  it('renvoie le lundi 00h local pour un mercredi', () => {
    const monday = startOfWeek(NOW);
    expect(monday.getFullYear()).toBe(2025);
    expect(monday.getMonth()).toBe(0);
    expect(monday.getDate()).toBe(13);
    expect(monday.getHours()).toBe(0);
  });

  it('renvoie le lundi pour un dimanche (fin de semaine ISO)', () => {
    const sunday = new Date('2025-01-19T12:00:00Z');
    const monday = startOfWeek(sunday);
    expect(monday.getFullYear()).toBe(2025);
    expect(monday.getMonth()).toBe(0);
    expect(monday.getDate()).toBe(13);
  });
});

describe('weekKey', () => {
  it('retourne yyyy-mm-dd du lundi', () => {
    expect(weekKey(NOW)).toBe('2025-01-13');
  });
});

describe('evaluateWeeklyGoals', () => {
  it('renvoie zéro quand pas de session', () => {
    const state = evaluateWeeklyGoals([], { targetSessions: 3, targetTonnageKg: 0 }, NOW);
    expect(state.doneSessions).toBe(0);
    expect(state.doneTonnageKg).toBe(0);
    expect(state.allOk).toBe(false);
  });

  it('compte uniquement les sessions terminées de la semaine courante', () => {
    const sessions = [
      session(0, [[10, 50]]), // lundi, terminée
      session(1, [[10, 50]], /* ended */ false), // mardi, en cours → exclue
      session(2, [[10, 50]]), // mercredi, terminée
    ];
    const state = evaluateWeeklyGoals(sessions, { targetSessions: 3, targetTonnageKg: 0 }, NOW);
    expect(state.doneSessions).toBe(2);
  });

  it('exclut les sessions de la semaine précédente', () => {
    const lastWeek: SessionLike = {
      startedAt: '2025-01-06T18:00:00Z',
      endedAt: '2025-01-06T19:00:00Z',
      entries: [{ sets: [{ reps: 10, weightKg: 50 }] }],
    };
    const state = evaluateWeeklyGoals([lastWeek], { targetSessions: 1, targetTonnageKg: 0 }, NOW);
    expect(state.doneSessions).toBe(0);
  });

  it('calcule le tonnage total (Σ reps × weightKg)', () => {
    const sessions = [
      session(0, [
        [10, 50],
        [8, 60],
      ]), // 500 + 480 = 980
      session(2, [[5, 100]]), // 500
    ];
    const state = evaluateWeeklyGoals(sessions, { targetSessions: 1, targetTonnageKg: 1000 }, NOW);
    expect(state.doneTonnageKg).toBe(1480);
    expect(state.tonnageOk).toBe(true);
  });

  it('marque tonnageOk=true si la cible est 0 (objectif désactivé)', () => {
    const state = evaluateWeeklyGoals([], { targetSessions: 0, targetTonnageKg: 0 }, NOW);
    expect(state.tonnageOk).toBe(true);
    expect(state.tonnagePercent).toBe(100);
  });

  it('allOk=false si aucun objectif actif (évite le XP gratuit)', () => {
    // Sans objectif actif, l'utilisateur ne doit pas recevoir le bonus
    const state = evaluateWeeklyGoals([], { targetSessions: 0, targetTonnageKg: 0 }, NOW);
    expect(state.allOk).toBe(false);
  });

  it('allOk=false si seul targetSessions=0 (tonnage actif non atteint)', () => {
    // sessionsOk désactivé + tonnage non atteint → pas de bonus
    const state = evaluateWeeklyGoals([], { targetSessions: 0, targetTonnageKg: 1000 }, NOW);
    expect(state.allOk).toBe(false);
  });

  it('allOk=true si seul tonnage actif et atteint (cible sessions désactivée)', () => {
    // Régression : avec uniquement un objectif tonnage rempli, le bonus
    // doit être débloqué — sessionsOk doit être vacuously true.
    const sessions = [session(0, [[10, 100]]), session(2, [[10, 100]])]; // 2000 kg
    const state = evaluateWeeklyGoals(sessions, { targetSessions: 0, targetTonnageKg: 1500 }, NOW);
    expect(state.tonnageOk).toBe(true);
    expect(state.allOk).toBe(true);
  });

  it('allOk=true si seul sessions actif et atteint (cible tonnage désactivée)', () => {
    const sessions = [session(0, [[5, 50]]), session(2, [[5, 50]]), session(4, [[5, 50]])];
    const state = evaluateWeeklyGoals(sessions, { targetSessions: 3, targetTonnageKg: 0 }, NOW);
    expect(state.sessionsOk).toBe(true);
    expect(state.allOk).toBe(true);
  });

  it('plafonne sessionsPercent à 100 même si on dépasse', () => {
    const sessions = [
      session(0, [[5, 50]]),
      session(1, [[5, 50]]),
      session(2, [[5, 50]]),
      session(3, [[5, 50]]),
    ];
    const state = evaluateWeeklyGoals(sessions, { targetSessions: 3, targetTonnageKg: 0 }, NOW);
    expect(state.sessionsPercent).toBe(100);
    expect(state.sessionsOk).toBe(true);
  });

  it('allOk=true quand tous les objectifs sont atteints', () => {
    const sessions = [session(0, [[10, 100]]), session(2, [[10, 100]]), session(4, [[10, 100]])];
    const state = evaluateWeeklyGoals(sessions, { targetSessions: 3, targetTonnageKg: 2000 }, NOW);
    expect(state.allOk).toBe(true);
  });
});

describe('shouldAwardWeeklyBonusXp', () => {
  it('false si objectifs non atteints', () => {
    expect(shouldAwardWeeklyBonusXp({ allOk: false, weekKey: '2025-01-13' }, '')).toBe(false);
  });

  it('true si atteints et pas encore crédité', () => {
    expect(shouldAwardWeeklyBonusXp({ allOk: true, weekKey: '2025-01-13' }, '')).toBe(true);
    expect(shouldAwardWeeklyBonusXp({ allOk: true, weekKey: '2025-01-13' }, '2025-01-06')).toBe(
      true,
    );
  });

  it('false (idempotent) si déjà crédité cette semaine', () => {
    expect(shouldAwardWeeklyBonusXp({ allOk: true, weekKey: '2025-01-13' }, '2025-01-13')).toBe(
      false,
    );
  });
});

describe('WEEKLY_GOAL_BONUS_XP', () => {
  it('vaut 100 (constant exporté)', () => {
    expect(WEEKLY_GOAL_BONUS_XP).toBe(100);
  });
});
