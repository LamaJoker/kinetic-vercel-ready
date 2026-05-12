import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn().mockResolvedValue({
    storage: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      remove: vi.fn(),
      keys: vi.fn().mockResolvedValue([]),
      clear: vi.fn(),
    },
  }),
}));

import { rewardsStore, THEMES } from '../../apps/web/src/stores/rewards.js';
import { REWARDS } from '@kinetic/core';

function makeStoreWithLevel(level: number) {
  const store = rewardsStore();
  // Stub _currentLevel to return a controlled level
  vi.spyOn(store as any, '_currentLevel').mockReturnValue(level);
  return store;
}

describe('THEMES', () => {
  it('contains at least 5 themes', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(5);
  });

  it('every theme has required fields', () => {
    for (const theme of THEMES) {
      expect(typeof theme.id).toBe('string');
      expect(typeof theme.label).toBe('string');
      expect(typeof theme.emoji).toBe('string');
      expect(typeof theme.neon).toBe('string');
      expect(typeof theme.accent).toBe('string');
    }
  });

  it('has unique ids', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes electrique (default) theme', () => {
    expect(THEMES.some((t) => t.id === 'electrique')).toBe(true);
  });
});

describe('rewardsStore initial state', () => {
  it('starts with correct defaults', () => {
    const store = rewardsStore();
    expect(store.showRewardModal).toBe(false);
    expect(store.pendingReward).toBeNull();
    expect(store.pendingLevel).toBe(0);
    expect(store.freezeTokens).toBe(0);
    expect(store.currentTheme).toBe('electrique');
    expect(store.allThemes).toBe(THEMES);
    expect(store.allRewards).toBe(REWARDS);
  });
});

describe('rewardsStore getters (via _currentLevel mock)', () => {
  afterEach(() => vi.clearAllMocks());

  describe('historyDays', () => {
    it('returns 7 for level 1', () => {
      expect(makeStoreWithLevel(1).historyDays).toBe(7);
    });

    it('returns 14 for level 2', () => {
      expect(makeStoreWithLevel(2).historyDays).toBe(14);
    });

    it('returns 30 for level 4+', () => {
      expect(makeStoreWithLevel(4).historyDays).toBe(30);
      expect(makeStoreWithLevel(8).historyDays).toBe(30);
    });
  });

  describe('hasXpBonus', () => {
    it('false below level 5', () => {
      expect(makeStoreWithLevel(4).hasXpBonus).toBe(false);
    });
    it('true at level 5+', () => {
      expect(makeStoreWithLevel(5).hasXpBonus).toBe(true);
    });
  });

  describe('hasAdvancedCoach', () => {
    it('false below level 3', () => {
      expect(makeStoreWithLevel(2).hasAdvancedCoach).toBe(false);
    });
    it('true at level 3+', () => {
      expect(makeStoreWithLevel(3).hasAdvancedCoach).toBe(true);
    });
  });

  describe('hasStreakFreeze', () => {
    it('false below level 6', () => {
      expect(makeStoreWithLevel(5).hasStreakFreeze).toBe(false);
    });
    it('true at level 6+', () => {
      expect(makeStoreWithLevel(6).hasStreakFreeze).toBe(true);
    });
  });

  describe('hasColorThemes', () => {
    it('true at level 7+', () => {
      expect(makeStoreWithLevel(7).hasColorThemes).toBe(true);
    });
    it('false below level 7', () => {
      expect(makeStoreWithLevel(6).hasColorThemes).toBe(false);
    });
  });

  describe('hasLegendBadge', () => {
    it('true at level 8', () => {
      expect(makeStoreWithLevel(8).hasLegendBadge).toBe(true);
    });
    it('false below level 8', () => {
      expect(makeStoreWithLevel(7).hasLegendBadge).toBe(false);
    });
  });

  describe('isUnlocked', () => {
    it('returns true when current level meets min', () => {
      expect(makeStoreWithLevel(5).isUnlocked(5)).toBe(true);
    });
    it('returns false when current level below min', () => {
      expect(makeStoreWithLevel(4).isUnlocked(5)).toBe(false);
    });
  });
});

describe('rewardsStore.dismissModal', () => {
  it('hides the modal and clears pending reward', () => {
    const store = rewardsStore();
    store.showRewardModal = true;
    store.pendingReward = REWARDS[0] ?? null;
    store.dismissModal();
    expect(store.showRewardModal).toBe(false);
    expect(store.pendingReward).toBeNull();
  });
});

describe('rewardsStore._assertLevel', () => {
  it('throws when level is too low', () => {
    const store = makeStoreWithLevel(3);
    expect(() => (store as any)._assertLevel(6)).toThrow('niveau 6');
  });

  it('does not throw when level is sufficient', () => {
    const store = makeStoreWithLevel(6);
    expect(() => (store as any)._assertLevel(6)).not.toThrow();
  });
});
