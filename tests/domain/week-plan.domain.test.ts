import { describe, it, expect } from 'vitest';
import {
  planWeek,
  moveTargets,
  splitPlanSessions,
  catalogPlanSessions,
  defaultTrainingDays,
  mondayIndex,
  sameSessionName,
  type PlanSession,
  type WeekPlan,
} from '../../packages/core/src/domain/week-plan.domain.js';
import { PRESET_SPLITS } from '../../packages/core/src/domain/program.domain.js';
import { findProgram } from '../../packages/core/src/domain/programs-catalog.domain.js';

const PPL = splitPlanSessions(PRESET_SPLITS.ppl.schedule);
const UL = splitPlanSessions(PRESET_SPLITS.upper_lower.schedule);
const FB = splitPlanSessions(PRESET_SPLITS.full_body.schedule);

/** « Nom@jour » pour chaque séance, ordre du cycle. */
function layout(plan: WeekPlan): string[] {
  return plan.items.map((i) => `${i.name}@${i.day === null ? '-' : i.day}:${i.status}`);
}

describe('sources', () => {
  it('découpage PPL : 6 séances du lundi au samedi, dimanche de repos', () => {
    expect(PPL.map((s) => [s.name, s.day])).toEqual([
      ['Push A', 0],
      ['Pull A', 1],
      ['Jambes A', 2],
      ['Push B', 3],
      ['Pull B', 4],
      ['Jambes B', 5],
    ]);
  });

  it('mondayIndex convertit getDay() (0 = dimanche)', () => {
    expect(mondayIndex(0)).toBe(6);
    expect(mondayIndex(1)).toBe(0);
    expect(mondayIndex(6)).toBe(5);
  });

  it('répartit les jours par défaut selon le nombre de séances', () => {
    expect(defaultTrainingDays(3)).toEqual([0, 2, 4]);
    expect(defaultTrainingDays(4)).toEqual([0, 1, 3, 4]);
    expect(defaultTrainingDays(0)).toEqual([0]);
    expect(defaultTrainingDays(9)).toHaveLength(7);
  });

  it('compare les noms sans accents ni casse', () => {
    expect(sameSessionName('Jambes A', 'jambes a')).toBe(true);
    expect(sameSessionName('Épaules', 'epaules')).toBe(true);
    expect(sameSessionName('Push A', 'Pull A')).toBe(false);
    expect(sameSessionName('', 'Push A')).toBe(false);
    expect(sameSessionName('Jambes A', 'Legs A')).toBe(true);
    expect(sameSessionName('Haut du corps B', 'Upper B')).toBe(true);
  });
});

describe('semaine normale', () => {
  it('rien de fait lundi matin : tout reste au jour prévu', () => {
    const plan = planWeek(PPL, [], 0);
    expect(plan.items.every((i) => i.status === 'planned' && i.day === i.baseDay)).toBe(true);
    expect(plan.messages).toEqual([]);
    expect(plan.today?.name).toBe('Push A');
    expect(plan.days[6]!.item).toBeNull();
  });

  it('séances faites à l’heure : ✓ et pas de message', () => {
    const plan = planWeek(
      PPL,
      [
        { day: 0, name: 'Push A' },
        { day: 1, name: 'Pull A' },
      ],
      2,
    );
    expect(plan.doneCount).toBe(2);
    expect(plan.today?.name).toBe('Jambes A');
    expect(plan.messages).toEqual([]);
    expect(plan.days[0]!.item?.status).toBe('done');
  });

  it('déjà entraîné aujourd’hui : la séance du jour est faite, rien n’est proposé aujourd’hui', () => {
    const plan = planWeek(PPL, [{ day: 0, name: 'Push A' }], 0);
    expect(plan.today).toBeNull();
    expect(plan.items[1]!.day).toBe(1);
  });

  it('une séance faite sans nom compte pour la prochaine du cycle', () => {
    const plan = planWeek(UL, [{ day: 0 }], 1);
    expect(plan.items[0]!.status).toBe('done');
    expect(plan.today?.name).toBe('Bas du corps A');
  });

  it('une autre séance choisie le jour prévu est reconnue par son nom', () => {
    // Lundi : Pull A au lieu de Push A → Push A est ratée et glisse à mardi.
    const plan = planWeek(PPL, [{ day: 0, name: 'Pull A' }], 1);
    expect(plan.items.find((i) => i.name === 'Pull A')!.status).toBe('done');
    expect(plan.today?.name).toBe('Push A');
  });

  it('jours au-delà de la semaine ignorés', () => {
    const plan = planWeek(PPL, [{ day: 9, name: 'Push A' }], 0);
    expect(plan.doneCount).toBe(0);
  });
});

