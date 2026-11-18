import { describe, it, expect } from 'vitest';
import {
  detectPRs,
  forgottenSet,
  insertSessionSet,
  orderSetEntries,
  removeSessionSet,
  retimeSession,
  updateSessionSet,
  validateSetInput,
  workAvgRpe,
  workSetsOf,
  e1rm,
  toLocalInputValue,
  type AnalyticsSet,
  type EditableSet,
} from '../../packages/core/src/index.js';

function set(setIndex: number, weightKg: number, reps: number, extra: Partial<EditableSet> = {}) {
  return {
    setIndex,
    weightKg,
    reps,
    rpe: 8,
    performedAt: `2026-11-10T10:0${setIndex}:00.000Z`,
    ...extra,
  } as EditableSet;
}

function session(id: string, startedAt: string, sets: EditableSet[]) {
  return {
    id,
    name: 'Haut',
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(),
    entries: [{ exerciseId: 'bench', sets }],
  };
}

/** Records comme la page Records : séries de travail de toutes les séances. */
function bestRecord(sessions: ReturnType<typeof session>[]) {
  const sets: AnalyticsSet[] = sessions.flatMap((s) =>
    s.entries.flatMap((e) =>
      workSetsOf(e.sets).map((x) => ({
        sessionId: s.id,
        exerciseId: e.exerciseId,
        muscles: [],
        reps: x.reps,
        weightKg: x.weightKg,
        rpe: x.rpe,
        performedAt: x.performedAt,
      })),
    ),
  );
  const prs = detectPRs(sets).filter((p) => p.exerciseId === 'bench');
  return prs.at(-1) ?? null;
}

