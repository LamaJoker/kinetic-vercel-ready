import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { REWARDS, STORAGE_KEYS } from '@kinetic/core';

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

// ─── init / destroy ───────────────────────────────────────────────────────────

describe('rewardsStore.init / destroy', () => {
  const listeners = new Map<string, Set<(e: Event) => void>>();

  beforeEach(() => {
    listeners.clear();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (e: Event) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: Event) => void) => {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('registers a listener for EVENT_LEVELUP on init', () => {
    const store = rewardsStore();
    store.init();
    expect(listeners.has(STORAGE_KEYS.EVENT_LEVELUP)).toBe(true);
    expect(listeners.get(STORAGE_KEYS.EVENT_LEVELUP)!.size).toBe(1);
  });

  it('removes the EVENT_LEVELUP listener on destroy', () => {
    const store = rewardsStore();
    store.init();
    store.destroy();
    expect(listeners.get(STORAGE_KEYS.EVENT_LEVELUP)?.size ?? 0).toBe(0);
  });

  it('destroy is idempotent (no-op when called without init)', () => {
    const store = rewardsStore();
    expect(() => store.destroy()).not.toThrow();
  });

  it('shows modal for a non-base reward on LEVELUP event', () => {
    const store = makeStoreWithLevel(3);
    store.init();
    const nonBase = REWARDS.find((r) => r.kind !== 'base');
    if (!nonBase) return;
    const event = new CustomEvent(STORAGE_KEYS.EVENT_LEVELUP, {
      detail: { level: nonBase.level, title: nonBase.title },
    });
    listeners.get(STORAGE_KEYS.EVENT_LEVELUP)?.forEach((fn) => fn(event));
    expect(store.showRewardModal).toBe(true);
    expect(store.pendingLevel).toBe(nonBase.level);
    expect(store.pendingReward).toBe(nonBase);
  });

  it('does NOT show modal for a base reward (no physical unlock)', () => {
    const store = makeStoreWithLevel(1);
    store.init();
    const base = REWARDS.find((r) => r.kind === 'base');
    if (!base) return;
    const event = new CustomEvent(STORAGE_KEYS.EVENT_LEVELUP, {
      detail: { level: base.level, title: base.title },
    });
    listeners.get(STORAGE_KEYS.EVENT_LEVELUP)?.forEach((fn) => fn(event));
    expect(store.showRewardModal).toBe(false);
  });

  it('ignores LEVELUP events with no detail', () => {
    const store = rewardsStore();
    store.init();
    const event = new CustomEvent(STORAGE_KEYS.EVENT_LEVELUP); // no detail
    expect(() =>
      listeners.get(STORAGE_KEYS.EVENT_LEVELUP)?.forEach((fn) => fn(event)),
    ).not.toThrow();
    expect(store.showRewardModal).toBe(false);
  });
});

// ─── applyTheme ───────────────────────────────────────────────────────────────

describe('rewardsStore.applyTheme', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('updates currentTheme for a valid theme id', async () => {
    const store = rewardsStore();
    await store.applyTheme('cyber');
    expect(store.currentTheme).toBe('cyber');
  });

  it('ignores an unknown theme id', async () => {
    const store = rewardsStore();
    await store.applyTheme('nonexistent-theme');
    expect(store.currentTheme).toBe('electrique');
  });

  it('sets document.documentElement.dataset.theme', async () => {
    const store = rewardsStore();
    await store.applyTheme('violet');
    const doc = document as unknown as { documentElement: { dataset: Record<string, string> } };
    expect(doc.documentElement.dataset['theme']).toBe('violet');
  });

  it('persists the theme to storage via getDeps', async () => {
    const { getDeps } = await import('../../apps/web/src/deps.js');
    const mockSet = vi.fn();
    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi.fn().mockResolvedValue(null),
        set: mockSet,
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const store = rewardsStore();
    await store.applyTheme('phoenix');
    expect(mockSet).toHaveBeenCalledWith(expect.any(String), 'phoenix');
  });

  it('logs error and does not throw when storage.set fails', async () => {
    const { getDeps } = await import('../../apps/web/src/deps.js');
    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockRejectedValue(new Error('disk full')),
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = rewardsStore();
    await expect(store.applyTheme('cyber')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('applyTheme save failed'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

describe('rewardsStore._currentLevel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns 1 when Alpine throws', () => {
    vi.stubGlobal('window', {
      get Alpine() {
        throw new Error('Alpine not ready');
      },
    });
    const store = rewardsStore();
    expect((store as any)._currentLevel()).toBe(1);
  });
});
