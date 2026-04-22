/**
 * tests/unit/domain/streak.domain.test.ts
 *
 * Tests unitaires du moteur de streak.
 * Couvre tous les cas : consécutifs, rupture, même jour, best streak.
 */

import { describe, it, expect } from 'vitest';
import {
  createStreak,
  processActivity,
  isStreakAlive,
  getStreakStatus,
  daysBetween,
} from '@kinetic/core';
import type { StreakState } from '@kinetic/core';

describe('createStreak', () => {
  it('crée un état initial vide', () => {
    const s = createStreak();
    expect(s.count).toBe(0);
    expect(s.best).toBe(0);
    expect(s.lastActiveDate).toBeNull();
  });
});

describe('processActivity', () => {

  describe('premier enregistrement', () => {
    it('initialise le streak à 1', () => {
      const s = processActivity(createStreak(), '2026-04-20');
      expect(s.count).toBe(1);
      expect(s.best).toBe(1);
      expect(s.lastActiveDate).toBe('2026-04-20');
    });
  });

  describe('jours consécutifs', () => {
    it('incrémente sur 3 jours de suite', () => {
      let s = createStreak();
      s = processActivity(s, '2026-04-18');
      s = processActivity(s, '2026-04-19');
      s = processActivity(s, '2026-04-20');
      expect(s.count).toBe(3);
      expect(s.best).toBe(3);
    });

    it('ne double pas si appelé deux fois le même jour', () => {
      let s = createStreak();
      s = processActivity(s, '2026-04-20');
      s = processActivity(s, '2026-04-20');
      expect(s.count).toBe(1);
    });

    it('met à jour best uniquement quand count dépasse', () => {
      const s: StreakState = { count: 5, best: 10, lastActiveDate: '2026-04-19' };
      const r = processActivity(s, '2026-04-20');
      expect(r.count).toBe(6);
      expect(r.best).toBe(10); // best inchangé car 6 < 10
    });

    it('met à jour best quand count le dépasse', () => {
      const s: StreakState = { count: 10, best: 10, lastActiveDate: '2026-04-19' };
      const r = processActivity(s, '2026-04-20');
      expect(r.count).toBe(11);
      expect(r.best).toBe(11);
    });
  });

  describe('rupture du streak', () => {
    it('remet count à 1 après 2 jours de gap', () => {
      let s = processActivity(createStreak(), '2026-04-15');
      s = processActivity(s, '2026-04-18'); // gap de 3 jours
      expect(s.count).toBe(1);
    });

    it('préserve le best streak après une rupture', () => {
      const s: StreakState = { count: 7, best: 7, lastActiveDate: '2026-04-10' };
      const r = processActivity(s, '2026-04-20');
      expect(r.count).toBe(1);
      expect(r.best).toBe(7);
    });

    it('ignore les dates dans le passé (protection)', () => {
      const s: StreakState = { count: 5, best: 5, lastActiveDate: '2026-04-20' };
      const r = processActivity(s, '2026-04-19'); // date passée
      expect(r.count).toBe(5); // inchangé
    });
  });

  describe('validation', () => {
    it('lève une erreur pour un format de date invalide', () => {
      expect(() => processActivity(createStreak(), '20-04-2026')).toThrow(TypeError);
      expect(() => processActivity(createStreak(), 'invalid')).toThrow(TypeError);
    });
  });

  describe('immutabilité', () => {
    it('ne mute jamais l\'état original', () => {
      const original: StreakState = { count: 3, best: 3, lastActiveDate: '2026-04-19' };
      const frozen = Object.freeze({ ...original });
      processActivity(frozen, '2026-04-20');
      expect(frozen.count).toBe(3); // inchangé
    });
  });
});

describe('isStreakAlive', () => {
  it('true si actif aujourd\'hui', () => {
    const s: StreakState = { count: 3, best: 3, lastActiveDate: '2026-04-20' };
    expect(isStreakAlive(s, '2026-04-20')).toBe(true);
  });

  it('true si actif hier (en danger mais vivant)', () => {
    const s: StreakState = { count: 3, best: 3, lastActiveDate: '2026-04-19' };
    expect(isStreakAlive(s, '2026-04-20')).toBe(true);
  });

  it('false si 2+ jours d\'inactivité', () => {
    const s: StreakState = { count: 3, best: 3, lastActiveDate: '2026-04-17' };
    expect(isStreakAlive(s, '2026-04-20')).toBe(false);
  });

  it('false si jamais actif', () => {
    expect(isStreakAlive(createStreak(), '2026-04-20')).toBe(false);
  });
});

describe('getStreakStatus', () => {
  it('"active" si actif aujourd\'hui', () => {
    const s: StreakState = { count: 5, best: 5, lastActiveDate: '2026-04-20' };
    expect(getStreakStatus(s, '2026-04-20')).toBe('active');
  });

  it('"at_risk" si actif hier mais pas encore aujourd\'hui', () => {
    const s: StreakState = { count: 5, best: 5, lastActiveDate: '2026-04-19' };
    expect(getStreakStatus(s, '2026-04-20')).toBe('at_risk');
  });

  it('"dead" si 2+ jours de gap', () => {
    const s: StreakState = { count: 5, best: 5, lastActiveDate: '2026-04-10' };
    expect(getStreakStatus(s, '2026-04-20')).toBe('dead');
  });

  it('"none" si jamais actif', () => {
    expect(getStreakStatus(createStreak(), '2026-04-20')).toBe('none');
  });

  it('"none" si count = 0', () => {
    const s: StreakState = { count: 0, best: 0, lastActiveDate: '2026-04-19' };
    expect(getStreakStatus(s, '2026-04-20')).toBe('none');
  });
});

describe('daysBetween', () => {
  it('retourne 0 pour la même date', () => {
    expect(daysBetween('2026-04-20', '2026-04-20')).toBe(0);
  });

  it('retourne 1 pour le lendemain', () => {
    expect(daysBetween('2026-04-19', '2026-04-20')).toBe(1);
  });

  it('retourne 7 pour une semaine', () => {
    expect(daysBetween('2026-04-13', '2026-04-20')).toBe(7);
  });

  it('gère les changements de mois', () => {
    expect(daysBetween('2026-03-31', '2026-04-01')).toBe(1);
  });

  it('gère les années bissextiles', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2); // 2024 est bissextile
    expect(daysBetween('2023-02-28', '2023-03-01')).toBe(1); // 2023 non bissextile
  });

  it('retourne négatif si from > to', () => {
    expect(daysBetween('2026-04-20', '2026-04-19')).toBe(-1);
  });
});
