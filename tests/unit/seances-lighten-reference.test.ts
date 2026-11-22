/**
 * « Forme basse » : l'allègement part de la charge de référence non allégée
 * (deux jours d'affilée ne cumulent pas la baisse) et « Même chose » propose
 * la charge allégée dans une séance allégée.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lightenSet, referencePerformance } from '@kinetic/core';

vi.mock('../../apps/web/src/pages/template-editor.page.js', () => ({
  openTemplateEditor: vi.fn(),
}));
vi.mock('../../apps/web/src/lib/training/rest-alert.js', () => ({
  scheduleRestAlert: vi.fn(async () => {}),
  cancelRestAlert: vi.fn(async () => {}),
}));

import { seances } from '../../apps/web/src/pages/seances.page.js';
import type { Exercise, WorkoutSession } from '../../apps/web/src/lib/training/types.js';

const BENCH: Exercise = {
  id: 'bench',
  name: 'Développé couché',
  muscles: ['chest'],
  equipment: 'barbell',
  incrementKg: 2.5,
};

const set = (weightKg: number, reps = 8) => ({
  setIndex: 0,
  weightKg,
  reps,
  rpe: 8,
  performedAt: '2026-11-10T10:00:00Z',
});

const session = (id: string, day: number, weightKg: number, lightened = false): WorkoutSession => ({
  id,
  name: 'Haut',
  startedAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`,
  endedAt: `2026-11-${String(day).padStart(2, '0')}T11:00:00Z`,
  entries: [{ exerciseId: 'bench', sets: [set(weightKg), set(weightKg)] }],
  ...(lightened ? { lightened: true } : {}),
});

describe('referencePerformance (domaine)', () => {
  it('ignore la dernière séance allégée', () => {
    const ref = referencePerformance([session('a', 10, 100), session('b', 12, 90, true)], 'bench');
    expect(ref?.sessionId).toBe('a');
    expect(ref?.sets[0]?.weightKg).toBe(100);
  });

  it('sans séance pleine, retombe sur la dernière (même allégée)', () => {
    const ref = referencePerformance([session('b', 12, 90, true)], 'bench');
    expect(ref?.sessionId).toBe('b');
  });

  it('exclut la séance en cours', () => {
    expect(referencePerformance([session('now', 12, 90)], 'bench', 'now')).toBeNull();
  });

  it('lightenSet : −10 % au pas de l’exercice, rien au poids du corps', () => {
    expect(lightenSet(set(100), 2.5).weightKg).toBe(90);
    expect(lightenSet(set(42.5), 2.5).weightKg).toBe(37.5);
    expect(lightenSet(set(0)).weightKg).toBe(0);
  });
});

function pageWith(history: WorkoutSession[]) {
  const page = seances();
  page.exercises = [BENCH];
  page.sessions = history;
  page.currentSession = {
    id: 'now',
    name: 'Haut',
    startedAt: new Date().toISOString(),
    entries: [{ exerciseId: 'bench', sets: [] }],
  };
  return page;
}

beforeEach(() => {
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe('séance allégée', () => {
  it('deux jours de forme basse d’affilée : −10 % de la charge pleine, pas −19 %', () => {
    // Avant-hier 100 kg (pleine), hier 90 kg (allégée).
    const page = pageWith([session('a', 10, 100), session('b', 12, 90, true)]);
    page._lighten = { sessionId: 'now', choice: 'apply' };
    const entry = page.currentSession!.entries[0]!;
    expect(page.setTarget('bench', 0)?.weightKg).toBe(100); // référence non allégée
    // « Même chose » propose la charge allégée de la référence…
    expect(page._sameAsLast(entry)?.weightKg).toBe(90);
    expect(page.sameAsLastLabel(entry)).toBe('90×8');
  });

  it('séance normale après une séance allégée : la cible repart de la charge pleine', () => {
    const page = pageWith([session('a', 10, 100), session('b', 12, 90, true)]);
    expect(page.setTarget('bench', 0)?.weightKg).toBe(100);
    // « Même chose » reste littéralement la dernière fois (hier, allégée).
    expect(page._sameAsLast(page.currentSession!.entries[0]!)?.weightKg).toBe(90);
  });

  it('séance allégée sans historique allégé : « Même chose » n’affiche pas la charge pleine', () => {
    const page = pageWith([session('a', 10, 100)]);
    page._lighten = { sessionId: 'now', choice: 'apply' };
    expect(page._sameAsLast(page.currentSession!.entries[0]!)?.weightKg).toBe(90);
  });
});
