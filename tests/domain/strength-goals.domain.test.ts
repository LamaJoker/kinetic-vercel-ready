import { describe, it, expect } from 'vitest';
import {
  closestGoal,
  e1rm,
  evaluateGoal,
  goalAchievedAt,
  goalEtaLabel,
  goalLabel,
  goalTargetE1rm,
  normalizeGoals,
  robustTrend,
  sessionBestE1rms,
  setMeetsGoal,
  syncAchievedGoals,
  validateGoalInput,
  type GoalSession,
  type StrengthGoal,
} from '@kinetic/core';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');

/** Séance de squat il y a `daysAgo` jours : une série d'échauffement lourde ignorée. */
function squat(daysAgo: number, kg: number, reps = 5, warmupKg = 0): GoalSession {
  const at = new Date(NOW - daysAgo * DAY).toISOString();
  return {
    startedAt: at,
    entries: [
      {
        exerciseId: 'sq',
        sets: [
          ...(warmupKg
            ? [{ weightKg: warmupKg, reps: 5, kind: 'warmup' as const, performedAt: at }]
            : []),
          { weightKg: kg, reps, performedAt: at },
          { weightKg: kg - 10, reps, performedAt: at },
        ],
      },
    ],
  };
}

const goal = (over: Partial<StrengthGoal> = {}): StrengthGoal => ({
  id: 'g1',
  exerciseId: 'sq',
  kind: 'weight',
  targetKg: 140,
  createdAt: new Date(NOW - 90 * DAY).toISOString(),
  ...over,
});

/** 10 semaines de progression régulière : +1 kg par semaine, 2 séances par semaine. */
const steady = Array.from({ length: 20 }, (_, i) => squat(70 - i * 3.5, 100 + i * 0.5));

describe('sessionBestE1rms', () => {
  it('meilleure e1RM par séance, échauffements et séries chronométrées exclus', () => {
    const s = squat(1, 100, 5, 200);
    s.entries[0]!.sets.push({ weightKg: 300, reps: 0, durationSec: 30 } as never);
    const pts = sessionBestE1rms([s], 'sq');
    expect(pts).toHaveLength(1);
    expect(pts[0]!.e1rm).toBeCloseTo(e1rm(100, 5));
  });
});

describe('robustTrend', () => {
  it('retrouve la pente d’une progression régulière', () => {
    const t = robustTrend(sessionBestE1rms(steady, 'sq'), NOW)!;
    expect(t).not.toBeNull();
    // +0,5 kg tous les 3,5 j de charge à 5 reps → ×(1+5/30)
    expect(t.perDay * 7).toBeCloseTo(1 * (1 + 5 / 30), 1);
  });

  it('résiste à une séance ratée isolée (Theil–Sen)', () => {
    const noisy = steady.map((s, i) => (i === 15 ? squat(70 - i * 3.5, 60) : s));
    const t = robustTrend(sessionBestE1rms(noisy, 'sq'), NOW)!;
    expect(t.perDay * 7).toBeGreaterThan(1);
  });

  it('null avec trop peu de données', () => {
    expect(robustTrend(sessionBestE1rms([squat(3, 100), squat(1, 102)], 'sq'), NOW)).toBeNull();
    // 3 séances mais sur moins de 14 jours
    const close = [squat(10, 100), squat(6, 101), squat(2, 102)];
    expect(robustTrend(sessionBestE1rms(close, 'sq'), NOW)).toBeNull();
  });

  it('ignore les séances de plus de 12 semaines', () => {
    const old = [squat(200, 50), squat(190, 60), squat(180, 70)];
    expect(robustTrend(sessionBestE1rms(old, 'sq'), NOW)).toBeNull();
  });
});

