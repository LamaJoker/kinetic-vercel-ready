import { describe, it, expect } from 'vitest';
import {
  parseRecapPeriod,
  defaultRecapPeriod,
  shiftRecapPeriod,
  isFutureRecap,
  recapRange,
  recapLabel,
  recapOf,
  recapTeaser,
  tonnageComparison,
  buildRecap,
  formatRecapHours,
  recapTonnageParts,
  recapTrendLabel,
  recapShareCard,
  recapFileName,
  type RecapSession,
} from '@kinetic/core';

const at = (day: string, h = 12, min = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, h, min);
};
const sess = (
  day: string,
  entries: RecapSession['entries'],
  durationMin = 60,
  h = 18,
): RecapSession => ({
  startedAt: at(day, h).toISOString(),
  durationMin,
  entries,
});
const set = (reps: number, weightKg: number, kind?: 'warmup') => ({ reps, weightKg, kind });

describe('périodes du bilan', () => {
  const now = at('2026-11-22');

  it('lit ?periode=, sinon le mois qui vient de se terminer', () => {
    expect(parseRecapPeriod('2026-10', now)).toEqual({ kind: 'month', key: '2026-10' });
    expect(parseRecapPeriod('2026', now)).toEqual({ kind: 'year', key: '2026' });
    expect(parseRecapPeriod(null, now)).toEqual({ kind: 'month', key: '2026-10' });
    expect(parseRecapPeriod('2026-13', now)).toEqual(defaultRecapPeriod(now));
    expect(parseRecapPeriod('2027', now)).toEqual(defaultRecapPeriod(now)); // futur
    expect(parseRecapPeriod('2026-11', now)).toEqual({ kind: 'month', key: '2026-11' }); // en cours
  });

  it('navigation mois / année et passage d’année', () => {
    expect(shiftRecapPeriod({ kind: 'month', key: '2026-01' }, -1).key).toBe('2025-12');
    expect(shiftRecapPeriod({ kind: 'month', key: '2025-12' }, 1).key).toBe('2026-01');
    expect(shiftRecapPeriod({ kind: 'year', key: '2026' }, -1).key).toBe('2025');
    expect(isFutureRecap({ kind: 'month', key: '2026-12' }, now)).toBe(true);
    expect(defaultRecapPeriod(at('2026-01-02')).key).toBe('2025-12');
  });

  it('bornes et libellés', () => {
    expect(recapRange({ kind: 'month', key: '2024-02' })).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
    });
    expect(recapRange({ kind: 'year', key: '2026' }).end).toBe('2026-12-31');
    expect(recapLabel({ kind: 'month', key: '2026-11' })).toBe('Novembre 2026');
    expect(recapOf({ kind: 'month', key: '2026-10' })).toBe("d'octobre");
    expect(recapOf({ kind: 'month', key: '2026-11' })).toBe('de novembre');
  });

  it('carte d’accueil les 3 premiers jours, seulement après un mois actif', () => {
    const s = [sess('2026-11-12', [])];
    expect(recapTeaser(at('2026-12-02'), s)).toEqual({
      period: { kind: 'month', key: '2026-11' },
      title: 'Ton bilan de novembre est prêt',
      href: '/bilan?periode=2026-11',
    });
    expect(recapTeaser(at('2026-12-04'), s)).toBeNull();
    expect(recapTeaser(at('2027-01-01'), s)).toBeNull(); // rien en décembre
  });
});

describe('tonnage parlant', () => {
  it('la plus grande image qui tient au moins deux fois', () => {
    expect(tonnageComparison(24_000)?.text).toBe("l'équivalent de 4 éléphants");
    expect(tonnageComparison(400_000)?.text).toBe("l'équivalent de 3 baleines bleues");
    expect(tonnageComparison(2_400)?.unit).toBe('voitures');
    expect(tonnageComparison(100)?.text).toBe("l'équivalent de 1 machine à laver");
    expect(tonnageComparison(10)).toBeNull();
  });
});

