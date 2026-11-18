import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/lib/training/template-editor-nav.js', () => ({
  openTemplateEditor: vi.fn(),
}));
vi.mock('../../apps/web/src/lib/training/rest-alert.js', () => ({
  scheduleRestAlert: vi.fn(async () => {}),
  cancelRestAlert: vi.fn(async () => {}),
}));
const store = new Map<string, unknown>();
vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(async () => ({
    storage: {
      set: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      remove: vi.fn(async (k: string) => void store.delete(k)),
      keys: vi.fn(async () => [...store.keys()]),
    },
  })),
}));

import { STORAGE_KEYS } from '../../packages/core/src/index.js';
import { seances } from '../../apps/web/src/pages/seances.page.js';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

function set(setIndex: number, weightKg: number, reps: number, rpe = 8) {
  return { setIndex, weightKg, reps, rpe, performedAt: `2026-11-10T10:0${setIndex}:00.000Z` };
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
  page.sessions = [
    {
      id: 'old',
      name: 'Haut A',
      startedAt: '2026-11-03T10:00:00.000Z',
      endedAt: '2026-11-03T11:00:00.000Z',
      durationMin: 60,
      entries: [{ exerciseId: 'bench', sets: [set(0, 60, 8)] }],
    },
    {
      id: 'typo',
      name: 'Haut B',
      startedAt: '2026-11-10T10:00:00.000Z',
      endedAt: '2026-11-10T11:00:00.000Z',
      durationMin: 60,
      avgRpe: 8,
      entries: [{ exerciseId: 'bench', sets: [set(0, 400, 8), set(1, 62.5, 8)] }],
    },
  ] as WorkoutSession[];
  page.currentSession = {
    id: 'now',
    name: 'Haut C',
    startedAt: new Date().toISOString(),
    entries: [{ exerciseId: 'bench', sets: [set(0, 40, 8), set(1, 42.5, 8)] }],
  };
  return page;
}

const dispatch = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  dispatch.mockClear();
  vi.stubGlobal('window', { dispatchEvent: dispatch });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const events = (type: string) =>
  dispatch.mock.calls.map((c) => c[0] as CustomEvent).filter((e) => e.type === type);

describe('séance en cours : corriger une série', () => {
  it('toucher une série ouvre son édition, « Enregistrer » remplace la séance', () => {
    const page = makePage();
    const before = page.currentSession;
    page.openSetEditor('bench', 1);
    expect(page.setForm).toMatchObject({ weightKg: '42,5', reps: 8, rpe: '8', warmup: false });
    page.setForm.weightKg = '45,5';
    page.setForm.note = 'barre penchée';
    page.saveSetEditor();
    expect(page.setEditor).toBeNull();
    expect(page.currentSession).not.toBe(before); // remplacée → enregistrée par le $watch
    expect(page.currentEntries[0]!.sets[1]).toMatchObject({
      weightKg: 45.5,
      note: 'barre penchée',
    });
  });

  it('saisie invalide : message, rien ne change', () => {
    const page = makePage();
    page.openSetEditor('bench', 0);
    page.setForm.reps = 0;
    page.saveSetEditor();
    expect(page.setFormError).toMatch(/Reps/);
    expect(page.setEditor).not.toBeNull();
    expect(page.currentEntries[0]!.sets[0]!.reps).toBe(8);
  });

  it('passer en échauffement la range avant les séries de travail', () => {
    const page = makePage();
    page.openSetEditor('bench', 1);
    page.setFormWarmup();
    page.saveSetEditor();
    const sets = page.currentEntries[0]!.sets;
    expect(sets.map((s) => [s.weightKg, s.kind])).toEqual([
      [42.5, 'warmup'],
      [40, undefined],
    ]);
    expect(page.pr('bench')).toBeCloseTo(page.e1rm(400, 8), 1);
  });

  it('« Supprimer la série » puis « Annuler » la remet à sa place', () => {
    const page = makePage();
    page.openSetEditor('bench', 0);
    page.deleteEditedSet();
    expect(page.currentEntries[0]!.sets.map((s) => s.weightKg)).toEqual([42.5]);
    expect(page.undoSet).not.toBeNull();
    page.undoDeleteSet();
    expect(page.currentEntries[0]!.sets.map((s) => s.weightKg)).toEqual([40, 42.5]);
    expect(page.undoSet).toBeNull();
  });

  it('l’annulation disparaît après quelques secondes', () => {
    const page = makePage();
    page.openSetEditor('bench', 0);
    page.deleteEditedSet();
    vi.advanceTimersByTime(6000);
    expect(page.undoSet).toBeNull();
    expect(page.currentEntries[0]!.sets).toHaveLength(1);
  });
});

