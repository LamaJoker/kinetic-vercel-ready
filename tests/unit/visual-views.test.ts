/**
 * Calendrier du mois et carte des muscles : composants Alpine chargés à la
 * demande (apps/web/src/components). Les agrégations elles-mêmes sont testées
 * dans training-calendar.test.ts et muscle-map.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MUSCLE_REGIONS, type CalendarDay } from '@kinetic/core';
import {
  dayAriaLabel,
  dayClasses,
  daySessionView,
  formatTonnage,
  trainingCalendar,
} from '../../apps/web/src/components/training-calendar';
import {
  formatSets,
  muscleLegend,
  muscleMap,
  regionDetail,
} from '../../apps/web/src/components/muscle-map';
import {
  drawnRegions,
  muscleMapSvg,
  regionFromClass,
} from '../../apps/web/src/components/muscle-map-svg';
import {
  loadLazyComponent,
  _resetLazyComponentsForTesting,
} from '../../apps/web/src/lib/lazy-component';
import type { Exercise, WorkoutSession } from '../../apps/web/src/lib/training/types';

vi.mock('alpinejs', () => ({ default: { store: () => undefined, data: () => undefined } }));

const EXERCISES = [
  { id: 'bench', name: 'Développé couché', muscles: ['chest', 'triceps'] },
  { id: 'squat', name: 'Squat', muscles: ['quads', 'glutes'] },
] as unknown as Exercise[];

function session(id: string, startedAt: string, name = 'Séance'): WorkoutSession {
  return {
    id,
    name,
    startedAt,
    durationMin: 55,
    entries: [
      {
        exerciseId: 'bench',
        sets: [
          { setIndex: 0, weightKg: 40, reps: 10, kind: 'warmup', performedAt: startedAt },
          { setIndex: 1, weightKg: 80, reps: 5, performedAt: startedAt },
          { setIndex: 2, weightKg: 80, reps: 5, performedAt: startedAt },
        ],
      },
    ],
  } as unknown as WorkoutSession;
}

function day(over: Partial<CalendarDay>): CalendarDay {
  return {
    date: '2026-11-17',
    day: 17,
    inMonth: true,
    isToday: false,
    isFuture: false,
    sessionIds: [],
    kinds: [],
    ...over,
  };
}

describe('calendrier : lecture', () => {
  it('formatTonnage en kg puis en tonnes', () => {
    expect(formatTonnage(840)).toMatch(/^840\skg$/);
    expect(formatTonnage(12_480)).toMatch(/^12,5\st$/);
    expect(formatTonnage(Number.NaN)).toMatch(/^0\skg$/);
  });

  it('dayClasses : hors mois, futur, type, aujourd’hui, sélection', () => {
    expect(dayClasses(day({ inMonth: false }), null)).toBe('k-cal-day k-cal-out');
    expect(dayClasses(day({ isFuture: true }), null)).toBe('k-cal-day k-cal-future');
    expect(dayClasses(day({ kinds: ['pull', 'legs'], isToday: true }), '2026-11-17')).toBe(
      'k-cal-day k-cal-on k-kind-pull k-cal-today k-cal-sel',
    );
  });

  it('dayAriaLabel nomme la date, le nombre de séances et leur type', () => {
    const label = dayAriaLabel(day({ kinds: ['push', 'push'], isToday: true }));
    expect(label).toContain('17 novembre');
    expect(label).toContain('2 séances (Push)');
    expect(label).toContain('aujourd’hui');
    expect(dayAriaLabel(day({}))).not.toContain('séance');
  });

  it('daySessionView : séries de travail, échauffements à part, tonnage hors échauffement', () => {
    const v = daySessionView(session('a', '2026-11-17T18:00:00'), 'push', (id) => `ex:${id}`);
    expect(v.kindLabel).toBe('Push');
    expect(v.time).toBe('18:00');
    expect(v.meta).toMatch(/^55 min · 800\skg$/);
    expect(v.exercises).toEqual([
      { key: '0-bench', name: 'ex:bench', sets: expect.stringContaining('(+1 échauff.)') },
    ]);
  });
});

describe('calendrier : composant', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00'), toFake: ['Date'] }));

  it('mois courant, pas de mois futur, navigation et retour à aujourd’hui', () => {
    const c = trainingCalendar();
    c.sync(
      [session('a', '2026-11-03T18:00:00', 'Push A'), session('b', '2026-10-20T18:00:00')],
      EXERCISES,
    );
    expect(c.cal.label).toBe('novembre 2026');
    expect(c.cal.summary.sessions).toBe(1);
    expect(c.days).toHaveLength(c.cal.weeks.length * 7);
    expect(c.canGoNext()).toBe(false);
    c.nextMonth();
    expect(c.month).toBe(10);

    c.prevMonth();
    expect(c.cal.label).toBe('octobre 2026');
    expect(c.monthKeys()).toEqual(['2026-9']);
    expect(c.gridClass()).toContain('k-cal-anim-prev');
    expect(c.canGoNext()).toBe(true);

    c.goToday();
    expect(c.month).toBe(10);
    expect(c.selectedDate).toBe('2026-11-18');
  });

  it('toucher un jour affiche ses séances ; re-toucher referme', () => {
    const c = trainingCalendar();
    c.sync([session('a', '2026-11-03T18:00:00', 'Push A')], EXERCISES);
    const d = c.days.find((x) => x.date === '2026-11-03')!;
    expect(c.dots(d)).toEqual([{ key: '0push', cls: 'k-cal-dot k-kind-push' }]);
    c.pick(d);
    expect(c.isPicked(d)).toBe('true');
    expect(c.daySessions.map((s) => s.name)).toEqual(['Push A']);
    expect(c.selectedLabel).toMatch(/^Mardi 3 novembre$/);
    c.pick(d);
    expect(c.selectedDate).toBeNull();
  });

  it('un jour du mois voisin bascule sur ce mois', () => {
    const c = trainingCalendar();
    c.sync([], EXERCISES);
    const out = c.days.find((x) => !x.inMonth && x.date < '2026-11-01')!;
    c.pick(out);
    expect(c.month).toBe(9);
    expect(c.selectedDate).toBe(out.date);
  });

  it('glisser horizontal : gauche = suivant, droite = précédent ; vertical ignoré', () => {
    const c = trainingCalendar();
    const touch = (x: number, y: number) => ({ clientX: x, clientY: y });
    const swipe = (x0: number, x1: number, y1 = 100) => {
      c.onTouchStart({ touches: [touch(x0, 100)] } as unknown as TouchEvent);
      c.onTouchEnd({ changedTouches: [touch(x1, y1)] } as unknown as TouchEvent);
    };
    swipe(100, 220);
    expect(c.month).toBe(9);
    swipe(220, 100);
    expect(c.month).toBe(10);
    swipe(100, 180, 300); // surtout vertical
    expect(c.month).toBe(10);
    swipe(10, 200); // bord gauche : geste « retour »
    expect(c.month).toBe(10);
  });

  it('légende : types présents seulement, avec leur nombre', () => {
    const c = trainingCalendar();
    c.sync(
      [
        session('a', '2026-11-03T18:00:00', 'Push A'),
        session('b', '2026-11-05T18:00:00', 'Push B'),
      ],
      EXERCISES,
    );
    expect(c.legend()).toEqual([
      { kind: 'push', label: 'Push', count: 2, cls: 'k-kind-chip k-kind-push' },
    ]);
  });
});

describe('carte des muscles : silhouette', () => {
  it('chaque zone du domaine est dessinée', () => {
    const drawn = drawnRegions();
    for (const r of MUSCLE_REGIONS) expect(drawn.has(r.key), r.key).toBe(true);
  });

  it('SVG : paliers, sélection, libellé échappé, pas de style ni de script', () => {
    const svg = muscleMapSvg({ levels: { chest: 3 }, selected: 'chest', label: 'A <b>' });
    expect(svg).toContain('k-mm k-mm-l3 mm-r-chest k-mm-on');
    expect(svg).toContain('k-mm-l0 mm-r-quads');
    expect(svg).toContain('aria-label="A b"');
    expect(svg).toContain('AVANT');
    expect(svg).not.toMatch(/style=|<script|href=/);
    expect(muscleMapSvg({ levels: {}, compact: true })).not.toContain('AVANT');
  });

  it('regionFromClass lit la zone touchée', () => {
    expect(regionFromClass('k-mm k-mm-l2 mm-r-upper_back k-mm-on')).toBe('upper_back');
    expect(regionFromClass('k-mm-base')).toBeNull();
    expect(regionFromClass(null)).toBeNull();
  });
});

describe('carte des muscles : composant', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00'), toFake: ['Date'] }));

  it('formatSets et légende', () => {
    expect(formatSets(2.5)).toBe('2,5');
    expect(formatSets(3)).toBe('3');
    expect(muscleLegend().map((l) => l.label)).toEqual(['0', '1-3', '4-9', '10-19', '20+']);
  });

  it('agrège 7 j puis 30 j ; toucher une zone donne son détail', () => {
    const m = muscleMap();
    m.sync([session('a', '2026-11-17T18:00:00'), session('b', '2026-10-28T18:00:00')], EXERCISES);
    expect(m.summary()).toBe('2 séries de travail sur 7 jours');
    expect(m.topLabels()).toBe('Pectoraux · Triceps');
    expect(m.svg()).toContain('mm-r-chest');

    m.pickFromEvent({
      target: { getAttribute: () => 'k-mm k-mm-l1 mm-r-chest' },
    } as unknown as Event);
    expect(m.isSelected('chest')).toBe(true);
    expect(m.detail).toMatchObject({
      label: 'Pectoraux',
      sets: '2 séries en 7 j',
      exercises: [{ id: 'bench', name: 'Développé couché', sets: '2 séries' }],
    });
    m.select('chest');
    expect(m.detail).toBeNull();

    m.setDays(30);
    expect(m.daysPressed(30)).toBe('true');
    expect(m.summary()).toBe('4 séries de travail sur 30 jours');
    const rows = m.rows();
    expect(rows[0]).toMatchObject({ key: 'chest', value: '4', width: 'width: 100%' });
    expect(rows[1]).toMatchObject({ key: 'triceps', value: '2', width: 'width: 50%' });
    expect(m.idleLabels()).toContain('Quadriceps');
  });

  it('vide : message clair, aucune donnée', () => {
    const m = muscleMap();
    m.sync(undefined, undefined);
    expect(m.hasData()).toBe(false);
    expect(m.summary()).toBe('Aucune série de travail sur 7 jours');
    expect(m.svg()).toContain('aucune série');
  });

  it('regionDetail : niveau et pluriels', () => {
    const d = regionDetail(
      {
        key: 'quads',
        label: 'Quadriceps',
        sets: 1,
        setsPerWeek: 1,
        tonnageKg: 500,
        level: 1,
        exercises: [{ exerciseId: 'squat', sets: 1 }],
      },
      7,
      () => 'Squat',
    );
    expect(d).toMatchObject({
      sets: '1 série en 7 j',
      levelLabel: 'Léger',
      levelCls: 'k-mm-key k-mm-l1',
      exercises: [{ id: 'squat', name: 'Squat', sets: '1 série' }],
    });
  });
});

describe('lazy-component', () => {
  beforeEach(() => _resetLazyComponentsForTesting());

  it('charge une seule fois et réessaie après un échec', async () => {
    const factory = () => ({});
    const load = vi.fn().mockRejectedValueOnce(new Error('hors-ligne')).mockResolvedValue(factory);
    const register = vi.fn();
    await expect(loadLazyComponent('demo', load, register)).rejects.toThrow('hors-ligne');
    await loadLazyComponent('demo', load, register);
    await loadLazyComponent('demo', load, register);
    expect(load).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith('demo', factory);
  });

  it('nom inconnu : refus explicite', async () => {
    await expect(loadLazyComponent('inconnu')).rejects.toThrow('Composant inconnu');
  });
});
