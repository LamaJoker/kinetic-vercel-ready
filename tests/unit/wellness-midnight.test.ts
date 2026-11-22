/**
 * Passage de minuit, accueil resté ouvert : le check-in et l'eau sont datés au
 * moment de la saisie, pas à l'ouverture de l'accueil.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';

vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn() }));
const vitalite = {
  tasks: [] as Array<{ id: string; done: boolean }>,
  healthSleep: null as number | null,
  complete: vi.fn(async () => undefined),
  undo: vi.fn(async () => undefined),
};
vi.mock('alpinejs', () => ({ default: { store: vi.fn(() => vitalite), data: vi.fn() } }));

const { getDeps } = await import('../../apps/web/src/deps.js');
const { formCheckin, waterTracker } = await import('../../apps/web/src/components/wellness.js');

let storage: InMemoryStorage;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 21, 23, 50)); // samedi 21 novembre, 23 h 50
  storage = new InMemoryStorage();
  vi.mocked(getDeps).mockResolvedValue({ storage } as never);
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('passage de minuit', () => {
  it('check-in commencé avant minuit, fini après : enregistré sur le nouveau jour', async () => {
    const f = formCheckin();
    await f.init();
    expect(f.date).toBe('2026-11-21');
    f.pickSleep('good');
    f.pickEnergy(4);
    vi.setSystemTime(new Date(2026, 10, 22, 0, 5));
    f.pickSoreness('none');
    await vi.waitFor(() => expect(f.current).not.toBeNull());
    const log = await storage.get<Record<string, unknown>>(STORAGE_KEYS.WELLNESS_CHECKINS);
    expect(Object.keys(log!)).toEqual(['2026-11-22']);
    expect(f.date).toBe('2026-11-22');
    expect(f.current!.date).toBe('2026-11-22');
  });

  it('check-in de la veille modifié après minuit : la veille reste intacte', async () => {
    const f = formCheckin();
    await f.init();
    f.pickSleep('bad');
    f.pickEnergy(2);
    f.pickSoreness('heavy');
    await vi.waitFor(() => expect(f.current).not.toBeNull());
    vi.setSystemTime(new Date(2026, 10, 22, 0, 10));
    f.edit();
    f.pickEnergy(5);
    await vi.waitFor(() => expect(f.current?.date).toBe('2026-11-22'));
    const log = await storage.get<Record<string, { energy: number }>>(
      STORAGE_KEYS.WELLNESS_CHECKINS,
    );
    expect(log!['2026-11-21']!.energy).toBe(2);
    expect(log!['2026-11-22']!.energy).toBe(5);
  });

  it('verre d’eau après minuit : compté sur le nouveau jour ; « annuler » ne touche pas la veille', async () => {
    const w = waterTracker();
    await w.init();
    await w.add();
    expect(w.total).toBe(250);
    vi.setSystemTime(new Date(2026, 10, 22, 0, 2));
    await w.undo(); // rien à annuler aujourd'hui
    let log = await storage.get<Record<string, number[]>>(STORAGE_KEYS.WELLNESS_WATER);
    expect(log!['2026-11-21']).toEqual([250]);
    await w.add();
    log = await storage.get<Record<string, number[]>>(STORAGE_KEYS.WELLNESS_WATER);
    expect(log!['2026-11-22']).toEqual([250]);
    expect(w.date).toBe('2026-11-22');
  });
});
