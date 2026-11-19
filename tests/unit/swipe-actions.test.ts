/**
 * Actions des lignes à glisser : série validée glissée à gauche (séance en
 * cours, avec « Annuler ») et tâches de Récupération (cocher / masquer / supprimer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/lib/training/template-editor-nav.js', () => ({
  openTemplateEditor: vi.fn(),
}));
vi.mock('../../apps/web/src/lib/training/rest-alert.js', () => ({
  scheduleRestAlert: vi.fn(async () => {}),
  cancelRestAlert: vi.fn(async () => {}),
}));
vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(async () => ({
    storage: {
      set: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
      keys: vi.fn(async () => []),
    },
  })),
}));

import { seances } from '../../apps/web/src/pages/seances.page.js';
import { vitaliteStore } from '../../apps/web/src/stores/vitalite.js';

function set(setIndex: number, weightKg: number, reps: number) {
  return { setIndex, weightKg, reps, rpe: 8, performedAt: `2026-11-10T10:0${setIndex}:00.000Z` };
}

function makePage() {
  const page = seances();
  page.exercises = [
    {
      id: 'bench',
      name: 'Développé couché',
      muscles: ['chest'],
      equipment: 'barbell',
      incrementKg: 2.5,
    },
  ];
  page.currentSession = {
    id: 'now',
    name: 'Haut',
    startedAt: new Date().toISOString(),
    entries: [{ exerciseId: 'bench', sets: [set(0, 40, 8), set(1, 42.5, 8), set(2, 45, 6)] }],
  };
  return page;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('séance en cours : glisser une série vers la gauche', () => {
  it('supprime la série, remplace la séance (persistée) et propose « Annuler »', () => {
    const page = makePage();
    const before = page.currentSession;
    page.swipeDeleteSet('bench', 1);
    expect(page.currentSession).not.toBe(before);
    expect(page.currentEntries[0]!.sets.map((s) => s.weightKg)).toEqual([40, 45]);
    expect(page.undoSet).toMatchObject({ scope: 'current', exerciseId: 'bench' });
    page.undoDeleteSet();
    expect(page.currentEntries[0]!.sets.map((s) => s.weightKg)).toEqual([40, 42.5, 45]);
  });

  it('« Annuler » disparaît après 6 s ; série inconnue : rien', () => {
    const page = makePage();
    page.swipeDeleteSet('bench', 9);
    expect(page.undoSet).toBeNull();
    expect(page.currentEntries[0]!.sets).toHaveLength(3);
    page.swipeDeleteSet('bench', 0);
    vi.advanceTimersByTime(6000);
    expect(page.undoSet).toBeNull();
  });
});

describe('Récupération : glisser une tâche', () => {
  function storeWith() {
    const store = vitaliteStore();
    store.tasks = [
      { id: 'water', done: false },
      { id: 'walk', done: true },
      { id: 'custom-1', done: true },
    ] as never;
    store.customSpecs = [{ id: 'custom-1', title: 'Étirements' }] as never;
    return store;
  }

  it('libellé du glisser à gauche selon la tâche', () => {
    const store = storeWith();
    expect(store.swipeLeftLabel({ id: 'water', done: false })).toBe('Masquer');
    expect(store.swipeLeftLabel({ id: 'walk', done: true })).toBe('');
    expect(store.swipeLeftLabel({ id: 'custom-1', done: true })).toBe('Supprimer');
    store._pendingIds = ['water'];
    expect(store.swipeLeftLabel({ id: 'water', done: false })).toBe('');
  });

  it('glisser à gauche : masque une tâche par défaut, supprime une tâche perso', async () => {
    const store = storeWith();
    const hide = vi.spyOn(store, 'hideTask').mockResolvedValue();
    const del = vi.spyOn(store, 'deleteCustomTask').mockResolvedValue();
    await store.swipeRemove('water');
    expect(hide).toHaveBeenCalledWith('water');
    await store.swipeRemove('custom-1');
    expect(del).toHaveBeenCalledWith('custom-1');
    await store.swipeRemove('walk');
    await store.swipeRemove('absente');
    expect(hide).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
  });
});
