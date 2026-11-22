/**
 * Minuteurs HIIT (page Minuteurs) : EMOM, AMRAP, Tabata, intervalles
 * personnalisés. Déroulé des phases, horloge à heure absolue (pause, reprise,
 * « Passer »), signaux sonores à jouer et enregistrement d'un finisher dans la
 * séance en cours. Pur, zéro I/O.
 *
 * Horloge : le temps écoulé se calcule depuis une heure de départ (décalée par
 * les pauses et « Passer »), jamais en comptant des tics : quelques secondes en
 * arrière-plan ne décalent rien, le minuteur se recale au retour.
 */

export type TimerMode = 'emom' | 'amrap' | 'tabata' | 'intervals';
export type TimerPhaseKind = 'prep' | 'warmup' | 'work' | 'rest' | 'cooldown';

/**
 * Réglage d'un minuteur. Sens de `workSec` selon le mode : EMOM = durée d'un
 * intervalle (60 s), AMRAP = durée totale, Tabata / intervalles = travail.
 * `rounds` : minutes (EMOM), tours (Tabata, intervalles), ignoré en AMRAP.
 */
export interface TimerConfig {
  mode: TimerMode;
  workSec: number;
  restSec: number;
  rounds: number;
  warmupSec: number;
  cooldownSec: number;
}

export interface TimerPhase {
  kind: TimerPhaseKind;
  sec: number;
  /** Tour (1…rounds) pour travail et repos, 0 sinon. */
  round: number;
  rounds: number;
}

export const TIMER_MODES: ReadonlyArray<{ key: TimerMode; label: string; hint: string }> = [
  { key: 'emom', label: 'EMOM', hint: 'Une tâche au début de chaque minute' },
  { key: 'amrap', label: 'AMRAP', hint: 'Un maximum de tours dans le temps imparti' },
  { key: 'tabata', label: 'Tabata', hint: '20 s d’effort, 10 s de repos, 8 tours' },
  { key: 'intervals', label: 'Intervalles', hint: 'Travail, repos et tours à ta main' },
];

/** Décompte « Prêt » avant le premier effort (le temps de poser le téléphone). */
export const TIMER_PREP_SEC = 10;
/** Signal « 3-2-1 » avant chaque changement de phase. */
export const TIMER_COUNTDOWN_SEC = 3;

export const DEFAULT_TIMER_CONFIGS: Readonly<Record<TimerMode, TimerConfig>> = {
  emom: { mode: 'emom', workSec: 60, restSec: 0, rounds: 10, warmupSec: 0, cooldownSec: 0 },
  amrap: { mode: 'amrap', workSec: 600, restSec: 0, rounds: 1, warmupSec: 0, cooldownSec: 0 },
  tabata: { mode: 'tabata', workSec: 20, restSec: 10, rounds: 8, warmupSec: 0, cooldownSec: 0 },
  intervals: {
    mode: 'intervals',
    workSec: 40,
    restSec: 20,
    rounds: 10,
    warmupSec: 0,
    cooldownSec: 0,
  },
};

