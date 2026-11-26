/**
 * PERF-05 : les statistiques de Progression (bilan hebdo, volume, muscles, records,
 * régularité, courbe e1RM) sont calculées une fois par historique, pas une fois par
 * liaison du gabarit, et recalculées dès que l'historique change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';

const storage = new InMemoryStorage();
vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(async () => ({ storage })),
}));

vi.mock('../../apps/web/src/lib/lazy-component.js', () => ({
  loadMuscleMap: vi.fn(async () => undefined),
  loadStrengthGoals: vi.fn(async () => undefined),
}));

// Compteurs d'appels sur les calculs du domaine (implémentations réelles).
const calls = vi.hoisted(() => ({ review: 0, volume: 0, muscles: 0, prs: 0, consistency: 0 }));
vi.mock('@kinetic/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@kinetic/core')>();
  return {
    ...core,
    buildWeeklyReview: (...a: Parameters<typeof core.buildWeeklyReview>) => {
      calls.review++;
      return core.buildWeeklyReview(...a);
    },
    weeklyVolume: (...a: Parameters<typeof core.weeklyVolume>) => {
      calls.volume++;
      return core.weeklyVolume(...a);
    },
    muscleDistribution: (...a: Parameters<typeof core.muscleDistribution>) => {
      calls.muscles++;
      return core.muscleDistribution(...a);
    },
    detectPRs: (...a: Parameters<typeof core.detectPRs>) => {
      calls.prs++;
      return core.detectPRs(...a);
    },
    consistencyScore: (...a: Parameters<typeof core.consistencyScore>) => {
      calls.consistency++;
      return core.consistencyScore(...a);
    },
  };
});

const { progression } = await import('../../apps/web/src/pages/progression.page.js');
const { loadDemoData } = await import('../../apps/web/src/lib/demo.js');
import { STORAGE_KEYS } from '@kinetic/core';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

type Page = ReturnType<typeof progression>;

let savedHandler: ((e: Event) => void) | null = null;
beforeEach(async () => {
  savedHandler = null;
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
      if (type === STORAGE_KEYS.EVENT_SESSION_SAVED) savedHandler = fn;
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  await storage.clear();
  await storage.set('kinetic:training:exercises', [
    { id: 'bp', name: 'Bench', muscles: ['chest'], equipment: 'barbell', incrementKg: 2.5 },
  ]);
  await loadDemoData(storage, new Date());
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0;
});
afterEach(() => vi.unstubAllGlobals());

/** Ce que le gabarit lit à un rendu (nombre de liaisons mesuré dans progression.html). */
function renderOnce(page: Page): void {
  for (let i = 0; i < 8; i++) void page.weeklyReview;
  for (let i = 0; i < 10; i++) void page.weeklyBuckets;
  for (let i = 0; i < 12; i++) void page.muscles;
  for (let i = 0; i < 8; i++) void page.records;
  for (let i = 0; i < 2; i++) void page.consistency;
  for (let i = 0; i < 7; i++) page.forcePoints();
}

describe('Progression : statistiques mémorisées (PERF-05)', () => {
  it('un seul calcul par statistique pour tout un rendu, et pour les rendus suivants', async () => {
    const page = progression() as Page;
    await page.init();
    for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0;
    renderOnce(page);
    renderOnce(page);
    expect(calls).toEqual({ review: 1, volume: 1, muscles: 1, prs: 1, consistency: 1 });
  });

  it('recalculé après une séance enregistrée (événement SESSION_SAVED)', async () => {
    const page = progression() as Page;
    await page.init();
    const before = page.totalSessions;
    const setsBefore = page.totalSets;
    const tonnageBefore = page.totalTonnage;
    renderOnce(page);
    for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0;

    const now = new Date().toISOString();
    const session: WorkoutSession = {
      id: 'nouvelle',
      name: 'Nouvelle',
      startedAt: now,
      endedAt: now,
      entries: [
        {
          exerciseId: 'bp',
          sets: [{ setIndex: 0, weightKg: 300, reps: 5, performedAt: now }],
        },
      ],
    };
    expect(savedHandler).not.toBeNull();
    savedHandler!(new CustomEvent(STORAGE_KEYS.EVENT_SESSION_SAVED, { detail: { session } }));

    expect(page.totalSessions).toBe(before + 1);
    expect(page.totalSets).toBe(setsBefore + 1);
    expect(page.totalTonnage).toBe(tonnageBefore + 1500);
    renderOnce(page);
    expect(calls).toEqual({ review: 1, volume: 1, muscles: 1, prs: 1, consistency: 1 });
    expect(page.records.some((r) => r.exerciseId === 'bp' && r.weightKg === 300)).toBe(true);
    expect(page.weeklyBuckets.at(-1)!.tonnageKg).toBeGreaterThanOrEqual(1500);
  });

  it('séance passée modifiée (même nombre de séances) : statistiques à jour', async () => {
    const page = progression() as Page;
    await page.init();
    const tonnage = page.totalTonnage;
    const target = page.sessions.find((s) => s.entries.length > 0)!;
    const edited = {
      ...target,
      entries: target.entries.map((e, i) =>
        i === 0
          ? {
              ...e,
              sets: [
                ...e.sets,
                { setIndex: 99, weightKg: 100, reps: 10, performedAt: target.startedAt },
              ],
            }
          : e,
      ),
    };
    savedHandler!(
      new CustomEvent(STORAGE_KEYS.EVENT_SESSION_SAVED, { detail: { session: edited } }),
    );
    expect(page.totalTonnage).toBe(tonnage + 1000);
  });

  it('courbe e1RM : une passe par exercice choisi, à jour au changement d’exercice', async () => {
    const page = progression() as Page;
    await page.init();
    const ids = [...new Set(page.sessions.flatMap((s) => s.entries.map((e) => e.exerciseId)))];
    expect(ids.length).toBeGreaterThan(1);
    page.selectExercise(ids[0]!);
    const a = page.forcePoints();
    expect(page.forcePoints()).toBe(a); // même calcul resservi
    page.selectExercise(ids[1]!);
    const b = page.forcePoints();
    expect(b).not.toBe(a);
    page.selectExercise(ids[0]!);
    expect(page.forcePoints()).toEqual(a);
  });
});
