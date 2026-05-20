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

import { nutritionStore } from '../../apps/web/src/stores/nutrition.js';
import type { LoggedMeal, FoodEntry } from '../../apps/web/src/stores/nutrition.js';
import type { NutritionPlan } from '@kinetic/core';
import { getDeps } from '../../apps/web/src/deps.js';

function makeMeal(overrides: Partial<LoggedMeal> = {}): LoggedMeal {
  return {
    id: 'meal-1',
    mealName: 'Breakfast',
    loggedAt: '2026-01-01T08:00:00.000Z',
    items: [
      {
        food: { name: 'Oats', kcalPer100: 370, proteinPer100: 13, carbsPer100: 67, fatPer100: 7 },
        grams: 100,
      },
    ],
    ...overrides,
  };
}

describe('nutritionStore.consumed', () => {
  let store: ReturnType<typeof nutritionStore>;

  beforeEach(() => {
    store = nutritionStore();
  });

  it('returns zero totals for empty log', () => {
    store.todayLog = [];
    const c = store.consumed;
    expect(c.kcal).toBe(0);
    expect(c.proteinG).toBe(0);
    expect(c.carbsG).toBe(0);
    expect(c.fatG).toBe(0);
  });

  it('sums macros from all meal items', () => {
    store.todayLog = [makeMeal()];
    const c = store.consumed;
    // 100g of oats: kcal=370, protein=13, carbs=67, fat=7
    expect(c.kcal).toBe(370);
    expect(c.proteinG).toBe(13);
    expect(c.carbsG).toBe(67);
    expect(c.fatG).toBe(7);
  });

  it('scales correctly by grams', () => {
    store.todayLog = [
      makeMeal({
        items: [
          {
            food: {
              name: 'Chicken',
              kcalPer100: 165,
              proteinPer100: 31,
              carbsPer100: 0,
              fatPer100: 3.6,
            },
            grams: 200,
          },
        ],
      }),
    ];
    const c = store.consumed;
    expect(c.kcal).toBe(Math.round(165 * 2));
    expect(c.proteinG).toBeCloseTo(31 * 2, 1);
  });

  it('sums across multiple meals', () => {
    store.todayLog = [
      makeMeal({
        id: 'meal-1',
        items: [
          {
            food: { name: 'A', kcalPer100: 100, proteinPer100: 10, carbsPer100: 10, fatPer100: 5 },
            grams: 100,
          },
        ],
      }),
      makeMeal({
        id: 'meal-2',
        items: [
          {
            food: { name: 'B', kcalPer100: 200, proteinPer100: 20, carbsPer100: 20, fatPer100: 10 },
            grams: 100,
          },
        ],
      }),
    ];
    const c = store.consumed;
    expect(c.kcal).toBe(300);
    expect(c.proteinG).toBeCloseTo(30, 1);
  });

  it('rounds kcal to integer', () => {
    store.todayLog = [
      makeMeal({
        items: [
          {
            food: { name: 'X', kcalPer100: 333, proteinPer100: 10, carbsPer100: 10, fatPer100: 5 },
            grams: 50,
          },
        ],
      }),
    ];
    const c = store.consumed;
    expect(Number.isInteger(c.kcal)).toBe(true);
  });
});

describe('nutritionStore.progress', () => {
  it('returns null when no plan', () => {
    const store = nutritionStore();
    store.plan = null;
    expect(store.progress).toBeNull();
  });
});

describe('nutritionStore initial state', () => {
  it('starts with loading=true and empty log', () => {
    const store = nutritionStore();
    expect(store.loading).toBe(true);
    expect(store.todayLog).toHaveLength(0);
    expect(store.plan).toBeNull();
  });
});

// ─── remaining getter ─────────────────────────────────────────────────────────

describe('nutritionStore.remaining', () => {
  it('returns null when plan is not set', () => {
    const store = nutritionStore();
    expect(store.remaining).toBeNull();
  });

  it('computes remaining macros by subtracting consumed from target', () => {
    const store = nutritionStore();
    store.plan = {
      macros: { kcal: 2000, proteinG: 150, carbsG: 250, fatG: 65 },
    } as NutritionPlan;
    store.todayLog = [makeMeal()]; // 370 kcal, 13g prot, 67g carbs, 7g fat
    const r = store.remaining!;
    expect(r.kcal).toBe(2000 - 370);
    expect(r.proteinG).toBeCloseTo(150 - 13, 1);
    expect(r.carbsG).toBeCloseTo(250 - 67, 1);
    expect(r.fatG).toBeCloseTo(65 - 7, 1);
  });

  it('clamps remaining to 0 when consumed exceeds target', () => {
    const store = nutritionStore();
    store.plan = {
      macros: { kcal: 100, proteinG: 5, carbsG: 10, fatG: 3 },
    } as NutritionPlan;
    store.todayLog = [makeMeal()]; // 370 kcal > 100 target
    const r = store.remaining!;
    expect(r.kcal).toBe(0);
    expect(r.proteinG).toBe(0);
    expect(r.carbsG).toBe(0);
    expect(r.fatG).toBe(0);
  });
});

// ─── init ─────────────────────────────────────────────────────────────────────

