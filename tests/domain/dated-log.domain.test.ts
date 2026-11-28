import { describe, it, expect } from 'vitest';
import {
  MIN_LOG_DATE,
  STORAGE_KEYS,
  currentBodyweightKg,
  domainMergeRegistry,
  latestByDate,
  localDayDate,
  localIsoDay,
  logDateError,
  placeByDate,
  resolveSyncConflict,
  sortByDate,
} from '@kinetic/core';

const TODAY = '2026-11-28';

describe('localIsoDay', () => {
  it('donne le jour local, pas le jour UTC', () => {
    expect(localIsoDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localIsoDay(new Date(2026, 10, 28, 0, 1))).toBe('2026-11-28');
  });
});

describe('localDayDate', () => {
  it('donne minuit LOCAL du jour (pas l’UTC)', () => {
    const d = localDayDate('2026-03-05')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 2, 5, 0]);
  });
  it('refuse les jours impossibles ou mal formés', () => {
    expect(localDayDate('2026-02-30')).toBeNull();
    expect(localDayDate('2026-13-01')).toBeNull();
    expect(localDayDate('28/11/2026')).toBeNull();
    expect(localDayDate('')).toBeNull();
  });
});

describe('logDateError', () => {
  it('accepte aujourd’hui, une date passée et la date minimale', () => {
    expect(logDateError(TODAY, TODAY)).toBeNull();
    expect(logDateError('2025-01-15', TODAY)).toBeNull();
    expect(logDateError(MIN_LOG_DATE, TODAY)).toBeNull();
  });
  it('refuse une date future', () => {
    expect(logDateError('2026-11-29', TODAY)).toMatch(/futur/);
  });
  it('refuse une date trop ancienne ou invalide', () => {
    expect(logDateError('1999-12-31', TODAY)).toMatch(/2000/);
    expect(logDateError('', TODAY)).toMatch(/valide/);
    expect(logDateError('2026-02-31', TODAY)).toMatch(/valide/);
  });
});

describe('placeByDate', () => {
  const list = [
    { date: '2026-11-01', weight: 82 },
    { date: '2026-11-20', weight: 80 },
    { date: '2026-11-27', weight: 79 },
  ];

  it('insère une saisie passée à sa place sans toucher aux jours suivants', () => {
    const next = placeByDate(list, { date: '2026-11-10', weight: 81 });
    expect(next.map((e) => e.date)).toEqual([
      '2026-11-01',
      '2026-11-10',
      '2026-11-20',
      '2026-11-27',
    ]);
    expect(next.at(-1)).toEqual({ date: '2026-11-27', weight: 79 });
    expect(list).toHaveLength(3); // pas de mutation
  });

  it('remplace seulement l’entrée du même jour', () => {
    const next = placeByDate(list, { date: '2026-11-20', weight: 80.5 });
    expect(next).toEqual([
      { date: '2026-11-01', weight: 82 },
      { date: '2026-11-20', weight: 80.5 },
      { date: '2026-11-27', weight: 79 },
    ]);
  });

  it('déplace une entrée modifiée vers une autre date (critère de remplacement explicite)', () => {
    const moved = { date: '2026-11-05', weight: 82 };
    const next = placeByDate(list, moved, (e) => e.date === '2026-11-01');
    expect(next.map((e) => e.date)).toEqual(['2026-11-05', '2026-11-20', '2026-11-27']);
  });
});

describe('sortByDate / latestByDate', () => {
  it('trie sans muter, de façon stable', () => {
    const src = [
      { date: '2026-11-03', id: 'b' },
      { date: '2026-11-01', id: 'a' },
      { date: '2026-11-03', id: 'c' },
    ];
    expect(sortByDate(src).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(src[0]!.id).toBe('b');
  });

  it('la plus récente est choisie par date, pas par ordre de saisie', () => {
    const entries = [
      { date: '2026-11-27', weight: 79 },
      { date: '2026-10-01', weight: 85 }, // saisie après coup, dans le passé
    ];
    expect(latestByDate(entries)?.weight).toBe(79);
    expect(latestByDate([])).toBeNull();
    expect(latestByDate(null)).toBeNull();
  });
});

describe('currentBodyweightKg', () => {
  it('poids actuel = pesée valide la plus récente par date', () => {
    expect(
      currentBodyweightKg([
        { date: '2026-11-27', weight: 79 },
        { date: '2026-11-28', weight: 0 },
        { date: '2026-10-01', weight: 85 },
      ]),
    ).toBe(79);
  });
  it('null sans pesée exploitable', () => {
    expect(currentBodyweightKg(null)).toBeNull();
    expect(currentBodyweightKg([{ weight: 80 }])).toBeNull();
    expect(currentBodyweightKg('x')).toBeNull();
  });
});

describe('synchro : saisies passées sur deux appareils', () => {
  const resolve = (key: string, local: unknown, server: unknown, ancestor: unknown) =>
    resolveSyncConflict(domainMergeRegistry, {
      key,
      local: { deleted: false, value: local },
      server: { deleted: false, value: server },
      ancestor: { deleted: false, value: ancestor },
      serverVersion: '2026-11-28T10:00:00.000000Z',
      pending: { op: 'set', seed: false, origin: 'app' },
      now: '2026-11-28T10:15:00.000Z',
    });

  it('pesées : les deux saisies passées sont gardées, triées par date', () => {
    const base = [{ date: '2026-11-27', weight: 79, bodyFatPct: null, note: null }];
    const a = placeByDate(base, { date: '2026-11-02', weight: 82, bodyFatPct: null, note: null });
    const b = placeByDate(base, { date: '2026-11-15', weight: 81, bodyFatPct: null, note: null });
    const r = resolve(STORAGE_KEYS.BODYWEIGHT_ENTRIES, a, b, base);
    const v = r.result.deleted ? [] : (r.result.value as Array<{ date: string }>);
    expect(v.map((e) => e.date)).toEqual(['2026-11-02', '2026-11-15', '2026-11-27']);
  });

  it('mensurations : deux saisies passées (ids distincts) sont gardées', () => {
    const base = [{ id: 'm0', date: '2026-11-27', waist: 80 }];
    const a = placeByDate(base, { id: 'm1', date: '2026-11-03', waist: 82 });
    const b = placeByDate(base, { id: 'm2', date: '2026-11-10', waist: 81 });
    const r = resolve(STORAGE_KEYS.MEASUREMENTS_ENTRIES, a, b, base);
    const v = r.result.deleted ? [] : (r.result.value as Array<{ id: string }>);
    expect(v.map((e) => e.id)).toEqual(['m1', 'm2', 'm0']);
  });
});
