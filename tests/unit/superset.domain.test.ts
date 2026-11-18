/**
 * Supersets / circuits : groupes de 2 ou 3 exercices consécutifs, étiquettes A1/A2,
 * enchaînement sans repos jusqu'à la fin du tour. Rétro-compatible (sans `group`).
 */
import { describe, it, expect } from 'vitest';
import {
  canLinkWithNext,
  linkWithNext,
  newSupersetId,
  normalizeSupersets,
  supersetBlocks,
  supersetLabel,
  supersetNextStep,
  unlinkSuperset,
  clampTemplateLine,
} from '@kinetic/core';

const e = (exerciseId: string, group?: string) => ({ exerciseId, ...(group ? { group } : {}) });
const ids = (list: ReadonlyArray<{ exerciseId: string; group?: string }>) =>
  list.map((x) => `${x.exerciseId}${x.group ? `:${x.group}` : ''}`);

describe('normalizeSupersets', () => {
  it('sans groupe : rien ne change (anciennes séances)', () => {
    const list = [e('a'), e('b')];
    expect(normalizeSupersets(list)).toEqual(list);
  });

  it('retire un groupe isolé, non consécutif ou au-delà de 3', () => {
    expect(ids(normalizeSupersets([e('a', 'g'), e('b')]))).toEqual(['a', 'b']);
    expect(ids(normalizeSupersets([e('a', 'g'), e('b'), e('c', 'g')]))).toEqual(['a', 'b', 'c']);
    expect(ids(normalizeSupersets([e('a', 'g'), e('b', 'g'), e('c', 'g'), e('d', 'g')]))).toEqual([
      'a:g',
      'b:g',
      'c:g',
      'd',
    ]);
    // un groupe qui réapparaît plus loin : seule la première suite compte
    expect(
      ids(normalizeSupersets([e('a', 'g'), e('b', 'g'), e('x'), e('c', 'g'), e('d', 'g')])),
    ).toEqual(['a:g', 'b:g', 'x', 'c', 'd']);
  });

  it('ne laisse pas de clé group: undefined', () => {
    const [a] = normalizeSupersets([e('a', 'g'), e('b')]);
    expect('group' in a!).toBe(false);
  });
});

describe('blocs et étiquettes', () => {
  const list = [e('a'), e('b', 's1'), e('c', 's1'), e('d', 's2'), e('f', 's2'), e('g', 's2')];

  it('lettres A, B dans l’ordre, exercices seuls à part', () => {
    const blocks = supersetBlocks(list);
    expect(blocks.map((b) => [b.letter, b.start, b.items.length])).toEqual([
      ['', 0, 1],
      ['A', 1, 2],
      ['B', 3, 3],
    ]);
    expect(['a', 'b', 'c', 'd', 'g'].map((id) => supersetLabel(list, id))).toEqual([
      '',
      'A1',
      'A2',
      'B1',
      'B3',
    ]);
  });
});

describe('lier / délier', () => {
  it('lie deux exercices seuls avec un nouvel identifiant', () => {
    const out = linkWithNext([e('a'), e('b'), e('c')], 0);
    expect(ids(out)).toEqual(['a:ss1', 'b:ss1', 'c']);
  });

  it('étend un superset de 2 à 3, refuse au-delà', () => {
    const two = linkWithNext([e('a'), e('b'), e('c'), e('d')], 0);
    const three = linkWithNext(two, 1);
    expect(ids(three)).toEqual(['a:ss1', 'b:ss1', 'c:ss1', 'd']);
    expect(canLinkWithNext(three, 2)).toBe(false);
    expect(ids(linkWithNext(three, 2))).toEqual(ids(three));
  });

  it('dernier exercice ou déjà dans le même groupe : impossible', () => {
    const list = [e('a', 'g'), e('b', 'g')];
    expect(canLinkWithNext(list, 0)).toBe(false);
    expect(canLinkWithNext(list, 1)).toBe(false);
    expect(canLinkWithNext([e('a')], 0)).toBe(false);
  });

  it('délier dissout tout le superset', () => {
    const list = [e('a', 'g'), e('b', 'g'), e('c', 'g'), e('d')];
    expect(ids(unlinkSuperset(list, 1))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(unlinkSuperset(list, 3))).toEqual(ids(list));
  });

  it('identifiant libre', () => {
    expect(newSupersetId([e('a', 'ss1'), e('b', 'ss2')])).toBe('ss3');
  });

  it('les lignes de modèle gardent leur superset', () => {
    expect(
      clampTemplateLine({ exerciseId: 'a', sets: 3, targetReps: 8, targetRpe: 8, group: 'ss1' })
        .group,
    ).toBe('ss1');
    expect(
      'group' in clampTemplateLine({ exerciseId: 'a', sets: 3, targetReps: 8, targetRpe: 8 }),
    ).toBe(false);
  });
});

describe('enchaînement après une série', () => {
  const s = (n: number, warm = 0) => [
    ...Array.from({ length: warm }, () => ({ kind: 'warmup' as const })),
    ...Array.from({ length: n }, () => ({})),
  ];

  it('exercice seul : repos, on reste dessus', () => {
    expect(supersetNextStep([{ exerciseId: 'a', sets: s(1) }], 'a')).toEqual({
      nextExerciseId: null,
      rest: true,
    });
  });

  it('A1 → A2 sans repos, puis repos et retour à A1 à la fin du tour', () => {
    const after1 = [
      { exerciseId: 'a', group: 'g', sets: s(1) },
      { exerciseId: 'b', group: 'g', sets: s(0, 2) }, // échauffements : hors tour
      { exerciseId: 'c', sets: s(0) },
    ];
    expect(supersetNextStep(after1, 'a')).toEqual({ nextExerciseId: 'b', rest: false });
    const after2 = [after1[0]!, { ...after1[1]!, sets: s(1, 2) }, after1[2]!];
    expect(supersetNextStep(after2, 'b')).toEqual({ nextExerciseId: 'a', rest: true });
  });

  it('circuit de 3, commencé par le milieu', () => {
    const list = [
      { exerciseId: 'a', group: 'g', sets: s(0) },
      { exerciseId: 'b', group: 'g', sets: s(1) },
      { exerciseId: 'c', group: 'g', sets: s(0) },
    ];
    expect(supersetNextStep(list, 'b')).toEqual({ nextExerciseId: 'c', rest: false });
    list[2] = { ...list[2]!, sets: s(1) };
    expect(supersetNextStep(list, 'c')).toEqual({ nextExerciseId: 'a', rest: false });
    list[0] = { ...list[0]!, sets: s(1) };
    expect(supersetNextStep(list, 'a')).toEqual({ nextExerciseId: 'a', rest: true });
  });
});
