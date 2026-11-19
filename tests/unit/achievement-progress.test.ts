import { describe, it, expect } from 'vitest';
import {
  achievementProgress,
  achievementSeries,
  isNextTier,
  type AchievementMetrics,
} from '../../apps/web/src/lib/achievement-progress.js';

const m: AchievementMetrics = {
  totalCompletedSessions: 32,
  bestStreak: 5,
  totalPRs: 3,
  totalTonnageKg: 4200,
  bestE1rmByLift: { bench: 92.4 },
};

describe('achievementSeries', () => {
  it('regroupe par préfixe', () => {
    expect(achievementSeries('sessions:10')).toBe('sessions');
    expect(achievementSeries('strength:bench:100')).toBe('strength:bench');
    expect(achievementSeries('volume:10t')).toBe('volume');
    expect(achievementSeries('seul')).toBe('seul');
  });
});

describe('achievementProgress', () => {
  it('séances, séries, PR', () => {
    expect(achievementProgress('sessions:50', m)).toMatchObject({
      current: 32,
      target: 50,
      label: '32 / 50 séances',
    });
    expect(achievementProgress('streak:7', m)?.label).toBe('5 / 7 jours');
    expect(achievementProgress('pr:5', m)?.ratio).toBeCloseTo(0.6);
  });

  it('volume en tonnes avec une décimale sous 10 t', () => {
    expect(achievementProgress('volume:10t', m)?.label).toBe('4,2 / 10 t');
  });

  it('force : e1RM du lift, arrondi, borné à la cible', () => {
    expect(achievementProgress('strength:bench:100', m)?.label).toBe('e1RM 92 / 100 kg');
    expect(achievementProgress('strength:bench:60', m)?.ratio).toBe(1);
    expect(achievementProgress('strength:squat:80', m)?.current).toBe(0);
  });

  it('null si inconnu ou sans mesures', () => {
    expect(achievementProgress('mystere:3', m)).toBeNull();
    expect(achievementProgress('sessions:x', m)).toBeNull();
    expect(achievementProgress('sessions:10', null)).toBeNull();
  });
});

describe('isNextTier', () => {
  const ids = ['sessions:1', 'sessions:10', 'sessions:25', 'pr:1'];
  it('premier verrouillé de la série seulement', () => {
    const unlocked = new Set(['sessions:1']);
    const isU = (id: string) => unlocked.has(id);
    expect(isNextTier('sessions:10', ids, isU)).toBe(true);
    expect(isNextTier('sessions:25', ids, isU)).toBe(false);
    expect(isNextTier('sessions:1', ids, isU)).toBe(false);
    expect(isNextTier('pr:1', ids, isU)).toBe(true);
    expect(isNextTier('absent:1', ids, isU)).toBe(false);
  });
});
