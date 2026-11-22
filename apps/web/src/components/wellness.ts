/**
 * Forme du jour et hydratation — composants Alpine chargés à la demande.
 *
 *  - `formCheckin`  (accueil) : check-in du matin en 3 touches (sommeil,
 *    énergie, courbatures) → score de forme 0–100 en anneau ; modifiable dans
 *    la journée. Coche « Dormir 7 h ou plus » (sommeil bon ou ≥ 7 h) et « Noter
 *    ton énergie et tes courbatures » dans la routine.
 *  - `waterTracker` (accueil) : jauge d'eau, « + 1 verre » avec vibration,
 *    annuler le dernier, objectif réglable (ou d'après le poids), 7 jours ;
 *    coche « Boire 2 L d'eau » à l'objectif.
 *  - `formHistory`  (Récupération) : courbe des 30 derniers jours.
 *
 * Calculs : packages/core wellness.domain. Données : STORAGE_KEYS.WELLNESS_*
 * (incluses dans la sauvegarde, cf. lib/backup.ts).
 */
import Alpine from 'alpinejs';
import {
  FORM_LEVEL_LABELS,
  FORM_LOW_THRESHOLD,
  SLEEP_LABELS,
  SORENESS_LABELS,
  STORAGE_KEYS,
  addWater,
  averageForm,
  formHistory as buildFormHistory,
  formLevel,
  formScore,
  formatWater,
  glassSize,
  localDay,
  normalizeCheckIn,
  sleepGoalReached,
  sleepQualityFromHours,
  undoWater,
  upsertCheckIn,
  waterGoal,
  waterGoalFromWeight,
  waterHistory,
  waterTotal,
  type CheckIn,
  type CheckInLog,
  type FormLevel,
  type FormPoint,
  type SleepQuality,
  type Soreness,
  type WaterDay,
  type WaterLog,
  type WaterPrefs,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { hapticLight, hapticSuccess } from '../lib/haptics';
import type { ScrubData } from '../lib/chart-scrub';

const SLEEP_TASK = 'sleep-routine';
const JOURNAL_TASK = 'journaling';
const WATER_TASK = 'hydration';

function notify(kind: 'success' | 'info' | 'error', message: string): void {
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind, message } }));
}

/** Coche une tâche de la routine si elle est affichée et pas encore faite. */
async function completeRoutineTask(id: string): Promise<boolean> {
  const store = Alpine.store('vitalite') as
    | {
        tasks?: Array<{ id: string; done: boolean }>;
        complete?: (id: string, byUser?: boolean) => Promise<void>;
      }
    | undefined;
  const task = store?.tasks?.find((t) => t.id === id);
  if (!task || task.done || !store?.complete) return false;
  await store.complete(id, false);
  return true;
}

/** Décoche une tâche cochée automatiquement quand sa condition n'est plus remplie. */
async function undoRoutineTask(id: string): Promise<void> {
  const store = Alpine.store('vitalite') as
    | { tasks?: Array<{ id: string; done: boolean }>; undo?: (id: string) => Promise<void> }
    | undefined;
  const task = store?.tasks?.find((t) => t.id === id);
  if (task?.done && store?.undo) await store.undo(id);
}

/** Couleur de l'anneau et du texte selon le palier. */
const LEVEL_TEXT: Readonly<Record<FormLevel, string>> = {
  good: 'text-kinetic-teal',
  ok: 'text-kinetic-gold',
  low: 'text-kinetic-coral',
};
const LEVEL_ADVICE: Readonly<Record<FormLevel, string>> = {
  good: 'Fonce sur ta séance.',
  ok: 'Séance normale, écoute tes sensations.',
  low: 'Ta séance te proposera de l’alléger.',
};

/** « 7 h 30 » */
export function formatHours(h: number): string {
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  return min === 0 ? `${whole} h` : `${whole} h ${String(min).padStart(2, '0')}`;
}

/** « Sommeil bon (7 h 30) · énergie 4/5 · courbatures légères » */
export function checkInSummary(c: CheckIn): string {
  const sleep =
    `Sommeil ${SLEEP_LABELS[c.sleep].toLowerCase()}` +
    (c.sleepHours !== undefined ? ` (${formatHours(c.sleepHours)})` : '');
  return `${sleep} · énergie ${c.energy}/5 · courbatures ${SORENESS_LABELS[c.soreness].toLowerCase()}`;
}

