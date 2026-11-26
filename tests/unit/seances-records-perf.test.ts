/**
 * Écran Séances : non-régressions de l'audit.
 *  - PERF-06 : records (badge PR) calculés en UNE passe sur l'historique, même résultat
 *    que le calcul d'origine, recalculés quand l'historique change (y compris la
 *    modification d'une séance passée) ; micro-benchmark déterministe (lectures comptées).
 *  - QA-09 : double appui sur « Terminer » → un seul enregistrement / événement.
 *  - QA-08 : écriture d'un modèle en échec → état restauré et message d'erreur.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/lib/training/template-editor-nav.js', () => ({
  openTemplateEditor: vi.fn(),
}));
vi.mock('../../apps/web/src/lib/training/rest-alert.js', () => ({
  scheduleRestAlert: vi.fn(async () => {}),
  cancelRestAlert: vi.fn(async () => {}),
}));
const store = new Map<string, unknown>();
const failingKeys = new Set<string>();
let writeDelayMs = 0;
vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(async () => ({
    storage: {
      set: vi.fn(async (k: string, v: unknown) => {
        if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
        if (failingKeys.has(k)) throw new Error('QuotaExceededError');
        store.set(k, v);
      }),
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      remove: vi.fn(async (k: string) => void store.delete(k)),
      keys: vi.fn(async () => [...store.keys()]),
    },
  })),
}));

import { STORAGE_KEYS, bestTimed, workSetsOf } from '../../packages/core/src/index.js';
import { seances } from '../../apps/web/src/pages/seances.page.js';
import { estimateE1rmKg } from '../../apps/web/src/lib/training/rpe.js';
import type { WorkoutSession, SetEntry } from '../../apps/web/src/lib/training/types.js';

const EXERCISES = ['bench', 'squat', 'row', 'press', 'dl', 'plank'];

/** Historique déterministe : 6 exercices, échauffements, entrées en double, chronométré. */
function history(count: number): WorkoutSession[] {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const sessions: WorkoutSession[] = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString();
    const entries = EXERCISES.slice(0, 3 + (i % 4)).map((exerciseId) => ({
      exerciseId,
      sets: Array.from({ length: 4 }, (_, k) => {
        const set: SetEntry = {
          setIndex: k,
          weightKg: Math.round(40 + rnd() * 80),
          reps: 1 + Math.floor(rnd() * 12),
          performedAt: day,
        };
        if (k === 0) set.kind = 'warmup';
        if (exerciseId === 'plank') {
          set.reps = 0;
          set.durationSec = 30 + Math.floor(rnd() * 90);
          set.distanceM = Math.floor(rnd() * 3) * 100;
        }
        return set;
      }),
    }));
    // Même exercice deux fois dans la séance : seule la première entrée compte.
    if (i % 5 === 0)
      entries.push({
        exerciseId: 'bench',
        sets: [{ setIndex: 0, weightKg: 300, reps: 10, performedAt: day }],
      });
    sessions.push({ id: `s${i}`, name: `S${i}`, startedAt: day, endedAt: day, entries });
  }
  return sessions;
}

/** Calcul d'origine de pr() (avant PERF-06), pour comparer. */
function referencePr(
  sessions: readonly WorkoutSession[],
  current: WorkoutSession | null,
  exerciseId: string,
): number | null {
  let best = 0;
  for (const s of current ? [...sessions, current] : sessions) {
    const entry = s.entries.find((e) => e.exerciseId === exerciseId);
    if (!entry) continue;
    for (const set of workSetsOf(entry.sets))
      best = Math.max(best, estimateE1rmKg(set.weightKg, set.reps));
  }
  return best > 0 ? best : null;
}

/** Sessions dont chaque lecture de `entries` est comptée (micro-benchmark déterministe). */
function counted(sessions: WorkoutSession[]): { sessions: WorkoutSession[]; reads: () => number } {
  let reads = 0;
  const wrapped = sessions.map((s) => {
    const copy = { ...s };
    Object.defineProperty(copy, 'entries', {
      enumerable: true,
      get: () => {
        reads++;
        return s.entries;
      },
    });
    return copy;
  });
  return { sessions: wrapped, reads: () => reads };
}

