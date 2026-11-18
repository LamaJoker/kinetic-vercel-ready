import { describe, it, expect } from 'vitest';
import {
  buildMonthCalendar,
  kindFromMuscles,
  kindFromName,
  monthLabel,
  sessionKind,
  sessionTonnageKg,
  sessionsOnDay,
  shiftMonth,
  type CalendarSession,
} from '../../packages/core/src/domain/training-calendar.domain.js';

const MUSCLES: Record<string, readonly string[]> = {
  bench: ['chest', 'triceps'],
  ohp: ['shoulders', 'triceps'],
  row: ['back'],
  curl: ['biceps'],
  squat: ['quads', 'glutes'],
  rdl: ['hamstrings', 'glutes'],
  plank: ['core'],
};
const musclesOf = (id: string): readonly string[] => MUSCLES[id] ?? [];

function work(n: number, weightKg = 50, reps = 10) {
  return Array.from({ length: n }, () => ({ weightKg, reps }));
}

function session(
  id: string,
  startedAt: string,
  entries: CalendarSession['entries'],
  name = 'Séance',
): CalendarSession {
  return { id, name, startedAt, entries };
}

describe('kindFromName', () => {
  it('reconnaît les noms usuels, accents et casse compris', () => {
    expect(kindFromName('Push A')).toBe('push');
    expect(kindFromName('PULL — dos')).toBe('pull');
    expect(kindFromName('Jambes lourdes')).toBe('legs');
    expect(kindFromName('Leg day')).toBe('legs');
    expect(kindFromName('Full Body 1')).toBe('full');
    expect(kindFromName('Haut du corps')).toBe('upper');
    expect(kindFromName('Upper B')).toBe('upper');
    expect(kindFromName('Poussée')).toBe('push');
  });

  it('combine plusieurs patterns', () => {
    expect(kindFromName('Push / Pull')).toBe('upper');
    expect(kindFromName('Push + Legs')).toBe('full');
  });

  it("null quand le nom n'indique rien (« pushup » n'est pas « push »)", () => {
    expect(kindFromName('Séance du matin')).toBeNull();
    expect(kindFromName('Pushups challenge')).toBeNull();
    expect(kindFromName('')).toBeNull();
  });
});

describe('kindFromMuscles', () => {
  it('un pattern ≥ 70 % des séries de travail l’emporte', () => {
    const s = session('a', '2026-11-02T10:00:00', [
      { exerciseId: 'bench', sets: work(4) },
      { exerciseId: 'ohp', sets: work(3) },
      { exerciseId: 'curl', sets: work(2) },
    ]);
    expect(kindFromMuscles(s, musclesOf)).toBe('push');
  });

  it('push + pull sans jambes = haut du corps ; avec jambes = full body', () => {
    const upper = session('u', '2026-11-02T10:00:00', [
      { exerciseId: 'bench', sets: work(3) },
      { exerciseId: 'row', sets: work(3) },
    ]);
    expect(kindFromMuscles(upper, musclesOf)).toBe('upper');
    const full = session('f', '2026-11-02T10:00:00', [
      { exerciseId: 'bench', sets: work(3) },
      { exerciseId: 'row', sets: work(3) },
      { exerciseId: 'squat', sets: work(3) },
    ]);
    expect(kindFromMuscles(full, musclesOf)).toBe('full');
  });

  it('ignore les échauffements et rend « other » sans muscle classable', () => {
    const s = session('w', '2026-11-02T10:00:00', [
      { exerciseId: 'bench', sets: [{ weightKg: 20, reps: 10, kind: 'warmup' }, ...work(1)] },
      { exerciseId: 'squat', sets: [{ weightKg: 20, reps: 10, kind: 'warmup' }] },
    ]);
    expect(kindFromMuscles(s, musclesOf)).toBe('push');
    const core = session('c', '2026-11-02T10:00:00', [
      { exerciseId: 'plank', sets: work(3, 0, 60) },
    ]);
    expect(kindFromMuscles(core, musclesOf)).toBe('other');
  });

  it('le nom passe avant les muscles', () => {
    const s = session(
      'n',
      '2026-11-02T10:00:00',
      [{ exerciseId: 'bench', sets: work(3) }],
      'Jambes',
    );
    expect(sessionKind(s, musclesOf)).toBe('legs');
  });
});