describe('séance ratée', () => {
  it('Haut/Bas : haut A raté lundi → mardi, le cycle glisse sur le mercredi de repos', () => {
    const plan = planWeek(UL, [], 1);
    expect(layout(plan)).toEqual([
      'Haut du corps A@1:moved',
      'Bas du corps A@2:moved',
      'Haut du corps B@3:planned',
      'Bas du corps B@4:planned',
    ]);
    expect(plan.messages).toContain('Haut du corps A déplacé à mardi');
    expect(plan.messages).toContain('Bas du corps A déplacé à mercredi');
    expect(plan.today?.name).toBe('Haut du corps A');
  });

  it('Full body : un jour de repos minimum entre deux séances corps entier', () => {
    const plan = planWeek(FB, [], 1);
    expect(layout(plan)).toEqual([
      'Full Body A@1:moved',
      'Full Body B@3:moved',
      'Full Body C@5:moved',
    ]);
  });

  it('PPL : Pull B raté vendredi → samedi, Jambes B glisse à dimanche', () => {
    const done = ['Push A', 'Pull A', 'Jambes A', 'Push B'].map((name, day) => ({ day, name }));
    const plan = planWeek(PPL, done, 5);
    expect(plan.messages[0]).toBe('Pull B déplacé à samedi');
    expect(layout(plan).slice(4)).toEqual(['Pull B@5:moved', 'Jambes B@6:moved']);
  });

  it('respecte le repos des mêmes muscles quand une séance faite est la veille', () => {
    // Full body A fait mardi (au lieu de lundi). Mercredi : B prévu, mais pas de repos → jeudi.
    const plan = planWeek(FB, [{ day: 1, name: 'Full Body A' }], 2);
    expect(plan.items[1]!.day).toBe(3);
    expect(plan.items[2]!.day).toBe(5);
    expect(plan.today).toBeNull();
  });
});

describe('deux séances ratées', () => {
  it('PPL : lundi et mardi ratés → le cycle reprend mercredi dans l’ordre', () => {
    const plan = planWeek(PPL, [], 2);
    expect(plan.items.map((i) => i.day)).toEqual([2, 3, 4, 5, 6, null]);
    expect(plan.items[5]!.status).toBe('unplaced');
    expect(plan.today?.name).toBe('Push A');
    expect(plan.messages.at(-1)).toMatch(/Semaine trop entamée.*Jambes B.*sauter/);
  });

  it('Haut/Bas : deux ratées, il reste juste la place', () => {
    const plan = planWeek(UL, [], 2);
    expect(plan.items.map((i) => i.day)).toEqual([2, 3, 4, 5]);
    expect(plan.messages).toHaveLength(4);
  });
});

