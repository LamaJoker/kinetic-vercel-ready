import { describe, it, expect } from 'vitest';
import {
  TIMER_PREP_SEC,
  DEFAULT_TIMER_CONFIGS,
  FINISHER_EXERCISE,
  clampTimerConfig,
  buildTimerPhases,
  timerTotalSec,
  timerSnapshot,
  startTimerClock,
  timerElapsedMs,
  pauseTimerClock,
  resumeTimerClock,
  skipTimerPhase,
  timerWorkedSec,
  timerCuesBetween,
  timerCueToPlay,
  formatTimerSec,
  formatTimerClock,
  timerTitle,
  timerPhaseLabel,
  timerRoundLabel,
  normalizeTimerPresets,
  addTimerPreset,
  removeTimerPreset,
  finisherNote,
  withFinisherSet,
} from '@kinetic/core';

const PREP = TIMER_PREP_SEC * 1000;

describe('déroulé des phases', () => {
  it('Tabata : prêt, 8 × (20 s effort, 10 s repos), sans repos après le dernier tour', () => {
    const phases = buildTimerPhases(DEFAULT_TIMER_CONFIGS.tabata);
    expect(phases[0]).toEqual({ kind: 'prep', sec: TIMER_PREP_SEC, round: 0, rounds: 0 });
    const body = phases.slice(1);
    expect(body).toHaveLength(15);
    expect(body.filter((p) => p.kind === 'work')).toHaveLength(8);
    expect(body.at(-1)).toEqual({ kind: 'work', sec: 20, round: 8, rounds: 8 });
    expect(timerTotalSec(phases)).toBe(8 * 20 + 7 * 10);
    expect(timerTotalSec(phases, true)).toBe(230 + TIMER_PREP_SEC);
  });

  it('EMOM : une phase d’effort par minute, pas de repos', () => {
    const phases = buildTimerPhases({ mode: 'emom', workSec: 60, rounds: 5 });
    expect(phases.slice(1).map((p) => p.kind)).toEqual(Array(5).fill('work'));
    expect(timerTotalSec(phases)).toBe(300);
  });

  it('AMRAP : une seule phase de la durée totale', () => {
    const phases = buildTimerPhases({ mode: 'amrap', workSec: 720 });
    expect(phases.slice(1)).toEqual([{ kind: 'work', sec: 720, round: 1, rounds: 1 }]);
  });

  it('Intervalles : échauffement et retour au calme optionnels', () => {
    const phases = buildTimerPhases({
      mode: 'intervals',
      workSec: 30,
      restSec: 15,
      rounds: 3,
      warmupSec: 120,
      cooldownSec: 60,
    });
    expect(phases.map((p) => p.kind)).toEqual([
      'prep',
      'warmup',
      'work',
      'rest',
      'work',
      'rest',
      'work',
      'cooldown',
    ]);
    // Tabata ignore échauffement / retour au calme
    const t = buildTimerPhases({ ...DEFAULT_TIMER_CONFIGS.tabata, warmupSec: 60 });
    expect(t.some((p) => p.kind === 'warmup')).toBe(false);
  });

  it('borne les réglages absurdes', () => {
    expect(clampTimerConfig({ mode: 'tabata', workSec: -5, rounds: 500 })).toMatchObject({
      workSec: 5,
      rounds: 99,
    });
    expect(clampTimerConfig({ mode: 'amrap', workSec: 10 }).workSec).toBe(60);
    expect(clampTimerConfig({ mode: 'nope' as never }).mode).toBe('tabata');
    expect(clampTimerConfig(null)).toEqual(DEFAULT_TIMER_CONFIGS.tabata);
  });
});

