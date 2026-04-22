/**
 * tests/unit/domain/xp.domain.test.ts
 *
 * Tests unitaires exhaustifs du moteur XP.
 * Logique pure — aucun mock requis.
 */

import { describe, it, expect } from 'vitest';
import {
  computeXpState,
  addXp,
  didLevelUp,
  getNewLevel,
  LEVELS,
} from '@kinetic/core';

describe('computeXpState', () => {

  describe('niveau 1 (Rookie)', () => {
    it('retourne niveau 1 pour 0 XP', () => {
      const s = computeXpState(0);
      expect(s.currentLevel).toBe(1);
      expect(s.title).toBe('Rookie');
      expect(s.progressPercent).toBe(0);
      expect(s.remaining).toBe(200);
      expect(s.isMaxLevel).toBe(false);
    });

    it('retourne 50% de progression à 100 XP', () => {
      expect(computeXpState(100).progressPercent).toBe(50);
    });

    it('retourne 99% à 199 XP', () => {
      expect(computeXpState(199).progressPercent).toBe(100); // arrondi
    });
  });

  describe('transitions de niveaux', () => {
    it('passe niveau 1→2 à exactement 200 XP', () => {
      expect(computeXpState(199).currentLevel).toBe(1);
      expect(computeXpState(200).currentLevel).toBe(2);
    });

    it('passe niveau 2→3 à exactement 500 XP', () => {
      expect(computeXpState(499).currentLevel).toBe(2);
      expect(computeXpState(500).currentLevel).toBe(3);
    });

    it('retourne les bons titres pour tous les niveaux', () => {
      const expected: [number, string][] = [
        [0,     'Rookie'   ],
        [200,   'Apprenti' ],
        [500,   'Confirmé' ],
        [1000,  'Expert'   ],
        [2000,  'Elite'    ],
        [3500,  'Champion' ],
        [5500,  'Maître'   ],
        [8000,  'Légende'  ],
      ];
      for (const [xp, title] of expected) {
        expect(computeXpState(xp).title).toBe(title);
      }
    });
  });

  describe('niveau maximum (Légende)', () => {
    it('isMaxLevel = true à 8000 XP', () => {
      const s = computeXpState(8000);
      expect(s.isMaxLevel).toBe(true);
      expect(s.progressPercent).toBe(100);
      expect(s.remaining).toBe(0);
    });

    it('ne dépasse jamais 100% même avec XP très élevé', () => {
      expect(computeXpState(99999).progressPercent).toBeLessThanOrEqual(100);
    });
  });

  describe('validation des entrées', () => {
    it('lève une erreur pour XP négatif', () => {
      expect(() => computeXpState(-1)).toThrow(RangeError);
    });
  });

  describe('cohérence interne', () => {
    it('remaining + threshold = seuil du niveau suivant', () => {
      const s = computeXpState(350); // niveau 2, entre 200 et 500
      const nextLevel = LEVELS.find((l) => l.level === s.currentLevel + 1);
      if (nextLevel) {
        expect(350 + s.remaining).toBe(nextLevel.threshold);
      }
    });

    it('totalXp === xp dans le state', () => {
      const xp = 1234;
      expect(computeXpState(xp).xp).toBe(xp);
    });
  });
});

describe('addXp', () => {
  it('additionne correctement', () => {
    expect(addXp(100, 50)).toBe(150);
    expect(addXp(0, 1)).toBe(1);
  });

  it('lève RangeError pour montant ≤ 0', () => {
    expect(() => addXp(100, 0)).toThrow(RangeError);
    expect(() => addXp(100, -10)).toThrow(RangeError);
  });

  it('lève RangeError pour montant non-fini', () => {
    expect(() => addXp(100, Infinity)).toThrow(RangeError);
    expect(() => addXp(100, NaN)).toThrow(RangeError);
  });

  it('lève RangeError pour XP courant négatif', () => {
    expect(() => addXp(-1, 50)).toThrow(RangeError);
  });
});

describe('didLevelUp', () => {
  it('retourne true lors d\'un passage de niveau', () => {
    expect(didLevelUp(180, 250)).toBe(true);  // 1 → 2
    expect(didLevelUp(490, 510)).toBe(true);  // 2 → 3
  });

  it('retourne false si même niveau', () => {
    expect(didLevelUp(100, 150)).toBe(false);
    expect(didLevelUp(200, 400)).toBe(false);
  });

  it('retourne false si même XP', () => {
    expect(didLevelUp(300, 300)).toBe(false);
  });
});

describe('getNewLevel', () => {
  it('retourne le nouveau niveau lors d\'un level-up', () => {
    const level = getNewLevel(180, 250);
    expect(level?.level).toBe(2);
    expect(level?.title).toBe('Apprenti');
  });

  it('retourne null si pas de level-up', () => {
    expect(getNewLevel(100, 150)).toBeNull();
  });

  it('retourne null si XP identique', () => {
    expect(getNewLevel(300, 300)).toBeNull();
  });
});