describe('fin de semaine', () => {
  it('samedi sans rien fait : on garde ce qui rentre, le reste est proposé à sauter', () => {
    const plan = planWeek(FB, [], 5);
    expect(layout(plan)).toEqual([
      'Full Body A@5:moved',
      'Full Body B@-:unplaced',
      'Full Body C@-:unplaced',
    ]);
    expect(plan.messages.at(-1)).toMatch(/Full Body B, Full Body C.*les sauter/);
  });

  it('dimanche, déjà entraîné : plus rien de possible', () => {
    const plan = planWeek(UL, [{ day: 6 }], 6);
    expect(plan.items.filter((i) => i.status === 'unplaced')).toHaveLength(3);
  });

  it('séance sautée par l’utilisateur : plus de message', () => {
    const plan = planWeek(FB, [], 5, { skipped: ['d3', 'd5'] });
    expect(plan.items.map((i) => i.status)).toEqual(['moved', 'skipped', 'skipped']);
    expect(plan.messages).toEqual(['Full Body A déplacé à samedi']);
  });
});

describe('jours indisponibles', () => {
  it('jeudi indisponible : Push B passe au premier jour libre sans enchaîner les mêmes muscles', () => {
    const plan = planWeek(UL, [{ day: 0 }, { day: 1 }], 2, { unavailable: [3] });
    expect(layout(plan).slice(2)).toEqual(['Haut du corps B@4:moved', 'Bas du corps B@5:moved']);
    expect(plan.days[3]!.unavailable).toBe(true);
  });

  it('jours invalides ignorés', () => {
    const plan = planWeek(FB, [], 0, { unavailable: [-1, 12, 2.5] });
    expect(plan.messages).toEqual([]);
  });

  it('toute la fin de semaine indisponible : séances à sauter', () => {
    const plan = planWeek(FB, [], 0, { unavailable: [1, 2, 3, 4, 5, 6] });
    expect(plan.items.map((i) => i.status)).toEqual(['planned', 'unplaced', 'unplaced']);
  });
});

describe('déplacement manuel', () => {
  it('Pull B choisi jeudi : il y est, et le reste s’organise autour', () => {
    const plan = planWeek(PPL, [], 0, { moves: { d5: 3 } });
    const pullB = plan.items.find((i) => i.key === 'd5')!;
    expect(pullB).toMatchObject({ day: 3, status: 'moved', manual: true });
    expect(plan.messages).toContain('Pull B déplacé à jeudi (ton choix)');
    expect(plan.items.find((i) => i.key === 'd4')!.day).toBe(4); // Push B → vendredi
  });

  it('prévient si le jour choisi colle à une séance des mêmes muscles', () => {
    const plan = planWeek(FB, [{ day: 0 }], 0, { moves: { d3: 1 } });
    expect(plan.items[1]).toMatchObject({ day: 1, manual: true });
    expect(plan.messages.some((m) => m.includes("moins d'un jour de repos"))).toBe(true);
  });

  it('une séance avancée à la main repousse les autres pour garder le repos', () => {
    const plan = planWeek(FB, [], 0, { moves: { d3: 1 } });
    expect(plan.items.map((i) => i.day)).toEqual([3, 1, 5]);
    expect(plan.messages.some((m) => m.includes('repos'))).toBe(false);
  });

  it('déplacement vers un jour passé ou indisponible ignoré', () => {
    const plan = planWeek(PPL, [], 3, { moves: { d4: 1 }, unavailable: [6] });
    expect(plan.items.find((i) => i.key === 'd4')!.manual).toBe(false);
  });

  it('une séance faite n’est jamais déplacée, même si un déplacement la vise', () => {
    const plan = planWeek(PPL, [{ day: 0, name: 'Push' }], 2, { moves: { d1: 4 } });
    const push = plan.items.find((i) => i.key === 'd1')!;
    expect(push.status).toBe('done');
    expect(push.day).toBe(0);
  });

  it('déplacement vers un jour déjà fait ignoré', () => {
    const plan = planWeek(UL, [{ day: 2 }], 3, { moves: { d4: 2 } });
    expect(plan.items.find((i) => i.key === 'd4')!.day).not.toBe(2);
  });

  it('aucune séance planifiée sur un jour indisponible ni deux le même jour', () => {
    for (let today = 0; today <= 6; today++) {
      const unavailable = [today, (today + 2) % 7];
      const plan = planWeek(PPL, [], today, { unavailable });
      const days = plan.items.flatMap((i) => (i.day === null ? [] : [i.day]));
      expect(days.some((d) => unavailable.includes(d))).toBe(false);
      expect(new Set(days).size).toBe(days.length);
      expect(days.every((d) => d >= today)).toBe(true);
    }
  });

  it('stable : replanifier avec le résultat ne change rien (pas de boucle)', () => {
    const adjust = { unavailable: [3], moves: { d5: 6 } };
    const a = planWeek(PPL, [{ day: 0 }], 2, adjust);
    const b = planWeek(PPL, [{ day: 0 }], 2, adjust);
    expect(layout(b)).toEqual(layout(a));
  });

  it('moveTargets : aujourd’hui → dimanche, sans les jours indisponibles ni ceux déjà faits', () => {
    const plan = planWeek(UL, [{ day: 2 }], 2, { unavailable: [5] });
    expect(moveTargets(plan, 'd4', 2)).toEqual([3, 4, 6]);
  });
});

