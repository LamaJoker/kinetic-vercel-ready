import { describe, it, expect } from 'vitest';
import {
  gymView,
  nextGymExercise,
  gymSetTitle,
  gymProgressLabel,
  gymLastLabel,
  parseGymModePref,
} from '@kinetic/core';

const work = (n: number) => Array.from({ length: n }, () => ({ kind: 'work' as const }));
const warm = (n: number) => Array.from({ length: n }, () => ({ kind: 'warmup' as const }));

describe('mode salle : vue affichée', () => {
  it('repos en cours → minuteur géant, sinon la saisie selon la mesure', () => {
    expect(gymView({ hasEntry: true, restRemainingSec: 42, measure: 'reps' })).toBe('rest');
    expect(gymView({ hasEntry: true, restRemainingSec: 0, measure: 'reps' })).toBe('reps');
    expect(gymView({ hasEntry: true, restRemainingSec: 0, measure: 'time' })).toBe('time');
    expect(gymView({ hasEntry: true, restRemainingSec: 0, measure: 'distance' })).toBe('distance');
    expect(gymView({ hasEntry: false, restRemainingSec: 0, measure: 'reps' })).toBe('empty');
  });
});

describe('mode salle : exercice suivant', () => {
  const entries = [
    { exerciseId: 'a', sets: work(3) },
    { exerciseId: 'b', sets: [] },
    { exerciseId: 'c', sets: warm(2) }, // échauffement seul : pas encore commencé
    { exerciseId: 'd', sets: work(1) },
  ];

  it('le prochain exercice sans série de travail, en boucle', () => {
    expect(nextGymExercise(entries, 'a')).toBe('b');
    expect(nextGymExercise(entries, 'b')).toBe('c');
    expect(nextGymExercise(entries, 'd')).toBe('b');
  });

  it('tous commencés : simplement le suivant dans l’ordre', () => {
    const done = entries.map((e) => ({ ...e, sets: work(1) }));
    expect(nextGymExercise(done, 'a')).toBe('b');
    expect(nextGymExercise(done, 'd')).toBe('a');
  });

  it('un seul exercice : pas de suivant ; courant inconnu : depuis le début', () => {
    expect(nextGymExercise([{ exerciseId: 'a', sets: [] }], 'a')).toBeNull();
    expect(nextGymExercise(entries, null)).toBe('b');
  });
});

describe('mode salle : libellés', () => {
  it('titre de la prochaine série (travail, échauffement, superset)', () => {
    expect(gymSetTitle([...warm(2), ...work(2)], false)).toBe('Série 3');
    expect(gymSetTitle([...warm(2), ...work(2)], true)).toBe('Échauffement 3');
    expect(gymSetTitle([], false, 'A2')).toBe('Série 1 · A2');
  });

  it('position dans la séance et dernière série', () => {
    const entries = [
      { exerciseId: 'a', sets: [] },
      { exerciseId: 'b', sets: [] },
    ];
    expect(gymProgressLabel(entries, 'b')).toBe('Exercice 2/2');
    expect(gymProgressLabel(entries, 'z')).toBe('');
    expect(gymLastLabel([])).toBe('');
    expect(
      gymLastLabel([
        { kind: 'warmup', weightKg: 40, reps: 10 },
        { kind: 'work', weightKg: 82.5, reps: 5 },
      ]),
    ).toBe('Dernière : 82,5 kg × 5');
    expect(gymLastLabel([{ kind: 'warmup', weightKg: 40, reps: 10 }])).toBe(
      'Dernière : 40 kg × 10 (échauffement)',
    );
    expect(gymLastLabel([{ weightKg: 0, reps: 0, durationSec: 90 }])).toBe('Dernière : 1:30');
    expect(gymLastLabel([{ weightKg: 0, reps: 12 }])).toBe('Dernière : 12 reps');
  });

  it('réglage mémorisé', () => {
    expect(parseGymModePref('1')).toBe(true);
    expect(parseGymModePref('0')).toBe(false);
    expect(parseGymModePref(null)).toBe(false);
  });
});