describe('séance passée : « Modifier »', () => {
  it('les séries ne sont touchables qu’en mode modification', () => {
    const page = makePage();
    page.openPastSetEditor('typo', 'bench', 0);
    expect(page.setEditor).toBeNull();
    page.startEditSession('typo');
    page.openPastSetEditor('typo', 'bench', 0);
    expect(page.setEditor).toMatchObject({ scope: 'history', setIndex: 0 });
  });

  it('corriger 400 → 40 : enregistré, records et événements recalculés', async () => {
    const page = makePage();
    expect(page.pr('bench')).toBeCloseTo(page.e1rm(400, 8), 1);
    page.startEditSession('typo');
    page.openPastSetEditor('typo', 'bench', 0);
    page.setForm.weightKg = '40';
    page.setForm.rpe = '9';
    page.saveSetEditor();
    // Rien n'est enregistré avant « Enregistrer » (séance d'origine intacte).
    expect(page.sessions[1]!.entries[0]!.sets[0]!.weightKg).toBe(400);
    page.editName = 'Haut B corrigé';
    await page.saveEditedSession();

    const saved = store.get(STORAGE_KEYS.TRAINING_SESSION('typo')) as WorkoutSession;
    expect(saved.name).toBe('Haut B corrigé');
    expect(saved.entries[0]!.sets.map((s) => s.weightKg)).toEqual([40, 62.5]);
    expect(saved.avgRpe).toBe(8.5);
    expect(page.sessions.find((s) => s.id === 'typo')).toEqual(saved);
    expect(page.editingSession).toBeNull();
    // Le record redescend (la séance en cours compte aussi : 42,5×8).
    expect(page.pr('bench')).toBeCloseTo(page.e1rm(62.5, 8), 1);
    expect(events(STORAGE_KEYS.EVENT_SESSION_SAVED)[0]!.detail.session.id).toBe('typo');
  });

  it('série oubliée : ajoutée puis éditée ; « Annuler » la retire', async () => {
    const page = makePage();
    page.startEditSession('old');
    page.addPastSet('bench');
    expect(page.setEditor).toMatchObject({ isNew: true, setIndex: 1 });
    page.closeSetEditor();
    expect(page.editingSession!.entries[0]!.sets).toHaveLength(1);

    page.addPastSet('bench');
    page.setForm.reps = 6;
    page.saveSetEditor();
    await page.saveEditedSession();
    const saved = store.get(STORAGE_KEYS.TRAINING_SESSION('old')) as WorkoutSession;
    expect(saved.entries[0]!.sets.map((s) => [s.weightKg, s.reps])).toEqual([
      [60, 8],
      [60, 6],
    ]);
  });

  it('changer la date réordonne l’historique et décale les séries', async () => {
    const page = makePage();
    page.startEditSession('old');
    const d = new Date('2026-11-12T18:00:00.000Z');
    const p = (n: number) => String(n).padStart(2, '0');
    page.editStart = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    await page.saveEditedSession();
    expect(page.sessions.map((s) => s.id)).toEqual(['typo', 'old']);
    const moved = page.sessions[1]!;
    expect(moved.startedAt).toBe('2026-11-12T18:00:00.000Z');
    expect(moved.endedAt).toBe('2026-11-12T19:00:00.000Z');
    // Série décalée d'autant que le début (9 j 8 h).
    expect(moved.entries[0]!.sets[0]!.performedAt).toBe('2026-11-19T18:00:00.000Z');
  });

  it('plus aucune série : refus, rien n’est enregistré', async () => {
    const page = makePage();
    page.startEditSession('old');
    page.openPastSetEditor('old', 'bench', 0);
    page.deleteEditedSet();
    await page.saveEditedSession();
    expect(store.size).toBe(0);
    expect(page.editingSession).not.toBeNull();
    expect(events(STORAGE_KEYS.EVENT_NOTIFY).at(-1)!.detail.kind).toBe('warning');
  });

  it('« Annuler » abandonne les modifications', () => {
    const page = makePage();
    page.startEditSession('typo');
    page.openPastSetEditor('typo', 'bench', 0);
    page.deleteEditedSet();
    page.cancelEditSession();
    expect(page.detailEntries(page.sessions[1]!)[0]!.sets).toHaveLength(2);
    expect(page.undoSet).toBeNull();
  });
});
