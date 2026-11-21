import { describe, it, expect } from 'vitest';
import {
  presetRanges,
  normalizeRange,
  formatRange,
  rangeDays,
  periodStats,
  comparePeriods,
  pctChange,
  localDayOf,
  type CompareSession,
} from '@kinetic/core';

/** Horodatage ISO d'une heure LOCALE (tests indépendants du fuseau de la machine). */
const at = (y: number, m: number, d: number, h = 18, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString();

const set = (reps: number, weightKg: number, kind?: 'work' | 'warmup') => ({
  reps,
  weightKg,
  ...(kind ? { kind } : {}),
});

describe('presetRanges', () => {
  const now = new Date(2026, 10, 21, 10);

  it('ce mois vs mêmes jours du mois précédent', () => {
    expect(presetRanges('month', now)).toEqual({
      a: { start: '2026-11-01', end: '2026-11-21' },
      b: { start: '2026-10-01', end: '2026-10-21' },
    });
  });

  it('ce mois vs même mois l’an dernier', () => {
    expect(presetRanges('year', now).b).toEqual({ start: '2025-11-01', end: '2025-11-21' });
  });

  it('4 semaines vs les 4 précédentes', () => {
    const r = presetRanges('4w', now);
    expect(r.a).toEqual({ start: '2026-10-25', end: '2026-11-21' });
    expect(r.b).toEqual({ start: '2026-09-27', end: '2026-10-24' });
    expect(rangeDays(r.a)).toBe(28);
    expect(rangeDays(r.b)).toBe(28);
  });

  it('borne le jour au mois précédent plus court et passe l’année en janvier', () => {
    expect(presetRanges('month', new Date(2026, 2, 31, 9)).b).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(presetRanges('month', new Date(2026, 0, 15, 9)).b).toEqual({
      start: '2025-12-01',
      end: '2025-12-15',
    });
  });
});

describe('plages et libellés', () => {
  it('remet une plage personnalisée dans l’ordre', () => {
    expect(normalizeRange('2026-05-10', '2026-05-01')).toEqual({
      start: '2026-05-01',
      end: '2026-05-10',
    });
    expect(normalizeRange('', '2026-05-01')).toBeNull();
  });

  it('formate les plages en français', () => {
    expect(formatRange({ start: '2026-11-01', end: '2026-11-21' })).toBe('1–21 nov. 2026');
    expect(formatRange({ start: '2026-10-28', end: '2026-11-03' })).toBe('28 oct. – 3 nov. 2026');
    expect(formatRange({ start: '2025-12-02', end: '2026-01-05' })).toBe(
      '2 déc. 2025 – 5 janv. 2026',
    );
    expect(formatRange({ start: '2026-08-04', end: '2026-08-04' })).toBe('4 août 2026');
  });

  it('range une séance tardive dans son jour local', () => {
    expect(localDayOf(at(2026, 11, 30, 23, 30))).toBe('2026-11-30');
    expect(localDayOf(at(2026, 12, 1, 0, 15))).toBe('2026-12-01');
  });
});

describe('periodStats / comparePeriods', () => {
  const sessions: CompareSession[] = [
    // Octobre (période B)
    {
      startedAt: at(2026, 10, 5),
      durationMin: 60,
      entries: [{ exerciseId: 'bp', sets: [set(10, 40, 'warmup'), set(5, 100), set(5, 100)] }],
    },
    {
      startedAt: at(2026, 10, 12),
      endedAt: new Date(Date.parse(at(2026, 10, 12)) + 50 * 60_000).toISOString(),
      entries: [{ exerciseId: 'sq', sets: [set(5, 120)] }],
    },
    // Novembre (période A) : record au développé couché, tardif le 30
    {
      startedAt: at(2026, 11, 3),
      durationMin: 70,
      entries: [
        { exerciseId: 'bp', sets: [set(5, 105), set(5, 105)] },
        { exerciseId: 'sq', sets: [set(5, 110)] },
      ],
    },
    {
      startedAt: at(2026, 11, 30, 23, 30),
      durationMin: 50,
      entries: [{ exerciseId: 'plank', sets: [{ reps: 0, weightKg: 0 }] }],
    },
    // Décembre : hors des deux périodes
    { startedAt: at(2026, 12, 1, 0, 15), entries: [{ exerciseId: 'bp', sets: [set(1, 200)] }] },
  ];
  const input = {
    sessions,
    musclesByExercise: new Map([
      ['bp', ['chest', 'triceps']],
      ['sq', ['quads', 'glutes']],
      ['plank', ['core']],
    ]),
    bodyweight: [
      { date: '2026-10-10', weight: 80 },
      { date: '2026-11-02', weight: 81 },
      { date: '2026-11-20', weight: 82 },
    ],
  };
  const A = { start: '2026-11-01', end: '2026-11-30' };
  const B = { start: '2026-10-01', end: '2026-10-31' };

  it('agrège une période (séries de travail seulement, jours locaux)', () => {
    const a = periodStats(input, A);
    expect(a.sessions).toBe(2);
    expect(a.sets).toBe(4);
    expect(a.tonnageKg).toBe(5 * 105 * 2 + 5 * 110);
    expect(a.avgDurationMin).toBe(60);
    expect(a.records).toBe(1); // bp battu ; sq en baisse ; gainage sans e1RM
    expect(a.avgBodyweightKg).toBe(81.5);
    expect(a.trainingDays).toBe(2);
    expect(a.perWeek).toBe(0.5); // 2 séances × 7 / 30 j
    expect(a.muscles.get('chest')).toBe(2);
    expect(a.muscles.get('triceps')).toBe(1);

    const b = periodStats(input, B);
    expect(b.sessions).toBe(2);
    expect(b.sets).toBe(3); // échauffement exclu
    expect(b.tonnageKg).toBe(1600);
    expect(b.avgDurationMin).toBe(55); // 60 et 50 (déduite de endedAt)
    expect(b.records).toBe(0); // premiers essais : pas des records
  });

  it('calcule écarts, sens et couleurs', () => {
    const c = comparePeriods(input, A, B);
    const m = Object.fromEntries(c.metrics.map((x) => [x.key, x]));
    expect(m.tonnage!.pct).toBe(Math.round(((1600 - 1600) / 1600) * 100));
    expect(m.sets!.pct).toBe(33);
    expect(m.sets!.trend).toBe('up');
    expect(m.sets!.tone).toBe('good');
    expect(m.sessions!.trend).toBe('flat');
    expect(m.duration!.trend).toBe('up');
    expect(m.duration!.tone).toBe('neutral');
    expect(m.bodyweight!.tone).toBe('neutral');
    expect(m.records!.pct).toBeNull(); // 0 en référence : pas de %
    expect(c.topExercises.map((r) => r.id)).toEqual(['bp', 'sq']); // gainage : pas de tonnage
    const sq = c.topExercises.find((r) => r.id === 'sq')!;
    expect(sq.pct).toBe(-8);
    expect(sq.trend).toBe('down');
    expect(c.muscles[0]!.id).toBe('chest');
  });

  it('pctChange gère les cas limites', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(null, 4)).toBeNull();
  });
});