describe('session-edit', () => {
  it('corriger 400 kg en 40 kg recalcule le record', () => {
    const old = session('a', '2026-11-03T10:00:00.000Z', [set(0, 60, 8)]);
    const typo = session('b', '2026-11-10T10:00:00.000Z', [set(0, 400, 8), set(1, 62.5, 8)]);
    expect(bestRecord([old, typo])?.weightKg).toBe(400);

    const fixed = updateSessionSet(typo, 'bench', 0, { weightKg: 40, reps: 8, rpe: 8 });
    const pr = bestRecord([old, fixed]);
    expect(pr?.weightKg).toBe(62.5);
    expect(pr?.e1rmKg).toBeCloseTo(e1rm(62.5, 8), 1);
    // La séance d'origine n'est pas modifiée (pur).
    expect(typo.entries[0]!.sets[0]!.weightKg).toBe(400);
  });

  it('supprimer la série fautive fait retomber le record', () => {
    const typo = session('b', '2026-11-10T10:00:00.000Z', [set(0, 400, 8), set(1, 60, 8)]);
    const fixed = removeSessionSet(typo, 'bench', 0);
    expect(fixed.entries[0]!.sets.map((s) => [s.setIndex, s.weightKg])).toEqual([[0, 60]]);
    expect(bestRecord([fixed])?.weightKg).toBe(60);
  });

  it('passer une série en échauffement la retire des records et garde l’ordre', () => {
    const s = session('b', '2026-11-10T10:00:00.000Z', [set(0, 60, 8), set(1, 100, 3)]);
    const next = updateSessionSet(s, 'bench', 1, { weightKg: 20, reps: 10, rpe: 6, warmup: true });
    const sets = next.entries[0]!.sets;
    expect(sets[0]).toMatchObject({ setIndex: 0, weightKg: 20, kind: 'warmup' });
    expect(sets[1]).toMatchObject({ setIndex: 1, weightKg: 60 });
    expect(bestRecord([next])?.weightKg).toBe(60);
    // Et inversement : de nouveau une série de travail (kind retiré).
    const back = updateSessionSet(next, 'bench', 0, { weightKg: 20, reps: 10, rpe: 6 });
    expect(back.entries[0]!.sets.every((x) => x.kind === undefined)).toBe(true);
  });

  it('note : nettoyée, tronquée à 200, retirée si vide', () => {
    const s = session('b', '2026-11-10T10:00:00.000Z', [set(0, 60, 8, { note: 'ancienne' })]);
    const a = updateSessionSet(s, 'bench', 0, { weightKg: 60, reps: 8, rpe: 8, note: '  ' });
    expect(a.entries[0]!.sets[0]!.note).toBeUndefined();
    const b = updateSessionSet(s, 'bench', 0, {
      weightKg: 60,
      reps: 8,
      rpe: 8,
      note: 'x'.repeat(250),
    });
    expect(b.entries[0]!.sets[0]!.note).toHaveLength(200);
  });

  it('annuler une suppression remet la série à sa place', () => {
    const s = session('b', '2026-11-10T10:00:00.000Z', [
      set(0, 20, 10, { kind: 'warmup' }),
      set(1, 60, 8),
      set(2, 62.5, 8),
    ]);
    const removed = s.entries[0]!.sets[1]!;
    const back = insertSessionSet(removeSessionSet(s, 'bench', 1), 'bench', removed);
    expect(back.entries[0]!.sets.map((x) => x.weightKg)).toEqual([20, 60, 62.5]);
    expect(back.entries[0]!.sets.map((x) => x.setIndex)).toEqual([0, 1, 2]);
  });

  it('série oubliée : copie de la dernière série de travail, une seconde après', () => {
    const sets = [set(0, 20, 10, { kind: 'warmup' }), set(1, 60, 8)];
    const f = forgottenSet(sets, '2026-11-10T09:00:00.000Z');
    expect(f).toMatchObject({ setIndex: 2, weightKg: 60, reps: 8, rpe: 8 });
    expect(f.kind).toBeUndefined();
    expect(Date.parse(f.performedAt) - Date.parse(sets[1]!.performedAt)).toBe(1000);
    expect(forgottenSet([], '2026-11-10T09:00:00.000Z').performedAt).toBe(
      '2026-11-10T09:00:01.000Z',
    );
  });

  it('changer la date décale la fin et les séries (records datés au bon jour)', () => {
    const s = session('b', '2026-11-10T10:00:00.000Z', [set(0, 60, 8)]);
    const moved = retimeSession(s, '2026-11-08T18:30:00.000Z');
    expect(moved.startedAt).toBe('2026-11-08T18:30:00.000Z');
    expect(moved.endedAt).toBe('2026-11-08T19:30:00.000Z');
    expect(moved.entries[0]!.sets[0]!.performedAt).toBe('2026-11-08T18:30:00.000Z');
    expect(bestRecord([moved])?.achievedAt).toBe('2026-11-08T18:30:00.000Z');
    expect(retimeSession(s, 'pas une date')).toBe(s);
  });

  it('validation de la saisie', () => {
    expect(validateSetInput({ weightKg: 40, reps: 8, rpe: 8 })).toBeNull();
    expect(validateSetInput({ weightKg: 0, reps: 12, rpe: 6 })).toBeNull();
    expect(validateSetInput({ weightKg: -1, reps: 8, rpe: 8 })).toMatch(/Charge/);
    expect(validateSetInput({ weightKg: Number.NaN, reps: 8, rpe: 8 })).toMatch(/Charge/);
    expect(validateSetInput({ weightKg: 40, reps: 0, rpe: 8 })).toMatch(/Reps/);
    expect(validateSetInput({ weightKg: 40, reps: 7.5, rpe: 8 })).toMatch(/Reps/);
    expect(validateSetInput({ weightKg: 40, reps: 8, rpe: 11 })).toMatch(/RPE/);
  });

  it('RPE moyen des séries de travail seulement', () => {
    const s = session('b', '2026-11-10T10:00:00.000Z', [
      set(0, 20, 10, { kind: 'warmup', rpe: 6 }),
      set(1, 60, 8, { rpe: 8 }),
      set(2, 60, 8, { rpe: 9 }),
    ]);
    expect(workAvgRpe(s)).toBe(8.5);
    expect(workAvgRpe(session('c', '2026-11-10T10:00:00.000Z', []))).toBeNull();
  });

  it('ordre des séries et valeur datetime-local', () => {
    const ordered = orderSetEntries([set(5, 60, 8), set(2, 20, 10, { kind: 'warmup' })]);
    expect(ordered.map((x) => [x.setIndex, x.kind])).toEqual([
      [0, 'warmup'],
      [1, undefined],
    ]);
    const local = toLocalInputValue('2026-11-10T10:05:00.000Z');
    expect(local).toMatch(/^2026-11-\d{2}T\d{2}:05$/);
    expect(new Date(local).toISOString()).toBe('2026-11-10T10:05:00.000Z');
    expect(toLocalInputValue('n/a')).toBe('');
  });
});
