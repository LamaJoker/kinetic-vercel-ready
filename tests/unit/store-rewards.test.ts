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
import { getDeps } from '../../apps/web/src/deps.js';

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

  it('returns 1 when Alpine.store("xp").currentLevel is undefined (covers ?? 1 at line 267)', () => {
    vi.stubGlobal('window', {
      Alpine: { store: () => ({}) }, // returns object without currentLevel
    });
    const store = rewardsStore();
    // Alpine.store('xp')?.currentLevel → undefined → ?? 1 → 1
    expect((store as any)._currentLevel()).toBe(1);
  });
});

// ─── _initFreezeTokens ────────────────────────────────────────────────────────

describe('rewardsStore._initFreezeTokens', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not renew tokens when the stored week matches the current week', async () => {
    // Compute the current ISO week key the same way the source does
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
    const currentWeek = `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;

    const mockSet = vi.fn();
    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi
          .fn()
          .mockResolvedValueOnce(currentWeek) // KEY_FREEZE_WEEK → same as current
          .mockResolvedValueOnce(2), // final read for this.freezeTokens
        set: mockSet,
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const store = rewardsStore();
    await (store as any)._initFreezeTokens();

    expect(store.freezeTokens).toBe(2);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('renews tokens by +1 (max 2) on a new week when level >= 6', async () => {
    const mockSet = vi.fn();
    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi
          .fn()
          .mockResolvedValueOnce('2020-W01') // old week → triggers renewal
          .mockResolvedValueOnce(0) // current FREEZE_TOKENS count
          .mockResolvedValueOnce(1), // final read after renewal
        set: mockSet,
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const store = makeStoreWithLevel(6);
    await (store as any)._initFreezeTokens();

    expect(store.freezeTokens).toBe(1);
    // set called twice: FREEZE_TOKENS and FREEZE_WEEK
    expect(mockSet).toHaveBeenCalledTimes(2);
  });

  it('does not renew tokens when level is below 6 even on a new week', async () => {
    const mockSet = vi.fn();
    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi
          .fn()
          .mockResolvedValueOnce('2020-W01') // old week
          .mockResolvedValueOnce(1), // final read
        set: mockSet,
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const store = makeStoreWithLevel(3); // level < 6
    await (store as any)._initFreezeTokens();

    expect(mockSet).not.toHaveBeenCalled();
    expect(store.freezeTokens).toBe(1);
  });

  it('isoWeekKey covers Sunday branch (day || 7) via _initFreezeTokens on a Sunday (covers line 51)', async () => {
    // 2026-05-17 is a Sunday (getUTCDay() = 0 → 0 || 7 = 7)
    vi.setSystemTime(new Date('2026-05-17T12:00:00Z'));
    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi.fn().mockResolvedValue(null), // same week or null
        set: vi.fn(),
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const store = makeStoreWithLevel(1); // level < 6, no renewal
    await (store as any)._initFreezeTokens();
    expect(store.freezeTokens).toBe(0); // null ?? 0 = 0
    vi.setSystemTime(new Date()); // restore to real time
  });

  it('uses 0 as fallback when KEY_FREEZE_TOKENS is null in storage (covers ?? 0 at line 125)', async () => {
    const mockSet = vi.fn();
    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi
          .fn()
          .mockResolvedValueOnce('2020-W01') // old week → triggers renewal
          .mockResolvedValueOnce(null) // KEY_FREEZE_TOKENS null → ?? 0
          .mockResolvedValueOnce(1), // final read for this.freezeTokens
        set: mockSet,
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const store = makeStoreWithLevel(6); // level >= 6 to enter renewal
    await (store as any)._initFreezeTokens();
    // null ?? 0 = 0, renewed = min(0+1, 2) = 1
    expect(store.freezeTokens).toBe(1);
    expect(mockSet).toHaveBeenCalledTimes(2);
  });

  it('catches errors silently and does not propagate', async () => {
    vi.mocked(getDeps).mockRejectedValueOnce(new Error('IDB unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = rewardsStore();
    await expect((store as any)._initFreezeTokens()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('_initFreezeTokens failed'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

// ─── useStreakFreeze ──────────────────────────────────────────────────────────

describe('rewardsStore.useStreakFreeze', () => {
  let dispatchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchSpy = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: dispatchSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns without action when freezeTokens is 0', async () => {
    const store = makeStoreWithLevel(6);
    store.freezeTokens = 0;
    await store.useStreakFreeze();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('returns without action when freezeLoading is already true', async () => {
    const store = makeStoreWithLevel(6);
    store.freezeTokens = 1;
    store.freezeLoading = true;
    await store.useStreakFreeze();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('throws when level is below 6 even with tokens available', async () => {
    const store = makeStoreWithLevel(3);
    store.freezeTokens = 2;
    await expect(store.useStreakFreeze()).rejects.toThrow('niveau 6');
  });

  it('decrements freezeTokens and dispatches EVENT_STREAK_UPDATED on success', async () => {
    // Default mock: get returns null (no streak), set is a no-op
    const store = makeStoreWithLevel(6);
    store.freezeTokens = 2;

    await store.useStreakFreeze();

    expect(store.freezeTokens).toBe(1);
    expect(store.freezeLoading).toBe(false); // released in finally
    // At minimum EVENT_STREAK_UPDATED + EVENT_NOTIFY
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it('uses plural "jetons" in notification when newCount is not 1 (covers line 172 : "s" branch)', async () => {
    const store = makeStoreWithLevel(6);
    store.freezeTokens = 3; // newCount = 3 - 1 = 2; 2 !== 1 → 's'

    await store.useStreakFreeze();

    // Find the EVENT_NOTIFY dispatch call
    const notifyCall = dispatchSpy.mock.calls.find(
      ([event]) => (event as Event).type === STORAGE_KEYS.EVENT_NOTIFY,
    );
    const detail = (notifyCall?.[0] as CustomEvent)?.detail as { message?: string } | undefined;
    expect(detail?.message).toContain('jetons');
  });

  it('dispatches error notification and resets freezeLoading when storage.set throws', async () => {
    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockRejectedValue(new Error('storage full')),
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const store = makeStoreWithLevel(6);
    store.freezeTokens = 1;

    await store.useStreakFreeze();

    expect(store.freezeLoading).toBe(false);
    // Error notification dispatched
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: STORAGE_KEYS.EVENT_NOTIFY }),
    );
  });
});

// ─── _loadTheme catch branch ──────────────────────────────────────────────────

describe('rewardsStore._loadTheme', () => {
  afterEach(() => vi.clearAllMocks());

  it('does not throw when getDeps fails (silent catch)', async () => {
    vi.mocked(getDeps).mockRejectedValueOnce(new Error('storage unavailable'));
    const store = rewardsStore();
    await expect((store as any)._loadTheme()).resolves.toBeUndefined();
  });
});
