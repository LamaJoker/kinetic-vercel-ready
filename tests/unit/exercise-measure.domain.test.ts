/**
 * Exercices chronométrés / distance : mesure déduite, saisie m:ss, validation,
 * records (meilleure durée) et exclusion des calculs reps × kg.
 */
import { describe, it, expect } from 'vitest';
import {
  bestTimed,
  defaultDistanceUnit,
  detectPRs,
  distanceInputValue,
  e1rm,
  exerciseMeasure,
  forgottenSet,
  formatDistance,
  formatDuration,
  formatSetShort,
  formatSetsShort,
  isTimedRecord,
  isTimedSet,
  loadSetsOf,
  normalizeCustomExercise,
  parseDistance,
  parseDuration,
  timedRecords,
  timedSetFields,
  timedSetsOf,
  updateSessionSet,
  validateSetInput,
  validateTimedSetInput,
} from '@kinetic/core';
import { estimateE1rmKg } from '../../apps/web/src/lib/training/rpe.js';

describe('mesure d’un exercice', () => {
  it('déduite du catalogue pour les exercices concernés', () => {
    expect(exerciseMeasure({ id: 'plank', name: 'Gainage' })).toBe('time');
    expect(exerciseMeasure({ id: 'sideplan', name: 'Gainage latéral' })).toBe('time');
    expect(exerciseMeasure({ id: 'farmerswalk', name: 'Marche du fermier' })).toBe('distance');
    expect(exerciseMeasure({ id: 'treadmill', name: 'Tapis' })).toBe('distance');
    expect(exerciseMeasure({ id: 'bp', name: 'Développé couché' })).toBe('reps');
  });

  it('déduite du nom pour les exercices perso ou importés, sans faux positifs', () => {
    expect(exerciseMeasure({ id: 'x', name: 'Chaise contre le mur' })).toBe('time');
    expect(exerciseMeasure({ id: 'x', name: 'Dead hang' })).toBe('time');
    expect(exerciseMeasure({ id: 'x', name: 'Course à pied' })).toBe('distance');
    expect(exerciseMeasure({ id: 'x', name: 'Hanging Leg Raise' })).toBe('reps');
    expect(exerciseMeasure({ id: 'x', name: 'Walking Lunges' })).toBe('reps');
    expect(exerciseMeasure({ id: 'x', name: 'Barbell Row' })).toBe('reps');
  });

  it('la mesure enregistrée l’emporte ; absente et illisible = reps', () => {
    expect(exerciseMeasure({ id: 'plank', name: 'Gainage', measure: 'reps' })).toBe('reps');
    expect(exerciseMeasure({ id: 'x', name: 'Mon exo', measure: 'time' })).toBe('time');
    expect(exerciseMeasure({ id: 'x', name: 'Mon exo', measure: 'bidon' })).toBe('reps');
    expect(exerciseMeasure(null)).toBe('reps');
  });

  it('exercice perso : la mesure est gardée, reps omis', () => {
    const base = { name: 'Chaise', muscles: ['quads'], equipment: 'bodyweight' as const };
    expect(normalizeCustomExercise({ ...base, incrementKg: 2.5, measure: 'time' }).measure).toBe(
      'time',
    );
    expect(
      'measure' in normalizeCustomExercise({ ...base, incrementKg: 2.5, measure: 'reps' }),
    ).toBe(false);
  });

  it('unité de distance par défaut', () => {
    expect(defaultDistanceUnit({ id: 'farmerswalk', name: 'Marche du fermier' })).toBe('m');
    expect(defaultDistanceUnit({ id: 'rower', name: 'Rameur' })).toBe('km');
  });
});

describe('saisie', () => {
  it('durée m:ss, secondes, minutes', () => {
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration("1'05")).toBe(65);
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('1 min 30')).toBe(90);
    expect(parseDuration('2min')).toBe(120);
    expect(parseDuration('1:02:05')).toBe(3725);
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('1:75')).toBeNaN();
    expect(parseDuration('abc')).toBeNaN();
  });

  it('distance en m ou km (virgule acceptée)', () => {
    expect(parseDistance('400')).toBe(400);
    expect(parseDistance('2,5 km')).toBe(2500);
    expect(parseDistance('5', 'km')).toBe(5000);
    expect(parseDistance('30 m', 'km')).toBe(30);
    expect(parseDistance('')).toBe(0);
    expect(parseDistance('loin')).toBeNaN();
    expect(distanceInputValue(2500, 'km')).toBe('2,5');
    expect(distanceInputValue(0, 'm')).toBe('');
  });

  it('affichage', () => {
    expect(formatDuration(45)).toBe('0:45');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDistance(400)).toBe('400 m');
    expect(formatDistance(2500)).toBe('2,5 km');
    expect(formatSetShort({ weightKg: 0, reps: 0, durationSec: 90 })).toBe('1:30');
    expect(formatSetShort({ weightKg: 20, reps: 0, durationSec: 60 })).toBe('20×1:00');
    expect(formatSetShort({ weightKg: 0, reps: 0, distanceM: 400, durationSec: 105 })).toBe(
      '400 m en 1:45',
    );
    expect(formatSetsShort([{ weightKg: 40, reps: 8 }])).toBe('40×8');
  });

  it('validation', () => {
    const ok = { durationSec: 60, distanceM: 0, weightKg: 0, rpe: 8 };
    expect(validateTimedSetInput(ok, 'time')).toBeNull();
    expect(validateTimedSetInput({ ...ok, durationSec: 0 }, 'time')).toMatch(/durée/i);
    expect(validateTimedSetInput({ ...ok, durationSec: 0, distanceM: 50 }, 'distance')).toBeNull();
    expect(validateTimedSetInput({ ...ok, durationSec: NaN }, 'time')).toMatch(/durée/i);
    expect(validateTimedSetInput({ ...ok, rpe: 11 }, 'time')).toMatch(/RPE/);
    expect(timedSetFields({ ...ok, weightKg: 10 })).toEqual({
      reps: 0,
      weightKg: 10,
      rpe: 8,
      durationSec: 60,
    });
  });
});

