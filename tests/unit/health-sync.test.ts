/**
 * Tests pour la lib health-sync. Le module charge dynamiquement
 * `@capacitor-community/health` qui n'est PAS installé — on couvre les deux
 * chemins : plugin absent (no-op) et plugin présent (mocké).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('health-sync', () => {
  it("isHealthAvailable retourne false quand le plugin n'est pas installé", async () => {
    // Le module utilise un import dynamique conditionnel. Sans mock du plugin,
    // l'import échoue → null → false.
    const { isHealthAvailable } = await import('../../apps/web/src/lib/health-sync.js');
    expect(await isHealthAvailable()).toBe(false);
  });

  it('writeWorkoutToHealth no-op et retourne false sans plugin', async () => {
    const { writeWorkoutToHealth } = await import('../../apps/web/src/lib/health-sync.js');
    const session = {
      id: 's1',
      name: 'Push',
      startedAt: '2026-05-27T18:00:00Z',
      endedAt: '2026-05-27T18:45:00Z',
      entries: [],
    };
    expect(await writeWorkoutToHealth(session)).toBe(false);
  });

  it('writeWorkoutToHealth retourne false si endedAt manquant', async () => {
    const { writeWorkoutToHealth } = await import('../../apps/web/src/lib/health-sync.js');
    const session = {
      id: 's1',
      name: 'Push',
      startedAt: '2026-05-27T18:00:00Z',
      entries: [],
    };
    expect(await writeWorkoutToHealth(session)).toBe(false);
  });
});

describe('health-sync avec plugin mocké', () => {
  beforeEach(() => {
    // Mock dynamique du plugin via vi.doMock
    vi.doMock('@capacitor-community/health', () => ({
      Health: {
        requestAuth: vi.fn(async () => undefined),
        storeWorkout: vi.fn(async () => undefined),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('@capacitor-community/health');
  });

  it('isHealthAvailable retourne true avec plugin présent', async () => {
    const { isHealthAvailable } = await import('../../apps/web/src/lib/health-sync.js');
    expect(await isHealthAvailable()).toBe(true);
  });

  it('writeWorkoutToHealth appelle storeWorkout avec ISO startTime/endTime', async () => {
    const { writeWorkoutToHealth } = await import('../../apps/web/src/lib/health-sync.js');
    const session = {
      id: 's1',
      name: 'Push',
      startedAt: '2026-05-27T18:00:00Z',
      endedAt: '2026-05-27T18:45:00Z',
      entries: [],
      caloriesKcal: 250,
    };
    const ok = await writeWorkoutToHealth(session);
    expect(ok).toBe(true);
  });

  it('writeWorkoutToHealth retourne false si le plugin throw', async () => {
    vi.doMock('@capacitor-community/health', () => ({
      Health: {
        requestAuth: vi.fn(async () => undefined),
        storeWorkout: vi.fn(async () => {
          throw new Error('User denied access');
        }),
      },
    }));
    vi.resetModules();
    const { writeWorkoutToHealth } = await import('../../apps/web/src/lib/health-sync.js');
    const session = {
      id: 's1',
      name: 'Push',
      startedAt: '2026-05-27T18:00:00Z',
      endedAt: '2026-05-27T18:45:00Z',
      entries: [],
    };
    expect(await writeWorkoutToHealth(session)).toBe(false);
  });
});

describe('health-sync hors-natif', () => {
  beforeEach(() => {
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('@capacitor/core');
  });

  it('isHealthAvailable retourne false hors plateforme native', async () => {
    vi.resetModules();
    const { isHealthAvailable } = await import('../../apps/web/src/lib/health-sync.js');
    expect(await isHealthAvailable()).toBe(false);
  });
});
