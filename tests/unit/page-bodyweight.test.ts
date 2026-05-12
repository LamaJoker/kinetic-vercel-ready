import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { bodyweight } from '../../apps/web/src/pages/bodyweight.page.js';

function makeStore(entries: Array<{ date: string; weight: number; bodyFatPct?: number | null; note?: string | null }> = []) {
  const store = bodyweight();
  store.entries = entries.map((e) => ({
    date: e.date,
    weight: e.weight,
    bodyFatPct: e.bodyFatPct ?? null,
    note: e.note ?? null,
  }));
  return store;
}

// ISO date N days ago
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('bodyweight() initial state', () => {
  it('starts empty', () => {
    const store = bodyweight();
    expect(store.entries).toHaveLength(0);
    expect(store.newWeight).toBeNull();
    expect(store.goalWeight).toBeNull();
    expect(store.period).toBe(90);
  });
});

describe('bodyweight filteredEntries', () => {
  it('returns all entries when period=9999', () => {
    const store = makeStore([
      { date: daysAgo(200), weight: 80 },
      { date: daysAgo(10), weight: 78 },
    ]);
    store.period = 9999;
    expect(store.filteredEntries).toHaveLength(2);
  });

  it('filters entries older than period', () => {
    const store = makeStore([
      { date: daysAgo(100), weight: 82 },
      { date: daysAgo(30), weight: 79 },
    ]);
    store.period = 90;
    expect(store.filteredEntries).toHaveLength(1);
    expect(store.filteredEntries[0]!.weight).toBe(79);
  });

  it('includes entries within period', () => {
    const store = makeStore([
      { date: daysAgo(89), weight: 80 },
      { date: daysAgo(1), weight: 78 },
    ]);
    store.period = 90;
    expect(store.filteredEntries).toHaveLength(2);
  });
});

describe('bodyweight computed getters', () => {
  let store: ReturnType<typeof bodyweight>;

  beforeEach(() => {
    store = makeStore([
      { date: daysAgo(60), weight: 85 },
      { date: daysAgo(30), weight: 82 },
      { date: daysAgo(5), weight: 79 },
    ]);
    store.period = 9999;
  });

  it('latest returns last entry', () => {
    expect(store.latest?.weight).toBe(79);
  });

  it('earliest returns first filtered entry', () => {
    expect(store.earliest?.weight).toBe(85);
  });

  it('minWeight returns minimum', () => {
    expect(store.minWeight).toBe(79);
  });

  it('maxWeight returns maximum', () => {
    expect(store.maxWeight).toBe(85);
  });

  it('avgWeight returns average', () => {
    expect(store.avgWeight).toBeCloseTo((85 + 82 + 79) / 3, 1);
  });

  it('delta returns last - first in filtered range', () => {
    expect(store.delta).toBeCloseTo(79 - 85, 1);
  });

  it('delta returns null for single entry', () => {
    const s = makeStore([{ date: daysAgo(10), weight: 75 }]);
    s.period = 9999;
    expect(s.delta).toBeNull();
  });

  it('returns null for empty entries', () => {
    const s = makeStore([]);
    expect(s.latest).toBeNull();
    expect(s.earliest).toBeNull();
    expect(s.minWeight).toBeNull();
    expect(s.maxWeight).toBeNull();
    expect(s.avgWeight).toBeNull();
    expect(s.delta).toBeNull();
  });
});

describe('bodyweight trend7', () => {
  it('returns null for fewer than 2 entries in last 7 days', () => {
    const store = makeStore([{ date: daysAgo(3), weight: 79 }]);
    expect(store.trend7).toBeNull();
  });

  it('computes trend over last 7 days', () => {
    const store = makeStore([
      { date: daysAgo(6), weight: 80 },
      { date: daysAgo(1), weight: 78 },
    ]);
    expect(store.trend7).toBeCloseTo(-2, 1);
  });

  it('ignores entries older than 7 days', () => {
    const store = makeStore([
      { date: daysAgo(10), weight: 90 }, // should be ignored
      { date: daysAgo(5), weight: 80 },
      { date: daysAgo(1), weight: 78 },
    ]);
    expect(store.trend7).toBeCloseTo(-2, 1);
  });
});

describe('bodyweight goalProgress', () => {
  it('returns 0 when no goal or no entries', () => {
    const store = makeStore([]);
    expect(store.goalProgress).toBe(0);
    const s2 = makeStore([{ date: daysAgo(5), weight: 80 }]);
    s2.goalWeight = null;
    expect(s2.goalProgress).toBe(0);
  });

  it('returns 100 when start equals goal', () => {
    const store = makeStore([{ date: daysAgo(10), weight: 75 }]);
    store.goalWeight = 75;
    expect(store.goalProgress).toBe(100);
  });

  it('computes progress toward goal', () => {
    const store = makeStore([
      { date: daysAgo(20), weight: 90 }, // start
      { date: daysAgo(5), weight: 85 },  // latest
    ]);
    store.goalWeight = 80; // target: lose 10kg from 90
    // progress = (90-85)/(90-80) * 100 = 50%
    expect(store.goalProgress).toBeCloseTo(50, 0);
  });
});