describe('sessionTonnageKg', () => {
  it('ne compte que les séries de travail', () => {
    const s = session('t', '2026-11-02T10:00:00', [
      {
        exerciseId: 'bench',
        sets: [
          { weightKg: 40, reps: 10, kind: 'warmup' },
          { weightKg: 80, reps: 5 },
          { weightKg: 80, reps: 5, kind: 'work' },
        ],
      },
    ]);
    expect(sessionTonnageKg(s)).toBe(800);
  });
});

describe('buildMonthCalendar', () => {
  const now = new Date('2026-11-18T12:00:00');

  it('grille lundi → dimanche couvrant tout le mois', () => {
    // Novembre 2026 : le 1er est un dimanche, le 30 un lundi.
    const cal = buildMonthCalendar({ sessions: [], musclesOf, year: 2026, month: 10, now });
    expect(cal.label).toBe('novembre 2026');
    expect(cal.weeks).toHaveLength(6);
    for (const w of cal.weeks) expect(w).toHaveLength(7);
    expect(cal.weeks[0]![0]!.date).toBe('2026-10-26');
    expect(cal.weeks[0]![6]).toMatchObject({ date: '2026-11-01', day: 1, inMonth: true });
    expect(cal.weeks[5]![0]).toMatchObject({ date: '2026-11-30', inMonth: true });
    expect(cal.weeks[5]![6]).toMatchObject({ date: '2026-12-06', inMonth: false });
    const days = cal.weeks.flat();
    expect(days.filter((d) => d.inMonth)).toHaveLength(30);
    expect(days.filter((d) => d.isToday).map((d) => d.date)).toEqual(['2026-11-18']);
    expect(days.find((d) => d.date === '2026-11-19')!.isFuture).toBe(true);
    expect(days.find((d) => d.date === '2026-11-17')!.isFuture).toBe(false);
  });

  it('février 2027 tient en 4 semaines (commence un lundi)', () => {
    const cal = buildMonthCalendar({ sessions: [], musclesOf, year: 2027, month: 1, now });
    expect(cal.weeks).toHaveLength(4);
    expect(cal.weeks[0]![0]!.date).toBe('2027-02-01');
  });

  it('place les séances par jour local, dans l’ordre, avec leur type et un résumé du mois', () => {
    const sessions = [
      session('late', '2026-11-03T18:00:00', [{ exerciseId: 'squat', sets: work(4, 100, 5) }]),
      session('early', '2026-11-03T07:00:00', [{ exerciseId: 'bench', sets: work(3, 60, 8) }]),
      session(
        'pull',
        '2026-11-10T10:00:00',
        [{ exerciseId: 'row', sets: work(2, 50, 10) }],
        'Pull',
      ),
      session('oct', '2026-10-31T10:00:00', [{ exerciseId: 'row', sets: work(2) }]),
      session('bad', 'pas une date', [{ exerciseId: 'row', sets: work(2) }]),
    ];
    const cal = buildMonthCalendar({ sessions, musclesOf, year: 2026, month: 10, now });
    const days = cal.weeks.flat();
    const d3 = days.find((d) => d.date === '2026-11-03')!;
    expect(d3.sessionIds).toEqual(['early', 'late']);
    expect(d3.kinds).toEqual(['push', 'legs']);
    // Le 31 octobre complète la grille mais ne montre pas de séance (autre mois).
    expect(days.find((d) => d.date === '2026-10-31')!.sessionIds).toEqual([]);
    expect(cal.summary).toEqual({
      sessions: 3,
      tonnageKg: 4 * 500 + 3 * 480 + 2 * 500,
      activeDays: 2,
      byKind: { push: 1, pull: 1, legs: 1, upper: 0, full: 0, other: 0 },
    });
  });
});

describe('navigation et jour', () => {
  it('shiftMonth passe les années', () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 5, 0)).toEqual({ year: 2026, month: 5 });
  });

  it('monthLabel', () => {
    expect(monthLabel(2026, 7)).toBe('août 2026');
  });

  it('sessionsOnDay trie par heure', () => {
    const list = [
      session('b', '2026-11-03T18:00:00', []),
      session('x', '2026-11-04T08:00:00', []),
      session('a', '2026-11-03T07:00:00', []),
    ];
    expect(sessionsOnDay(list, '2026-11-03').map((s) => s.id)).toEqual(['a', 'b']);
  });
});
