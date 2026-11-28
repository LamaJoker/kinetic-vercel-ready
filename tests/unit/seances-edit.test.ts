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

describe('séance en cours : « Annuler la séance »', () => {
  it('confirmation puis suppression : rien n’est enregistré, repos et sauvegarde locale effacés', async () => {
    const { cancelRestAlert } = await import('../../apps/web/src/lib/training/rest-alert.js');
    const page = makePage();
    const schedule = vi.fn();
    page._activeWriter = {
      schedule,
      flush: vi.fn(async () => {}),
      pending: () => false,
      failing: () => false,
    };
    page.restEndsAtMs = Date.now() + 60_000;
    page.openSetEditor('bench', 0);
    page.askAbandon();
    expect(page.confirmAbandon).toBe(true);
    page.cancelAbandon(); // « Continuer la séance »
    expect(page.currentSession).not.toBeNull();
    page.askAbandon();
    page.abandonCurrentSession();
    expect(page.currentSession).toBeNull();
    expect(page.confirmAbandon).toBe(false);
    expect(page.setEditor).toBeNull();
    expect(page.restEndsAtMs).toBe(0);
    expect(cancelRestAlert).toHaveBeenCalled();
    expect(schedule).toHaveBeenLastCalledWith(null); // séance en cours effacée de l'appareil
    expect(store.size).toBe(0); // aucune séance enregistrée (donc rien à synchroniser)
    expect(page.sessions.map((s) => s.id)).toEqual(['old', 'typo']);
    expect(events(STORAGE_KEYS.EVENT_SESSION_SAVED)).toHaveLength(0);
    expect(events(STORAGE_KEYS.EVENT_NOTIFY).at(-1)!.detail.message).toMatch(/annulée/);
  });
});

