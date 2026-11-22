/**
 * Page Minuteurs (/minuteurs) : EMOM, AMRAP, Tabata et intervalles
 * personnalisés, en plein écran. Déroulé des phases, horloge, signaux et
 * enregistrement du finisher : @kinetic/core (interval-timer.domain).
 *
 * - Temps calculé depuis l'heure de départ (jamais un compteur) : quelques
 *   secondes en arrière-plan ne décalent rien, l'écran se recale au retour.
 * - Bips « 3-2-1 » (Web Audio, oscillateur court, sans fichier) et vibrations.
 * - Écran gardé allumé pendant le minuteur (lib/wake-lock.ts, même réglage).
 * - Ouvert depuis la séance en cours (?finisher=1) : à la fin, le finisher est
 *   ajouté à la séance (exercice chronométré « Finisher HIIT »). Sinon, rien
 *   n'est enregistré.
 */
import {
  STORAGE_KEYS,
  TIMER_MODES,
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
  type TimerConfig,
  type TimerCue,
  type TimerClock,
  type TimerMode,
  type TimerPhase,
  type TimerPreset,
  type TimerSnapshot,
} from '@kinetic/core';
import { UuidGenerator } from '@kinetic/adapters-web';
import { getDeps } from '../deps';
import { hapticLight, hapticMedium, hapticHeavy, hapticSuccess } from '../lib/haptics';
import {
  createSessionWakeLock,
  wakeLockEnabled,
  wakeLockSupported,
  type SessionWakeLock,
} from '../lib/wake-lock';
import {
  announceActiveSession,
  loadActiveSession,
  summarizeActiveSession,
  writeActiveSession,
} from '../lib/training/active-session';
import { loadCustomExercises, saveCustomExercises } from '../lib/training/storage';

type Field = 'workSec' | 'restSec' | 'rounds' | 'warmupSec' | 'cooldownSec';
interface FieldDef {
  key: Field;
  label: string;
  step: number;
  /** Unité d'affichage : durée (s → « 1 min 30 »), minutes, tours. */
  unit: 'sec' | 'min' | 'rounds';
}

/** Réglages proposés pour chaque mode (steppers −/+). */
const FIELDS: Record<TimerMode, FieldDef[]> = {
  emom: [
    { key: 'rounds', label: 'Durée', step: 1, unit: 'min' },
    { key: 'workSec', label: 'Toutes les', step: 15, unit: 'sec' },
  ],
  amrap: [{ key: 'workSec', label: 'Durée', step: 60, unit: 'sec' }],
  tabata: [
    { key: 'workSec', label: 'Effort', step: 5, unit: 'sec' },
    { key: 'restSec', label: 'Repos', step: 5, unit: 'sec' },
    { key: 'rounds', label: 'Tours', step: 1, unit: 'rounds' },
  ],
  intervals: [
    { key: 'workSec', label: 'Effort', step: 5, unit: 'sec' },
    { key: 'restSec', label: 'Repos', step: 5, unit: 'sec' },
    { key: 'rounds', label: 'Tours', step: 1, unit: 'rounds' },
    { key: 'warmupSec', label: 'Échauffement', step: 30, unit: 'sec' },
    { key: 'cooldownSec', label: 'Retour au calme', step: 30, unit: 'sec' },
  ],
};

const idGen = new UuidGenerator();

const notify = (kind: 'success' | 'info' | 'warning', message: string): void => {
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind, message } }));
};

// ─── Bips (Web Audio) ───────────────────────────────────────────────────────

let audio: AudioContext | null = null;

/** À appeler sur un geste (Démarrer) : iOS n'autorise le son qu'après un toucher. */
function unlockAudio(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

/** Quitter la page : plus aucun bip (y compris un bip différé) et contexte audio libéré. */
function closeAudio(): void {
  const ctx = audio;
  audio = null;
  try {
    if (ctx) void ctx.close().catch(() => undefined);
  } catch {
    /* déjà fermé */
  }
}

/** Bip court : oscillateur sinus avec une enveloppe douce (pas de clic). */
function beep(freq: number, ms: number): void {
  const ctx = audio;
  if (!ctx) return;
  try {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.03);
  } catch {
    /* audio indisponible : on ignore */
  }
}