export function isTimerMode(v: unknown): v is TimerMode {
  return v === 'emom' || v === 'amrap' || v === 'tabata' || v === 'intervals';
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Réglage borné et cohérent avec son mode (valeurs absurdes → défauts). */
export function clampTimerConfig(raw: Partial<TimerConfig> | null | undefined): TimerConfig {
  const mode = isTimerMode(raw?.mode) ? raw.mode : 'tabata';
  const d = DEFAULT_TIMER_CONFIGS[mode];
  const r = raw ?? {};
  switch (mode) {
    case 'emom':
      return {
        ...d,
        workSec: clampInt(r.workSec, 15, 600, d.workSec),
        rounds: clampInt(r.rounds, 1, 99, d.rounds),
      };
    case 'amrap':
      return { ...d, workSec: clampInt(r.workSec, 60, 7200, d.workSec) };
    case 'tabata':
      return {
        ...d,
        workSec: clampInt(r.workSec, 5, 600, d.workSec),
        restSec: clampInt(r.restSec, 0, 600, d.restSec),
        rounds: clampInt(r.rounds, 1, 99, d.rounds),
      };
    default:
      return {
        mode,
        workSec: clampInt(r.workSec, 5, 3600, d.workSec),
        restSec: clampInt(r.restSec, 0, 1800, d.restSec),
        rounds: clampInt(r.rounds, 1, 99, d.rounds),
        warmupSec: clampInt(r.warmupSec, 0, 1800, 0),
        cooldownSec: clampInt(r.cooldownSec, 0, 1800, 0),
      };
  }
}

/** Déroulé complet : « Prêt », puis les phases du mode (pas de repos après le dernier tour). */
export function buildTimerPhases(raw: Partial<TimerConfig>): TimerPhase[] {
  const c = clampTimerConfig(raw);
  const phases: TimerPhase[] = [{ kind: 'prep', sec: TIMER_PREP_SEC, round: 0, rounds: 0 }];
  if (c.mode === 'amrap') {
    phases.push({ kind: 'work', sec: c.workSec, round: 1, rounds: 1 });
    return phases;
  }
  if (c.warmupSec > 0) phases.push({ kind: 'warmup', sec: c.warmupSec, round: 0, rounds: 0 });
  for (let i = 1; i <= c.rounds; i++) {
    phases.push({ kind: 'work', sec: c.workSec, round: i, rounds: c.rounds });
    if (c.mode !== 'emom' && c.restSec > 0 && i < c.rounds) {
      phases.push({ kind: 'rest', sec: c.restSec, round: i, rounds: c.rounds });
    }
  }
  if (c.cooldownSec > 0) phases.push({ kind: 'cooldown', sec: c.cooldownSec, round: 0, rounds: 0 });
  return phases;
}

/** Durée totale (s), « Prêt » compris ou non. */
export function timerTotalSec(phases: readonly TimerPhase[], withPrep = false): number {
  return phases.reduce((n, p) => n + (withPrep || p.kind !== 'prep' ? p.sec : 0), 0);
}

export interface TimerSnapshot {
  /** Indice de la phase en cours (phases.length une fois terminé). */
  index: number;
  phase: TimerPhase | null;
  /** Temps restant de la phase (ms). */
  phaseRemainingMs: number;
  /** Part écoulée de la phase, 0 → 1. */
  phaseProgress: number;
  /** Temps restant au total, « Prêt » compris (ms). */
  totalRemainingMs: number;
  done: boolean;
}

/** État du minuteur après `elapsedMs` depuis le départ. */
export function timerSnapshot(phases: readonly TimerPhase[], elapsedMs: number): TimerSnapshot {
  const total = timerTotalSec(phases, true) * 1000;
  const t = Math.max(0, Number(elapsedMs) || 0);
  let start = 0;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]!;
    const end = start + p.sec * 1000;
    if (t < end) {
      return {
        index: i,
        phase: p,
        phaseRemainingMs: end - t,
        phaseProgress: p.sec > 0 ? (t - start) / (p.sec * 1000) : 1,
        totalRemainingMs: total - t,
        done: false,
      };
    }
    start = end;
  }
  return {
    index: phases.length,
    phase: null,
    phaseRemainingMs: 0,
    phaseProgress: 1,
    totalRemainingMs: 0,
    done: true,
  };
}

// ─── Horloge (heure absolue) ────────────────────────────────────────────────

export interface TimerClock {
  /** Heure de départ virtuelle (décalée par les pauses et « Passer »). */
  startMs: number;
  /** Heure de la mise en pause, null si le minuteur tourne. */
  pausedAtMs: number | null;
}

export function startTimerClock(nowMs: number): TimerClock {
  return { startMs: nowMs, pausedAtMs: null };
}

export function timerElapsedMs(clock: TimerClock, nowMs: number): number {
  return Math.max(0, (clock.pausedAtMs ?? nowMs) - clock.startMs);
}

export function pauseTimerClock(clock: TimerClock, nowMs: number): TimerClock {
  return clock.pausedAtMs === null ? { ...clock, pausedAtMs: nowMs } : clock;
}

export function resumeTimerClock(clock: TimerClock, nowMs: number): TimerClock {
  if (clock.pausedAtMs === null) return clock;
  return { startMs: clock.startMs + (nowMs - clock.pausedAtMs), pausedAtMs: null };
}

/** « Passer » : saute au début de la phase suivante (même en pause). */
export function skipTimerPhase(
  clock: TimerClock,
  phases: readonly TimerPhase[],
  nowMs: number,
): TimerClock {
  const snap = timerSnapshot(phases, timerElapsedMs(clock, nowMs));
  if (snap.done) return clock;
  return { ...clock, startMs: clock.startMs - snap.phaseRemainingMs };
}

