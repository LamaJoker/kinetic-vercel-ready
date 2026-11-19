import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/lib/haptics.js', () => ({
  hapticCelebrate: vi.fn(),
}));

import { REWARDS, STORAGE_KEYS } from '@kinetic/core';
import {
  announceLevelUp,
  asCelebration,
  celebration,
  celebrationDuration,
  highestLevelUp,
  levelCelebration,
  rewardForLevel,
  setCelebrationsMuted,
  CELEBRATION_MS,
  CELEBRATION_REWARD_MS,
} from '../../apps/web/src/lib/celebration.js';

describe('highestLevelUp', () => {
  it('rien si aucun gain ne fait monter de niveau', () => {
    expect(highestLevelUp([])).toBeUndefined();
    expect(highestLevelUp([{ leveledUp: false }, null, undefined])).toBeUndefined();
    expect(highestLevelUp([{ leveledUp: true }])).toBeUndefined(); // niveau manquant
  });

  it('le bonus +20 % seul suffit à célébrer', () => {
    expect(highestLevelUp([{ leveledUp: false }, { leveledUp: true, newLevel: 5 }])).toBe(5);
  });

  it('garde le plus haut niveau (une seule carte)', () => {
    expect(
      highestLevelUp([
        { leveledUp: true, newLevel: 4 },
        { leveledUp: true, newLevel: 5 },
      ]),
    ).toBe(5);
  });

  it('accepte les résultats « déjà crédité » / en échec sans planter', () => {
    expect(highestLevelUp([{ ok: true, skipped: true } as never, { ok: false } as never])).toBe(
      undefined,
    );
  });
});

describe('récompense intégrée à la carte de niveau', () => {
  it('rewardForLevel ignore le niveau de base', () => {
    expect(rewardForLevel(1)).toBeUndefined();
    expect(rewardForLevel(99)).toBeUndefined();
    const r6 = REWARDS.find((r) => r.level === 6)!;
    expect(rewardForLevel(6)).toEqual({ emoji: r6.emoji, title: r6.title, text: r6.description });
  });

  it('levelCelebration(objet) garde le sous-titre et ajoute la récompense', () => {
    const reward = { emoji: '🧊', title: 'Gel de série', text: 'Un jeton par semaine.' };
    const d = levelCelebration(6, reward);
    expect(d.reward).toEqual(reward);
    expect(d.subtitle).toBe('Récompense débloquée : Gel de série');
    expect(celebrationDuration(d)).toBe(CELEBRATION_REWARD_MS);
    expect(celebrationDuration(levelCelebration(6))).toBe(CELEBRATION_MS);
    expect(celebrationDuration(null)).toBe(CELEBRATION_MS);
  });

  it('asCelebration conserve une récompense valide et rejette le reste', () => {
    const raw = { kind: 'level', title: 'Niveau 6 atteint', reward: { title: 'Gel', emoji: 3 } };
    expect(asCelebration(raw)?.reward).toEqual({ emoji: '', title: 'Gel', text: '' });
    expect(asCelebration({ kind: 'level', title: 'N', reward: { title: '' } })?.reward).toBe(
      undefined,
    );
  });
});

describe('announceLevelUp → une seule carte', () => {
  let target: EventTarget;
  beforeEach(() => {
    target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', { createElement: () => ({}) });
    setCelebrationsMuted(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('n’émet rien sans niveau', () => {
    const fn = vi.fn();
    target.addEventListener(STORAGE_KEYS.EVENT_LEVELUP, fn);
    announceLevelUp(undefined);
    announceLevelUp(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('émet EVENT_LEVELUP et la carte présente la récompense, sans doublon', () => {
    vi.useFakeTimers();
    const c = celebration() as ReturnType<typeof celebration> & { $el: unknown };
    c.$el = { querySelector: () => null };
    c.init();
    target.dispatchEvent(new Event('pointerdown'));

    announceLevelUp(5);
    announceLevelUp(5); // doublon consécutif ignoré
    expect(c.visible).toBe(true);
    expect(c.title).toBe('Niveau 5 atteint');
    expect(c.hasReward).toBe(true);
    expect(c.rewardTitle).toBe(REWARDS.find((r) => r.level === 5)!.title);
    expect(c.rewardText.length).toBeGreaterThan(0);
    expect(c.showSubtitle).toBe(false); // la récompense remplace le sous-titre
    expect(c.cardKindClass).toBe('is-in has-reward');

    vi.advanceTimersByTime(CELEBRATION_REWARD_MS + 400);
    expect(c.visible).toBe(false);
    c.destroy();
  });
});