type Page = ReturnType<typeof seances>;

function currentSession(): WorkoutSession {
  return {
    id: 'now',
    name: 'En cours',
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    entries: [
      { exerciseId: 'bench', sets: [{ setIndex: 0, weightKg: 150, reps: 5, performedAt: '' }] },
      {
        exerciseId: 'plank',
        sets: [{ setIndex: 0, weightKg: 0, reps: 0, durationSec: 500, performedAt: '' }],
      },
    ],
  };
}

const events: CustomEvent[] = [];
beforeEach(() => {
  store.clear();
  failingKeys.clear();
  writeDelayMs = 0;
  events.length = 0;
  vi.stubGlobal('window', {
    dispatchEvent: (e: CustomEvent) => {
      events.push(e);
      return true;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PERF-06 : records précalculés', () => {
  it('même résultat que le calcul d’origine (historique, séance en cours, chronométré)', () => {
    const page: Page = seances();
    const sessions = history(60);
    page.sessions = sessions;
    for (const current of [null, currentSession()]) {
      page.currentSession = current;
      for (const id of [...EXERCISES, 'inconnu']) {
        expect(page.pr(id), id).toBe(referencePr(sessions, current, id));
      }
      const all = current ? [...sessions, current] : sessions;
      expect(page._bestTimed('plank')).toEqual(bestTimed(all, 'plank'));
      expect(page._bestTimed('bench')).toEqual(bestTimed(all, 'bench'));
    }
    // isSetPr : une série égale au record (à 0,1 kg près) est un record.
    page.currentSession = null;
    const best = page.pr('squat')!;
    const reps = 1;
    expect(page.isSetPr('squat', best / (1 + reps / 30), reps)).toBe(true);
    expect(page.isSetPr('squat', best / (1 + reps / 30) - 5, reps)).toBe(false);
  });

  it('une seule passe sur l’historique pour toute une séance affichée (lectures comptées)', () => {
    const page: Page = seances();
    const { sessions, reads } = counted(history(500));
    page.sessions = sessions;
    page.currentSession = currentSession();
    // 6 exercices × (en-tête : prLabel + isNewPr) + 4 séries × isSetPr ×2 (x-show, :class)
    for (let round = 0; round < 3; round++) {
      for (const id of EXERCISES.slice(0, 5)) {
        page.prLabel(id);
        page.isNewPr(id, 100, 5);
        for (let k = 0; k < 4; k++) {
          page.isSetPr(id, 80 + k, 5);
          page.isSetPr(id, 80 + k, 5);
        }
      }
    }
    // Avant : 150 évaluations × 500 séances = 75 000 lectures. Maintenant : une passe.
    expect(reads()).toBe(500);
  });

  it('recalculé quand l’historique change : séance ajoutée, séance passée modifiée, supprimée', () => {
    const page: Page = seances();
    const base = history(20);
    page.sessions = base;
    page.currentSession = null;
    const before = page.pr('row')!;

    const day = '2025-06-01T10:00:00.000Z';
    const heavy: WorkoutSession = {
      id: 'heavy',
      name: 'Lourd',
      startedAt: day,
      endedAt: day,
      entries: [
        { exerciseId: 'row', sets: [{ setIndex: 0, weightKg: 250, reps: 5, performedAt: day }] },
      ],
    };
    page.sessions = [...base, heavy];
    expect(page.pr('row')).toBeCloseTo(estimateE1rmKg(250, 5));

    // Correction d'une séance passée (même nombre de séances, même dernière séance).
    page.sessions = page.sessions.map((s) =>
      s.id === 'heavy'
        ? {
            ...s,
            entries: [
              {
                exerciseId: 'row',
                sets: [{ setIndex: 0, weightKg: 1, reps: 5, performedAt: day }],
              },
            ],
          }
        : s,
    );
    expect(page.pr('row')).toBe(before);

    page.sessions = page.sessions.filter((s) => !s.entries.some((e) => e.exerciseId === 'row'));
    expect(page.pr('row')).toBeNull();
  });

  it('séries ajoutées à la séance en cours prises en compte sans changer l’historique', () => {
    const page: Page = seances();
    page.sessions = history(10);
    page.currentSession = currentSession();
    const withCurrent = page.pr('bench')!;
    page.currentSession.entries[0]!.sets.push({
      setIndex: 1,
      weightKg: 400,
      reps: 5,
      performedAt: '',
    });
    expect(page.pr('bench')).toBeGreaterThan(withCurrent);
    expect(page.pr('bench')).toBeCloseTo(estimateE1rmKg(400, 5));
  });
});

describe('QA-09 : double appui sur « Terminer »', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  it('un seul enregistrement, un seul SESSION_SAVED, un seul message', async () => {
    writeDelayMs = 5;
    const page: Page = seances();
    page.sessions = [];
    page.currentSession = currentSession();
    expect(page.canFinishSession).toBe(true);
    const first = page.saveCurrentSession();
    expect(page.canFinishSession).toBe(false); // bouton désactivé pendant l'enregistrement
    await Promise.all([first, page.saveCurrentSession(), page.saveCurrentSession()]);

    const saved = events.filter((e) => e.type === STORAGE_KEYS.EVENT_SESSION_SAVED);
    const toasts = events.filter((e) => e.type === STORAGE_KEYS.EVENT_NOTIFY);
    expect(saved).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect((toasts[0]!.detail as { kind: string }).kind).toBe('success');
    expect(page.sessions.map((s) => s.id)).toEqual(['now']);
    expect(page.currentSession).toBeNull();
    expect(page.savingSession).toBe(false);
  });

  it('après un échec, « Terminer » redevient possible', async () => {
    failingKeys.add(STORAGE_KEYS.TRAINING_SESSION('now'));
    const page: Page = seances();
    page.sessions = [];
    page.currentSession = currentSession();
    await page.saveCurrentSession();
    expect(page.currentSession).not.toBeNull();
    expect(page.savingSession).toBe(false);
    expect(page.canFinishSession).toBe(true);
    failingKeys.clear();
    await page.saveCurrentSession();
    expect(page.currentSession).toBeNull();
  });
});

describe('QA-08 (Séances) : écriture en échec signalée et annulée', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  const templates = [
    { id: 't1', name: 'Haut', createdAt: '2026-01-01', exercises: [] },
    { id: 't2', name: 'Bas', createdAt: '2026-01-01', exercises: [] },
  ];

  it('suppression d’un modèle : modèle rétabli et message d’erreur', async () => {
    failingKeys.add(STORAGE_KEYS.TRAINING_TEMPLATES);
    const page: Page = seances();
    page.templates = [...templates];
    await page.deleteTemplate('t1');
    expect(page.templates.map((t) => t.id)).toEqual(['t1', 't2']);
    const err = events.find((e) => e.type === STORAGE_KEYS.EVENT_NOTIFY);
    expect((err?.detail as { kind: string; message: string }).kind).toBe('error');
    expect((err?.detail as { message: string }).message).toContain('Impossible d’enregistrer');
  });

  it('duplication d’un modèle et masquage d’une alerte : état rétabli', async () => {
    failingKeys.add(STORAGE_KEYS.TRAINING_TEMPLATES);
    failingKeys.add(STORAGE_KEYS.PLATEAU_DISMISSED);
    const page: Page = seances();
    page.templates = [...templates];
    await page.duplicateTemplate('t1');
    expect(page.templates).toHaveLength(2);
    const dismissed = page.plateauDismissed;
    await page.hidePlateau('bench');
    expect(page.plateauDismissed).toBe(dismissed);
    expect(events.filter((e) => e.type === STORAGE_KEYS.EVENT_NOTIFY)).toHaveLength(2);
  });

  it('écriture réussie : pas de message, état conservé', async () => {
    const page: Page = seances();
    page.templates = [...templates];
    await page.deleteTemplate('t1');
    expect(page.templates.map((t) => t.id)).toEqual(['t2']);
    expect(events).toHaveLength(0);
  });
});
