/**
 * Forme du jour, eau et carte de récupération : composants Alpine
 * (components/wellness.ts, components/muscle-map.ts) avec un stockage en mémoire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS, localDay } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';

vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn() }));
const vitalite = {
  tasks: [] as Array<{ id: string; done: boolean }>,
  healthSleep: null as number | null,
  complete: vi.fn(async (id: string) => {
    vitalite.tasks = vitalite.tasks.map((t) => (t.id === id ? { ...t, done: true } : t));
  }),
  undo: vi.fn(async (id: string) => {
    vitalite.tasks = vitalite.tasks.map((t) => (t.id === id ? { ...t, done: false } : t));
  }),
};
vi.mock('alpinejs', () => ({ default: { store: vi.fn(() => vitalite), data: vi.fn() } }));

const { getDeps } = await import('../../apps/web/src/deps.js');
const { formCheckin, waterTracker, formHistory, formatHours, checkInSummary, formChartCoords } =
  await import('../../apps/web/src/components/wellness.js');
const { muscleMap, recoveryLegend } = await import('../../apps/web/src/components/muscle-map.js');

let storage: InMemoryStorage;
const events: Event[] = [];

beforeEach(() => {
  storage = new InMemoryStorage();
  vi.mocked(getDeps).mockResolvedValue({ storage } as never);
  vitalite.tasks = [
    { id: 'sleep-routine', done: false },
    { id: 'journaling', done: false },
    { id: 'hydration', done: false },
  ];
  vitalite.healthSleep = null;
  vitalite.complete.mockClear();
  vitalite.undo.mockClear();
  events.length = 0;
  vi.stubGlobal('window', {
    dispatchEvent: (e: Event) => events.push(e),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('formatage', () => {
  it('heures et résumé', () => {
    expect(formatHours(7)).toBe('7 h');
    expect(formatHours(7.5)).toBe('7 h 30');
    expect(
      checkInSummary({
        date: '2026-11-21',
        sleep: 'good',
        sleepHours: 7.5,
        energy: 4,
        soreness: 'light',
      }),
    ).toBe('Sommeil bon (7 h 30) · énergie 4/5 · courbatures légères');
  });

  it('courbe : un jour sans check-in coupe la courbe', () => {
    const c = formChartCoords([
      { date: 'a', score: 100 },
      { date: 'b', score: null },
      { date: 'c', score: 0 },
    ]);
    expect(c[1]).toBeNull();
    expect(c[0]![1]).toBeLessThan(c[2]![1]);
  });
});

describe('check-in du matin', () => {
  it('3 touches : enregistré, score, tâches sommeil et journal cochées', async () => {
    const f = formCheckin();
    await f.init();
    expect(f.done).toBe(false);
    expect(f.stepsLeft).toContain('3 touches');
    f.pickSleep('good');
    f.pickEnergy(4);
    expect(await storage.get(STORAGE_KEYS.WELLNESS_CHECKINS)).toBeNull();
    f.pickSoreness('none');
    await vi.waitFor(() => expect(f.current).not.toBeNull());
    await vi.waitFor(() => expect(vitalite.complete).toHaveBeenCalledTimes(2));
    expect(f.done).toBe(true);
    expect(f.score).toBeGreaterThanOrEqual(70);
    expect(f.levelLabel).toBe('En forme');
    const log = await storage.get<Record<string, unknown>>(STORAGE_KEYS.WELLNESS_CHECKINS);
    expect(Object.keys(log!)).toEqual([localDay(new Date())]);
    expect(vitalite.complete).toHaveBeenCalledWith('journaling', false);
    expect(vitalite.complete).toHaveBeenCalledWith('sleep-routine', false);
    expect(events.some((e) => e.type === STORAGE_KEYS.EVENT_CHECKIN_SAVED)).toBe(true);
  });

  it('modifiable dans la journée ; sommeil court : pas de tâche sommeil', async () => {
    const f = formCheckin();
    await f.init();
    f.toggleHours();
    f.bumpHours(-1.5); // 5 h 30
    expect(f.sleep).toBe('bad');
    f.pickEnergy(1);
    f.pickSoreness('heavy');
    await vi.waitFor(() => expect(f.current).not.toBeNull());
    expect(f.current!.sleepHours).toBe(5.5);
    expect(f.level).toBe('low');
    expect(vitalite.complete).not.toHaveBeenCalledWith('sleep-routine', false);

    f.edit();
    expect(f.editing).toBe(true);
    f.pickEnergy(5);
    await vi.waitFor(() => expect(f.current!.energy).toBe(5));
    f.finish();

    const again = formCheckin();
    await again.init();
    expect(again.done).toBe(true);
    expect(again.current!.energy).toBe(5);
  });

  it('sommeil corrigé sous 7 h : la tâche sommeil se décoche', async () => {
    const f = formCheckin();
    await f.init();
    f.pickSleep('good');
    f.pickEnergy(3);
    f.pickSoreness('none');
    await vi.waitFor(() => expect(vitalite.complete).toHaveBeenCalledWith('sleep-routine', false));
    f.edit();
    f.pickSleep('bad');
    await vi.waitFor(() => expect(vitalite.undo).toHaveBeenCalledWith('sleep-routine'));
    expect(vitalite.tasks.find((t) => t.id === 'journaling')!.done).toBe(true);
  });

  it('touche pendant l’enregistrement : la dernière valeur est enregistrée', async () => {
    const f = formCheckin();
    await f.init();
    f.pickSleep('ok');
    f.pickEnergy(2);
    f.pickSoreness('none'); // enregistrement en cours…
    f.pickEnergy(5); // …touche suivante, pas perdue
    await vi.waitFor(async () => {
      const log = await storage.get<Record<string, { energy: number }>>(
        STORAGE_KEYS.WELLNESS_CHECKINS,
      );
      expect(log![localDay(new Date())]!.energy).toBe(5);
    });
  });

  it('Health Connect pré-remplit les heures', async () => {
    vitalite.healthSleep = 450;
    const f = formCheckin();
    await f.init();
    expect(f.hours).toBe(7.5);
    expect(f.sleep).toBe('good');
  });
});

describe('eau', () => {
  it('objectif d’après le poids, + 1 verre, annuler, tâche cochée à l’objectif', async () => {
    await storage.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ weight: 60 }]);
    await storage.set(STORAGE_KEYS.WELLNESS_WATER_PREFS, { glassMl: 500 });
    const w = waterTracker();
    await w.init();
    expect(w.goal).toBe(2000); // 60 × 35 = 2 100 → 2 000
    expect(w.glassesLabel).toBe('0 verre sur 4');
    for (let i = 0; i < 3; i++) await w.add();
    expect(w.totalLabel).toBe('1,5 L');
    expect(vitalite.complete).not.toHaveBeenCalled();
    await w.undo();
    expect(w.total).toBe(1000);
    await w.add();
    await w.add();
    expect(w.reached).toBe(true);
    expect(vitalite.complete).toHaveBeenCalledWith('hydration', false);
    expect(w.history).toHaveLength(7);
    expect(w.history.at(-1)!.reached).toBe(true);
    const log = await storage.get<Record<string, number[]>>(STORAGE_KEYS.WELLNESS_WATER);
    expect(log![localDay(new Date())]).toEqual([500, 500, 500, 500]);
    // Annuler repasse sous l'objectif : la tâche cochée par l'eau se décoche.
    await w.undo();
    expect(vitalite.undo).toHaveBeenCalledWith('hydration');
    expect(vitalite.tasks.find((t) => t.id === 'hydration')!.done).toBe(false);
  });

  it('réglages : objectif choisi puis retour au conseillé', async () => {
    const w = waterTracker();
    await w.init();
    expect(w.goalAuto).toBe(true);
    w.bumpGoal(500);
    expect(w.goal).toBe(2500);
    expect(w.goalAuto).toBe(false);
    w.setGlass(330);
    expect(w.glass).toBe(330);
    w.useAutoGoal();
    expect(w.goal).toBe(2000);
    await vi.waitFor(async () =>
      expect(await storage.get(STORAGE_KEYS.WELLNESS_WATER_PREFS)).toEqual({
        glassMl: 330,
        goalMl: null,
      }),
    );
  });
});

describe('historique de forme', () => {
  it('30 jours, moyenne et courbe', async () => {
    const today = localDay(new Date());
    await storage.set(STORAGE_KEYS.WELLNESS_CHECKINS, {
      [today]: { date: today, sleep: 'good', energy: 5, soreness: 'none' },
    });
    const h = formHistory();
    await h.init();
    expect(h.points).toHaveLength(30);
    expect(h.hasData).toBe(true);
    expect(h.countLabel).toBe('1 check-in sur 30 jours');
    expect(h.chartSvg()).toContain('<circle');
    expect(h.chartScrub()!.points).toHaveLength(1);
  });
});

describe('carte des muscles : mode récupération', () => {
  it('silhouette colorée par état, phrase au toucher', async () => {
    const now = new Date();
    const m = muscleMap();
    m.sync(
      [
        {
          id: 's',
          name: 'Push',
          startedAt: now.toISOString(),
          entries: [
            {
              exerciseId: 'bp',
              sets: Array.from({ length: 10 }, (_, i) => ({
                setIndex: i,
                reps: 8,
                weightKg: 80,
                rpe: 8,
                performedAt: now.toISOString(),
              })),
            },
          ],
        },
      ],
      [
        {
          id: 'bp',
          name: 'Développé couché',
          muscles: ['chest'],
          equipment: 'barbell',
          incrementKg: 2.5,
        },
      ],
    );
    m.setView('recovery');
    expect(m.isRecovery).toBe(true);
    const svg = m.svg();
    expect(svg).toMatch(/k-mm k-mm-tired mm-r-chest/);
    expect(svg).toMatch(/k-mm k-mm-fresh mm-r-quads/);
    expect(m.freshLabel()).toContain('jambes');
    m.select('chest');
    expect(m.recoveryDetail!.sentence).toMatch(/^Pectoraux : récupérés à ~0 %/);
    expect(m.recoveryRows()[0]!.key).toBe('chest');
    expect(recoveryLegend().map((l) => l.label)).toEqual(['Récupéré', 'En cours', 'Fatigué']);
    m.setView('volume');
    expect(m.svg()).toMatch(/k-mm-l\d mm-r-chest/);
  });
});
