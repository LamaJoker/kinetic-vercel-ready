import { describe, it, expect } from 'vitest';
import {
  addTemplateLine,
  clampTemplateLine,
  cleanLabel,
  customExerciseId,
  isExerciseInUse,
  mergeExerciseLists,
  moveItem,
  normalizeCustomExercise,
  searchExercises,
  upsertById,
  validateCustomExercise,
  validateTemplateDraft,
} from '../../packages/core/src/domain/template-editor.domain.js';

describe('modèle : lignes', () => {
  it('ajoute un exercice avec les valeurs par défaut, sans doublon', () => {
    const one = addTemplateLine([], 'sq');
    expect(one).toEqual([{ exerciseId: 'sq', sets: 3, targetReps: 10, targetRpe: 8 }]);
    expect(addTemplateLine(one, 'sq')).toHaveLength(1);
    expect(addTemplateLine(one, '')).toHaveLength(1);
  });

  it('borne séries, répétitions et RPE (demi-points)', () => {
    expect(clampTemplateLine({ exerciseId: 'a', sets: 0, targetReps: 99, targetRpe: 11 })).toEqual({
      exerciseId: 'a',
      sets: 1,
      targetReps: 50,
      targetRpe: 10,
    });
    expect(
      clampTemplateLine({ exerciseId: 'a', sets: 4, targetReps: 8, targetRpe: 7.3 }).targetRpe,
    ).toBe(7.5);
    expect(
      clampTemplateLine({ exerciseId: 'a', sets: NaN, targetReps: 8, targetRpe: 4 }),
    ).toMatchObject({
      sets: 3,
      targetRpe: 5,
    });
  });

  it('monte et descend un élément, sans sortir des bornes', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('valide nom et exercices', () => {
    const line = { exerciseId: 'a', sets: 3, targetReps: 8, targetRpe: 8 };
    expect(validateTemplateDraft('  ', [line])).toBe('Donne un nom au modèle.');
    expect(validateTemplateDraft('Haut A', [])).toBe('Ajoute au moins un exercice.');
    expect(validateTemplateDraft('Haut A', [line])).toBeNull();
    expect(cleanLabel('  Haut   du   corps ')).toBe('Haut du corps');
    expect(cleanLabel('x'.repeat(80))).toHaveLength(60);
  });

  it('remplace ou ajoute par id', () => {
    expect(upsertById([{ id: 'a', v: 1 }], { id: 'a', v: 2 })).toEqual([{ id: 'a', v: 2 }]);
    expect(upsertById([{ id: 'a', v: 1 }], { id: 'b', v: 2 })).toHaveLength(2);
  });
});

describe('exercices personnalisés', () => {
  it('normalise la saisie', () => {
    expect(
      normalizeCustomExercise({
        name: '  Hip  thrust machine ',
        muscles: ['glutes', 'glutes', 'inconnu'],
        equipment: 'laser' as never,
        incrementKg: 1.1,
      }),
    ).toEqual({
      name: 'Hip thrust machine',
      muscles: ['glutes'],
      equipment: 'other',
      incrementKg: 1,
    });
  });

  it('refuse nom vide, doublon (casse, accents), sans muscle', () => {
    const base = {
      name: 'Élévation',
      muscles: ['shoulders'],
      equipment: 'dumbbell' as const,
      incrementKg: 1,
    };
    expect(validateCustomExercise({ ...base, name: '' }, [])).toBe('Donne un nom à l’exercice.');
    expect(validateCustomExercise(base, ['elevation'])).toBe('Un exercice porte déjà ce nom.');
    expect(validateCustomExercise({ ...base, muscles: [] }, [])).toBe(
      'Choisis au moins un groupe musculaire.',
    );
    expect(validateCustomExercise(base, ['Squat'])).toBeNull();
  });

  it('crée un id stable et unique', () => {
    expect(customExerciseId('Élévation latérale', [])).toBe('custom-elevation-laterale');
    expect(customExerciseId('Élévation latérale', ['custom-elevation-laterale'])).toBe(
      'custom-elevation-laterale-2',
    );
    expect(customExerciseId('!!!', [])).toBe('custom-exercice');
  });

  it('détecte un exercice utilisé en séance ou dans un modèle', () => {
    const sessions = [{ entries: [{ exerciseId: 'custom-a' }] }];
    const templates = [{ exercises: [{ exerciseId: 'custom-b' }] }];
    expect(isExerciseInUse('custom-a', sessions, templates)).toBe(true);
    expect(isExerciseInUse('custom-b', sessions, templates)).toBe(true);
    expect(isExerciseInUse('custom-c', sessions, templates)).toBe(false);
  });

  it('fusionne catalogue et exercices perso (le perso gagne à id égal)', () => {
    const merged = mergeExerciseLists(
      [
        { id: 'sq', name: 'Squat' },
        { id: 'x', name: 'Ancien' },
      ],
      [
        { id: 'x', name: 'Perso' },
        { id: 'custom-y', name: 'Y' },
      ],
    );
    expect(merged.map((e) => e.name)).toEqual(['Squat', 'Perso', 'Y']);
  });

  it('recherche sans accents, ignore masqués et déjà choisis', () => {
    const list = [
      { id: 'a', name: 'Développé couché' },
      { id: 'b', name: 'Développé militaire', hidden: true },
      { id: 'c', name: 'Développé incliné' },
    ];
    expect(searchExercises(list, 'developpe', ['c']).map((e) => e.id)).toEqual(['a']);
    expect(searchExercises(list, '', [], 1)).toHaveLength(1);
  });
});
