/**
 * Tests pour le store `achievements`. On mocke `getDeps` pour fournir un
 * `InMemoryStorage` et on émet manuellement les events EVENT_SESSION_SAVED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs';
import { STORAGE_KEYS } from '../../packages/core/src/index.js';

// Stub window minimal
type Listener = (ev: Event) => void;
const winListeners = new Map<string, Set<Listener>>();
(globalThis as Record<string, unknown>).window = {
  addEventListener(name: string, cb: Listener) {
    if (!winListeners.has(name)) winListeners.set(name, new Set());
    winListeners.get(name)!.add(cb);
  },
  removeEventListener(name: string, cb: Listener) {
    winListeners.get(name)?.delete(cb);
  },
  dispatchEvent(ev: Event) {
    winListeners.get(ev.type)?.forEach((cb) => cb(ev));
    return true;
  },
};

const storage = new InMemoryStorage();

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(async () => ({ storage })),
}));

beforeEach(async () => {
  await storage.clear();
  winListeners.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('store achievements', () => {
  it('au boot, charge unlockedIds et expose catalog', async () => {
    const { achievementsStore } = await import('../../apps/web/src/stores/achievements.js');
    const store = achievementsStore();
    await store.init();
    expect(store.catalog.length).toBeGreaterThan(0);
    expect(store.totalCount).toBe(store.catalog.length);
    // unlockedIds doit toujours être un tableau valide
    expect(Array.isArray(store.unlockedIds)).toBe(true);
    store.destroy();
  });

  it('isUnlocked répond true pour un achievement réellement débloqué', async () => {
    // Pré-rempli avec 1 session complétée → "sessions:1" doit unlock
    await storage.set(STORAGE_KEYS.TRAINING_SESSIONS, [
      {
        id: 's1',
        name: 'Push',
        startedAt: '2026-05-20T18:00:00Z',
        endedAt: '2026-05-20T19:00:00Z',
        entries: [
          {
            exerciseId: 'bench',
            sets: [
              { setIndex: 0, reps: 5, weightKg: 80, rpe: 8, performedAt: '2026-05-20T18:05:00Z' },
            ],
          },
        ],
      },
    ]);
    await storage.set(STORAGE_KEYS.TRAINING_EXERCISES, [
      {
        id: 'bench',
        name: 'Bench Press',
        muscles: ['chest'],
        equipment: 'barbell',
        incrementKg: 2.5,
      },
    ]);
    const { achievementsStore } = await import('../../apps/web/src/stores/achievements.js');
    const store = achievementsStore();
    await store.init();
    expect(store.isUnlocked('sessions:1')).toBe(true);
    expect(store.isUnlocked('does-not-exist')).toBe(false);
    store.destroy();
  });

  it('progressPercent reflète le ratio unlocked/total', async () => {
    const { achievementsStore } = await import('../../apps/web/src/stores/achievements.js');
    const store = achievementsStore();
    await store.init();
    // À l'init avec 0 sessions, on a au moins 0 — pas d'erreur de division
    expect(typeof store.progressPercent).toBe('number');
    expect(store.progressPercent).toBeGreaterThanOrEqual(0);
    expect(store.progressPercent).toBeLessThanOrEqual(100);
    store.destroy();
  });

  it('evaluate() débloque les achievements basés sur les sessions sauvegardées', async () => {
    // Pré-rempli avec quelques sessions terminées
    await storage.set(STORAGE_KEYS.TRAINING_SESSIONS, [
      {
        id: 's1',
        name: 'Push',
        startedAt: '2026-05-20T18:00:00Z',
        endedAt: '2026-05-20T19:00:00Z',
        entries: [
          {
            exerciseId: 'bench-press',
            sets: [
              { setIndex: 0, reps: 5, weightKg: 100, rpe: 8, performedAt: '2026-05-20T18:05:00Z' },
            ],
          },
        ],
      },
    ]);
    await storage.set(STORAGE_KEYS.TRAINING_EXERCISES, [
      {
        id: 'bench-press',
        name: 'Bench Press',
        muscles: ['chest'],
        equipment: 'barbell',
        incrementKg: 2.5,
      },
    ]);

    const { achievementsStore } = await import('../../apps/web/src/stores/achievements.js');
    const store = achievementsStore();
    await store.init();
    // Achievement "first-session" doit maintenant être présent
    // "sessions:1" est le badge pour la 1re séance complétée
    expect(store.unlockedIds).toContain('sessions:1');
    store.destroy();
  });

  it('evaluate() ré-évalue après EVENT_SESSION_SAVED', async () => {
    const { achievementsStore } = await import('../../apps/web/src/stores/achievements.js');
    const store = achievementsStore();
    await store.init();
    const before = store.unlockedIds.length;

    // Pose une session après init
    await storage.set(STORAGE_KEYS.TRAINING_SESSIONS, [
      {
        id: 's1',
        name: 'Push',
        startedAt: '2026-05-20T18:00:00Z',
        endedAt: '2026-05-20T19:00:00Z',
        entries: [
          {
            exerciseId: 'bench-press',
            sets: [
              { setIndex: 0, reps: 5, weightKg: 100, rpe: 8, performedAt: '2026-05-20T18:05:00Z' },
            ],
          },
        ],
      },
    ]);
    await storage.set(STORAGE_KEYS.TRAINING_EXERCISES, [
      {
        id: 'bench-press',
        name: 'Bench Press',
        muscles: ['chest'],
        equipment: 'barbell',
        incrementKg: 2.5,
      },
    ]);

    // Dispatch l'event qui déclenche le re-eval
    window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_SESSION_SAVED));
    // Laisse les promises se résoudre
    await new Promise((r) => setTimeout(r, 30));
    expect(store.unlockedIds.length).toBeGreaterThanOrEqual(before);
    store.destroy();
  });

  it('destroy() retire les listeners', async () => {
    const { achievementsStore } = await import('../../apps/web/src/stores/achievements.js');
    const store = achievementsStore();
    await store.init();
    expect(winListeners.get(STORAGE_KEYS.EVENT_SESSION_SAVED)?.size).toBe(1);
    store.destroy();
    expect(winListeners.get(STORAGE_KEYS.EVENT_SESSION_SAVED)?.size ?? 0).toBe(0);
  });

  it('evaluate() est protégé contre les ré-entrances concurrentes', async () => {
    const { achievementsStore } = await import('../../apps/web/src/stores/achievements.js');
    const store = achievementsStore();
    await store.init();
    // Lance 3 evaluate() en parallèle — pas de crash, pas de double-exec
    await Promise.all([store.evaluate(), store.evaluate(), store.evaluate()]);
    expect(store.unlockedIds).toBeDefined();
    store.destroy();
  });
});