/** Temps d'effort réellement passé (sans « Prêt »), en secondes entières. */
export function timerWorkedSec(phases: readonly TimerPhase[], elapsedMs: number): number {
  const prep = phases[0]?.kind === 'prep' ? phases[0].sec * 1000 : 0;
  const max = timerTotalSec(phases) * 1000;
  return Math.floor(Math.min(max, Math.max(0, elapsedMs - prep)) / 1000);
}

// ─── Signaux (bips, vibrations) ─────────────────────────────────────────────

export type TimerCue =
  | { kind: 'count'; n: number }
  | { kind: 'work' }
  | { kind: 'rest' }
  | { kind: 'done' };

/**
 * Signaux franchis entre deux instants : « 3-2-1 » avant chaque changement de
 * phase (si la phase dure assez), puis le départ de la phase suivante (effort,
 * repos) ou la fin. Dans l'ordre chronologique.
 */
export function timerCuesBetween(
  phases: readonly TimerPhase[],
  fromMs: number,
  toMs: number,
): TimerCue[] {
  const cues: Array<{ at: number; cue: TimerCue }> = [];
  const crossed = (at: number): boolean => at > fromMs && at <= toMs;
  let end = 0;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]!;
    end += p.sec * 1000;
    if (p.sec > TIMER_COUNTDOWN_SEC + 1) {
      for (let n = TIMER_COUNTDOWN_SEC; n >= 1; n--) {
        const at = end - n * 1000;
        if (crossed(at)) cues.push({ at, cue: { kind: 'count', n } });
      }
    }
    if (crossed(end)) {
      const next = phases[i + 1];
      const cue: TimerCue = !next
        ? { kind: 'done' }
        : next.kind === 'work'
          ? { kind: 'work' }
          : { kind: 'rest' };
      cues.push({ at: end, cue });
    }
  }
  return cues.sort((a, b) => a.at - b.at).map((c) => c.cue);
}

/**
 * Signal à jouer pour un tic : le dernier franchi, et seulement si le tic est
 * récent (retour d'arrière-plan → pas de rafale de bips en retard).
 */
export function timerCueToPlay(
  phases: readonly TimerPhase[],
  fromMs: number,
  toMs: number,
  maxGapMs = 1500,
): TimerCue | null {
  if (toMs - fromMs > maxGapMs) return null;
  return timerCuesBetween(phases, fromMs, toMs).at(-1) ?? null;
}

// ─── Libellés ───────────────────────────────────────────────────────────────

