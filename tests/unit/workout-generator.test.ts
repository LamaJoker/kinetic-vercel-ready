import { describe, it, expect } from 'vitest';
import {
  generateWorkout,
  isCompound,
  scoreExercise,
  type GeneratorExercise,
} from '../../packages/core/src/domain/workout-generator.domain.js';

const CATALOG: GeneratorExercise[] = [
  { id: 'bp', name: 'Bench Press', muscles: ['chest', 'triceps'], equipment: 'barbell' },
  { id: 'sq', name: 'Squat', muscles: ['quads', 'glutes'], equipment: 'barbell' },
  { id: 'dl', name: 'Deadlift', muscles: ['posterior', 'back'], equipment: 'barbell' },
  { id: 'ohp', name: 'Overhead Press', muscles: ['shoulders', 'triceps'], equipment: 'barbell' },
  { id: 'row', name: 'Barbell Row', muscles: ['back', 'biceps'], equipment: 'barbell' },
  { id: 'curl', name: 'Bicep Curl', muscles: ['biceps'], equipment: 'dumbbell' },
  { id: 'lat', name: 'Lat Pulldown', muscles: ['back', 'biceps'], equipment: 'cable' },
  { id: 'sl', name: 'Side Lateral', muscles: ['shoulders'], equipment: 'dumbbell' },
  { id: 'tx', name: 'Tricep Extension', muscles: ['triceps'], equipment: 'cable' },
  { id: 'lc', name: 'Leg Curl', muscles: ['hamstrings'], equipment: 'machine' },
];

describe('isCompound', () => {
  it('marks lifts with ≥2 muscles incl. a major as compound', () => {
    expect(isCompound(['chest', 'triceps'])).toBe(true); // bench = compound
    expect(isCompound(['chest', 'back'])).toBe(true);
    expect(isCompound(['posterior'])).toBe(true); // deadlift
    expect(isCompound(['biceps'])).toBe(false); // curl = isolation
    expect(isCompound([])).toBe(false);
  });
});

describe('scoreExercise', () => {
  it('returns 0 when no muscle matches the focus', () => {
    const ex = { id: 'curl', name: 'Curl', muscles: ['biceps'], equipment: 'dumbbell' };
    expect(scoreExercise(ex, ['chest', 'triceps', 'shoulders'])).toBe(0);
  });

  it('boosts compounds and barbells', () => {
    const compoundBarbell = {
      id: 'bp',
      name: 'Bench',
      muscles: ['chest', 'posterior'],
      equipment: 'barbell',
    };
    const isoMachine = { id: 'fly', name: 'Fly', muscles: ['chest'], equipment: 'machine' };
    expect(scoreExercise(compoundBarbell, ['chest'])).toBeGreaterThan(
      scoreExercise(isoMachine, ['chest']),
    );
  });
});

describe('generateWorkout', () => {
  it('produces 5 exercises for push focus with hypertrophie scheme', () => {
    const out = generateWorkout({ goal: 'hypertrophie', focus: 'push', exercises: CATALOG });
    expect(out.exercises.length).toBeGreaterThan(0);
    expect(out.exercises.length).toBeLessThanOrEqual(5);
    // RPE cible hypertrophie = 8
    for (const ex of out.exercises) {
      expect(ex.targetRpe).toBe(8);
    }
  });

  it('uses force scheme (low reps, high RPE) for force goal', () => {
    const out = generateWorkout({ goal: 'force', focus: 'push', exercises: CATALOG });
    const compound = out.exercises.find((e) => e.targetReps <= 5);
    expect(compound).toBeDefined();
    expect(compound!.targetRpe).toBe(8.5);
    expect(compound!.sets).toBe(5);
  });

  it('uses endurance scheme (high reps, low RPE)', () => {
    const out = generateWorkout({ goal: 'endurance', focus: 'legs', exercises: CATALOG });
    for (const ex of out.exercises) {
      expect(ex.targetRpe).toBeLessThanOrEqual(7);
      expect(ex.targetReps).toBeGreaterThanOrEqual(15);
    }
  });

  it('respects exerciseCount parameter', () => {
    const out = generateWorkout({
      goal: 'hypertrophie',
      focus: 'push',
      exercises: CATALOG,
      exerciseCount: 3,
    });
    expect(out.exercises).toHaveLength(3);
  });

  it('returns empty if catalog has no relevant exercises', () => {
    const onlyLegs: GeneratorExercise[] = [
      { id: 'sq', name: 'Squat', muscles: ['quads'], equipment: 'barbell' },
    ];
    const out = generateWorkout({ goal: 'force', focus: 'push', exercises: onlyLegs });
    expect(out.exercises).toHaveLength(0);
  });

  it('full body varies muscle groups (max 1 per primary)', () => {
    const out = generateWorkout({ goal: 'hypertrophie', focus: 'full', exercises: CATALOG });
    const primaries = out.exercises.map((e) => {
      const cat = CATALOG.find((c) => c.id === e.exerciseId)!;
      return cat.muscles[0];
    });
    // Pas plus d'1 doublon sur le muscle primaire en mode full body
    const counts = primaries.reduce<Record<string, number>>((acc, m) => {
      const key = m ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    for (const count of Object.values(counts)) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });
});
