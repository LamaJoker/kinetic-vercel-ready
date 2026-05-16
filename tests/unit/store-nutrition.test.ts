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

import { nutritionStore } from '../../apps/web/src/stores/nutrition.js';
import type { LoggedMeal } from '../../apps/web/src/stores/nutrition.js';

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