/** « 45 s », « 1 min », « 1 min 30 ». */
export function formatTimerSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${String(r).padStart(2, '0')}` : `${m} min`;
}

/** Compte à rebours « 0:07 », « 12:30 » (secondes arrondies au-dessus). */
export function formatTimerClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Titre d'un réglage : « Tabata 20 s / 10 s × 8 », « EMOM 10 min ». */
export function timerTitle(raw: Partial<TimerConfig>): string {
  const c = clampTimerConfig(raw);
  switch (c.mode) {
    case 'emom':
      return c.workSec === 60
        ? `EMOM ${c.rounds} min`
        : `EMOM ${c.rounds} × ${formatTimerSec(c.workSec)}`;
    case 'amrap':
      return `AMRAP ${formatTimerSec(c.workSec)}`;
    case 'tabata':
      return `Tabata ${formatTimerSec(c.workSec)} / ${formatTimerSec(c.restSec)} × ${c.rounds}`;
    default: {
      const extra = [
        c.warmupSec ? `échauffement ${formatTimerSec(c.warmupSec)}` : '',
        c.cooldownSec ? `retour au calme ${formatTimerSec(c.cooldownSec)}` : '',
      ].filter(Boolean);
      return `Intervalles ${formatTimerSec(c.workSec)} / ${formatTimerSec(c.restSec)} × ${c.rounds}${
        extra.length ? ` (${extra.join(', ')})` : ''
      }`;
    }
  }
}

/** Libellé de phase affiché en grand. */
export function timerPhaseLabel(phase: TimerPhase | null, mode: TimerMode): string {
  if (!phase) return 'Terminé';
  switch (phase.kind) {
    case 'prep':
      return 'Prêt';
    case 'warmup':
      return 'Échauffement';
    case 'cooldown':
      return 'Retour au calme';
    case 'rest':
      return 'Repos';
    default:
      return mode === 'amrap' ? 'Go' : 'Effort';
  }
}

/** « Minute 3/10 », « Tour 2/8 » (vide hors effort et repos, et en AMRAP). */
export function timerRoundLabel(phase: TimerPhase | null, mode: TimerMode): string {
  if (!phase || phase.round === 0 || mode === 'amrap') return '';
  const word = mode === 'emom' && phase.rounds > 0 ? 'Minute' : 'Tour';
  return `${word} ${phase.round}/${phase.rounds}`;
}

// ─── Préréglages ────────────────────────────────────────────────────────────

export interface TimerPreset {
  id: string;
  name: string;
  config: TimerConfig;
}

export const MAX_TIMER_PRESETS = 12;

const sameConfig = (a: TimerConfig, b: TimerConfig): boolean =>
  a.mode === b.mode &&
  a.workSec === b.workSec &&
  a.restSec === b.restSec &&
  a.rounds === b.rounds &&
  a.warmupSec === b.warmupSec &&
  a.cooldownSec === b.cooldownSec;

/** Préréglages enregistrés, nettoyés (données corrompues ou anciennes ignorées). */
export function normalizeTimerPresets(raw: unknown): TimerPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: TimerPreset[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || !r['id'] || !r['config']) continue;
    const config = clampTimerConfig(r['config'] as Partial<TimerConfig>);
    const name =
      typeof r['name'] === 'string' && r['name'].trim()
        ? r['name'].trim().slice(0, 60)
        : timerTitle(config);
    out.push({ id: r['id'], name, config });
    if (out.length >= MAX_TIMER_PRESETS) break;
  }
  return out;
}

/** Ajoute un préréglage en tête (un réglage identique remonte au lieu d'être doublé). */
export function addTimerPreset(
  list: readonly TimerPreset[],
  id: string,
  rawConfig: Partial<TimerConfig>,
  name?: string,
): TimerPreset[] {
  const config = clampTimerConfig(rawConfig);
  const label = (name ?? '').trim().slice(0, 60) || timerTitle(config);
  const rest = list.filter((p) => !sameConfig(p.config, config));
  return [{ id, name: label, config }, ...rest].slice(0, MAX_TIMER_PRESETS);
}

export function removeTimerPreset(list: readonly TimerPreset[], id: string): TimerPreset[] {
  return list.filter((p) => p.id !== id);
}

// ─── Finisher enregistré dans la séance en cours ────────────────────────────

/** Exercice chronométré créé à la demande (masqué des listes de choix). */
export const FINISHER_EXERCISE = {
  id: 'finisher_hiit',
  name: 'Finisher HIIT',
  muscles: ['conditioning'] as readonly string[],
  equipment: 'bodyweight' as const,
  incrementKg: 1,
  measure: 'time' as const,
  hidden: true,
};

/** Note de la série : « Tabata 20 s / 10 s × 8 », « AMRAP 10 min · 7 tours ». */
export function finisherNote(raw: Partial<TimerConfig>, amrapRounds = 0): string {
  const c = clampTimerConfig(raw);
  const rounds = Math.max(0, Math.round(amrapRounds) || 0);
  const suffix =
    c.mode === 'amrap' && rounds > 0 ? ` · ${rounds} tour${rounds > 1 ? 's' : ''}` : '';
  return `${timerTitle(c)}${suffix}`.slice(0, 200);
}

interface FinisherSet {
  setIndex: number;
  reps: number;
  weightKg: number;
  rpe: number;
  durationSec?: number;
  performedAt?: string;
  note?: string;
  kind?: 'work' | 'warmup';
}

interface FinisherEntry {
  exerciseId: string;
  sets: readonly FinisherSet[];
}

/**
 * Ajoute le finisher (série chronométrée de `durationSec`) à la séance : à la
 * suite de l'exercice « Finisher HIIT » s'il y est déjà, sinon en dernier.
 * Séance inchangée si la durée est nulle.
 */
export function withFinisherSet<E extends FinisherEntry, S extends { entries: readonly E[] }>(
  session: S,
  durationSec: number,
  note: string,
  performedAt: string,
  rpe = 9,
): S {
  const sec = Math.round(Number(durationSec) || 0);
  if (sec <= 0) return session;
  const id = FINISHER_EXERCISE.id;
  const make = (setIndex: number): FinisherSet => ({
    setIndex,
    reps: 0,
    weightKg: 0,
    rpe,
    durationSec: sec,
    performedAt,
    ...(note ? { note } : {}),
  });
  const has = session.entries.some((e) => e.exerciseId === id);
  const entries = has
    ? session.entries.map((e) =>
        e.exerciseId === id ? { ...e, sets: [...e.sets, make(e.sets.length)] } : e,
      )
    : [...session.entries, { exerciseId: id, sets: [make(0)] } as unknown as E];
  return { ...session, entries };
}
