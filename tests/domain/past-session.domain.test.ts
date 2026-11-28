import { describe, it, expect } from 'vitest';
import {
  buildPastSession,
  defaultPastTiming,
  localDateTime,
  parseLocalDateTime,
  pastSessionEntries,
  upsertSessionByDate,
  validatePastMove,
  validatePastStart,
  validatePastTiming,
} from '../../packages/core/src/index.js';

// « Maintenant » : 28 novembre 2026, 10 h 00 (heure locale).
const NOW = new Date(2026, 10, 28, 10, 0);

describe('séance passée : date et heure locales', () => {
  it('date + heure → instant local (pas UTC)', () => {
    const d = localDateTime('2026-11-20', '18:30')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 10, 20, 18, 30,
    ]);
    expect(parseLocalDateTime('2026-11-20T18:30')!.getTime()).toBe(d.getTime());
  });

  it('dates ou heures impossibles refusées', () => {
    expect(localDateTime('2026-02-31', '10:00')).toBeNull();
    expect(localDateTime('2026-13-01', '10:00')).toBeNull();
    expect(localDateTime('2026-11-20', '24:00')).toBeNull();
    expect(localDateTime('20/11/2026', '10:00')).toBeNull();
    expect(localDateTime('2026-11-20', '')).toBeNull();
    expect(parseLocalDateTime('')).toBeNull();
  });

  it('valeurs par défaut : aujourd’hui, fin il y a une minute', () => {
    expect(defaultPastTiming(NOW)).toEqual({ date: '2026-11-28', time: '08:59', durationMin: 60 });
    // Juste après minuit : la séance commence la veille.
    expect(defaultPastTiming(new Date(2026, 10, 28, 0, 20)).date).toBe('2026-11-27');
  });
});

describe('séance passée : validation', () => {
  it('séance d’hier ou de ce matin acceptée', () => {
    expect(validatePastTiming(localDateTime('2026-11-27', '18:00'), 75, NOW)).toBeNull();
    expect(validatePastTiming(localDateTime('2026-11-28', '08:00'), 60, NOW)).toBeNull();
    expect(validatePastTiming(localDateTime('2000-01-01', '00:00'), 60, NOW)).toBeNull();
  });

  it('futur refusé (jour, heure de début, fin)', () => {
    expect(validatePastTiming(localDateTime('2026-11-29', '08:00'), 60, NOW)).toMatch(/futur/);
    expect(validatePastTiming(localDateTime('2026-11-28', '11:00'), 60, NOW)).toMatch(/futur/);
    expect(validatePastTiming(localDateTime('2026-11-28', '09:30'), 60, NOW)).toMatch(
      /finirait dans le futur/,
    );
  });

  it('avant 2000, date invalide, durée invalide refusées', () => {
    expect(validatePastTiming(localDateTime('1999-12-31', '10:00'), 60, NOW)).toMatch(/2000/);
    expect(validatePastTiming(null, 60, NOW)).toMatch(/invalide/);
    const start = localDateTime('2026-11-20', '10:00');
    expect(validatePastTiming(start, 0, NOW)).toMatch(/Durée/);
    expect(validatePastTiming(start, 601, NOW)).toMatch(/Durée/);
    expect(validatePastTiming(start, 45.5, NOW)).toMatch(/Durée/);
  });

  it('début seul (séance déplacée)', () => {
    expect(validatePastStart(localDateTime('2026-11-28', '09:59'), NOW)).toBeNull();
    expect(validatePastStart(localDateTime('2026-11-28', '10:01'), NOW)).toMatch(/futur/);
    expect(validatePastStart(localDateTime('1990-05-01', '10:00'), NOW)).toMatch(/2000/);
  });
});

function past(id: string, startedAt: string, sets: Array<[number, number]> = [[60, 8]]) {
  return {
    id,
    name: id,
    startedAt,
    endedAt: startedAt,
    entries: [
      {
        exerciseId: 'bench',
        sets: sets.map(([weightKg, reps], setIndex) => ({
          setIndex,
          weightKg,
          reps,
          rpe: 8,
          performedAt: startedAt,
        })),
      },
    ],
  };
}