// ─── Check-in du matin (accueil) ──────────────────────────────────────────────

export function formCheckin() {
  return {
    ready: false,
    date: '',
    current: null as CheckIn | null,
    editing: false,
    showHours: false,
    saving: false,
    /** Une touche est arrivée pendant l'enregistrement : on réenregistre ensuite. */
    _again: false,
    sleep: null as SleepQuality | null,
    energy: 0,
    soreness: null as Soreness | null,
    hours: null as number | null,

    sleepOptions: (['bad', 'ok', 'good'] as const).map((value) => ({
      value,
      label: SLEEP_LABELS[value],
    })),
    energyOptions: [1, 2, 3, 4, 5],
    sorenessOptions: (['none', 'light', 'heavy'] as const).map((value) => ({
      value,
      label: SORENESS_LABELS[value],
    })),

    async init(): Promise<void> {
      this.date = localDay(new Date());
      try {
        const deps = await getDeps();
        const log = await deps.storage.get<CheckInLog>(STORAGE_KEYS.WELLNESS_CHECKINS);
        this.current = normalizeCheckIn(log?.[this.date]);
      } catch (err) {
        console.warn('[forme] lecture impossible :', err);
      }
      this._fillFromCurrent();
      if (!this.current) {
        // Health Connect (Android) : la nuit mesurée pré-remplit les heures.
        const v = Alpine.store('vitalite') as { healthSleep?: number | null } | undefined;
        const min = Number(v?.healthSleep);
        if (Number.isFinite(min) && min > 0) {
          this.hours = Math.round((min / 60) * 4) / 4;
          this.sleep = sleepQualityFromHours(this.hours);
          this.showHours = true;
        }
      }
      this.ready = true;
    },

    _fillFromCurrent(): void {
      const c = this.current;
      this.sleep = c?.sleep ?? null;
      this.energy = c?.energy ?? 0;
      this.soreness = c?.soreness ?? null;
      this.hours = c?.sleepHours ?? null;
      this.showHours = c?.sleepHours !== undefined;
    },

    /** Carte résultat (anneau) ; sinon les questions. */
    get done(): boolean {
      return !!this.current && !this.editing;
    },
    get score(): number {
      return this.current ? formScore(this.current) : 0;
    },
    get level(): FormLevel {
      return formLevel(this.score);
    },
    get levelLabel(): string {
      return FORM_LEVEL_LABELS[this.level];
    },
    get levelCls(): string {
      return LEVEL_TEXT[this.level];
    },
    get ringStyle(): string {
      return `--p: ${this.score}`;
    },
    get summary(): string {
      return this.current ? checkInSummary(this.current) : '';
    },
    get advice(): string {
      return LEVEL_ADVICE[this.level];
    },
    get hoursLabel(): string {
      return this.hours === null ? '—' : formatHours(this.hours);
    },
    get stepsLeft(): string {
      const n = [this.sleep, this.energy || null, this.soreness].filter((v) => v === null).length;
      if (n === 0) return 'Enregistré';
      return n === 3 ? '3 touches, enregistré tout seul' : `Encore ${n} touche${n > 1 ? 's' : ''}`;
    },

    sleepPressed(v: SleepQuality): string {
      return this.sleep === v ? 'true' : 'false';
    },
    energyPressed(n: number): string {
      return this.energy === n ? 'true' : 'false';
    },
    sorenessPressed(v: Soreness): string {
      return this.soreness === v ? 'true' : 'false';
    },

    pickSleep(v: SleepQuality): void {
      this.sleep = v;
      // Qualité choisie à la main : les heures précises (si incohérentes) s'effacent.
      if (this.hours !== null && sleepQualityFromHours(this.hours) !== v) this.hours = null;
      hapticLight();
      void this._maybeSave();
    },
    pickEnergy(n: number): void {
      this.energy = n;
      hapticLight();
      void this._maybeSave();
    },
    pickSoreness(v: Soreness): void {
      this.soreness = v;
      hapticLight();
      void this._maybeSave();
    },
    toggleHours(): void {
      this.showHours = !this.showHours;
      if (this.showHours && this.hours === null) this.hours = 7;
      if (this.showHours) this.sleep = sleepQualityFromHours(this.hours ?? 7);
    },
    bumpHours(delta: number): void {
      const next = Math.max(0, Math.min(14, (this.hours ?? 7) + delta));
      this.hours = Math.round(next * 4) / 4;
      this.sleep = sleepQualityFromHours(this.hours);
      hapticLight();
      void this._maybeSave();
    },

    /**
     * Jour courant recalculé au moment de la saisie (application restée ouverte
     * après minuit). Vrai si la date a changé : le check-in de la veille n'est
     * plus celui qu'on modifie.
     */
    _rollDay(): boolean {
      const today = localDay(new Date());
      if (today === this.date) return false;
      this.date = today;
      this.current = null;
      return true;
    },

    edit(): void {
      this._fillFromCurrent();
      this.editing = true;
    },
    finish(): void {
      this.editing = false;
    },

    async _maybeSave(): Promise<void> {
      if (!this.sleep || !this.energy || !this.soreness) return;
      if (this.saving) {
        this._again = true;
        return;
      }
      // Accueil ouvert avant minuit : la saisie va au jour où elle est faite.
      const rolled = this._rollDay();
      let prev = this.current;
      const c: CheckIn = {
        date: this.date,
        sleep: this.sleep,
        energy: this.energy,
        soreness: this.soreness,
        at: new Date().toISOString(),
        ...(this.showHours && this.hours !== null ? { sleepHours: this.hours } : {}),
      };
      this.saving = true;
      try {
        const deps = await getDeps();
        const log = await deps.storage.get<CheckInLog>(STORAGE_KEYS.WELLNESS_CHECKINS);
        if (rolled) prev = normalizeCheckIn(log?.[c.date]);
        const first = !prev;
        await deps.storage.set(STORAGE_KEYS.WELLNESS_CHECKINS, upsertCheckIn(log, c));
        this.current = c;
        if (first) {
          hapticSuccess();
          this.editing = false;
        }
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_CHECKIN_SAVED, { detail: c }));
        await completeRoutineTask(JOURNAL_TASK);
        if (sleepGoalReached(c)) await completeRoutineTask(SLEEP_TASK);
        else if (prev && sleepGoalReached(prev)) await undoRoutineTask(SLEEP_TASK);
      } catch (err) {
        console.error('[forme] enregistrement impossible :', err);
        notify('error', 'Impossible d’enregistrer ta forme. Réessaie.');
      } finally {
        this.saving = false;
      }
      if (this._again) {
        this._again = false;
        await this._maybeSave();
      }
    },
  };
}