describe('nutritionStore.init', () => {
  it('sets loading=false and defaults to empty state when storage is empty', async () => {
    const store = nutritionStore();
    await store.init();
    expect(store.loading).toBe(false);
    expect(store.plan).toBeNull();
    expect(store.todayLog).toHaveLength(0);
  });

  it('loads plan and log from storage', async () => {
    const mockPlan = {
      macros: { kcal: 2000, proteinG: 150, carbsG: 250, fatG: 65 },
    } as NutritionPlan;
    const mockLog = [makeMeal()];

    vi.mocked(getDeps).mockResolvedValueOnce({
      storage: {
        get: vi
          .fn()
          .mockResolvedValueOnce(mockPlan) // KEY_PLAN
          .mockResolvedValueOnce(mockLog), // KEY_LOG
        set: vi.fn(),
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    const store = nutritionStore();
    await store.init();

    expect(store.plan).toEqual(mockPlan);
    expect(store.todayLog).toEqual(mockLog);
    expect(store.loading).toBe(false);
  });

  it('handles getDeps failure gracefully, keeps loading=false', async () => {
    vi.mocked(getDeps).mockRejectedValueOnce(new Error('storage unavailable'));
    const store = nutritionStore();
    await store.init();
    expect(store.loading).toBe(false);
  });
});

// ─── addMealItem ──────────────────────────────────────────────────────────────

const egg: FoodEntry = {
  name: 'Egg',
  kcalPer100: 155,
  proteinPer100: 13,
  carbsPer100: 1,
  fatPer100: 11,
};
const toast: FoodEntry = {
  name: 'Toast',
  kcalPer100: 265,
  proteinPer100: 9,
  carbsPer100: 49,
  fatPer100: 3,
};

describe('nutritionStore.addMealItem', () => {
  let store: ReturnType<typeof nutritionStore>;
  const dispatchFn = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('window', { dispatchEvent: dispatchFn });
    store = nutritionStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns false and notifies for zero grams', async () => {
    const result = await store.addMealItem('Breakfast', egg, 0);
    expect(result).toBe(false);
    expect(dispatchFn).toHaveBeenCalledTimes(1);
  });

  it('returns false for negative grams', async () => {
    const result = await store.addMealItem('Breakfast', egg, -50);
    expect(result).toBe(false);
  });

  it('returns false for NaN grams', async () => {
    const result = await store.addMealItem('Breakfast', egg, NaN);
    expect(result).toBe(false);
  });

  it('returns false immediately when meal is already pending', async () => {
    store._pendingMealNames = ['Breakfast'];
    const result = await store.addMealItem('Breakfast', egg, 100);
    expect(result).toBe(false);
  });

  it('creates a new meal entry and returns true', async () => {
    const result = await store.addMealItem('Breakfast', egg, 100);
    expect(result).toBe(true);
    expect(store.todayLog).toHaveLength(1);
    expect(store.todayLog[0]!.mealName).toBe('Breakfast');
    expect(store.todayLog[0]!.items[0]!.food.name).toBe('Egg');
    expect(store.todayLog[0]!.items[0]!.grams).toBe(100);
  });

  it('removes the meal name from _pendingMealNames on completion', async () => {
    await store.addMealItem('Breakfast', egg, 100);
    expect(store._pendingMealNames).not.toContain('Breakfast');
  });

  it('appends item to an existing meal (stateful storage)', async () => {
    // Use a stateful storage mock so the second get() sees the first write
    const stored = new Map<string, unknown>();
    vi.mocked(getDeps).mockResolvedValue({
      storage: {
        get: vi.fn().mockImplementation((k: string) => Promise.resolve(stored.get(k) ?? null)),
        set: vi.fn().mockImplementation((k: string, v: unknown) => {
          stored.set(k, v);
          return Promise.resolve();
        }),
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    await store.addMealItem('Breakfast', egg, 100);
    await store.addMealItem('Breakfast', toast, 50);

    expect(store.todayLog).toHaveLength(1);
    expect(store.todayLog[0]!.items).toHaveLength(2);
    expect(store.todayLog[0]!.items[1]!.food.name).toBe('Toast');
  });
});

// ─── removeMealItem ───────────────────────────────────────────────────────────

describe('nutritionStore.removeMealItem', () => {
  let store: ReturnType<typeof nutritionStore>;

  beforeEach(() => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    store = nutritionStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('removes the item at the given index from storage and in-memory state', async () => {
    const stored = new Map<string, unknown>();
    vi.mocked(getDeps).mockResolvedValue({
      storage: {
        get: vi.fn().mockImplementation((k: string) => Promise.resolve(stored.get(k) ?? null)),
        set: vi.fn().mockImplementation((k: string, v: unknown) => {
          stored.set(k, v);
          return Promise.resolve();
        }),
        remove: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        clear: vi.fn(),
      },
    } as ReturnType<typeof getDeps> extends Promise<infer T> ? Promise<T> : never);

    await store.addMealItem('Breakfast', egg, 100);
    await store.addMealItem('Breakfast', toast, 50);
    await store.removeMealItem('Breakfast', 0); // remove Egg

    expect(store.todayLog[0]!.items).toHaveLength(1);
    expect(store.todayLog[0]!.items[0]!.food.name).toBe('Toast');
  });

  it('handles removal gracefully when meal is not found in storage', async () => {
    // storage returns null → rawLog = [] → mapping produces []
    await expect(store.removeMealItem('Nonexistent', 0)).resolves.not.toThrow();
  });
});