describe('état et horloge', () => {
  const phases = buildTimerPhases(DEFAULT_TIMER_CONFIGS.tabata);

  it('situe la phase en cours et le temps restant', () => {
    expect(timerSnapshot(phases, 0).phase?.kind).toBe('prep');
    const s = timerSnapshot(phases, PREP + 5000);
    expect(s.phase).toMatchObject({ kind: 'work', round: 1 });
    expect(s.phaseRemainingMs).toBe(15_000);
    expect(s.phaseProgress).toBeCloseTo(0.25);
    expect(timerSnapshot(phases, PREP + 21_000).phase?.kind).toBe('rest');
    const end = timerSnapshot(phases, 10_000_000);
    expect(end.done).toBe(true);
    expect(end.phase).toBeNull();
  });

  it('pause et reprise : le temps en pause ne compte pas', () => {
    let c = startTimerClock(1000);
    expect(timerElapsedMs(c, 6000)).toBe(5000);
    c = pauseTimerClock(c, 6000);
    expect(timerElapsedMs(c, 60_000)).toBe(5000);
    c = resumeTimerClock(c, 60_000);
    expect(timerElapsedMs(c, 61_000)).toBe(6000);
    expect(resumeTimerClock(c, 99)).toBe(c);
  });

  it('heure absolue : un retour d’arrière-plan retrouve le bon instant', () => {
    const c = startTimerClock(0);
    // 52 s plus tard sans aucun tic : on est au repos du 2e tour
    const s = timerSnapshot(phases, timerElapsedMs(c, PREP + 52_000));
    expect(s.phase).toMatchObject({ kind: 'rest', round: 2 });
  });

  it('« Passer » saute au début de la phase suivante, même en pause', () => {
    let c = startTimerClock(0);
    c = skipTimerPhase(c, phases, 2000); // pendant « Prêt »
    expect(timerSnapshot(phases, timerElapsedMs(c, 2000))).toMatchObject({
      phase: { kind: 'work', round: 1 },
      phaseRemainingMs: 20_000,
    });
    c = pauseTimerClock(c, 5000);
    c = skipTimerPhase(c, phases, 9000);
    expect(timerSnapshot(phases, timerElapsedMs(c, 9000)).phase?.kind).toBe('rest');
  });

  it('temps d’effort : sans « Prêt », plafonné à la durée totale', () => {
    expect(timerWorkedSec(phases, 3000)).toBe(0);
    expect(timerWorkedSec(phases, PREP + 61_500)).toBe(61);
    expect(timerWorkedSec(phases, 10_000_000)).toBe(230);
  });
});

describe('signaux', () => {
  const phases = buildTimerPhases(DEFAULT_TIMER_CONFIGS.tabata);

  it('3-2-1 puis départ de l’effort', () => {
    expect(timerCuesBetween(phases, PREP - 3500, PREP)).toEqual([
      { kind: 'count', n: 3 },
      { kind: 'count', n: 2 },
      { kind: 'count', n: 1 },
      { kind: 'work' },
    ]);
    // fin de l'effort du tour 1 → repos
    expect(timerCuesBetween(phases, PREP + 19_500, PREP + 20_000)).toEqual([{ kind: 'rest' }]);
    // fin du minuteur
    const total = timerTotalSec(phases, true) * 1000;
    expect(timerCuesBetween(phases, total - 100, total + 100).at(-1)).toEqual({ kind: 'done' });
  });

  it('EMOM : bip au début de chaque minute', () => {
    const emom = buildTimerPhases({ mode: 'emom', workSec: 60, rounds: 3 });
    const starts = timerCuesBetween(emom, 0, 1e9).filter((c) => c.kind === 'work');
    expect(starts).toHaveLength(3); // minutes 1, 2 et 3
  });

  it('pas de rafale de bips en retard au retour d’arrière-plan', () => {
    expect(timerCueToPlay(phases, PREP - 1100, PREP - 900)).toEqual({ kind: 'count', n: 1 });
    expect(timerCueToPlay(phases, 0, PREP + 30_000)).toBeNull();
    expect(timerCueToPlay(phases, 500, 700)).toBeNull();
  });
});