// ─── Eau (accueil) ─────────────────────────────────────────────────────────────

const GLASS_OPTIONS = [150, 200, 250, 330, 500];
const WEEKDAY_INITIALS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

export function waterTracker() {
  return {
    ready: false,
    date: '',
    log: {} as WaterLog,
    prefs: {} as WaterPrefs,
    weightKg: null as number | null,
    showSettings: false,
    glassOptions: GLASS_OPTIONS,

    async init(): Promise<void> {
      this.date = localDay(new Date());
      try {
        const deps = await getDeps();
        const [log, prefs, profile, entries] = await Promise.all([
          deps.storage.get<WaterLog>(STORAGE_KEYS.WELLNESS_WATER),
          deps.storage.get<WaterPrefs>(STORAGE_KEYS.WELLNESS_WATER_PREFS),
          deps.storage.get<{ weightKg?: number }>(STORAGE_KEYS.USER_PROFILE),
          deps.storage.get<Array<{ weight?: number }>>(STORAGE_KEYS.BODYWEIGHT_ENTRIES),
        ]);
        this.log = log && typeof log === 'object' ? log : {};
        this.prefs = prefs && typeof prefs === 'object' ? prefs : {};
        const last = Array.isArray(entries) ? Number(entries.at(-1)?.weight) : NaN;
        const w = Number.isFinite(last) && last > 0 ? last : Number(profile?.weightKg);
        this.weightKg = Number.isFinite(w) && w > 0 ? w : null;
      } catch (err) {
        console.warn('[eau] lecture impossible :', err);
      }
      this.ready = true;
    },

    get goal(): number {
      return waterGoal(this.prefs, this.weightKg);
    },
    get glass(): number {
      return glassSize(this.prefs);
    },
    get total(): number {
      return waterTotal(this.log, this.date);
    },
    get percent(): number {
      return Math.min(100, Math.round((this.total / this.goal) * 100));
    },
    get reached(): boolean {
      return this.total >= this.goal;
    },
    get barStyle(): string {
      return `width: ${this.percent}%`;
    },
    get totalLabel(): string {
      return formatWater(this.total);
    },
    get goalLabel(): string {
      return `/ ${formatWater(this.goal)}`;
    },
    /** « 5 verres sur 8 » */
    get glassesLabel(): string {
      const done = this.log[this.date]?.length ?? 0;
      const target = Math.ceil(this.goal / this.glass);
      return `${done} verre${done > 1 ? 's' : ''} sur ${target}`;
    },
    get addLabel(): string {
      return `+ 1 verre (${formatWater(this.glass)})`;
    },
    get canUndo(): boolean {
      return (this.log[this.date]?.length ?? 0) > 0;
    },
    get history(): Array<WaterDay & { initial: string; style: string; cls: string; aria: string }> {
      return waterHistory(this.log, new Date(), this.goal, 7).map((d) => {
        const [y, m, day] = d.date.split('-').map(Number);
        const wd = new Date(y!, m! - 1, day!).getDay();
        return {
          ...d,
          initial: WEEKDAY_INITIALS[wd]!,
          style: `height: ${Math.max(6, d.percent)}%`,
          cls: d.reached ? 'bg-kinetic-purple' : d.ml > 0 ? 'bg-kinetic-purple/45' : 'bg-white/10',
          aria: `${d.date} : ${formatWater(d.ml)}${d.reached ? ', objectif atteint' : ''}`,
        };
      });
    },

    async _saveLog(next: WaterLog): Promise<void> {
      const deps = await getDeps();
      await deps.storage.set(STORAGE_KEYS.WELLNESS_WATER, next);
      this.log = next;
    },

    async add(): Promise<void> {
      this.date = localDay(new Date());
      const wasReached = this.reached;
      try {
        await this._saveLog(addWater(this.log, this.date, this.glass));
      } catch (err) {
        console.error('[eau] ajout impossible :', err);
        notify('error', 'Impossible d’ajouter le verre.');
        return;
      }
      if (!wasReached && this.reached) {
        hapticSuccess();
        const checked = await completeRoutineTask(WATER_TASK);
        notify(
          'success',
          checked
            ? 'Objectif d’eau atteint : tâche de la routine cochée.'
            : 'Objectif d’eau atteint.',
        );
      } else {
        hapticLight();
      }
    },

    async undo(): Promise<void> {
      this.date = localDay(new Date()); // après minuit : on n'annule pas un verre de la veille
      if (!this.canUndo) return;
      const wasReached = this.reached;
      try {
        await this._saveLog(undoWater(this.log, this.date));
        hapticLight();
        // Le verre annulé repasse sous l'objectif : la tâche cochée par l'eau se décoche.
        if (wasReached && !this.reached) await undoRoutineTask(WATER_TASK);
      } catch (err) {
        console.error('[eau] annulation impossible :', err);
      }
    },

    // ─── Réglages (feuille) ──────────────────────────────────

    openSettings(): void {
      this.showSettings = true;
    },
    closeSettings(): void {
      this.showSettings = false;
    },
    get goalAuto(): boolean {
      return this.prefs.goalMl === undefined || this.prefs.goalMl === null;
    },
    get autoGoalLabel(): string {
      const g = formatWater(waterGoalFromWeight(this.weightKg));
      return this.weightKg ? `Conseillé d’après ton poids : ${g}` : `Conseillé : ${g}`;
    },
    get settingsGoalLabel(): string {
      return formatWater(this.goal);
    },
    glassPressed(ml: number): string {
      return this.glass === ml ? 'true' : 'false';
    },
    glassOptionLabel(ml: number): string {
      return `${ml} ml`;
    },
    async _savePrefs(next: WaterPrefs): Promise<void> {
      this.prefs = next;
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEYS.WELLNESS_WATER_PREFS, next);
      } catch (err) {
        console.error('[eau] réglages non enregistrés :', err);
      }
    },
    setGlass(ml: number): void {
      hapticLight();
      void this._savePrefs({ ...this.prefs, glassMl: ml });
    },
    bumpGoal(delta: number): void {
      const next = Math.max(500, Math.min(6000, this.goal + delta));
      hapticLight();
      void this._savePrefs({ ...this.prefs, goalMl: next });
    },
    useAutoGoal(): void {
      hapticLight();
      void this._savePrefs({ ...this.prefs, goalMl: null });
    },
  };
}

