import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  PRESET_SPLITS,
  todayFocus,
  weekProgress,
  type TrainingProgram,
  type ProgramDay,
} from '@kinetic/core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProgram(overrides: Partial<TrainingProgram> = {}): TrainingProgram {
  return {
    id:          'prog-1',
    name:        'Test Program',
    splitType:   'ppl',
    daysPerWeek: 6,
    goal:        'hypertrophie',
    createdAt:   '2025-01-01T00:00:00Z',
    active:      true,
    schedule:    PRESET_SPLITS.ppl.schedule,
    ...overrides,
  };
}

// ─── PRESET_SPLITS ────────────────────────────────────────────────────────────

describe('PRESET_SPLITS', () => {
  it('contient les 5 types de split attendus', () => {
    const keys = Object.keys(PRESET_SPLITS);
    expect(keys).toContain('ppl');
    expect(keys).toContain('upper_lower');
    expect(keys).toContain('full_body');
    expect(keys).toContain('bro_split');
    expect(keys).toContain('custom');
  });

  it('PPL a 7 jours planifiés dont 6 jours de travail et 1 repos', () => {
    const { schedule } = PRESET_SPLITS.ppl;
    expect(schedule).toHaveLength(7);
    const restDays = schedule.filter((d) => d.restDay);
    expect(restDays).toHaveLength(1);
    expect(restDays[0]!.dayOfWeek).toBe(0); // dimanche
  });

  it('Upper/Lower a 4 jours de travail', () => {
    const { schedule } = PRESET_SPLITS.upper_lower;
    const trainingDays = schedule.filter((d) => !d.restDay);
    expect(trainingDays).toHaveLength(4);
  });

  it('Full Body a 3 jours de travail', () => {
    const trainingDays = PRESET_SPLITS.full_body.schedule.filter((d) => !d.restDay);
    expect(trainingDays).toHaveLength(3);
  });

  it('Bro Split a 5 jours de travail', () => {
    const trainingDays = PRESET_SPLITS.bro_split.schedule.filter((d) => !d.restDay);
    expect(trainingDays).toHaveLength(5);
  });

  it('Custom a un planning vide', () => {
    expect(PRESET_SPLITS.custom.schedule).toHaveLength(0);
  });

  it('chaque jour a un focus non vide (hors jours de repos)', () => {
    for (const [splitName, split] of Object.entries(PRESET_SPLITS)) {
      if (splitName === 'custom') continue;
      for (const day of split.schedule) {
        if (!day.restDay) {
          expect(day.focus, `${splitName} day ${day.dayOfWeek}`).toBeTruthy();
          expect(day.muscleGroups.length, `${splitName} day ${day.dayOfWeek}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('les dayOfWeek sont tous dans la plage 0–6', () => {
    for (const split of Object.values(PRESET_SPLITS)) {
      for (const day of split.schedule) {
        expect(day.dayOfWeek).toBeGreaterThanOrEqual(0);
        expect(day.dayOfWeek).toBeLessThanOrEqual(6);
      }
    }
  });
});

// ─── todayFocus ───────────────────────────────────────────────────────────────

describe('todayFocus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retourne le jour du programme correspondant au jour réel', () => {
    // Lundi = dayOfWeek 1
    vi.setSystemTime(new Date('2025-01-06T10:00:00Z')); // lundi
    const program = makeProgram();
    const focus = todayFocus(program);
    expect(focus).not.toBeNull();
    expect(focus!.dayOfWeek).toBe(1);
    expect(focus!.focus).toBe('Push A');
  });

  it('retourne dimanche (repos) si aujourd\'hui est dimanche', () => {
    vi.setSystemTime(new Date('2025-01-05T10:00:00Z')); // dimanche
    const program = makeProgram();
    const focus = todayFocus(program);
    expect(focus).not.toBeNull();
    expect(focus!.restDay).toBe(true);
  });

  it('retourne null si le programme n\'a pas de jour pour aujourd\'hui', () => {
    vi.setSystemTime(new Date('2025-01-06T10:00:00Z')); // lundi
    // Programme sans lundi
    const program = makeProgram({
      schedule: [
        { dayOfWeek: 2, label: 'Mardi', focus: 'Pull', muscleGroups: ['dos'], restDay: false },
      ],
    });
    const focus = todayFocus(program);
    expect(focus).toBeNull();
  });

  it('retourne null si le planning est vide (custom)', () => {
    const program = makeProgram({ schedule: [] });
    expect(todayFocus(program)).toBeNull();
  });
});

// ─── weekProgress ────────────────────────────────────────────────────────────

describe('weekProgress', () => {
  it('retourne 0 si aucun jour complété', () => {
    const program = makeProgram();
    expect(weekProgress(program, [])).toBe(0);
  });

  it('retourne 100 si tous les jours de travail sont complétés (PPL = 6 jours)', () => {
    const program = makeProgram();
    const trainingDays = program.schedule
      .filter((d) => !d.restDay)
      .map((d) => d.dayOfWeek);
    expect(weekProgress(program, trainingDays)).toBe(100);
  });

  it('retourne 50 si la moitié des jours de travail sont complétés', () => {
    const program = makeProgram();
    // PPL : 6 jours de travail → 3 complétés = 50%
    const completedDays = [1, 2, 3]; // lun, mar, mer
    expect(weekProgress(program, completedDays)).toBe(50);
  });

  it('ne compte pas les jours de repos dans le progrès', () => {
    const program = makeProgram();
    // Seul le dimanche (repos) est "complété"
    const progress = weekProgress(program, [0]);
    expect(progress).toBe(0);
  });

  it('retourne 0 si le programme n\'a que des jours de repos', () => {
    const program = makeProgram({
      schedule: [
        { dayOfWeek: 0, label: 'Dim', focus: 'Repos', muscleGroups: [], restDay: true },
        { dayOfWeek: 6, label: 'Sam', focus: 'Repos', muscleGroups: [], restDay: true },
      ],
    });
    expect(weekProgress(program, [0, 6])).toBe(0);
  });

  it('retourne 0 si le planning est vide', () => {
    const program = makeProgram({ schedule: [] });
    expect(weekProgress(program, [1, 2, 3])).toBe(0);
  });

  it('Upper/Lower — 4 jours → 25% à 1 jour complété', () => {
    const program = makeProgram({
      splitType: 'upper_lower',
      schedule:  PRESET_SPLITS.upper_lower.schedule,
    });
    expect(weekProgress(program, [1])).toBe(25);
  });

  it('arrondit le pourcentage à l\'entier le plus proche', () => {
    // Bro split : 5 jours → 1 complété = 20%
    const program = makeProgram({
      splitType: 'bro_split',
      schedule:  PRESET_SPLITS.bro_split.schedule,
    });
    expect(weekProgress(program, [1])).toBe(20);
  });
});
