import { describe, it, expect } from 'vitest';
import { buildDeloadRecommendation, DEFAULT_MRV, type AnalyticsSet } from '@kinetic/core';

const REF = '2026-06-17T12:00:00.000Z';

function aset(o: Partial<AnalyticsSet> & { performedAt: string }): AnalyticsSet {
  return {
    sessionId: 's',
    exerciseId: 'squat',
    muscles: ['quads'],
    reps: 5,
    weightKg: 100,
    rpe: 8,
    ...o,
  };
}

describe('buildDeloadRecommendation', () => {
  it('ne recommande pas de deload sous le MRV et sans fatigue', () => {
    const sets = [
      aset({ performedAt: '2026-06-15T10:00:00Z' }),
      aset({ performedAt: '2026-06-16T10:00:00Z' }),
      aset({ performedAt: '2026-06-17T10:00:00Z' }),
    ];
    const r = buildDeloadRecommendation(sets, { referenceIso: REF });
    expect(r.shouldDeload).toBe(false);
    expect(r.severity).toBe('none');
    expect(r.overReached).toHaveLength(0);
  });

  it('recommande un deload quand un muscle dépasse le MRV', () => {
    const sets = [
      aset({ performedAt: '2026-06-15T10:00:00Z' }),
      aset({ performedAt: '2026-06-16T10:00:00Z' }),
      aset({ performedAt: '2026-06-17T10:00:00Z' }),
    ];
    const r = buildDeloadRecommendation(sets, { referenceIso: REF, mrvByMuscle: { quads: 2 } });
    expect(r.shouldDeload).toBe(true);
    expect(r.severity).toBe('recommended');
    expect(r.overReached[0]!.muscle).toBe('quads');
    expect(r.overReached[0]!.weeklySets).toBe(3);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("passe en 'monitor' quand un muscle approche le MRV sans l'atteindre", () => {
    const sets = [
      aset({ performedAt: '2026-06-16T10:00:00Z' }),
      aset({ performedAt: '2026-06-17T10:00:00Z' }),
    ];
    // 2 sets / MRV 2.2 = 0.91 → approche (>= 0.9, < 1)
    const r = buildDeloadRecommendation(sets, { referenceIso: REF, mrvByMuscle: { quads: 2.2 } });
    expect(r.shouldDeload).toBe(false);
    expect(r.severity).toBe('monitor');
    expect(r.approaching[0]!.muscle).toBe('quads');
  });

  it('détecte la fatigue via needsDeload même sous le MRV', () => {
    // 5 séances RPE 9, e1RM plat → needsDeload true ; volume quads largement sous le MRV
    const sets = [
      aset({ performedAt: '2026-06-09T10:00:00Z', rpe: 9 }),
      aset({ performedAt: '2026-06-11T10:00:00Z', rpe: 9 }),
      aset({ performedAt: '2026-06-13T10:00:00Z', rpe: 9.5 }),
      aset({ performedAt: '2026-06-15T10:00:00Z', rpe: 9 }),
      aset({ performedAt: '2026-06-17T10:00:00Z', rpe: 9.5 }),
    ];
    const r = buildDeloadRecommendation(sets, { referenceIso: REF });
    expect(r.shouldDeload).toBe(true);
    expect(r.severity).toBe('recommended');
    expect(r.fatiguedExercises).toContain('squat');
    expect(r.overReached).toHaveLength(0); // pas le volume, la fatigue
  });

  it('ignore les muscles sans repère MRV', () => {
    const sets = Array.from({ length: 10 }, () =>
      aset({ muscles: ['grip'], performedAt: '2026-06-17T10:00:00Z' }),
    );
    const r = buildDeloadRecommendation(sets, { referenceIso: REF });
    expect(r.overReached).toHaveLength(0);
    expect(r.approaching).toHaveLength(0);
    expect(r.shouldDeload).toBe(false);
  });

  it('utilise les seuils MRV par défaut quand non surchargés', () => {
    // hamstrings MRV par défaut = 16 ; 18 sets → dépassement
    const sets = Array.from({ length: 18 }, (_, i) =>
      aset({ muscles: ['hamstrings'], performedAt: '2026-06-17T10:00:00Z', sessionId: `s${i}` }),
    );
    const r = buildDeloadRecommendation(sets, { referenceIso: REF });
    expect(r.shouldDeload).toBe(true);
    expect(r.overReached[0]!.muscle).toBe('hamstrings');
    expect(r.overReached[0]!.mrv).toBe(DEFAULT_MRV.hamstrings);
  });
});