describe('objectif atteint', () => {
  it('charge : une série de travail à la charge (échauffement exclu)', () => {
    const g = goal({ targetKg: 140 });
    expect(setMeetsGoal(g, { weightKg: 140, reps: 1 })).toBe(true);
    expect(setMeetsGoal(g, { weightKg: 140, reps: 1, kind: 'warmup' })).toBe(false);
    expect(setMeetsGoal(g, { weightKg: 137.5, reps: 5 })).toBe(false);
  });

  it('reps à une charge et e1RM', () => {
    expect(
      setMeetsGoal(goal({ kind: 'reps', targetKg: 100, targetReps: 8 }), {
        weightKg: 100,
        reps: 8,
      }),
    ).toBe(true);
    expect(
      setMeetsGoal(goal({ kind: 'reps', targetKg: 100, targetReps: 8 }), {
        weightKg: 100,
        reps: 7,
      }),
    ).toBe(false);
    expect(setMeetsGoal(goal({ kind: 'e1rm', targetKg: 116 }), { weightKg: 100, reps: 5 })).toBe(
      true,
    );
    expect(goalTargetE1rm(goal({ kind: 'reps', targetKg: 90, targetReps: 10 }))).toBeCloseTo(120);
  });

  it('déjà atteint dans l’historique : état achieved, marqué sans célébration', () => {
    const sessions = [squat(100, 150, 1), squat(5, 120)];
    const g = goal({ createdAt: new Date(NOW - 10 * DAY).toISOString() });
    expect(goalAchievedAt(g, sessions)).toBe(sessions[0]!.startedAt);
    const st = evaluateGoal(g, sessions, NOW);
    expect(st.state).toBe('achieved');
    expect(st.pct).toBe(100);
    expect(goalEtaLabel(st, NOW)).toMatch(/^Atteint le /);
    const sync = syncAchievedGoals([g], sessions);
    expect(sync.changed).toBe(true);
    expect(sync.goals[0]!.achievedAt).toBe(sessions[0]!.startedAt);
    expect(sync.newly).toHaveLength(0);
  });

  it('atteint après la création : à célébrer', () => {
    const g = goal({ createdAt: new Date(NOW - 10 * DAY).toISOString() });
    const sync = syncAchievedGoals([g], [squat(2, 140, 2)]);
    expect(sync.newly.map((x) => x.id)).toEqual(['g1']);
  });
});

describe('evaluateGoal', () => {
  it('date estimée avec une tendance régulière', () => {
    const st = evaluateGoal(goal({ kind: 'e1rm', targetKg: 135 }), steady, NOW);
    expect(st.state).toBe('on-track');
    expect(st.pct).toBeGreaterThan(80);
    expect(st.pct).toBeLessThan(100);
    // ~128,4 kg aujourd'hui, ~1,17 kg/sem → ~5,7 semaines
    const weeks = (st.eta! - NOW) / (7 * DAY);
    expect(weeks).toBeGreaterThan(5);
    expect(weeks).toBeLessThan(7);
    expect(goalEtaLabel(st, NOW)).toMatch(/^Vers le \d+ \w+/);
  });

  it('tendance plate : pas atteignable au rythme actuel', () => {
    const flat = Array.from({ length: 8 }, (_, i) => squat(50 - i * 6, 100));
    const st = evaluateGoal(goal({ targetKg: 140 }), flat, NOW);
    expect(st.state).toBe('flat');
    expect(goalEtaLabel(st, NOW)).toBe('Au rythme actuel, pas atteignable — tendance plate');
  });

  it('trop loin : au-delà de 2 ans', () => {
    const slow = Array.from({ length: 8 }, (_, i) => squat(50 - i * 6, 100 + i * 0.25));
    const st = evaluateGoal(goal({ kind: 'e1rm', targetKg: 400 }), slow, NOW);
    expect(st.state).toBe('too-far');
  });

  it('peu de données, aucune donnée', () => {
    expect(evaluateGoal(goal(), [squat(3, 100)], NOW).state).toBe('few-data');
    expect(evaluateGoal(goal(), [], NOW).state).toBe('no-data');
    expect(evaluateGoal(goal(), [], NOW).pct).toBe(0);
  });

  it('à portée : e1RM au niveau d’une charge jamais soulevée', () => {
    // 100 × 5 → e1RM 116,7 ; 112 kg × 1 → 115,7 (même formule Epley partout).
    const st = evaluateGoal(goal({ targetKg: 112 }), [squat(3, 100, 5)], NOW);
    expect(st.state).toBe('ready');
    expect(evaluateGoal(goal({ targetKg: 115 }), [squat(3, 100, 5)], NOW).state).not.toBe('ready');
  });

  it('cible e1RM d’un objectif de charge : la série unique à la charge vaut 100 %', () => {
    expect(goalTargetE1rm(goal({ kind: 'weight', targetKg: 150 }))).toBeCloseTo(155);
    expect(goalTargetE1rm(goal({ kind: 'e1rm', targetKg: 150 }))).toBe(150);
  });

  it('objectif le plus proche pour l’accueil (hors atteints)', () => {
    const a = evaluateGoal(goal({ id: 'a', kind: 'e1rm', targetKg: 300 }), steady, NOW);
    const b = evaluateGoal(goal({ id: 'b', kind: 'e1rm', targetKg: 130 }), steady, NOW);
    const c = evaluateGoal(goal({ id: 'c', targetKg: 50 }), steady, NOW);
    expect(closestGoal([a, b, c])?.goal.id).toBe('b');
    expect(closestGoal([c])).toBeNull();
  });
});

