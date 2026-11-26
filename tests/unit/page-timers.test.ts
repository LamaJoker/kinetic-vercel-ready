/**
 * Page Minuteurs : réglage, déroulé (pause, passer, fin) et finisher ajouté à
 * la séance en cours seulement quand on vient de la séance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS, TIMER_PREP_SEC, FINISHER_EXERCISE } from '@kinetic/core';

const store = new Map<string, unknown>();
const storage = {
  get: vi.fn(async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null)),
  set: vi.fn(async (k: string, v: unknown) => void store.set(k, structuredClone(v))),
  remove: vi.fn(async (k: string) => void store.delete(k)),
  keys: vi.fn(async () => [...store.keys()]),
};
// Identifiants fournis par deps.idGen (QA-12 : la page n'instancie plus d'adaptateur).
let nextId = 0;
const idGen = { newId: vi.fn(() => `preset-${++nextId}`) };
vi.mock('../../apps/web/src/deps', () => ({ getDeps: async () => ({ storage, idGen }) }));
vi.mock('../../apps/web/src/lib/haptics', () => ({
  hapticLight: vi.fn(),
  hapticMedium: vi.fn(),
  hapticHeavy: vi.fn(),
  hapticSuccess: vi.fn(),
}));

const { timersPage } = await import('../../apps/web/src/pages/timers.page.js');

const SNAP = {
  v: 1,
  session: {
    id: 's1',
    name: 'Push A',
    startedAt: '2026-11-22T09:00:00.000Z',
    entries: [{ exerciseId: 'bench', sets: [] }],
  },
  restEndsAtMs: 0,
  restTotalSec: 90,
  restPresetSec: 90,
  activeExerciseId: 'bench',
  savedAtMs: 0,
};

function stubWindow(search: string) {
  vi.stubGlobal('window', {
    location: { search },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('navigator', {});
}

beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('page Minuteurs', () => {
  it('réglage : changement de mode, bornes, durée totale, préréglage', async () => {
    stubWindow('?mode=emom');
    const p = timersPage();
    await p.init();
    expect(p.cfg.mode).toBe('emom');
    expect(p.title()).toBe('EMOM 10 min');
    const rounds = p.fields().find((f) => f.key === 'rounds')!;
    p.bump(rounds, 2);
    expect(p.title()).toBe('EMOM 12 min');
    expect(p.totalLabel()).toBe('12 min');
    p.setMode('tabata');
    expect(p.fieldValue(p.fields()[0]!)).toBe('20 s');
    await p.savePreset();
    expect(store.get(STORAGE_KEYS.TIMER_PRESETS)).toMatchObject([
      { name: 'Tabata 20 s / 10 s × 8' },
    ]);
    // L'identifiant du préréglage vient du port IdGenerator de deps.
    expect(idGen.newId).toHaveBeenCalledTimes(1);
    const [saved] = store.get(STORAGE_KEYS.TIMER_PRESETS) as Array<{ id: string }>;
    expect(saved!.id).toBe(idGen.newId.mock.results[0]!.value);
  });

  it('déroulé : prêt, effort, pause, passer, fin', async () => {
    stubWindow('');
    const p = timersPage();
    await p.init();
    p.start();
    expect(p.view).toBe('run');
    expect(p.phaseLabel()).toBe('Prêt');
    expect(p.tone()).toBe('prep');
    vi.advanceTimersByTime(TIMER_PREP_SEC * 1000 + 1000);
    expect(p.phaseLabel()).toBe('Effort');
    expect(p.roundLabel()).toBe('Tour 1/8');
    expect(p.toneClass()).toBe('k-stage-work');
    p.togglePause();
    expect(p.paused()).toBe(true);
    const frozen = p.clockText();
    vi.advanceTimersByTime(30_000);
    expect(p.clockText()).toBe(frozen);
    p.togglePause();
    p.skip();
    expect(p.phaseLabel()).toBe('Repos');
    expect(p.tone()).toBe('rest');
    vi.advanceTimersByTime(10 * 60_000);
    expect(p.view).toBe('done');
    expect(p.completed).toBe(true);
    // Hors séance : rien n'est enregistré
    expect(p.finisher).toBe(false);
    expect(store.has(STORAGE_KEYS.TRAINING_ACTIVE_SESSION)).toBe(false);
  });

  it('lancé depuis la séance : le finisher est ajouté à la fin', async () => {
    store.set(STORAGE_KEYS.TRAINING_ACTIVE_SESSION, SNAP);
    stubWindow('?finisher=1&mode=amrap');
    const p = timersPage();
    await p.init();
    expect(p.finisher).toBe(true);
    expect(p.finisherSessionName).toBe('Push A');
    p.start();
    p.addRound(1);
    p.addRound(1);
    vi.advanceTimersByTime((TIMER_PREP_SEC + 600) * 1000 + 500);
    await vi.runOnlyPendingTimersAsync();
    expect(p.view).toBe('done');
    await vi.waitFor(() => expect(p.recorded).toBe(true));
    const snap = store.get(STORAGE_KEYS.TRAINING_ACTIVE_SESSION) as typeof SNAP;
    const entry = snap.session.entries.at(-1) as unknown as {
      exerciseId: string;
      sets: Array<{ durationSec: number; note: string }>;
    };
    expect(entry.exerciseId).toBe(FINISHER_EXERCISE.id);
    expect(entry.sets[0]).toMatchObject({ durationSec: 600, note: 'AMRAP 10 min · 2 tours' });
    const custom = store.get(STORAGE_KEYS.TRAINING_CUSTOM_EXERCISES) as Array<{ id: string }>;
    expect(custom.map((e) => e.id)).toEqual([FINISHER_EXERCISE.id]);
  });

  it('arrêté avant la fin : ajout à la demande seulement', async () => {
    store.set(STORAGE_KEYS.TRAINING_ACTIVE_SESSION, SNAP);
    stubWindow('?finisher=1');
    const p = timersPage();
    await p.init();
    p.start();
    vi.advanceTimersByTime((TIMER_PREP_SEC + 45) * 1000);
    p.stop();
    await vi.waitFor(() => expect(p.view).toBe('done'));
    expect(p.completed).toBe(false);
    expect(p.recorded).toBe(false);
    expect(p.canRecord()).toBe(true);
    await p.recordFinisher();
    const snap = store.get(STORAGE_KEYS.TRAINING_ACTIVE_SESSION) as typeof SNAP;
    expect(snap.session.entries).toHaveLength(2);
    expect(p.canRecord()).toBe(false);
  });

  it('?finisher=1 sans séance en cours : simple minuteur', async () => {
    stubWindow('?finisher=1');
    const p = timersPage();
    await p.init();
    expect(p.finisher).toBe(false);
  });
});

describe('préréglages : sauvegarde et démo', () => {
  it('inclus dans la sauvegarde et montrés par la démo', async () => {
    const { isBackedUpKey } = await import('../../apps/web/src/lib/backup.js');
    const { buildDemoData } = await import('../../apps/web/src/lib/demo.js');
    const { normalizeTimerPresets } = await import('@kinetic/core');
    expect(isBackedUpKey(STORAGE_KEYS.TIMER_PRESETS)).toBe(true);
    const demo = buildDemoData(new Date('2026-11-22T10:00:00Z'));
    const presets = demo.values.find(([k]) => k === STORAGE_KEYS.TIMER_PRESETS)?.[1];
    expect(normalizeTimerPresets(presets).map((p) => p.name)).toEqual([
      'Tabata burpees',
      'EMOM kettlebell 12 min',
    ]);
  });
});
