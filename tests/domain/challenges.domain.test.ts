import { describe, it, expect } from 'vitest';
import {
  periodKeyOf,
  periodRange,
  periodPhrase,
  measureChallenge,
  evaluateChallenge,
  challengeTitle,
  challengeXp,
  challengeAwardKey,
  closestChallenge,
  challengeBaseline,
  autoChallenges,
  suggestedChallenges,
  createCustomChallenge,
  normalizeChallengeStore,
  recordCompleted,
  activeDefs,
  pruneAccepted,
  longestDayRun,
  niceTarget,
  type ChallengeDef,
  type ChallengeSession,
  type ChallengeData,
} from '@kinetic/core';

/** Séance à 18 h locale le jour `day`. */
function session(day: string, entries: ChallengeSession['entries'], durationMin = 60) {
  const [y, m, d] = day.split('-').map(Number);
  return { startedAt: new Date(y!, m! - 1, d!, 18).toISOString(), durationMin, entries };
}
const set = (reps: number, weightKg: number, kind?: 'warmup') => ({ reps, weightKg, kind });
const at = (day: string, h = 12) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, h);
};
const def = (over: Partial<ChallengeDef>): ChallengeDef => ({
  id: 'x',
  metric: 'sessions',
  period: 'month',
  periodKey: '2026-11',
  target: 3,
  origin: 'suggested',
  ...over,
});