describe('séance passée : création', () => {
  const history = [
    past('a', '2026-11-01T10:00:00.000Z', [[50, 8]]),
    past('b', '2026-11-10T10:00:00.000Z', [
      [70, 5],
      [72.5, 5],
    ]),
    past('c', '2026-11-25T10:00:00.000Z', [[100, 3]]),
  ];

  it('séries du modèle pré-remplies avec la charge de la dernière fois AVANT la date', () => {
    const start = new Date('2026-11-15T09:00:00.000Z');
    const [entry] = pastSessionEntries(
      [{ exerciseId: 'bench', sets: 3, targetReps: 6, targetRpe: 9 }],
      history,
      start,
      60,
    );
    // Séance du 10 (pas celle du 25, postérieure) : 70 puis 72,5 (dernière répétée).
    expect(entry!.sets.map((s) => [s.weightKg, s.reps, s.rpe])).toEqual([
      [70, 6, 9],
      [72.5, 6, 9],
      [72.5, 6, 9],
    ]);
    // Heures des séries dans la séance, dans l'ordre.
    const times = entry!.sets.map((s) => Date.parse(s.performedAt));
    expect(times[0]).toBeGreaterThan(start.getTime());
    expect(times[2]).toBeLessThan(start.getTime() + 60 * 60_000);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('exercice jamais fait : charge 0, cibles du modèle ; séries bornées', () => {
    const [entry] = pastSessionEntries(
      [{ exerciseId: 'squat', sets: 50, targetReps: 10, targetRpe: 3, group: 'g1' }],
      history,
      new Date('2026-11-15T09:00:00.000Z'),
      60,
    );
    expect(entry!.sets).toHaveLength(20);
    expect(entry!.sets[0]).toMatchObject({ weightKg: 0, reps: 10, rpe: 8, setIndex: 0 });
    expect(entry!.group).toBe('g1');
  });

  it('séance terminée : début, fin, durée cohérents', () => {
    const s = buildPastSession({
      id: 'new',
      name: 'Haut',
      templateId: 't1',
      start: new Date('2026-11-15T09:00:00.000Z'),
      durationMin: 75,
      entries: [],
    });
    expect(s).toEqual({
      id: 'new',
      name: 'Haut',
      templateId: 't1',
      startedAt: '2026-11-15T09:00:00.000Z',
      endedAt: '2026-11-15T10:15:00.000Z',
      durationMin: 75,
      entries: [],
    });
    expect(
      'templateId' in
        buildPastSession({ id: 'x', name: 'x', start: new Date(), durationMin: 1, entries: [] }),
    ).toBe(false);
  });

  it('insérée à sa date, sans remplacer aucune autre séance', () => {
    const added = past('new', '2026-11-05T18:00:00.000Z');
    const next = upsertSessionByDate(history, added);
    expect(next.map((s) => s.id)).toEqual(['a', 'new', 'b', 'c']);
    expect(next.filter((s) => s.id !== 'new')).toEqual(history);
    expect(history.map((s) => s.id)).toEqual(['a', 'b', 'c']); // entrée non modifiée
    // Même jour, même heure qu'une autre : les deux sont gardées.
    const twin = upsertSessionByDate(next, past('same', '2026-11-10T10:00:00.000Z'));
    expect(twin.map((s) => s.id)).toEqual(['a', 'new', 'b', 'same', 'c']);
  });

  it('même identifiant : remplacée et replacée à sa nouvelle date', () => {
    const moved = { ...history[0]!, startedAt: '2026-11-26T10:00:00.000Z' };
    expect(upsertSessionByDate(history, moved).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('validatePastMove : séance de l’historique déplacée', () => {
  const HOUR = 3_600_000;
  it('acceptée si elle est finie avant maintenant', () => {
    expect(validatePastMove(localDateTime('2026-11-28', '08:30'), HOUR, NOW)).toBeNull();
    expect(validatePastMove(localDateTime('2026-11-28', '09:00'), HOUR, NOW)).toBeNull();
  });
  it('refusée si sa fin tomberait dans le futur, ou si le début est futur', () => {
    expect(validatePastMove(localDateTime('2026-11-28', '09:30'), HOUR, NOW)).toMatch(/futur/);
    expect(validatePastMove(localDateTime('2026-11-29', '08:00'), HOUR, NOW)).toMatch(/futur/);
    expect(validatePastMove(null, HOUR, NOW)).toBe('Date ou heure invalide.');
  });
  it('durée inconnue (séance sans fin) : seul le début compte', () => {
    expect(validatePastMove(localDateTime('2026-11-28', '09:59'), Number.NaN, NOW)).toBeNull();
  });
});