describe('programme du catalogue à semaines numérotées', () => {
  const p531 = findProgram('531-bbb')!;

  it('5/3/1 semaine 2 : 4 séances lundi, mardi, jeudi, vendredi', () => {
    const sessions = catalogPlanSessions(p531.weeks[1]!);
    expect(sessions.map((s) => [s.name, s.day])).toEqual([
      ['Press Day', 0],
      ['Deadlift Day', 1],
      ['Bench Day', 3],
      ['Squat Day', 4],
    ]);
    expect(sessions[1]!.muscles).toContain('ischio');
  });

  it('5/3/1 : Deadlift raté mardi → mercredi, Bench vendredi, Squat samedi', () => {
    const plan = planWeek(catalogPlanSessions(p531.weeks[0]!), [{ day: 0 }], 2);
    expect(layout(plan)).toEqual([
      'Press Day@0:done',
      'Deadlift Day@2:moved',
      'Bench Day@3:planned',
      // Squat vendredi possible (deadlift mercredi = 1 jour de repos jeudi).
      'Squat Day@4:planned',
    ]);
  });

  it('Starting Strength : séances A/B, jamais deux squats d’affilée', () => {
    const ss = findProgram('starting-strength')!;
    const plan = planWeek(catalogPlanSessions(ss.weeks[0]!), [], 1);
    const days = plan.items.map((i) => i.day);
    expect(days).toEqual([1, 3, 5]);
  });

  it('séances sans mouvement connu : muscles = nom du mouvement', () => {
    const s = catalogPlanSessions({ sessions: [{ name: 'X', exercises: [{ liftRef: 'curl' }] }] });
    expect(s[0]!.muscles).toEqual(['curl']);
  });
});

describe('robustesse', () => {
  it('programme vide', () => {
    const plan = planWeek([], [{ day: 0 }], 3);
    expect(plan.total).toBe(0);
    expect(plan.today).toBeNull();
    expect(plan.days).toHaveLength(7);
  });

  it('plus de séances faites que prévues : le surplus est ignoré', () => {
    const one: PlanSession[] = [{ key: 'a', name: 'A', muscles: ['x'], day: 0 }];
    const plan = planWeek(one, [{ day: 0 }, { day: 1 }], 2);
    expect(plan.doneCount).toBe(1);
  });

  it('le programme écrit avec deux jours collés reste tel quel (pas de déplacement inutile)', () => {
    const s: PlanSession[] = [
      { key: 'a', name: 'Jambes 1', muscles: ['jambes'], day: 0 },
      { key: 'b', name: 'Jambes 2', muscles: ['jambes'], day: 1 },
    ];
    expect(planWeek(s, [], 0).messages).toEqual([]);
  });
});
