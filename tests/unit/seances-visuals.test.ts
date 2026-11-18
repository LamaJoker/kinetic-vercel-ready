import { describe, it, expect } from 'vitest';
import {
  ringPct,
  volumeParts,
  entriesTonnageKg,
  recentStatsOf,
  seances,
} from '../../apps/web/src/pages/seances.page.js';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

const NBSP = /\s/g; // espaces insécables de toLocaleString

describe('séances : valeurs des anneaux et grands chiffres', () => {
  it('ringPct borne entre 0 et 100 et gère un total nul', () => {
    expect(ringPct(45, 90)).toBe(50);
    expect(ringPct(120, 90)).toBe(100);
    expect(ringPct(-3, 90)).toBe(0);
    expect(ringPct(3, 0)).toBe(0);
    expect(ringPct(Number.NaN, 10)).toBe(0);
  });

  it('volumeParts passe en tonnes au seuil demandé', () => {
    expect(volumeParts(840)).toEqual({ value: '840', unit: 'kg' });
    expect(volumeParts(12400)).toEqual({ value: '12,4', unit: 't' });
    expect(volumeParts(6264, 1000)).toEqual({ value: '6,3', unit: 't' });
    expect(volumeParts(4583).value.replace(NBSP, ' ')).toBe('4 583');
    expect(volumeParts(-5)).toEqual({ value: '0', unit: 'kg' });
  });

  it('entriesTonnageKg somme charge × reps', () => {
    expect(
      entriesTonnageKg([
        {
          sets: [
            { weightKg: 100, reps: 5 },
            { weightKg: 80, reps: 10 },
          ],
        },
        { sets: [] },
      ]),
    ).toBe(1300);
  });

  it('recentStatsOf ne garde que les 7 derniers jours', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const mk = (iso: string, durationMin: number): WorkoutSession =>
      ({
        id: iso,
        name: 'S',
        startedAt: iso,
        durationMin,
        entries: [{ exerciseId: 'squat', sets: [{ weightKg: 100, reps: 10 }] }],
      }) as unknown as WorkoutSession;
    const stats = recentStatsOf(
      [
        mk('2026-11-16T10:00:00Z', 40),
        mk('2026-11-12T10:00:00Z', 30),
        mk('2026-11-01T10:00:00Z', 60),
      ],
      now,
    );
    expect(stats.count).toBe(2);
    expect(stats.minutes).toBe(70);
    expect(stats.volume).toEqual({ value: '2', unit: 't' });
  });

  it('anneau de repos : se vide et suit les +15 s', () => {
    const page = seances();
    page.nowMs = 1_000_000;
    page.restPresetSec = 90;
    page.startRest();
    expect(page.restRingStyle()).toBe('--p: 100');
    page.nowMs += 45_000;
    expect(page.restRingStyle()).toBe('--p: 50');
    page.addRestSec(60); // 45 s restantes + 60 = 105 s > 90 : le total suit
    expect(page.restTotalSec).toBe(105);
    expect(page.restRingStyle()).toBe('--p: 100');
    expect(page.restEnding()).toBe(false);
    page.stopRest();
    expect(page.restRingStyle()).toBe('--p: 0');
  });

  it('dateDay / dateMonth découpent la date pour la pastille', () => {
    const page = seances();
    expect(page.dateDay('2026-11-14T10:00:00')).toBe('14');
    expect(page.dateMonth('2026-11-14T10:00:00')).toBe('nov.');
    expect(page.dateDay('pas une date')).toBe('');
  });
});
