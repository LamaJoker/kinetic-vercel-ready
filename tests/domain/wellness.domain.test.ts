import { describe, it, expect } from 'vitest';
import {
  addWater,
  averageForm,
  formHistory,
  formLevel,
  formScore,
  formatWater,
  glassSize,
  lastDays,
  lightenSetCount,
  lightenWeight,
  normalizeCheckIn,
  sleepGoalReached,
  sleepQualityFromHours,
  undoWater,
  upsertCheckIn,
  waterGoal,
  waterGoalFromWeight,
  waterHistory,
  waterTotal,
  type CheckIn,
} from '@kinetic/core';

const TODAY = new Date(2026, 10, 21, 8, 0);

describe('score de forme', () => {
  it('bornes : tout au top → 100 ; tout au plus bas → bas', () => {
    expect(formScore({ sleep: 'good', sleepHours: 8.5, energy: 5, soreness: 'none' })).toBe(100);
    const low = formScore({ sleep: 'bad', sleepHours: 4, energy: 1, soreness: 'heavy' });
    expect(low).toBeLessThan(10);
    expect(formLevel(low)).toBe('low');
  });

  it('les heures précises priment sur la qualité', () => {
    const a = formScore({ sleep: 'good', sleepHours: 5, energy: 3, soreness: 'light' });
    const b = formScore({ sleep: 'good', energy: 3, soreness: 'light' });
    expect(a).toBeLessThan(b);
  });

  it('pondération 40 / 35 / 25', () => {
    // sommeil moyen 0,6 ; énergie 3 → 0,5 ; courbatures légères 0,6
    expect(formScore({ sleep: 'ok', energy: 3, soreness: 'light' })).toBe(
      Math.round(100 * (0.4 * 0.6 + 0.35 * 0.5 + 0.25 * 0.6)),
    );
  });

  it('paliers', () => {
    expect(formLevel(70)).toBe('good');
    expect(formLevel(69)).toBe('ok');
    expect(formLevel(45)).toBe('ok');
    expect(formLevel(44)).toBe('low');
  });

  it('sommeil : qualité depuis les heures et tâche des 7 h', () => {
    expect(sleepQualityFromHours(5.5)).toBe('bad');
    expect(sleepQualityFromHours(6.5)).toBe('ok');
    expect(sleepQualityFromHours(7)).toBe('good');
    expect(sleepGoalReached({ sleep: 'good' })).toBe(true);
    expect(sleepGoalReached({ sleep: 'ok' })).toBe(false);
    expect(sleepGoalReached({ sleep: 'good', sleepHours: 6.5 })).toBe(false);
    expect(sleepGoalReached({ sleep: 'bad', sleepHours: 7.25 })).toBe(true);
  });
});

describe('check-ins', () => {
  const c = (date: string, energy = 3): CheckIn => ({
    date,
    sleep: 'ok',
    energy,
    soreness: 'none',
  });

  it('normalise et rejette les données invalides', () => {
    expect(normalizeCheckIn(null)).toBeNull();
    expect(normalizeCheckIn({ ...c('2026-11-21'), energy: 9 })).toBeNull();
    expect(normalizeCheckIn({ ...c('2026-11-21'), sleep: 'great' })).toBeNull();
    expect(normalizeCheckIn({ ...c('21/11/2026') })).toBeNull();
    expect(normalizeCheckIn({ ...c('2026-11-21'), sleepHours: 7.3 })?.sleepHours).toBe(7.25);
    expect(normalizeCheckIn({ ...c('2026-11-21'), sleepHours: 40 })?.sleepHours).toBeUndefined();
  });

  it('un check-in par jour, modifiable, historique borné', () => {
    let log = upsertCheckIn({}, c('2026-11-20', 2));
    log = upsertCheckIn(log, c('2026-11-21', 3));
    log = upsertCheckIn(log, c('2026-11-21', 5));
    expect(Object.keys(log)).toEqual(['2026-11-20', '2026-11-21']);
    expect(log['2026-11-21']!.energy).toBe(5);
    expect(Object.keys(upsertCheckIn(log, c('2026-11-22'), 2))).toEqual([
      '2026-11-21',
      '2026-11-22',
    ]);
  });

  it('historique 30 jours : trous à null, moyenne', () => {
    const log = upsertCheckIn(upsertCheckIn({}, c('2026-11-21', 5)), c('2026-11-19', 1));
    const h = formHistory(log, TODAY, 30);
    expect(h).toHaveLength(30);
    expect(h.at(-1)!.date).toBe('2026-11-21');
    expect(h[0]!.date).toBe('2026-10-23');
    expect(h.at(-2)!.score).toBeNull();
    expect(h.filter((p) => p.score !== null)).toHaveLength(2);
    expect(averageForm(h)).toBe(Math.round((h.at(-1)!.score! + h.at(-3)!.score!) / 2));
    expect(averageForm([])).toBeNull();
  });

  it('jours locaux', () => {
    expect(lastDays(new Date(2026, 2, 1), 2)).toEqual(['2026-02-28', '2026-03-01']);
  });
});

describe('allègement', () => {
  it('−10 % arrondi vers le bas au pas', () => {
    expect(lightenWeight(100, 2.5)).toBe(90);
    expect(lightenWeight(62.5, 2.5)).toBe(55);
    expect(lightenWeight(22, 2)).toBe(18);
    expect(lightenWeight(0, 2.5)).toBe(0);
  });
  it('une série de moins, jamais zéro', () => {
    expect(lightenSetCount(4)).toBe(3);
    expect(lightenSetCount(1)).toBe(1);
  });
});

describe('hydratation', () => {
  it('objectif : réglé, sinon d’après le poids, sinon 2 L', () => {
    expect(waterGoalFromWeight(80)).toBe(2750);
    expect(waterGoalFromWeight(40)).toBe(1500);
    expect(waterGoalFromWeight(150)).toBe(4000);
    expect(waterGoalFromWeight(null)).toBe(2000);
    expect(waterGoal({ goalMl: 2500 }, 80)).toBe(2500);
    expect(waterGoal({ goalMl: null }, 80)).toBe(2750);
    expect(glassSize({ glassMl: 330 })).toBe(330);
    expect(glassSize({})).toBe(250);
  });

  it('ajouter, annuler le dernier verre', () => {
    let log = addWater({}, '2026-11-21', 250);
    log = addWater(log, '2026-11-21', 500);
    expect(waterTotal(log, '2026-11-21')).toBe(750);
    log = undoWater(log, '2026-11-21');
    expect(waterTotal(log, '2026-11-21')).toBe(250);
    log = undoWater(log, '2026-11-21');
    expect(log['2026-11-21']).toBeUndefined();
    expect(undoWater(log, '2026-11-21')).toEqual({});
    expect(addWater({}, '2026-11-21', -3)).toEqual({});
  });

  it('historique 7 jours', () => {
    const log = { '2026-11-21': [1000, 1000], '2026-11-20': [500] };
    const h = waterHistory(log, TODAY, 2000, 7);
    expect(h).toHaveLength(7);
    expect(h.at(-1)).toMatchObject({ ml: 2000, percent: 100, reached: true });
    expect(h.at(-2)).toMatchObject({ ml: 500, percent: 25, reached: false });
  });

  it('format', () => {
    expect(formatWater(750)).toBe('750 ml');
    expect(formatWater(1250)).toBe('1,25 L');
    expect(formatWater(2000)).toBe('2 L');
  });
});