/** Son et vibration d'un signal du minuteur. */
function playCue(cue: TimerCue, sound: boolean): void {
  switch (cue.kind) {
    case 'count':
      if (sound) beep(660, 120);
      hapticLight();
      break;
    case 'work':
      if (sound) beep(990, 420);
      hapticHeavy();
      break;
    case 'rest':
      if (sound) beep(520, 380);
      hapticMedium();
      break;
    default:
      if (sound) {
        beep(880, 180);
        setTimeout(() => beep(1175, 420), 200);
      }
      hapticSuccess();
  }
}

export function timersPage() {
  return {
    MODES: TIMER_MODES,
    view: 'setup' as 'setup' | 'run' | 'done',
    cfg: { ...DEFAULT_TIMER_CONFIGS.tabata } as TimerConfig,
    presets: [] as TimerPreset[],
    /** Ouvert depuis la séance en cours : le finisher y sera ajouté. */
    finisher: false,
    finisherSessionName: '',
    recorded: false,
    sound: true,

    phases: [] as TimerPhase[],
    clock: null as TimerClock | null,
    elapsedMs: 0,
    amrapRounds: 0,
    /** Terminé jusqu'au bout (sinon arrêté avant la fin). */
    completed: false,
    _lastMs: 0,
    _tick: null as ReturnType<typeof setInterval> | null,
    _lock: null as SessionWakeLock | null,
    _onVisible: null as (() => void) | null,

    async init(): Promise<void> {
      const params = new URLSearchParams(window.location?.search ?? '');
      const wanted = params.get('finisher') === '1';
      try {
        const deps = await getDeps();
        this.presets = normalizeTimerPresets(await deps.storage.get(STORAGE_KEYS.TIMER_PRESETS));
        if (wanted) {
          const snap = await loadActiveSession(deps.storage);
          this.finisher = !!snap;
          this.finisherSessionName = snap?.session.name ?? '';
        }
      } catch (err) {
        console.warn('[minuteurs] init failed:', err);
      }
      const mode = params.get('mode');
      if (mode === 'emom' || mode === 'amrap' || mode === 'tabata' || mode === 'intervals')
        this.setMode(mode);
    },

    destroy(): void {
      this._stopTicking();
      closeAudio();
    },

    // ─── Réglage ───────────────────────────────────────────────

    setMode(mode: TimerMode): void {
      if (this.cfg.mode === mode) return;
      this.cfg = { ...DEFAULT_TIMER_CONFIGS[mode] };
      hapticLight();
    },

    modePressed(mode: TimerMode): string {
      return this.cfg.mode === mode ? 'true' : 'false';
    },

    modeHint(): string {
      return TIMER_MODES.find((m) => m.key === this.cfg.mode)?.hint ?? '';
    },

    fields(): FieldDef[] {
      return FIELDS[this.cfg.mode];
    },

    fieldValue(f: FieldDef): string {
      const v = this.cfg[f.key];
      if (f.unit === 'min') return `${v} min`;
      if (f.unit === 'rounds') return String(v);
      if (v === 0 && (f.key === 'warmupSec' || f.key === 'cooldownSec')) return 'Aucun';
      return formatTimerSec(v);
    },

    bump(f: FieldDef, dir: number): void {
      const next = clampTimerConfig({ ...this.cfg, [f.key]: this.cfg[f.key] + dir * f.step });
      if (next[f.key] === this.cfg[f.key]) return;
      this.cfg = next;
      hapticLight();
    },

    decLabel(f: FieldDef): string {
      return `Diminuer : ${f.label.toLowerCase()}`;
    },

    incLabel(f: FieldDef): string {
      return `Augmenter : ${f.label.toLowerCase()}`;
    },

    title(): string {
      return timerTitle(this.cfg);
    },

    /** « Durée totale 3 min 50 ». */
    totalLabel(): string {
      return formatTimerSec(timerTotalSec(buildTimerPhases(this.cfg)));
    },

    // ─── Préréglages ───────────────────────────────────────────

    async _savePresets(): Promise<void> {
      try {
        const deps = await getDeps();
        await deps.storage.set(
          STORAGE_KEYS.TIMER_PRESETS,
          JSON.parse(JSON.stringify(this.presets)),
        );
      } catch (err) {
        console.warn('[minuteurs] presets save failed:', err);
      }
    },

    async savePreset(): Promise<void> {
      this.presets = addTimerPreset(this.presets, idGen.newId(), this.cfg);
      await this._savePresets();
      hapticSuccess();
      notify('success', 'Préréglage enregistré.');
    },

    usePreset(p: TimerPreset): void {
      this.cfg = clampTimerConfig(p.config);
      hapticLight();
    },

    async deletePreset(id: string): Promise<void> {
      this.presets = removeTimerPreset(this.presets, id);
      await this._savePresets();
    },

    presetTotal(p: TimerPreset): string {
      return formatTimerSec(timerTotalSec(buildTimerPhases(p.config)));
    },

    // ─── Déroulé ───────────────────────────────────────────────

    start(): void {
      unlockAudio();
      this.cfg = clampTimerConfig(this.cfg);
      this.phases = buildTimerPhases(this.cfg);
      const now = Date.now();
      this.clock = startTimerClock(now);
      this.elapsedMs = 0;
      this._lastMs = 0;
      this.amrapRounds = 0;
      this.completed = false;
      this.recorded = false;
      this.view = 'run';
      hapticMedium();
      this._startTicking();
    },

    _startTicking(): void {
      this._stopTicking();
      this._tick = setInterval(() => this.tick(), 200);
      if (wakeLockSupported() && wakeLockEnabled()) {
        this._lock = createSessionWakeLock({
          request: () => navigator.wakeLock.request('screen'),
          isVisible: () => document.visibilityState === 'visible',
        });
        void this._lock.setSessionActive(true);
      }
      // Retour au premier plan : recalage immédiat (et verrou d'écran redemandé).
      this._onVisible = () => {
        void this._lock?.refresh();
        if (document.visibilityState !== 'visible') return;
        // iOS suspend (« interrupted ») le contexte audio en arrière-plan.
        if (audio && audio.state !== 'running') void audio.resume().catch(() => undefined);
        this.tick();
      };
      document.addEventListener('visibilitychange', this._onVisible);
    },

    _stopTicking(): void {
      if (this._tick) clearInterval(this._tick);
      this._tick = null;
      if (this._lock) void this._lock.setSessionActive(false);
      this._lock = null;
      if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
      this._onVisible = null;
    },

    tick(): void {
      if (!this.clock) return;
      const el = timerElapsedMs(this.clock, Date.now());
      const cue = timerCueToPlay(this.phases, this._lastMs, el);
      this._lastMs = el;
      this.elapsedMs = el;
      if (cue) playCue(cue, this.sound);
      if (timerSnapshot(this.phases, el).done) void this._finish(true);
    },

    snap(): TimerSnapshot {
      return timerSnapshot(this.phases, this.elapsedMs);
    },

    paused(): boolean {
      return !!this.clock && this.clock.pausedAtMs !== null;
    },

    togglePause(): void {
      if (!this.clock) return;
      const now = Date.now();
      this.clock = this.paused()
        ? resumeTimerClock(this.clock, now)
        : pauseTimerClock(this.clock, now);
      this._lastMs = timerElapsedMs(this.clock, now);
      hapticMedium();
    },

    skip(): void {
      if (!this.clock) return;
      const now = Date.now();
      this.clock = skipTimerPhase(this.clock, this.phases, now);
      // Pas de bip pour le saut lui-même : le signal du nouveau départ suffit.
      const el = timerElapsedMs(this.clock, now);
      this._lastMs = el;
      this.elapsedMs = el;
      const s = this.snap();
      if (s.done) void this._finish(true);
      else playCue(s.phase?.kind === 'work' ? { kind: 'work' } : { kind: 'rest' }, this.sound);
    },

    /** Arrêt avant la fin : bilan (le finisher partiel s'ajoute à la demande). */
    stop(): void {
      void this._finish(false);
    },

    toggleSound(): void {
      this.sound = !this.sound;
      if (this.sound) unlockAudio();
    },

    addRound(delta: number): void {
      this.amrapRounds = Math.max(0, this.amrapRounds + delta);
      if (delta > 0) hapticSuccess();
      else hapticLight();
    },

    async _finish(completed: boolean): Promise<void> {
      if (this.view !== 'run' || !this.clock) return;
      this.elapsedMs = timerElapsedMs(this.clock, Date.now());
      this._stopTicking();
      this.clock = null;
      this.completed = completed;
      this.view = 'done';
      if (completed && this.finisher) await this.recordFinisher();
    },

    // ─── Affichage du déroulé ──────────────────────────────────

    clockText(): string {
      const s = this.snap();
      // En pause, le temps est figé : ceil() suffit (pas de clignotement).
      return formatTimerClock(s.phaseRemainingMs);
    },

    phaseLabel(): string {
      return timerPhaseLabel(this.snap().phase, this.cfg.mode);
    },

    roundLabel(): string {
      return timerRoundLabel(this.snap().phase, this.cfg.mode);
    },

    /** 'work' (corail), 'rest' (turquoise : repos, échauffement, retour au calme) ou 'prep'. */
    tone(): 'work' | 'rest' | 'prep' {
      const k = this.snap().phase?.kind;
      return k === 'work' ? 'work' : k === 'prep' ? 'prep' : 'rest';
    },

    toneClass(): string {
      return `k-stage-${this.tone()}`;
    },

    /** Anneau : part restante de la phase (style CSP « --p: N »). */
    ringStyle(): string {
      const p = Math.round((1 - this.snap().phaseProgress) * 1000) / 10;
      return `--p: ${Math.max(0, Math.min(100, p))}`;
    },

    totalLeftLabel(): string {
      return `Reste ${formatTimerClock(this.snap().totalRemainingMs)}`;
    },

    /** « Ensuite : Repos 10 s ». */
    nextLabel(): string {
      const s = this.snap();
      const next = this.phases[s.index + 1];
      if (!next) return 'Dernière ligne droite';
      return `Ensuite : ${timerPhaseLabel(next, this.cfg.mode).toLowerCase()} ${formatTimerSec(next.sec)}`;
    },

    isAmrap(): boolean {
      return this.cfg.mode === 'amrap';
    },

    /** Compte à rebours « Prêt » affiché seul (« 7 »). */
    countdownBig(): boolean {
      return this.tone() === 'prep';
    },

    prepSeconds(): string {
      return String(Math.ceil(this.snap().phaseRemainingMs / 1000));
    },

    // ─── Bilan ─────────────────────────────────────────────────

    workedLabel(): string {
      return formatTimerSec(timerWorkedSec(this.phases, this.elapsedMs));
    },

    doneTitle(): string {
      return this.completed ? 'Bravo, c’est fini !' : 'Minuteur arrêté';
    },

    doneSummary(): string {
      return finisherNote(this.cfg, this.amrapRounds);
    },

    canRecord(): boolean {
      return this.finisher && !this.recorded && timerWorkedSec(this.phases, this.elapsedMs) > 0;
    },

    /** Ajoute le finisher (durée d'effort réelle) à la séance en cours. */
    async recordFinisher(): Promise<void> {
      if (this.recorded) return;
      const sec = timerWorkedSec(this.phases, this.elapsedMs);
      if (sec <= 0) return;
      try {
        const deps = await getDeps();
        const snap = await loadActiveSession(deps.storage);
        if (!snap) {
          this.finisher = false;
          notify('warning', 'Plus de séance en cours : le finisher n’a pas été enregistré.');
          return;
        }
        // Exercice chronométré créé une fois (masqué des listes de choix).
        const custom = await loadCustomExercises(deps.storage);
        if (!custom.some((e) => e.id === FINISHER_EXERCISE.id)) {
          await saveCustomExercises(deps.storage, [
            ...custom,
            { ...FINISHER_EXERCISE, muscles: [...FINISHER_EXERCISE.muscles], custom: true },
          ]);
        }
        const session = withFinisherSet(
          snap.session,
          sec,
          finisherNote(this.cfg, this.amrapRounds),
          new Date().toISOString(),
        );
        const next = { ...snap, session, savedAtMs: Date.now() };
        await writeActiveSession(deps.storage, next);
        announceActiveSession(summarizeActiveSession(next));
        this.recorded = true;
        notify('success', 'Finisher ajouté à ta séance.');
      } catch (err) {
        console.warn('[minuteurs] finisher save failed:', err);
        notify('warning', 'Impossible d’enregistrer le finisher.');
      }
    },

    again(): void {
      this.start();
    },

    backToSetup(): void {
      this.view = 'setup';
      this.phases = [];
      this.elapsedMs = 0;
    },
  };
}
