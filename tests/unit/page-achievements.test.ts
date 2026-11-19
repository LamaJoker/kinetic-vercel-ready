import { describe, it, expect } from 'vitest';
import { achievements } from '../../apps/web/src/pages/achievements.page.js';
import type { Achievement } from '@kinetic/core';

function make(unlocked: string[], progressPercent?: number) {
  const page = achievements();
  page.$store = {
    achievements: {
      catalog: [] as Achievement[],
      isUnlocked: (id: string) => unlocked.includes(id),
      progressPercent,
    },
  };
  return page;
}

describe('achievements page — présentation', () => {
  it('ringStyle expose le pourcentage, borné entre 0 et 100', () => {
    expect(make([], 49).ringStyle).toBe('--p: 49');
    expect(make([], 140).ringStyle).toBe('--p: 100');
    expect(make([], -3).ringStyle).toBe('--p: 0');
    expect(make([]).ringStyle).toBe('--p: 0');
  });

  it('medalClass : médaillon coloré si débloqué, silhouette sinon', () => {
    const page = make(['a']);
    expect(page.medalClass('a')).toBe('k-medal is-unlocked');
    expect(page.medalClass('b')).toBe('k-medal is-locked');
  });

  it('tierDotClass : points pleins jusqu’au niveau, estompés au-delà', () => {
    const page = make(['a']);
    expect(page.tierDotClass('a', 2, 3)).toBe('bg-kinetic-gold');
    expect(page.tierDotClass('b', 2, 3)).toBe('bg-gray-400');
    expect(page.tierDotClass('a', 4, 3)).toBe('bg-gray-400 opacity-25');
  });
});

describe('achievements page — prochain palier', () => {
  const catalog = [
    { id: 'sessions:1' },
    { id: 'sessions:10' },
    { id: 'sessions:25' },
    { id: 'streak:3' },
  ] as Achievement[];
  const metrics = {
    totalCompletedSessions: 4,
    bestStreak: 1,
    totalPRs: 0,
    totalTonnageKg: 0,
    bestE1rmByLift: {},
  };
  function withMetrics(unlocked: string[], m: typeof metrics | null = metrics) {
    const page = make(unlocked);
    page.$store.achievements.catalog = catalog;
    page.$store.achievements.metrics = m;
    return page;
  }

  it('barre seulement sur le premier palier verrouillé de chaque série', () => {
    const page = withMetrics(['sessions:1']);
    expect(page.showProgress('sessions:1')).toBe(false); // débloqué
    expect(page.showProgress('sessions:10')).toBe(true);
    expect(page.showProgress('sessions:25')).toBe(false); // pas encore le prochain
    expect(page.showProgress('streak:3')).toBe(true);
    expect(page.progressLabel('sessions:10')).toBe('4 / 10 séances');
    expect(page.progressStyle('sessions:10')).toBe('transform: scaleX(0.400)');
  });

  it('pas de barre tant que les mesures ne sont pas calculées', () => {
    const page = withMetrics([], null);
    expect(page.showProgress('sessions:1')).toBe(false);
    expect(page.progressLabel('sessions:1')).toBe('');
  });
});
