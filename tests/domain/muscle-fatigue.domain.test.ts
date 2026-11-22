import { describe, it, expect } from 'vitest';
import {
  buildFatigueMap,
  fatigueSentence,
  freshGroups,
  freshSuggestion,
  readyLabel,
  recoveryState,
  rpeIntensity,
  type FatigueSession,
} from '@kinetic/core';

const H = 3_600_000;
const NOW = new Date(2026, 10, 21, 9, 0);

const MUSCLES: Record<string, string[]> = {
  bp: ['chest', 'triceps', 'shoulders'],
  sq: ['quads', 'glutes'],
  curl: ['biceps'],
  run: [],
};

function session(hoursAgo: number, exerciseId: string, sets: number, rpe = 8): FatigueSession {
  const at = new Date(NOW.getTime() - hoursAgo * H).toISOString();
  return {
    startedAt: at,
    entries: [
      {
        exerciseId,
        sets: [
          { weightKg: 20, reps: 10, rpe: 6, kind: 'warmup', performedAt: at },
          ...Array.from({ length: sets }, () => ({ weightKg: 80, reps: 8, rpe, performedAt: at })),
        ],
      },
    ],
  };
}

const build = (sessions: FatigueSession[], soreness?: 'none' | 'light' | 'heavy') =>
  buildFatigueMap({
    sessions,
    musclesOf: (id) => MUSCLES[id] ?? [],
    now: NOW,
    soreness,
  });

describe('fatigue par muscle', () => {
  it('sans séance : tout est récupéré', () => {
    const m = build([]);
    expect(m.hasData).toBe(false);
    expect(Object.values(m.regions).every((r) => r.state === 'fresh' && r.fatigue === 0)).toBe(
      true,
    );
    expect(freshSuggestion(m)).toContain('Tout est récupéré');
  });

  it('séance juste finie : le muscle principal est fatigué, les secondaires moins', () => {
    const m = build([session(0, 'bp', 10)]);
    expect(m.regions.chest.fatigue).toBe(100);
    expect(m.regions.chest.state).toBe('tired');
    expect(m.regions.triceps.fatigue).toBeLessThan(100);
    expect(m.regions.quads.state).toBe('fresh');
    expect(freshGroups(m)).toContain('jambes');
    expect(freshGroups(m)).not.toContain('pectoraux');
  });

  it('décroissance : demi-vie de 24 h pour un grand muscle', () => {
    const a = build([session(0, 'bp', 5)]).regions.chest.fatigue; // 5/10 → 50 %
    const b = build([session(24, 'bp', 5)]).regions.chest.fatigue;
    expect(a).toBe(50);
    expect(b).toBe(25);
    // Petit muscle : demi-vie 16 h → récupère plus vite.
    const curl = build([session(32, 'curl', 6)]).regions.biceps.fatigue; // 100 % → 25 %
    expect(curl).toBe(25);
  });

  it('les échauffements et séries hors 7 jours ne comptent pas', () => {
    expect(build([session(8 * 24, 'bp', 10)]).regions.chest.fatigue).toBe(0);
    expect(build([session(0, 'bp', 0)]).hasData).toBe(false);
  });

  it('le RPE module la charge', () => {
    expect(rpeIntensity(8)).toBe(1);
    expect(rpeIntensity(10)).toBe(1.5);
    expect(rpeIntensity(5)).toBe(0.5);
    expect(rpeIntensity(undefined)).toBe(1);
    const hard = build([session(0, 'sq', 4, 10)]).regions.quads.fatigue;
    const easy = build([session(0, 'sq', 4, 6)]).regions.quads.fatigue;
    expect(hard).toBeGreaterThan(easy);
  });

  it('les courbatures déclarées augmentent la fatigue des zones chargées seulement', () => {
    const base = build([session(24, 'bp', 5)]);
    const sore = build([session(24, 'bp', 5)], 'heavy');
    expect(sore.regions.chest.fatigue).toBeGreaterThan(base.regions.chest.fatigue);
    expect(sore.regions.quads.fatigue).toBe(0);
  });

  it('états et phrase lisible', () => {
    expect(recoveryState(10)).toBe('fresh');
    expect(recoveryState(50)).toBe('recovering');
    expect(recoveryState(80)).toBe('tired');
    const m = build([session(12, 'bp', 8)]);
    const chest = m.regions.chest;
    expect(chest.readyInHours).toBeGreaterThan(0);
    expect(fatigueSentence(chest, NOW)).toMatch(/^Pectoraux : récupérés à ~\d+ %, prêts /);
    expect(fatigueSentence(m.regions.shoulders, NOW)).toMatch(/^Épaules : récupérées/);
    expect(fatigueSentence(m.regions.quads, NOW)).toBe(
      'Quadriceps : récupérés à ~100 %, prêts maintenant',
    );
  });

  it('libellé « prêt »', () => {
    expect(readyLabel(0, NOW)).toBe('prêts maintenant');
    expect(readyLabel(5, NOW)).toBe('prêts dans ~5 h');
    expect(readyLabel(20, NOW)).toBe('prêts demain'); // 9 h + 20 h → demain 5 h
    expect(readyLabel(50, NOW)).toBe('prêts dans 2 jours');
    expect(readyLabel(12, NOW)).toBe('prêts ce soir');
  });
});