describe('périodes locales', () => {
  it('semaine du lundi au dimanche, mois civil', () => {
    expect(periodKeyOf('week', at('2026-11-22'))).toBe('2026-11-16'); // dimanche
    expect(periodKeyOf('week', at('2026-11-23'))).toBe('2026-11-23'); // lundi
    expect(periodKeyOf('month', at('2026-11-22'))).toBe('2026-11');
    expect(periodRange('week', '2026-11-16')).toEqual({ start: '2026-11-16', end: '2026-11-22' });
    expect(periodRange('month', '2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(periodRange('month', '2028-02').end).toBe('2028-02-29');
  });

  it('une séance de 23 h 30 compte pour son jour local', () => {
    const late = { startedAt: new Date(2026, 10, 30, 23, 30).toISOString(), entries: [] };
    const d = def({ metric: 'sessions', periodKey: '2026-11' });
    expect(measureChallenge(d, { sessions: [late] })).toBe(1);
    expect(measureChallenge({ ...d, periodKey: '2026-12' }, { sessions: [late] })).toBe(0);
  });

  it('phrase relative ou datée', () => {
    const now = at('2026-11-22');
    expect(periodPhrase('month', '2026-11', now)).toBe('ce mois-ci');
    expect(periodPhrase('week', '2026-11-16', now)).toBe('cette semaine');
    expect(periodPhrase('month', '2026-10', now)).toBe('en octobre');
    expect(periodPhrase('week', '2026-11-09', now)).toBe('semaine du 9 nov.');
    expect(periodPhrase('month', '2026-11', null)).toBe('en novembre 2026');
  });
});

describe('mesure', () => {
  const data: ChallengeData = {
    sessions: [
      session('2026-11-02', [
        { exerciseId: 'pullup', sets: [set(5, 0, 'warmup'), set(10, 0), set(8, 0)] },
      ]),
      session('2026-11-05', [{ exerciseId: 'sq', sets: [set(5, 100), set(5, 100)] }], 45),
      session('2026-10-30', [{ exerciseId: 'pullup', sets: [set(12, 0)] }]),
    ],
    checkinDays: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05', '2026-10-31'],
    water: { '2026-11-01': [250, 250, 1500], '2026-11-02': [500], '2026-11-03': [1000, 1000] },
  };

  it('séances, séries, tonnage, minutes, reps d’un exercice (échauffements exclus)', () => {
    expect(measureChallenge(def({ metric: 'sessions' }), data)).toBe(2);
    expect(measureChallenge(def({ metric: 'sets' }), data)).toBe(4);
    expect(measureChallenge(def({ metric: 'tonnage' }), data)).toBe(1000);
    expect(measureChallenge(def({ metric: 'minutes' }), data)).toBe(105);
    expect(measureChallenge(def({ metric: 'reps', exerciseId: 'pullup' }), data)).toBe(18);
  });

  it('check-ins d’affilée dans la période et jours d’eau au-dessus du seuil', () => {
    expect(measureChallenge(def({ metric: 'checkinStreak' }), data)).toBe(3);
    expect(measureChallenge(def({ metric: 'waterDays', waterMl: 2000 }), data)).toBe(2);
    expect(longestDayRun(['2026-02-28', '2026-03-01', '2026-03-01', '2026-03-03'])).toBe(2);
  });
});

describe('évaluation', () => {
  const data: ChallengeData = {
    sessions: ['2026-11-02', '2026-11-04', '2026-11-09'].map((d) => session(d, [])),
  };

  it('en cours : progression et reste', () => {
    const p = evaluateChallenge(def({ target: 12 }), data, at('2026-11-22'));
    expect(p.state).toBe('active');
    expect(p.value).toBe(3);
    expect(p.ratio).toBeCloseTo(0.25);
    expect(p.daysLeft).toBe(9);
    expect(p.title).toBe('12 séances ce mois-ci');
    expect(p.progressLabel).toBe('3 / 12 séances');
    expect(p.statusLabel).toBe('Plus que 9 séances · 9 j');
  });

  it('réussi dès la cible atteinte, raté une fois la période finie', () => {
    expect(evaluateChallenge(def({ target: 3 }), data, at('2026-11-10')).state).toBe('done');
    const failed = evaluateChallenge(def({ target: 4 }), data, at('2026-12-01'));
    expect(failed.state).toBe('failed');
    expect(failed.daysLeft).toBe(0);
    expect(failed.statusLabel).toBe('Terminé');
  });

  it('titres des différentes métriques', () => {
    const now = at('2026-11-22');
    expect(challengeTitle(def({ metric: 'tonnage', target: 50000 }), now)).toBe(
      '50 t de tonnage ce mois-ci',
    );
    expect(
      challengeTitle(
        def({
          metric: 'reps',
          period: 'week',
          periodKey: '2026-11-16',
          target: 100,
          exerciseName: 'Tractions',
        }),
        now,
      ),
    ).toBe('100 tractions cette semaine');
    expect(challengeTitle(def({ metric: 'checkinStreak', target: 7 }), now)).toBe(
      "7 check-ins d'affilée ce mois-ci",
    );
    expect(
      challengeTitle(
        def({
          metric: 'waterDays',
          period: 'week',
          periodKey: '2026-11-16',
          target: 5,
          waterMl: 3000,
        }),
        now,
      ),
    ).toBe("3 L d'eau 5 jours cette semaine");
    expect(challengeTitle(def({ metric: 'minutes', target: 600 }), now)).toBe(
      "10 h d'entraînement ce mois-ci",
    );
  });

  it('XP modérée, réduite pour un défi personnel ; clé d’idempotence stable', () => {
    expect(challengeXp({ origin: 'auto', period: 'month' })).toBe(50);
    expect(challengeXp({ origin: 'suggested', period: 'week' })).toBe(25);
    expect(challengeXp({ origin: 'custom', period: 'month' })).toBe(20);
    expect(challengeAwardKey({ id: 'auto:month:2026-11:sessions:' })).toBe(
      'challenge:auto:month:2026-11:sessions:',
    );
  });

  it('défi le plus proche : en cours seulement, meilleur ratio', () => {
    const now = at('2026-11-22');
    const a = evaluateChallenge(def({ id: 'a', target: 4 }), data, now);
    const b = evaluateChallenge(def({ id: 'b', target: 10 }), data, now);
    const done = evaluateChallenge(def({ id: 'c', target: 2 }), data, now);
    expect(closestChallenge([b, done, a])?.def.id).toBe('a');
    expect(closestChallenge([done])).toBeNull();
  });
});

describe('niveau, défis automatiques et proposés', () => {
  // 4 semaines avant novembre : 3 séances / semaine, tractions au poids du corps.
  const sessions: ChallengeSession[] = [];
  for (let w = 0; w < 4; w++) {
    for (const d of [0, 2, 4]) {
      const day = new Date(2026, 9, 5 + w * 7 + d, 18); // à partir du lundi 5 oct.
      sessions.push({
        startedAt: day.toISOString(),
        durationMin: 60,
        entries: [
          { exerciseId: 'pullup', sets: [set(10, 0), set(8, 0)] },
          { exerciseId: 'bp', sets: [set(8, 80), set(8, 80), set(8, 80)] },
        ],
      });
    }
  }
  const ctx = {
    data: { sessions },
    now: at('2026-11-03'),
    nameOf: (id: string) => (id === 'pullup' ? 'Tractions' : 'Développé couché'),
    waterGoalMl: 2500,
  };

  it('niveau d’après les 28 jours précédents', () => {
    const b = challengeBaseline({ sessions }, '2026-11-02');
    expect(b.activeWeeks).toBe(4);
    expect(b.sessionsPerWeek).toBe(3);
    expect(b.repsExercise).toEqual({ id: 'pullup', perWeek: 54 });
    expect(b.tonnagePerWeek).toBe(3 * 3 * 8 * 80);
  });

  it('automatiques : stables, adaptés au niveau', () => {
    const auto = autoChallenges(ctx);
    const week = auto.find((d) => d.period === 'week')!;
    expect(week.metric).toBe('reps');
    expect(week.exerciseName).toBe('Tractions');
    expect(week.target).toBe(niceTarget(54 * 1.15, 10, 20));
    const month = auto.filter((d) => d.period === 'month').map((d) => d.metric);
    expect(month).toEqual(['sessions', 'tonnage']);
    const sessionsTarget = auto.find((d) => d.metric === 'sessions')!.target;
    expect(sessionsTarget).toBe(Math.round(3 * (30 / 7) * 1.1));
    // Même résultat plus tard dans la période (le niveau est figé à son début).
    const later = autoChallenges({ ...ctx, now: at('2026-11-20') });
    expect(later.find((d) => d.metric === 'sessions')!.target).toBe(sessionsTarget);
  });

  it('débutant sans historique : objectifs accessibles', () => {
    const auto = autoChallenges({ ...ctx, data: { sessions: [] } });
    expect(auto.map((d) => `${d.period}:${d.metric}:${d.target}`)).toEqual([
      'week:sessions:2',
      'month:sessions:9',
      'month:sets:45',
    ]);
  });

  it('proposés : sans doublon avec les défis en place, une métrique chacun', () => {
    const auto = autoChallenges(ctx);
    const sugg = suggestedChallenges(ctx, auto);
    const metrics = sugg.map((d) => d.metric);
    expect(new Set(metrics).size).toBe(metrics.length);
    expect(metrics.slice(0, 2)).toEqual(['checkinStreak', 'waterDays']);
    expect(sugg.find((d) => d.metric === 'waterDays')!.waterMl).toBe(2500);
    for (const s of sugg) expect(auto.some((a) => a.id === s.id)).toBe(false);
  });
});

describe('défis personnels', () => {
  const now = at('2026-11-22');
  it('valide la cible, l’exercice et le nombre par période', () => {
    const ok = createCustomChallenge(
      {
        metric: 'reps',
        period: 'week',
        target: 100,
        exerciseId: 'pullup',
        exerciseName: 'Tractions',
      },
      now,
      [],
      'a',
    );
    expect('def' in ok && ok.def).toMatchObject({
      id: 'custom:a',
      periodKey: '2026-11-16',
      origin: 'custom',
      exerciseId: 'pullup',
    });
    expect(
      createCustomChallenge({ metric: 'reps', period: 'week', target: 100 }, now, [], 'b'),
    ).toEqual({
      error: 'Choisis un exercice.',
    });
    expect(
      'error' in
        createCustomChallenge({ metric: 'sessions', period: 'week', target: 9 }, now, [], 'c'),
    ).toBe(true);
    const three = [1, 2, 3].map((i) => def({ id: `custom:${i}`, origin: 'custom' }));
    const r = createCustomChallenge(
      { metric: 'sessions', period: 'month', target: 10 },
      now,
      three,
      'd',
    );
    expect(r).toEqual({ error: '3 défis personnels au plus par mois.' });
  });
});

describe('stockage et récompense idempotente', () => {
  const now = at('2026-11-22');
  const data: ChallengeData = { sessions: ['2026-11-02', '2026-11-04'].map((d) => session(d, [])) };

  it('normalise un stockage abîmé', () => {
    expect(normalizeChallengeStore(null)).toEqual({ accepted: [], completed: [] });
    const s = normalizeChallengeStore({ accepted: [def({}), { id: 1 }], completed: [{ id: 'a' }] });
    expect(s.accepted).toHaveLength(1);
    expect(s.completed).toHaveLength(0);
  });

  it('un défi réussi n’est enregistré (et récompensé) qu’une fois', () => {
    const p = evaluateChallenge(def({ id: 'm', target: 2 }), data, now);
    const first = recordCompleted({ accepted: [], completed: [] }, [p], now.toISOString());
    expect(first.newly).toHaveLength(1);
    expect(first.newly[0]!.title).toBe('2 séances en novembre 2026');
    expect(first.newly[0]!.xp).toBe(25 * 2);
    const again = recordCompleted(first.store, [p], now.toISOString());
    expect(again.newly).toEqual([]);
    expect(again.store).toBe(first.store);
  });

  it('défis en cours : automatiques + acceptés de la période ; nettoyage des anciens', () => {
    const ctx = { data, now, nameOf: (id: string) => id };
    const accepted = def({ id: 'sugg:old', periodKey: '2026-08' });
    const current = def({ id: 'sugg:cur', metric: 'checkinStreak' });
    const defs = activeDefs(ctx, { accepted: [accepted, current], completed: [] });
    expect(defs.some((d) => d.id === 'sugg:cur')).toBe(true);
    expect(defs.some((d) => d.id === 'sugg:old')).toBe(false);
    const pruned = pruneAccepted({ accepted: [accepted, current], completed: [] }, now);
    expect(pruned.accepted.map((d) => d.id)).toEqual(['sugg:cur']);
  });
});