describe('buildRecap', () => {
  const muscles: Record<string, string[]> = {
    bp: ['chest', 'triceps'],
    sq: ['quads', 'glutes'],
    pull: ['back'],
  };
  const sessions: RecapSession[] = [
    // Avant la période : référence des records.
    sess('2026-10-28', [
      { exerciseId: 'bp', sets: [set(5, 80)] },
      { exerciseId: 'sq', sets: [set(5, 120)] },
    ]),
    // Novembre : lundi 2, mardi 3, lundi 9, lundi 16 (jour préféré = lundi).
    sess(
      '2026-11-02',
      [{ exerciseId: 'bp', sets: [set(5, 60, 'warmup'), set(5, 82.5), set(5, 82.5)] }],
      50,
    ),
    sess('2026-11-03', [{ exerciseId: 'sq', sets: [set(5, 115)] }], 40),
    sess(
      '2026-11-09',
      [
        { exerciseId: 'bp', sets: [set(5, 85)] },
        { exerciseId: 'pull', sets: [set(10, 0)] },
      ],
      70,
    ),
    sess('2026-11-16', [{ exerciseId: 'bp', sets: [set(6, 85)] }], 30),
    // Décembre : hors période.
    sess('2026-12-01', [{ exerciseId: 'bp', sets: [set(5, 100)] }]),
  ];
  const input = {
    sessions,
    musclesOf: (id: string) => muscles[id] ?? [],
    checkins: {
      '2026-11-02': { sleep: 'good' as const, energy: 5, soreness: 'none' as const },
      '2026-11-03': { sleep: 'bad' as const, energy: 2, soreness: 'heavy' as const },
      '2026-10-30': { sleep: 'good' as const, energy: 5, soreness: 'none' as const },
    },
    milestones: [
      { title: 'Défi : 4 séances', at: at('2026-11-16').toISOString() },
      { title: 'Squat 140 kg', at: '2026-09-01' },
    ],
    weeklyTarget: 2,
  };
  const r = buildRecap(input, { kind: 'month', key: '2026-11' }, at('2026-12-02'));

  it('volume de la période (échauffements exclus)', () => {
    expect(r.empty).toBe(false);
    expect(r.ongoing).toBe(false);
    expect(r.sessions).toBe(4);
    expect(r.trainingDays).toBe(4);
    expect(r.minutes).toBe(190);
    expect(r.sets).toBe(6);
    expect(r.tonnageKg).toBe(5 * 82.5 * 2 + 575 + 425 + 510);
  });

  it('records battus contre tout l’historique antérieur', () => {
    expect(r.records.map((x) => x.exerciseId)).toEqual(['bp']);
    expect(r.records[0]).toMatchObject({ weightKg: 85, reps: 6 });
    expect(r.records[0]!.gainKg).toBeGreaterThan(0);
  });

  it('favori, jours, muscles, exercice clé', () => {
    expect(r.favorite).toEqual({ exerciseId: 'bp', sessions: 3, sets: 4 });
    expect(r.longestDayStreak).toBe(2);
    expect(r.weekday).toEqual({ index: 0, label: 'lundi', count: 3 });
    expect(r.muscles.top?.key).toBe('chest');
    expect(r.muscles.levels.chest).toBeGreaterThan(0);
    expect(r.muscles.levels.calves).toBe(0);
    expect(r.keyLift?.exerciseId).toBe('bp');
    expect(r.keyLift?.points).toHaveLength(3);
    expect(r.keyLift!.gainKg).toBeGreaterThan(0);
  });

  it('régularité, forme, objectifs et comparaison', () => {
    // Semaines du 26 oct., 2, 9, 16, 23 et 30 nov. : 3 actives sur 6.
    expect(r.totalWeeks).toBe(6);
    expect(r.activeWeeks).toBe(3);
    expect(r.regularityPct).toBe(50);
    expect(r.weeklyGoalsHit).toBe(1);
    expect(r.form?.count).toBe(2);
    expect(r.milestones.map((m) => m.title)).toEqual(['Défi : 4 séances']);
    expect(r.vsPrevious.sessionsPct).toBe(300);
  });

  it('période en cours : régularité jusqu’à aujourd’hui ; période vide', () => {
    const cur = buildRecap(input, { kind: 'month', key: '2026-11' }, at('2026-11-20'));
    expect(cur.ongoing).toBe(true);
    expect(cur.sessions).toBe(4);
    expect(cur.totalWeeks).toBe(4);
    const empty = buildRecap(input, { kind: 'month', key: '2026-06' }, at('2026-12-02'));
    expect(empty.empty).toBe(true);
    expect(empty.favorite).toBeNull();
    expect(empty.weekday).toBeNull();
    expect(empty.form).toBeNull();
  });

  it('année complète', () => {
    const y = buildRecap(input, { kind: 'year', key: '2026' }, at('2026-12-02'));
    expect(y.sessions).toBe(6);
    expect(y.label).toBe('2026');
  });

  it('textes et carte à partager', () => {
    expect(formatRecapHours(190)).toBe('3 h 10');
    expect(formatRecapHours(45)).toBe('45 min');
    expect(recapTonnageParts(182_400)).toEqual({ value: '182,4', unit: 't' });
    expect(recapTrendLabel(12, { kind: 'month', key: '2026-11' })).toBe('+12 % vs octobre');
    expect(recapTrendLabel(-5, { kind: 'year', key: '2026' })).toBe('−5 % vs 2025');
    expect(recapTrendLabel(150, { kind: 'month', key: '2026-11' })).toBe('×2,5 vs octobre');
    expect(recapTrendLabel(1598, { kind: 'month', key: '2026-11' })).toBe('×17 vs octobre');
    const card = recapShareCard(r, (id) => (id === 'bp' ? 'Développé couché' : id));
    expect(card.title).toBe('Novembre 2026');
    expect(card.tiles.map((t) => t.label)).toEqual(['Séances', 'Heures', 'Tonnage']);
    expect(card.lines.some((l) => l.includes('Développé couché'))).toBe(true);
    expect(recapFileName(r.period)).toBe('kinetic-bilan-2026-11.png');
  });
});

describe('exercice clé', () => {
  it('la courbe suit le favori, même si un exercice secondaire a plus de points', () => {
    const bp = (w: number) => ({ exerciseId: 'bp', sets: [set(5, w), set(5, w), set(5, w)] });
    const calf = (w: number) => ({ exerciseId: 'calf', sets: [set(12, w)] });
    const r = buildRecap(
      {
        sessions: [
          sess('2026-10-05', [bp(80), calf(60)]),
          sess('2026-10-12', [bp(0), calf(62)]), // poids non saisi : pas de point de courbe
          sess('2026-10-19', [bp(85), calf(64)]),
        ],
      },
      { kind: 'month', key: '2026-10' },
      at('2026-11-22'),
    );
    expect(r.favorite?.exerciseId).toBe('bp');
    expect(r.keyLift?.exerciseId).toBe('bp');
  });
});