describe('libellés', () => {
  it('durées et titres en français', () => {
    expect(formatTimerSec(45)).toBe('45 s');
    expect(formatTimerSec(60)).toBe('1 min');
    expect(formatTimerSec(90)).toBe('1 min 30');
    expect(formatTimerClock(7001)).toBe('0:08');
    expect(formatTimerClock(750_000)).toBe('12:30');
    expect(timerTitle(DEFAULT_TIMER_CONFIGS.tabata)).toBe('Tabata 20 s / 10 s × 8');
    expect(timerTitle({ mode: 'emom', workSec: 60, rounds: 12 })).toBe('EMOM 12 min');
    expect(timerTitle({ mode: 'emom', workSec: 90, rounds: 6 })).toBe('EMOM 6 × 1 min 30');
    expect(timerTitle({ mode: 'amrap', workSec: 600 })).toBe('AMRAP 10 min');
    expect(
      timerTitle({ mode: 'intervals', workSec: 40, restSec: 20, rounds: 5, warmupSec: 120 }),
    ).toBe('Intervalles 40 s / 20 s × 5 (échauffement 2 min)');
  });

  it('phase et tour', () => {
    const [prep, work] = buildTimerPhases({ mode: 'emom', workSec: 60, rounds: 10 });
    expect(timerPhaseLabel(prep!, 'emom')).toBe('Prêt');
    expect(timerPhaseLabel(work!, 'emom')).toBe('Effort');
    expect(timerPhaseLabel(null, 'emom')).toBe('Terminé');
    expect(timerRoundLabel(work!, 'emom')).toBe('Minute 1/10');
    expect(timerRoundLabel(prep!, 'emom')).toBe('');
    const tab = buildTimerPhases(DEFAULT_TIMER_CONFIGS.tabata);
    expect(timerRoundLabel(tab[2]!, 'tabata')).toBe('Tour 1/8');
    expect(timerPhaseLabel(tab[2]!, 'tabata')).toBe('Repos');
  });
});

describe('préréglages', () => {
  it('ajout en tête, sans doublon, nom par défaut', () => {
    let list = addTimerPreset([], 'a', DEFAULT_TIMER_CONFIGS.tabata);
    list = addTimerPreset(list, 'b', { mode: 'emom', workSec: 60, rounds: 12 }, 'Mon EMOM');
    list = addTimerPreset(list, 'c', DEFAULT_TIMER_CONFIGS.tabata);
    expect(list.map((p) => p.id)).toEqual(['c', 'b']);
    expect(list[0]!.name).toBe('Tabata 20 s / 10 s × 8');
    expect(list[1]!.name).toBe('Mon EMOM');
    expect(removeTimerPreset(list, 'c').map((p) => p.id)).toEqual(['b']);
  });

  it('données stockées nettoyées', () => {
    expect(normalizeTimerPresets(null)).toEqual([]);
    const out = normalizeTimerPresets([
      { id: 'x', name: '', config: { mode: 'amrap', workSec: 99999 } },
      { name: 'sans id', config: {} },
      'n’importe quoi',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.config.workSec).toBe(7200);
    expect(out[0]!.name).toBe('AMRAP 120 min');
  });
});

describe('finisher dans la séance', () => {
  const session = {
    id: 's',
    entries: [{ exerciseId: 'bench', sets: [{ setIndex: 0, reps: 5, weightKg: 100, rpe: 8 }] }],
  };

  it('ajoute l’exercice chronométré « Finisher HIIT » en dernier', () => {
    const at = '2026-11-22T10:00:00.000Z';
    const out = withFinisherSet(session, 230, finisherNote(DEFAULT_TIMER_CONFIGS.tabata), at);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[1]).toEqual({
      exerciseId: FINISHER_EXERCISE.id,
      sets: [
        {
          setIndex: 0,
          reps: 0,
          weightKg: 0,
          rpe: 9,
          durationSec: 230,
          performedAt: at,
          note: 'Tabata 20 s / 10 s × 8',
        },
      ],
    });
    // Second finisher : nouvelle série du même exercice
    const twice = withFinisherSet(out, 60, '', at);
    expect(twice.entries).toHaveLength(2);
    expect(twice.entries[1]!.sets.map((s) => s.setIndex)).toEqual([0, 1]);
    expect(session.entries).toHaveLength(1); // pas de mutation
  });

  it('durée nulle : rien n’est ajouté', () => {
    expect(withFinisherSet(session, 0, 'x', 'now')).toBe(session);
  });

  it('note AMRAP avec les tours', () => {
    expect(finisherNote({ mode: 'amrap', workSec: 600 }, 7)).toBe('AMRAP 10 min · 7 tours');
    expect(finisherNote({ mode: 'amrap', workSec: 600 }, 1)).toBe('AMRAP 10 min · 1 tour');
    expect(finisherNote({ mode: 'amrap', workSec: 600 }, 0)).toBe('AMRAP 10 min');
  });
});