describe('exclusion des calculs reps × kg', () => {
  const timed = { weightKg: 40, reps: 0, rpe: 8, durationSec: 60 };
  const loaded = { weightKg: 100, reps: 5, rpe: 8 };

  it('pas d’e1RM sans répétition', () => {
    expect(e1rm(40, 0)).toBe(0);
    expect(estimateE1rmKg(40, 0)).toBe(0);
    expect(e1rm(100, 5)).toBeCloseTo(116.7, 1);
  });

  it('séries reps × charge et séries chronométrées séparées', () => {
    const sets = [{ ...loaded, kind: 'warmup' as const }, loaded, timed];
    expect(loadSetsOf(sets)).toEqual([loaded]);
    expect(timedSetsOf(sets)).toEqual([timed]);
    expect(isTimedSet(timed)).toBe(true);
    expect(isTimedSet(loaded)).toBe(false);
  });

  it('aucun record de charge sur une série chronométrée', () => {
    const at = '2026-11-10T10:00:00Z';
    const prs = detectPRs([
      { sessionId: 's', exerciseId: 'farmer', muscles: [], performedAt: at, ...timed },
    ]);
    expect(prs).toEqual([]);
  });
});

describe('records chronométrés', () => {
  const sessions = [
    {
      startedAt: '2026-11-01T10:00:00Z',
      entries: [
        {
          exerciseId: 'plank',
          sets: [
            { weightKg: 0, reps: 0, rpe: 8, durationSec: 60, performedAt: '2026-11-01T10:01:00Z' },
            { weightKg: 0, reps: 0, rpe: 8, durationSec: 300, kind: 'warmup' as const },
          ],
        },
        { exerciseId: 'bp', sets: [{ weightKg: 100, reps: 5, rpe: 8 }] },
      ],
    },
    {
      startedAt: '2026-11-08T10:00:00Z',
      entries: [
        {
          exerciseId: 'plank',
          sets: [{ weightKg: 10, reps: 0, rpe: 9, durationSec: 75 }],
        },
        {
          exerciseId: 'farmer',
          sets: [{ weightKg: 40, reps: 0, rpe: 8, distanceM: 30, durationSec: 25 }],
        },
      ],
    },
  ];

  it('meilleure durée (échauffement exclu) et distance', () => {
    expect(bestTimed(sessions, 'plank')).toMatchObject({
      durationSec: 75,
      durationAt: '2026-11-08T10:00:00Z',
      weightKg: 10,
      distanceM: 0,
    });
    expect(bestTimed(sessions, 'bp')).toBeNull();
    expect(timedRecords(sessions).map((r) => [r.exerciseId, r.durationSec, r.distanceM])).toEqual([
      ['plank', 75, 0],
      ['farmer', 25, 30],
    ]);
  });

  it('nouveau record seulement au-delà d’une référence', () => {
    const best = bestTimed(sessions, 'plank');
    expect(isTimedRecord({ durationSec: 80 }, best)).toBe(true);
    expect(isTimedRecord({ durationSec: 75 }, best)).toBe(false);
    expect(isTimedRecord({ durationSec: 80 }, null)).toBe(false);
  });
});

describe('correction d’une série chronométrée', () => {
  const session = {
    name: 'Gainage',
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
            durationSec: 60,
            performedAt: '2026-11-10T10:01:00Z',
          },
        ],
      },
    ],
  };

  it('valide et remplace durée / distance, reps reste à 0', () => {
    const input = { weightKg: 5, reps: 0, rpe: 8, durationSec: 90 };
    expect(validateSetInput(input)).toBeNull();
    expect(validateSetInput({ ...input, durationSec: 0 })).toMatch(/durée/i);
    const next = updateSessionSet(session, 'plank', 0, input);
    expect(next.entries[0]!.sets[0]).toMatchObject({ durationSec: 90, reps: 0, weightKg: 5 });
    expect('distanceM' in next.entries[0]!.sets[0]!).toBe(false);
  });

  it('série oubliée : copie la durée de la dernière', () => {
    const set = forgottenSet(session.entries[0]!.sets, session.startedAt);
    expect(set).toMatchObject({ reps: 0, durationSec: 60 });
  });

  it('série en reps : inchangée (reps obligatoires)', () => {
    expect(validateSetInput({ weightKg: 50, reps: 0, rpe: 8 })).toMatch(/Reps/);
  });
});
