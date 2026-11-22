/**
 * Séances › « Mode salle » : bascule mémorisée, vue affichée (saisie, repos
 * géant, chronométré), validation de la série, supersets et exercice suivant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';

vi.mock('../../apps/web/src/pages/template-editor.page.js', () => ({
  openTemplateEditor: vi.fn(),
}));
vi.mock('../../apps/web/src/lib/lazy-component.js', () => ({
  loadTrainingCalendar: vi.fn(async () => {}),
  loadMuscleMap: vi.fn(async () => {}),
}));
vi.mock('../../apps/web/src/lib/training/rest-alert.js', () => ({
  scheduleRestAlert: vi.fn(async () => {}),
  cancelRestAlert: vi.fn(async () => {}),
}));

import { seances } from '../../apps/web/src/pages/seances.page.js';
import type { Exercise } from '../../apps/web/src/lib/training/types.js';

const ex = (id: string, name: string, extra: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscles: ['chest'],
  equipment: 'barbell',
  incrementKg: 2.5,
  ...extra,
});
const EXERCISES = [
  ex('bench', 'Développé couché'),
  ex('row', 'Rowing barre'),
  ex('plank', 'Gainage', { equipment: 'bodyweight' }),
];

let ls: Map<string, string>;

function page(ids: string[], groups: Record<string, string> = {}) {
  const p = seances();
  p.exercises = EXERCISES;
  p.sessions = [];
  p.currentSession = {
    id: 'now',
    name: 'Séance',
    startedAt: new Date().toISOString(),
    entries: ids.map((exerciseId) => ({
      exerciseId,
      sets: [],
      ...(groups[exerciseId] ? { group: groups[exerciseId] } : {}),
    })),
  };
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
  ls = new Map();
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mode salle', () => {
  it('bascule mémorisée, visible seulement pendant une séance', () => {
    const p = page(['bench']);
    expect(p.gymOn()).toBe(false);
    p.enterGymMode();
    expect(p.gymOn()).toBe(true);
    expect(ls.get(STORAGE_KEYS.GYM_MODE)).toBe('1');
    // Nouvelle visite de l'écran : toujours en mode salle
    expect(page(['bench']).gymOn()).toBe(true);
    const none = seances();
    expect(none.gymOn()).toBe(false); // pas de séance en cours
    p.exitGymMode();
    expect(ls.get(STORAGE_KEYS.GYM_MODE)).toBe('0');
    expect(page(['bench']).gymOn()).toBe(false);
  });

  it('valider la série : enregistrée, puis minuteur de repos géant', () => {
    const p = page(['bench', 'row']);
    p.enterGymMode();
    expect(p.gymExerciseName()).toBe('Développé couché');
    expect(p.gymView()).toBe('reps');
    expect(p.gymSetTitle()).toBe('Série 1');
    expect(p.gymProgress()).toBe('Exercice 1/2');
    p.draft.weightKg = 80;
    p.draft.reps = 8;
    p.gymValidate();
    expect(p.currentSession!.entries[0]!.sets).toHaveLength(1);
    expect(p.gymView()).toBe('rest');
    expect(p.gymLastLabel()).toBe('Dernière : 80 kg × 8');
    p.skipRest();
    expect(p.gymView()).toBe('reps');
    expect(p.gymSetTitle()).toBe('Série 2');
  });

  it('échauffement : pas de repos, titre dédié', () => {
    const p = page(['bench']);
    p.toggleDraftWarmup();
    expect(p.gymSetTitle()).toBe('Échauffement 1');
    p.gymValidate();
    expect(p.gymView()).toBe('reps');
    expect(p.currentSession!.entries[0]!.sets[0]!.kind).toBe('warmup');
  });

  it('superset : la saisie passe au membre suivant sans repos', () => {
    const p = page(['bench', 'row'], { bench: 'g1', row: 'g1' });
    expect(p.gymSetTitle()).toBe('Série 1 · A1');
    p.gymValidate();
    expect(p.gymExerciseId()).toBe('row');
    expect(p.gymView()).toBe('reps');
    expect(p.gymSetTitle()).toBe('Série 1 · A2');
    p.gymValidate();
    expect(p.gymView()).toBe('rest'); // repos à la fin du tour
  });

  it('exercice chronométré : chrono géant', () => {
    const p = page(['plank']);
    expect(p.gymView()).toBe('time');
    expect(p.gymTimed()).toBe(true);
    expect(p.gymDurationLabel()).toBe('0:00');
    p.gymToggleStopwatch();
    expect(p.gymStopwatchRunning()).toBe(true);
    vi.advanceTimersByTime(42_000);
    p.nowMs = Date.now();
    expect(p.gymDurationLabel()).toBe('0:42');
    p.gymToggleStopwatch();
    expect(p.draft.duration).toBe('0:42');
    p.gymValidate();
    expect(p.currentSession!.entries[0]!.sets[0]!.durationSec).toBe(42);
  });

  it('exercice suivant : le prochain pas encore commencé', () => {
    const p = page(['bench', 'row', 'plank']);
    expect(p.gymHasNext()).toBe(true);
    p.gymNext();
    expect(p.gymExerciseId()).toBe('row');
    p.gymNext();
    expect(p.gymExerciseId()).toBe('plank');
    expect(page(['bench']).gymHasNext()).toBe(false);
  });
});
