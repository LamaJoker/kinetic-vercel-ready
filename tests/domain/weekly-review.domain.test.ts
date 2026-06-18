import { describe, it, expect } from 'vitest';
import { buildWeeklyReview, type AnalyticsSet } from '@kinetic/core';

// Référence fixe : mercredi 17 juin 2026. Semaine précédente = autour du 10 juin.
const REF = '2026-06-17T12:00:00.000Z';

function aset(o: Partial<AnalyticsSet> & { performedAt: string }): AnalyticsSet {
  return {
    sessionId: 's1',
    exerciseId: 'squat',
    muscles: ['quads'],
    reps: 5,
    weightKg: 100,
    rpe: 8,
    ...o,
  };
}

describe('buildWeeklyReview', () => {
  it('retourne un bilan vide cohérent sans données', () => {
    const r = buildWeeklyReview([], REF);
    expect(r.tonnageKg).toBe(0);
    expect(r.totalSets).toBe(0);
    expect(r.sessions).toBe(0);
    expect(r.prCount).toBe(0);
    expect(r.tonnageDeltaPct).toBeNull();
    expect(r.trend).toBe('flat');
  });

  it("marque 'first' quand il y a des données cette semaine mais aucune avant", () => {
    const r = buildWeeklyReview(
      [aset({ performedAt: '2026-06-17T10:00:00Z', reps: 10, weightKg: 100 })],
      REF,
    );
    expect(r.tonnageKg).toBe(1000);
    expect(r.tonnageDeltaPct).toBeNull();
    expect(r.trend).toBe('first');
  });

  it('calcule la hausse de tonnage vs la semaine précédente', () => {
    const sets = [
      aset({ performedAt: '2026-06-10T10:00:00Z', reps: 10, weightKg: 100 }), // prev: 1000
      aset({ performedAt: '2026-06-17T10:00:00Z', reps: 12, weightKg: 100 }), // this: 1200
    ];
    const r = buildWeeklyReview(sets, REF);
    expect(r.tonnageKg).toBe(1200);
    expect(r.prevTonnageKg).toBe(1000);
    expect(r.tonnageDeltaPct).toBe(20);
    expect(r.trend).toBe('up');
  });

  it('détecte une baisse de tonnage', () => {
    const sets = [
      aset({ performedAt: '2026-06-10T10:00:00Z', reps: 10, weightKg: 100 }), // prev: 1000
      aset({ performedAt: '2026-06-17T10:00:00Z', reps: 5, weightKg: 100 }), // this: 500
    ];
    const r = buildWeeklyReview(sets, REF);
    expect(r.tonnageDeltaPct).toBe(-50);
    expect(r.trend).toBe('down');
  });

  it("considère 'flat' une variation sous le seuil de bruit", () => {
    const sets = [
      aset({ performedAt: '2026-06-10T10:00:00Z', reps: 10, weightKg: 100 }), // prev: 1000
      aset({ performedAt: '2026-06-17T10:00:00Z', reps: 10, weightKg: 101 }), // this: 1010 → +1%
    ];
    const r = buildWeeklyReview(sets, REF);
    expect(r.tonnageDeltaPct).toBe(1);
    expect(r.trend).toBe('flat');
  });

  it('compte séances, jours et exercices distincts de la semaine', () => {
    const sets = [
      aset({ sessionId: 'a', exerciseId: 'squat', performedAt: '2026-06-15T10:00:00Z' }),
      aset({ sessionId: 'a', exerciseId: 'bench', performedAt: '2026-06-15T10:30:00Z' }),
      aset({ sessionId: 'b', exerciseId: 'squat', performedAt: '2026-06-17T18:00:00Z' }),
    ];
    const r = buildWeeklyReview(sets, REF);
    expect(r.sessions).toBe(2); // a, b
    expect(r.trainingDays).toBe(2); // 06-15, 06-17
    expect(r.exercises).toBe(2); // squat, bench
    expect(r.totalSets).toBe(3);
  });

  it('ne compte que les PR battus cette semaine', () => {
    const sets = [
      // PR initial la semaine d'avant (ne doit pas compter cette semaine)
      aset({ exerciseId: 'squat', performedAt: '2026-06-10T10:00:00Z', reps: 5, weightKg: 100 }),
      // nouveau record cette semaine (bat l'e1RM précédent)
      aset({ exerciseId: 'squat', performedAt: '2026-06-17T10:00:00Z', reps: 5, weightKg: 110 }),
      // set plus faible cette semaine (pas un PR)
      aset({ exerciseId: 'squat', performedAt: '2026-06-17T11:00:00Z', reps: 3, weightKg: 90 }),
    ];
    const r = buildWeeklyReview(sets, REF);
    expect(r.prCount).toBe(1);
    expect(r.prs[0]!.exerciseId).toBe('squat');
    expect(r.prs[0]!.weightKg).toBe(110);
  });
});