describe('date estimée : jamais absurde', () => {
  it('jamais dans le passé, jamais NaN, jamais au-delà de 2 ans', () => {
    for (const target of [101, 105, 110, 120, 140, 200, 400]) {
      const st = evaluateGoal(goal({ kind: 'e1rm', targetKg: target }), steady, NOW);
      expect(Number.isNaN(st.pct)).toBe(false);
      if (st.state === 'on-track') {
        expect(st.eta!).toBeGreaterThanOrEqual(NOW + 7 * DAY);
        expect(st.eta!).toBeLessThanOrEqual(NOW + 731 * DAY);
      }
    }
  });

  it('séances le même jour ou charges invalides : pas de division par zéro', () => {
    const sameDay = [squat(5, 100), squat(5, 110), squat(5, 120)];
    expect(robustTrend(sessionBestE1rms(sameDay, 'sq'), NOW)).toBeNull();
    const bad = [squat(30, NaN), squat(15, 100), squat(2, 100)];
    const st = evaluateGoal(goal(), bad, NOW);
    expect(Number.isFinite(st.current)).toBe(true);
    // La séance à NaN est ignorée : 2 séances valides ne suffisent pas pour une date.
    expect(st.state).toBe('few-data');
  });
});

describe('saisie et stockage', () => {
  it('libellés', () => {
    expect(goalLabel(goal(), 'Squat')).toBe('Squat 140 kg');
    expect(goalLabel(goal({ kind: 'e1rm', targetKg: 152.5 }), 'Squat')).toBe('Squat e1RM 152,5 kg');
    expect(goalLabel(goal({ kind: 'reps', targetKg: 20, targetReps: 8 }), 'Tractions')).toBe(
      'Tractions 20 kg × 8',
    );
  });

  it('validation', () => {
    expect(validateGoalInput({ exerciseId: '', kind: 'weight', targetKg: 100 })).toMatch(
      /exercice/,
    );
    expect(validateGoalInput({ exerciseId: 'sq', kind: 'weight', targetKg: 0 })).toMatch(/charge/);
    expect(
      validateGoalInput({ exerciseId: 'sq', kind: 'reps', targetKg: 100, targetReps: 1 }),
    ).toMatch(/répétitions/);
    expect(
      validateGoalInput({ exerciseId: 'sq', kind: 'reps', targetKg: 100, targetReps: 8 }),
    ).toBeNull();
  });

  it('normalise des données abîmées', () => {
    expect(normalizeGoals(null)).toEqual([]);
    expect(
      normalizeGoals([goal(), { id: 'x' }, null, goal({ id: 'y', kind: 'nope' as never })]),
    ).toEqual([goal()]);
  });
});
