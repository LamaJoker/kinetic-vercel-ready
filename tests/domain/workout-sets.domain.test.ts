import { describe, it, expect } from 'vitest';
import {
  formatSetsShort,
  isWarmupSet,
  lastPerformance,
  matchingLastSet,
  nextSetTarget,
  warmupRamp,
  warmupSetsOf,
  workSetsOf,
  evaluateWeeklyGoals,
} from '../../packages/core/src/index.js';

const w = (weightKg: number, reps: number, kind?: 'warmup' | 'work') => ({
  weightKg,
  reps,
  ...(kind ? { kind } : {}),
});

describe('séries : échauffement / travail', () => {
  it('sans kind = travail (séances stockées avant le champ)', () => {
    const sets = [w(20, 10, 'warmup'), w(60, 8), w(60, 8, 'work')];
    expect(isWarmupSet(sets[0]!)).toBe(true);
    expect(workSetsOf(sets)).toHaveLength(2);
    expect(warmupSetsOf(sets)).toHaveLength(1);
  });
});

describe('la dernière fois', () => {
  const sessions = [
    {
      id: 'a',
      startedAt: '2026-11-01T10:00:00Z',
      entries: [{ exerciseId: 'bench', sets: [w(40, 8)] }],
    },
    {
      id: 'b',
      startedAt: '2026-11-08T10:00:00Z',
      entries: [
        { exerciseId: 'bench', sets: [w(20, 10, 'warmup'), w(40, 8), w(42.5, 8), w(42.5, 7)] },
      ],
    },
    // Plus récente mais échauffement seulement : ignorée
    {
      id: 'c',
      startedAt: '2026-11-10T10:00:00Z',
      entries: [{ exerciseId: 'bench', sets: [w(20, 10, 'warmup')] }],
    },
    {
      id: 'cur',
      startedAt: '2026-11-12T10:00:00Z',
      entries: [{ exerciseId: 'bench', sets: [w(50, 5)] }],
    },
  ];

  it('prend la séance la plus récente avec des séries de travail, hors séance en cours', () => {
    const last = lastPerformance(sessions, 'bench', 'cur');
    expect(last?.sessionId).toBe('b');
    expect(formatSetsShort(last!.sets)).toBe('40×8 · 42,5×8 · 42,5×7');
    expect(lastPerformance(sessions, 'squat')).toBeNull();
  });

  it('poids du corps : « 8 reps » plutôt que « 0×8 »', () => {
    expect(
      formatSetsShort([
        { weightKg: 0, reps: 8 },
        { weightKg: 0, reps: 7 },
      ]),
    ).toBe('8 reps · 7 reps');
  });

  it('série correspondante, la dernière au-delà', () => {
    const sets = [w(40, 8), w(42.5, 8)];
    expect(matchingLastSet(sets, 0)).toEqual(w(40, 8));
    expect(matchingLastSet(sets, 5)).toEqual(w(42.5, 8));
    expect(matchingLastSet([], 0)).toBeNull();
  });

  it('le coach passe devant seulement s’il propose de monter', () => {
    const lastSets = [w(40, 8), w(42.5, 8), w(42.5, 7)];
    // Plus lourd que la 1re série, même charge et plus de reps que les suivantes
    const coach = w(42.5, 9);
    expect(nextSetTarget({ lastSets, workIndex: 0, coach })).toEqual({
      weightKg: 42.5,
      reps: 9,
      source: 'coach',
    });
    expect(nextSetTarget({ lastSets, workIndex: 2, coach })?.source).toBe('coach');
    // Maintien ou recul : comme la dernière fois
    expect(nextSetTarget({ lastSets, workIndex: 1, coach: w(42.5, 8) })).toEqual({
      weightKg: 42.5,
      reps: 8,
      source: 'last',
    });
    expect(nextSetTarget({ lastSets, workIndex: 0, coach: w(37.5, 10) })?.source).toBe('last');
    expect(nextSetTarget({ lastSets, workIndex: 0, coach: w(0, 9) })?.source).toBe('last');
    expect(nextSetTarget({ lastSets: [], workIndex: 0, coach })).toBeNull();
  });
});

describe('montée d’échauffement', () => {
  it('barre : barre seule puis 40/60/80 % arrondis aux disques', () => {
    expect(warmupRamp({ workKg: 100, barbell: true })).toEqual([
      { weightKg: 20, reps: 10 },
      { weightKg: 40, reps: 8 },
      { weightKg: 60, reps: 5 },
      { weightKg: 80, reps: 3 },
    ]);
    // Disques limités (pas de 2,5) : arrondi vers le bas à ce qu'on peut charger
    expect(
      warmupRamp({ workKg: 85, barbell: true, plates: [20, 10, 5] }).map((s) => s.weightKg),
    ).toEqual([20, 30, 50, 60]);
  });

  it('barre : charge trop légère → rien, doublons écartés', () => {
    expect(warmupRamp({ workKg: 20, barbell: true })).toEqual([]);
    expect(warmupRamp({ workKg: 40, barbell: true }).map((s) => s.weightKg)).toEqual([
      20, 22.5, 30,
    ]);
  });

  it('sans barre : au pas de charge de l’exercice', () => {
    expect(warmupRamp({ workKg: 30, barbell: false, incrementKg: 2 })).toEqual([
      { weightKg: 12, reps: 10 },
      { weightKg: 18, reps: 6 },
      { weightKg: 24, reps: 3 },
    ]);
    expect(warmupRamp({ workKg: 0, barbell: false })).toEqual([]);
  });
});

describe('objectifs hebdo : échauffements hors tonnage', () => {
  it('ne compte que les séries de travail', () => {
    const now = new Date('2026-11-18T12:00:00');
    const state = evaluateWeeklyGoals(
      [
        {
          startedAt: '2026-11-17T10:00:00',
          endedAt: '2026-11-17T11:00:00',
          entries: [{ sets: [w(20, 10, 'warmup'), w(100, 5)] }],
        },
      ],
      { targetSessions: 3, targetTonnageKg: 10000 },
      now,
    );
    expect(state.doneTonnageKg).toBe(500);
  });
});