// ─── Historique de forme (Récupération) ───────────────────────────────────────

const CHART_W = 320;
const CHART_H = 112;
const PLOT_T = 10;
const PLOT_B = 96;
const PLOT_L = 6;
const PLOT_R = 290;

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

/** Coordonnées des points d'une courbe 30 jours (null : pas de check-in). */
export function formChartCoords(points: readonly FormPoint[]): Array<[number, number] | null> {
  const n = points.length;
  const step = n > 1 ? (PLOT_R - PLOT_L) / (n - 1) : 0;
  const y = (s: number): number =>
    PLOT_B - (Math.max(0, Math.min(100, s)) / 100) * (PLOT_B - PLOT_T);
  return points.map((p, i) => (p.score === null ? null : [PLOT_L + i * step, y(p.score)]));
}

export function formHistory() {
  return {
    ready: false,
    points: [] as FormPoint[],

    async init(): Promise<void> {
      await this.reload();
    },

    async reload(): Promise<void> {
      try {
        const deps = await getDeps();
        const log = await deps.storage.get<CheckInLog>(STORAGE_KEYS.WELLNESS_CHECKINS);
        this.points = buildFormHistory(log, new Date(), 30);
      } catch (err) {
        console.warn('[forme] historique indisponible :', err);
        this.points = [];
      }
      this.ready = true;
    },

    get count(): number {
      return this.points.filter((p) => p.score !== null).length;
    },
    get hasData(): boolean {
      return this.count > 0;
    },
    get average(): string {
      const a = averageForm(this.points);
      return a === null ? '—' : String(a);
    },
    get today(): string {
      const s = this.points.at(-1)?.score;
      return s === null || s === undefined ? '—' : String(s);
    },
    get countLabel(): string {
      const n = this.count;
      return `${n} check-in${n > 1 ? 's' : ''} sur 30 jours`;
    },

    chartScrub(): ScrubData | null {
      const coords = formChartCoords(this.points);
      const pts = this.points.flatMap((p, i) => {
        const c = coords[i];
        return c && p.score !== null
          ? [
              {
                x: c[0],
                y: c[1],
                label: dayLabel(p.date),
                value: `${p.score} · ${FORM_LEVEL_LABELS[formLevel(p.score)]}`,
              },
            ]
          : [];
      });
      return pts.length
        ? { w: CHART_W, h: CHART_H, top: PLOT_T - 4, bottom: PLOT_B, points: pts }
        : null;
    },

    chartSvg(): string {
      const coords = formChartCoords(this.points);
      // Traits entre jours consécutifs renseignés (un jour sans check-in coupe la courbe).
      let d = '';
      coords.forEach((c, i) => {
        if (!c) return;
        d += `${coords[i - 1] ? 'L' : 'M'}${c[0].toFixed(1)} ${c[1].toFixed(1)}`;
      });
      const yLow = PLOT_B - (FORM_LOW_THRESHOLD / 100) * (PLOT_B - PLOT_T);
      const dots = coords
        .map((c, i) => {
          if (!c) return '';
          const s = this.points[i]!.score!;
          const cls = LEVEL_TEXT[formLevel(s)];
          return `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="2.6" class="${cls}" fill="currentColor"/>`;
        })
        .join('');
      const grid = [100, 50, 0]
        .map((v) => {
          const y = (PLOT_B - (v / 100) * (PLOT_B - PLOT_T)).toFixed(1);
          return (
            `<line x1="${PLOT_L}" y1="${y}" x2="${PLOT_R}" y2="${y}" class="text-gray-500" stroke="currentColor" stroke-opacity="0.18" stroke-dasharray="2 5"/>` +
            `<text x="${CHART_W - 2}" y="${(+y + 4).toFixed(1)}" text-anchor="end" class="text-gray-500" fill="currentColor" font-size="11">${v}</text>`
          );
        })
        .join('');
      return (
        `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="w-full h-auto" role="img" aria-label="Score de forme sur 30 jours, moyenne ${this.average}">` +
        grid +
        `<line x1="${PLOT_L}" y1="${yLow.toFixed(1)}" x2="${PLOT_R}" y2="${yLow.toFixed(1)}" class="text-kinetic-coral" stroke="currentColor" stroke-opacity="0.45" stroke-dasharray="4 4"/>` +
        `<path d="${d}" fill="none" class="text-kinetic-teal" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.85"/>` +
        dots +
        '</svg>'
      );
    },
  };
}
