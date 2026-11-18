/**
 * Écran Séances : supersets (enchaînement sans repos, repos en fin de tour) et
 * exercices chronométrés (saisie m:ss, chronomètre, exclusion de l'e1RM).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Isolé du routeur et des composants chargés à la demande (Alpine a besoin du DOM).
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

import { seances, entriesTonnageKg } from '../../apps/web/src/pages/seances.page.js';
import { buildCsvExport } from '../../apps/web/src/lib/training/export.js';
import type { Exercise, WorkoutSession } from '../../apps/web/src/lib/training/types.js';

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
  ex('curl', 'Curl'),
  ex('plank', 'Gainage', { equipment: 'bodyweight' }),
  ex('farmerswalk', 'Marche du fermier', { equipment: 'dumbbell' }),
];

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
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('séance : supersets', () => {
  it('« Lier en superset » depuis le menu, étiquettes A1/A2, « Délier »', () => {
    const p = page(['bench', 'row', 'curl']);
    expect(p.canLinkPrev('bench')).toBe(false);
    expect(p.canLinkNext('bench')).toBe(true);
    expect(p.linkNextLabel('bench')).toBe('Lier en superset avec Rowing barre');
    p.toggleMenu('bench');
    p.linkNext('bench');
    expect(p.menuFor).toBeNull();
    expect(p.supersetTag('bench')).toBe('A1');
    expect(p.supersetTag('row')).toBe('A2');
    expect(p.supersetTag('curl')).toBe('');
    const blocks = p.entryBlocks();
    expect(blocks).toHaveLength(2);
    expect(p.supersetTitle(blocks[0]!)).toBe('Superset A');
    // Le 3e exercice rejoint le superset : circuit
    p.linkPrev('curl');
    expect(p.supersetTag('curl')).toBe('A3');
    expect(p.supersetTitle(p.entryBlocks()[0]!)).toBe('Circuit A');
    p.unlink('row');
    expect(p.currentEntries.every((e) => e.group === undefined)).toBe(true);
  });

  it('après A1 : saisie sur A2 sans repos ; repos seulement à la fin du tour', () => {
    const p = page(['bench', 'row', 'curl'], { bench: 'ss1', row: 'ss1' });
    p.setActiveEntry('bench');
    p.draft.weightKg = 60;
    p.draft.reps = 8;
    p.addSet('bench');
    expect(p.isActiveEntry('row')).toBe(true);
    expect(p.restEndsAtMs).toBe(0);
    p.draft.weightKg = 50;
    p.draft.reps = 10;
    p.addSet('row');
    expect(p.restEndsAtMs).toBeGreaterThan(Date.now());
    expect(p.isActiveEntry('bench')).toBe(true);
  });

  it('retirer un exercice dissout le superset devenu isolé', () => {
    const p = page(['bench', 'row'], { bench: 'ss1', row: 'ss1' });
    p.removeExercise('row');
    expect(p.currentEntries[0]!.group).toBeUndefined();
  });

  it('le superset est gardé dans l’historique (A1 · nom)', () => {
    const p = page([]);
    const s: WorkoutSession = {
      id: 'old',
      name: 'Haut',
      startedAt: '2026-11-10T10:00:00Z',
      entries: [
        { exerciseId: 'bench', sets: [], group: 'ss1' },
        { exerciseId: 'row', sets: [], group: 'ss1' },
      ],
    };
    expect(p.historyEntryTitle(s, s.entries[1]!)).toBe('A2 · Rowing barre');
  });
});

describe('séance : exercices chronométrés', () => {
  it('mesure déduite du catalogue', () => {
    const p = page([]);
    expect(p.measureOf('plank')).toBe('time');
    expect(p.measureOf('farmerswalk')).toBe('distance');
    expect(p.measureOf('bench')).toBe('reps');
    expect(p.setsColumnLabel('plank')).toBe('Durée');
  });

  it('série m:ss : reps à 0, hors tonnage et e1RM, repos lancé', () => {
    const p = page(['plank']);
    p.setActiveEntry('plank');
    p.draft.duration = '1:30';
    p.draft.weightKg = 0;
    p.addSet('plank');
    const set = p.currentEntries[0]!.sets[0]!;
    expect(set).toMatchObject({ reps: 0, durationSec: 90, weightKg: 0 });
    expect(entriesTonnageKg(p.currentEntries)).toBe(0);
    expect(p.pr('plank')).toBeNull();
    expect(p.prLabel('plank')).toBe('1:30');
    expect(p.timedMain(set)).toBe('1:30');
    expect(p.setSideValue(set)).toBe('—');
    expect(p.restEndsAtMs).toBeGreaterThan(Date.now());
    expect(p.progressionSuggestion('plank')).toBeNull();
  });

  it('durée manquante : avertissement, rien n’est enregistré', () => {
    const p = page(['plank']);
    p.draft.duration = '';
    p.addSet('plank');
    expect(p.currentEntries[0]!.sets).toHaveLength(0);
    expect(window.dispatchEvent).toHaveBeenCalled();
  });

  it('chronomètre « Démarrer / Arrêter » : la durée mesurée remplit la saisie', () => {
    const p = page(['plank']);
    p.toggleStopwatch('plank');
    expect(p.stopwatchRunning('plank')).toBe(true);
    vi.advanceTimersByTime(47_000);
    p.nowMs = Date.now();
    expect(p.stopwatchLabel()).toBe('0:47');
    p.toggleStopwatch('plank');
    expect(p.stopwatchRunning('plank')).toBe(false);
    expect(p.draft.duration).toBe('0:47');
    p.bumpDuration(15);
    expect(p.draft.duration).toBe('1:02');
  });

  it('le chronomètre s’arrête avec la séance (pas de chrono fantôme ensuite)', () => {
    const p = page(['plank']);
    p.toggleStopwatch('plank');
    expect(p.stopwatchRunning('plank')).toBe(true);
    p.abandonCurrentSession();
    expect(p.currentSession).toBeNull();
    expect(p.stopwatch).toBeNull();
    expect(p.stopwatchRunning('plank')).toBe(false);
  });

  it('distance en km + durée, charge facultative ; record de distance', () => {
    const p = page(['farmerswalk']);
    p.setDistUnit('km');
    p.draft.distance = '0,4';
    p.draft.duration = '1:45';
    p.draft.weightKg = 40;
    p.addSet('farmerswalk');
    const set = p.currentEntries[0]!.sets[0]!;
    expect(set).toMatchObject({ reps: 0, distanceM: 400, durationSec: 105, weightKg: 40 });
    expect(p.timedMain(set)).toBe('400 m en 1:45');
    expect(p.prLabel('farmerswalk')).toBe('400 m');
    p.draft.distance = '0,5';
    expect(p.isNewPr('farmerswalk', 40, 0)).toBe(true);
    p.setDistUnit('m');
    expect(p.draft.distance).toBe('500');
  });

  it('export CSV : durée et distance à part, pas d’e1RM', () => {
    const csv = buildCsvExport(
      [
        {
          id: 's',
          name: 'S',
          startedAt: '2026-11-10T10:00:00Z',
          entries: [
            {
              exerciseId: 'plank',
              sets: [
                {
                  setIndex: 0,
                  weightKg: 0,
                  reps: 0,
                  rpe: 8,
                  durationSec: 90,
                  performedAt: '2026-11-10T10:05:00Z',
                },
              ],
            },
          ],
        },
      ],
      EXERCISES,
    );
    const [head, row] = csv.slice(1).split('\r\n');
    const cols = head!.split(',').map((c) => c.replaceAll('"', ''));
    const cells = row!.split(',');
    expect(cells[cols.indexOf('duration_s')]).toBe('90');
    expect(cells[cols.indexOf('e1rm_kg')]).toBe('');
    expect(cols.at(-1)).toBe('set_type');
  });
});
