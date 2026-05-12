import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeXpState } from '@kinetic/core';

// Mock getDeps so the store doesn't try to open IndexedDB
vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(),
}));

import { xpStore } from '../../apps/web/src/stores/xp.js';
import { getDeps } from '../../apps/web/src/deps.js';

function makeMockDeps(xpValue: number | null = null) {
  return {
    storage: {
      get: vi.fn().mockResolvedValue(xpValue != null ? { xp: xpValue } : null),
      set: vi.fn(),
      remove: vi.fn(),
      keys: vi.fn().mockResolvedValue([]),
      clear: vi.fn(),
    },
  };
}

describe('xpStore', () => {
  beforeEach(() => {
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps(0) as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with empty XP state', () => {
    const store = xpStore();
    const empty = computeXpState(0);
    expect(store.xp).toBe(empty.xp);
    expect(store.currentLevel).toBe(empty.currentLevel);
    expect(store.loading).toBe(true);
  });

  it('reload sets loading to false', async () => {
    const store = xpStore();
    await store.reload();
    expect(store.loading).toBe(false);
  });

  it('reload reads XP from storage', async () => {
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps(500) as any);
    const store = xpStore();
    await store.reload();
    expect(store.xp).toBe(500);
  });

  it('reload defaults to 0 when storage returns null', async () => {
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps(null) as any);
    const store = xpStore();
    await store.reload();
    expect(store.xp).toBe(0);
    expect(store.loading).toBe(false);
  });

  it('_applyState updates all derived fields', () => {
    const store = xpStore();
    const state = computeXpState(1500);
    store._applyState(state);
    expect(store.xp).toBe(state.xp);
    expect(store.currentLevel).toBe(state.currentLevel);
    expect(store.progressPercent).toBe(state.progressPercent);
    expect(store.remaining).toBe(state.remaining);
    expect(store.isMaxLevel).toBe(state.isMaxLevel);
    expect(store.title).toBe(state.title);
  });

  it('init calls reload', async () => {
    const store = xpStore();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps(200) as any);
    await store.init();
    expect(store.xp).toBe(200);
  });

  it('reload handles getDeps failure gracefully', async () => {
    vi.mocked(getDeps).mockRejectedValue(new Error('IDB unavailable'));
    const store = xpStore();
    await store.reload(); // should not throw
    expect(store.loading).toBe(false);
    expect(store.xp).toBe(0); // keeps default
  });

  it('progressPercent is between 0 and 100', async () => {
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps(750) as any);
    const store = xpStore();
    await store.reload();
    expect(store.progressPercent).toBeGreaterThanOrEqual(0);
    expect(store.progressPercent).toBeLessThanOrEqual(100);
  });
});
