import { describe, it, expect } from 'vitest';
import {
  buildAchievementCatalog,
  computeUnlocked,
  detectLiftKey,
  newlyUnlocked,
} from '../../packages/core/src/domain/achievements.domain.js';

describe('buildAchievementCatalog', () => {
  it('produit un catalogue non vide avec IDs uniques', () => {
    const catalog = buildAchievementCatalog();
    expect(catalog.length).toBeGreaterThan(20);
    const ids = catalog.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('inclut sessions:1, streak:7 et strength:bench:100', () => {
    const ids = buildAchievementCatalog().map((a) => a.id);
    expect(ids).toContain('sessions:1');
    expect(ids).toContain('streak:7');
    expect(ids).toContain('strength:bench:100');
  });
});

describe('detectLiftKey', () => {
  it('reconnaît Bench / Squat / Deadlift en plusieurs langues', () => {
    expect(detectLiftKey('Bench Press')).toBe('bench');
    expect(detectLiftKey('Développé couché')).toBe('bench');
    expect(detectLiftKey('Back Squat')).toBe('squat');
    expect(detectLiftKey('Squat')).toBe('squat');
    expect(detectLiftKey('Deadlift')).toBe('deadlift');
    expect(detectLiftKey('Soulevé de terre')).toBe('deadlift');
  });

  it('renvoie null pour les exercices non reconnus', () => {
    expect(detectLiftKey('Bicep Curl')).toBeNull();
    expect(detectLiftKey('Tricep Pushdown')).toBeNull();
  });
});

describe('computeUnlocked', () => {
  it('débloque tous les paliers ≤ état actuel', () => {
    const unlocked = computeUnlocked({
      totalCompletedSessions: 27,
      bestStreak: 8,
      totalPRs: 6,
      totalTonnageKg: 12_000,
      bestE1rmByLift: { bench: 105 },
    });
    expect(unlocked).toContain('sessions:1');
    expect(unlocked).toContain('sessions:10');
    expect(unlocked).toContain('sessions:25');
    expect(unlocked).not.toContain('sessions:50');
    expect(unlocked).toContain('streak:7');
    expect(unlocked).not.toContain('streak:14');
    expect(unlocked).toContain('pr:5');
    expect(unlocked).not.toContain('pr:10');
    expect(unlocked).toContain('volume:10t');
    expect(unlocked).not.toContain('volume:50t');
    expect(unlocked).toContain('strength:bench:100');
    expect(unlocked).not.toContain('strength:bench:120');
  });

  it('renvoie une liste vide pour un compte neuf', () => {
    expect(
      computeUnlocked({
        totalCompletedSessions: 0,
        bestStreak: 0,
        totalPRs: 0,
        totalTonnageKg: 0,
        bestE1rmByLift: {},
      }),
    ).toEqual([]);
  });
});

describe('newlyUnlocked', () => {
  it('renvoie seulement les IDs nouveaux', () => {
    const prev = ['sessions:1', 'streak:3'];
    const cur = ['sessions:1', 'streak:3', 'streak:7', 'pr:1'];
    expect(newlyUnlocked(prev, cur)).toEqual(['streak:7', 'pr:1']);
  });
  it('renvoie vide si aucun nouveau', () => {
    expect(newlyUnlocked(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});