describe('« Ajouter une séance passée »', () => {
  const NOW = new Date(2026, 10, 28, 10, 0); // 28 nov. 2026, 10 h (heure locale)
  const template = {
    id: 'tpl-haut',
    name: 'Haut du corps',
    createdAt: '2026-01-01T00:00:00.000Z',
    exercises: [{ exerciseId: 'bench', sets: 2, targetReps: 6, targetRpe: 8 }],
  };

  it('feuille : aujourd’hui par défaut ; date future refusée', () => {
    vi.setSystemTime(NOW);
    const page = makePage();
    page.openPastSession();
    expect(page.pastSheet).toMatchObject({
      date: '2026-11-28',
      time: '08:59',
      duration: 60,
      templateId: '',
    });
    expect(page.pastMaxDate()).toBe('2026-11-28');
    page.pastSheet!.date = '2026-11-29';
    page.createPastSession();
    expect(page.pastSheet!.error).toMatch(/futur/);
    expect(page.editingSession).toBeNull();
  });

  it('modèle : brouillon pré-rempli, enregistré à sa date sans toucher aux autres séances', async () => {
    vi.setSystemTime(NOW);
    const page = makePage();
    page.templates = [template];
    page.openPastSession();
    Object.assign(page.pastSheet!, {
      date: '2026-11-05',
      time: '18:30',
      duration: '45',
      templateId: 'tpl-haut',
    });
    page.createPastSession();
    expect(page.pastSheet).toBeNull();
    const draft = page.editingSession!;
    expect(page.editingIsNew).toBe(true);
    expect(['old', 'typo', 'now']).not.toContain(draft.id); // identifiant neuf
    // Visible en tête de l'historique, pas encore enregistré.
    expect(page.visibleSessions()[0]!.id).toBe(draft.id);
    expect(page.sessions).toHaveLength(2);
    // Charge de la dernière fois AVANT le 5 novembre (séance du 3 : 60 kg).
    expect(draft.entries[0]!.sets.map((s) => [s.weightKg, s.reps])).toEqual([
      [60, 6],
      [60, 6],
    ]);
    // Replier la ligne ne perd pas la saisie.
    page.toggleSessionDetail(draft.id);
    expect(page.editingSession).not.toBeNull();

    await page.saveEditedSession();
    const saved = store.get(STORAGE_KEYS.TRAINING_SESSION(draft.id)) as WorkoutSession;
    expect(new Date(saved.startedAt).getDate()).toBe(5);
    expect(new Date(saved.startedAt).getHours()).toBe(18);
    expect(saved).toMatchObject({ templateId: 'tpl-haut', durationMin: 45, name: 'Haut du corps' });
    expect(Date.parse(saved.endedAt!) - Date.parse(saved.startedAt)).toBe(45 * 60_000);
    expect(page.sessions.map((s) => s.id)).toEqual(['old', draft.id, 'typo']);
    expect(store.size).toBe(1); // seule la nouvelle séance est écrite
    expect(page.editingSession).toBeNull();
    expect(page.editingIsNew).toBe(false);
    expect(page.currentSession?.id).toBe('now'); // séance en cours intacte
    expect(events(STORAGE_KEYS.EVENT_SESSION_SAVED)[0]!.detail.session.id).toBe(draft.id);
  });

  it('séance libre : exercice ajouté puis série saisie ; « Annuler » ne laisse rien', async () => {
    vi.setSystemTime(NOW);
    const page = makePage();
    page.openPastSession();
    Object.assign(page.pastSheet!, { date: '2026-11-27', time: '07:00', duration: 50 });
    page.createPastSession();
    await page.saveEditedSession(); // aucune série : refusé
    expect(events(STORAGE_KEYS.EVENT_NOTIFY).at(-1)!.detail.message).toMatch(/au moins/);
    expect(store.size).toBe(0);

    page.pastExerciseId = 'bench';
    page.addPastExercise();
    expect(page.setEditor).toMatchObject({ scope: 'history', isNew: true, setIndex: 0 });
    page.setForm.weightKg = '80';
    page.setForm.reps = 5;
    page.saveSetEditor();
    const id = page.editingSession!.id;
    await page.saveEditedSession();
    const saved = store.get(STORAGE_KEYS.TRAINING_SESSION(id)) as WorkoutSession;
    expect(saved.entries[0]!.sets.map((s) => [s.weightKg, s.reps])).toEqual([[80, 5]]);
    expect(page.sessions.map((s) => s.id)).toEqual(['old', 'typo', id]);

    page.openPastSession();
    page.createPastSession();
    page.cancelEditSession();
    expect(page.visibleSessions().map((s) => s.id)).toEqual([id, 'typo', 'old']);
    expect(page.expandedSessionId).toBeNull();
  });

  it('séance existante déplacée dans le futur : refusée', async () => {
    vi.setSystemTime(NOW);
    const page = makePage();
    page.startEditSession('old');
    page.editStart = '2026-11-30T10:00';
    await page.saveEditedSession();
    expect(store.size).toBe(0);
    expect(events(STORAGE_KEYS.EVENT_NOTIFY).at(-1)!.detail.message).toMatch(/futur/);
    expect(page.editingSession).not.toBeNull();
  });

  it('séance existante déplacée à aujourd’hui : refusée si elle finirait dans le futur', async () => {
    vi.setSystemTime(NOW); // 10 h ; la séance dure 1 h
    const page = makePage();
    page.startEditSession('old');
    page.editStart = '2026-11-28T09:30';
    await page.saveEditedSession();
    expect(store.size).toBe(0);
    expect(events(STORAGE_KEYS.EVENT_NOTIFY).at(-1)!.detail.message).toMatch(/futur/);
    page.editStart = '2026-11-28T08:30';
    await page.saveEditedSession();
    const saved = store.get(STORAGE_KEYS.TRAINING_SESSION('old')) as WorkoutSession;
    expect(Date.parse(saved.endedAt!)).toBeLessThanOrEqual(NOW.getTime());
  });
});
