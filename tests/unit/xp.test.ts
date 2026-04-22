/**
 * tests/unit/xp.test.ts
 *
 * Tests unitaires du moteur XP.
 * Couvre : calcul de niveau, progression, edge cases.
 *
 * Runner : vitest (via pnpm test)
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ─── Reproduit la logique XP du core (à importer en vrai projet) ──────────
const LEVELS = [
  { level: 1, title: 'Rookie',    threshold: 0    },
  { level: 2, title: 'Apprenti',  threshold: 200  },
  { level: 3, title: 'Confirmé',  threshold: 500  },
  { level: 4, title: 'Expert',    threshold: 1000 },
  { level: 5, title: 'Elite',     threshold: 2000 },
  { level: 6, title: 'Champion',  threshold: 3500 },
  { level: 7, title: 'Maître',    threshold: 5500 },
  { level: 8, title: 'Légende',   threshold: 8000 },
];

function computeXpState(totalXp: number) {
  let current = LEVELS[0]!;
  let next = LEVELS[1];

  for (let i = 0; i < LEVELS.length; i++) {
    if (totalXp >= LEVELS[i]!.threshold) {
      current = LEVELS[i]!;
      next = LEVELS[i + 1];
    }
  }

  const xpInLevel = totalXp - current.threshold;
  const xpForNextLevel = next ? next.threshold - current.threshold : 0;
  const progressPercent = next
    ? Math.min(100, Math.round((xpInLevel / xpForNextLevel) * 100))
    : 100;
  const remaining = next ? next.threshold - totalXp : 0;

  return {
    xp: totalXp,
    currentLevel: current.level,
    title: current.title,
    progressPercent,
    remaining,
    isMaxLevel: !next,
  };
}

function addXp(currentXp: number, amount: number): number {
  if (amount <= 0) throw new RangeError('XP amount must be positive');
  return currentXp + amount;
}
// ──────────────────────────────────────────────────────────────────────────

describe('XP Engine', () => {

  describe('computeXpState — niveau de base', () => {
    it('retourne niveau 1 pour 0 XP', () => {
      const state = computeXpState(0);
      expect(state.currentLevel).toBe(1);
      expect(state.title).toBe('Rookie');
      expect(state.progressPercent).toBe(0);
      expect(state.remaining).toBe(200);
    });

    it('retourne niveau 2 à exactement 200 XP', () => {
      const state = computeXpState(200);
      expect(state.currentLevel).toBe(2);
      expect(state.title).toBe('Apprenti');
      expect(state.progressPercent).toBe(0);
    });

    it('retourne niveau 2 à 350 XP (50% vers niveau 3)', () => {
      const state = computeXpState(350);
      expect(state.currentLevel).toBe(2);
      expect(state.progressPercent).toBe(50); // 150/300 * 100
      expect(state.remaining).toBe(150);
    });

    it('retourne niveau max (8) à 8000 XP', () => {
      const state = computeXpState(8000);
      expect(state.currentLevel).toBe(8);
      expect(state.isMaxLevel).toBe(true);
      expect(state.progressPercent).toBe(100);
      expect(state.remaining).toBe(0);
    });

    it('ne dépasse pas 100% de progress même avec XP > seuil suivant', () => {
      // 9999 XP, niveau max
      const state = computeXpState(9999);
      expect(state.progressPercent).toBeLessThanOrEqual(100);
    });
  });

  describe('computeXpState — transitions de niveaux', () => {
    it('passe de niveau 3 à 4 à exactement 1000 XP', () => {
      expect(computeXpState(999).currentLevel).toBe(3);
      expect(computeXpState(1000).currentLevel).toBe(4);
    });

    it('retourne les bons titres pour chaque niveau', () => {
      const expected: [number, string][] = [
        [0, 'Rookie'], [200, 'Apprenti'], [500, 'Confirmé'],
        [1000, 'Expert'], [2000, 'Elite'], [3500, 'Champion'],
        [5500, 'Maître'], [8000, 'Légende'],
      ];
      for (const [xp, title] of expected) {
        expect(computeXpState(xp).title).toBe(title);
      }
    });
  });

  describe('addXp — validation', () => {
    it('ajoute correctement le XP', () => {
      expect(addXp(0, 50)).toBe(50);
      expect(addXp(150, 100)).toBe(250);
    });

    it('lève une erreur pour un montant ≤ 0', () => {
      expect(() => addXp(100, 0)).toThrow(RangeError);
      expect(() => addXp(100, -10)).toThrow(RangeError);
    });

    it('détecte un passage de niveau', () => {
      const before = computeXpState(180);
      const newXp = addXp(180, 50); // → 230
      const after = computeXpState(newXp);
      expect(before.currentLevel).toBe(1);
      expect(after.currentLevel).toBe(2);
    });
  });
});
