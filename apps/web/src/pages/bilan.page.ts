/**
 * Page « Bilan » (/bilan?periode=2026-11 ou 2026) : le mois ou l'année en
 * grandes cartes successives, façon « Wrapped » — séances, heures, tonnage
 * parlant, records, favori, séries de jours, jour préféré, muscle n° 1 (mini
 * carte), exercice clé (courbe à parcourir), régularité, forme, objectifs.
 * Partage en image 1080 × 1920 (lib/recap-share-image.ts, chargé au partage).
 *
 * Calculs : @kinetic/core recap.domain. Ici : lecture des données, textes
 * pour le gabarit (build CSP : une expression par attribut) et apparition des
 * cartes au défilement (IntersectionObserver ; rien sous mouvement réduit).
 */
import {
  STORAGE_KEYS,
  buildRecap,
  currentRecapPeriod,
  formatRecapHours,
  goalLabel,
  isFutureRecap,
  normalizeChallengeStore,
  normalizeGoals,
  parseRecapPeriod,
  recapLabel,
  recapMonthName,
  recapTonnageParts,
  recapTrendLabel,
  shiftRecapPeriod,
  type RecapMilestone,
  type RecapPeriod,
  type RecapSummary,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { loadExercises, loadSessions } from '../lib/training/storage';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import type { ScrubData } from '../lib/chart-scrub';
import { hapticLight } from '../lib/haptics';
import { muscleMapSvg } from '../components/muscle-map-svg';
import '../components/visual-views.css';
import '../styles/recap.css';
import { notify } from '../lib/notify';

const fmt = (n: number, digits = 0): string =>
  n.toLocaleString('fr-FR', { maximumFractionDigits: digits }).replace(/[\u202f\u00a0]/g, ' ');
const plural = (n: number, one: string, many: string): string => (n > 1 ? many : one);

const MONTHS_SHORT = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
];
/** « 12 nov. » */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[(m ?? 1) - 1]}`;
}

export interface RecapChartGeometry {
  W: number;
  H: number;
  top: number;
  bottom: number;
  coords: Array<[number, number]>;
}

/** Géométrie de la courbe d'e1RM (viewBox 320 × 140), bornes avec un peu d'air. */
export function recapChartGeometry(values: readonly number[]): RecapChartGeometry {
  const W = 320;
  const H = 140;
  const top = 18;
  const bottom = 112;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.max(1, hi * 0.05);
  const n = values.length;
  const coords = values.map((v, i): [number, number] => [
    n > 1 ? 12 + (i * (W - 24)) / (n - 1) : W / 2,
    bottom - ((v - lo) / span) * (bottom - top),
  ]);
  return { W, H, top, bottom, coords };
}

/** Cartes du bilan (data-slide) : apparition au défilement. */
function observeSlides(root: HTMLElement): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') {
    root.querySelectorAll('.k-recap-slide').forEach((el) => el.classList.add('is-in'));
    return null;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    },
    { threshold: 0.25 },
  );
  root.querySelectorAll('.k-recap-slide:not(.is-in)').forEach((el) => io.observe(el));
  return io;
}

export function bilan() {
  let io: IntersectionObserver | null = null;
  /** Racine de la page (dans un gestionnaire, `$el` est l'élément touché). */
  let root: HTMLElement | null = null;
  return {
    loading: true,
    period: { kind: 'month', key: '' } as RecapPeriod,
    recap: null as RecapSummary | null,
    sessions: [] as WorkoutSession[],
    exercises: [] as Exercise[],
    milestones: [] as RecapMilestone[],
    checkins: {} as Record<string, never>,
    weeklyTarget: 0,
    sharing: false,
    $el: null as unknown as HTMLElement,
    $nextTick: null as unknown as (cb: () => void) => void,

    async init(): Promise<void> {
      root = this.$el;
      const raw = new URLSearchParams(window.location?.search ?? '').get('periode');
      this.period = parseRecapPeriod(raw, new Date());
      try {
        const deps = await getDeps();
        const [sessions, exercises, checkins, goals, challenges, weekly] = await Promise.all([
          loadSessions(deps.storage),
          loadExercises(deps.storage),
          deps.storage.get<Record<string, never>>(STORAGE_KEYS.WELLNESS_CHECKINS),
          deps.storage.get(STORAGE_KEYS.STRENGTH_GOALS),
          deps.storage.get(STORAGE_KEYS.CHALLENGES),
          deps.storage.get<{ targetSessions?: number }>(STORAGE_KEYS.GOALS),
        ]);
        this.sessions = sessions;
        this.exercises = exercises;
        this.checkins = checkins && typeof checkins === 'object' ? checkins : {};
        this.weeklyTarget = Number(weekly?.targetSessions) || 0;
        const goalsDone = normalizeGoals(goals)
          .filter((g) => g.achievedAt)
          .map((g) => ({ title: goalLabel(g, this.name(g.exerciseId)), at: g.achievedAt! }));
        const challengesDone = normalizeChallengeStore(challenges).completed.map((c) => ({
          title: `Défi : ${c.title}`,
          at: c.completedAt,
        }));
        this.milestones = [...goalsDone, ...challengesDone];
      } catch (err) {
        console.error('[bilan] lecture impossible :', err);
      }
      this._compute();
      this.loading = false;
    },

    destroy(): void {
      io?.disconnect();
      io = null;
    },

    _compute(): void {
      const muscles = new Map(this.exercises.map((e) => [e.id, e.muscles]));
      this.recap = buildRecap(
        {
          sessions: this.sessions,
          musclesOf: (id) => muscles.get(id) ?? [],
          checkins: this.checkins,
          milestones: this.milestones,
          ...(this.weeklyTarget > 0 ? { weeklyTarget: this.weeklyTarget } : {}),
        },
        this.period,
        new Date(),
      );
      // Nouvelles cartes : rejouer l'apparition (après le rendu d'Alpine).
      this.$nextTick?.(() => {
        io?.disconnect();
        if (!root) return;
        root.querySelectorAll('.k-recap-slide').forEach((el) => el.classList.remove('is-in'));
        io = observeSlides(root);
      });
    },

    _go(p: RecapPeriod): void {
      if (isFutureRecap(p, new Date())) return;
      this.period = p;
      try {
        window.history.replaceState(window.history.state, '', `/bilan?periode=${p.key}`);
      } catch {
        /* historique indisponible : la page reste juste */
      }
      hapticLight();
      this._compute();
      window.scrollTo({ top: 0, behavior: 'auto' });
    },

    prev(): void {
      this._go(shiftRecapPeriod(this.period, -1));
    },
    next(): void {
      this._go(shiftRecapPeriod(this.period, 1));
    },
    showMonth(): void {
      if (this.period.kind === 'month') return;
      const now = new Date();
      const cur = currentRecapPeriod('month', now);
      // Même année : dernier mois terminé de cette année (ou décembre d'une année passée).
      const key = this.period.key === String(now.getFullYear()) ? cur.key : `${this.period.key}-12`;
      this._go(key === cur.key ? shiftRecapPeriod(cur, -1) : { kind: 'month', key });
    },
    showYear(): void {
      if (this.period.kind === 'year') return;
      this._go({ kind: 'year', key: this.period.key.slice(0, 4) });
    },

    // ─── Lecture pour le gabarit ─────────────────────────────

    get isMonth(): boolean {
      return this.period.kind === 'month';
    },
    get isYear(): boolean {
      return this.period.kind === 'year';
    },
    get canNext(): boolean {
      return !isFutureRecap(shiftRecapPeriod(this.period, 1), new Date());
    },
    get periodLabel(): string {
      return recapLabel(this.period);
    },
    get prevLabel(): string {
      return `Bilan précédent : ${recapLabel(shiftRecapPeriod(this.period, -1))}`;
    },
    get nextLabel(): string {
      return `Bilan suivant : ${recapLabel(shiftRecapPeriod(this.period, 1))}`;
    },
    get hasData(): boolean {
      return !!this.recap && !this.recap.empty;
    },
    get isEmpty(): boolean {
      return !this.loading && !!this.recap && this.recap.empty;
    },
    get emptyText(): string {
      return this.isMonth
        ? `Aucune séance en ${recapMonthName(this.period)} ${this.period.key.slice(0, 4)}.`
        : `Aucune séance en ${this.period.key}.`;
    },
    get introKicker(): string {
      if (this.recap?.ongoing) return this.isMonth ? 'Ton mois en cours' : 'Ton année en cours';
      return this.isMonth ? 'Ton mois' : 'Ton année';
    },
    get introLine(): string {
      const r = this.recap;
      if (!r) return '';
      return `${r.trainingDays} ${plural(r.trainingDays, "jour d'entraînement", "jours d'entraînement")}, ${fmt(r.sets)} ${plural(r.sets, 'série', 'séries')}.`;
    },

    // Séances
    get sessionsText(): string {
      return fmt(this.recap?.sessions ?? 0);
    },
    get sessionsUnit(): string {
      return plural(this.recap?.sessions ?? 0, 'séance', 'séances');
    },
    get sessionsTrend(): string {
      return this.recap ? recapTrendLabel(this.recap.vsPrevious.sessionsPct, this.period) : '';
    },
    get sessionsTrendClass(): string {
      const p = this.recap?.vsPrevious.sessionsPct ?? 0;
      return p > 0 ? 'k-pill text-kinetic-teal' : 'k-pill text-gray-400';
    },

    // Heures
    get hoursText(): string {
      return fmt((this.recap?.minutes ?? 0) / 60, 1);
    },
    get hoursDetail(): string {
      const r = this.recap;
      if (!r || !r.minutes) return 'Durées non enregistrées sur cette période.';
      const avg = Math.round(r.minutes / Math.max(1, r.sessions));
      return `${formatRecapHours(r.minutes)} au total, ${avg} min par séance en moyenne.`;
    },

    // Tonnage
    get tonnageValue(): string {
      return recapTonnageParts(this.recap?.tonnageKg ?? 0).value;
    },
    get tonnageUnit(): string {
      return recapTonnageParts(this.recap?.tonnageKg ?? 0).unit;
    },
    get tonnageEmoji(): string {
      return this.recap?.tonnageCompare?.emoji ?? '🏋️';
    },
    get tonnageCompareText(): string {
      const c = this.recap?.tonnageCompare;
      return c ? `Soit ${c.text}.` : 'Charges soulevées sur toutes tes séries de travail.';
    },
    get tonnageTrend(): string {
      return this.recap ? recapTrendLabel(this.recap.vsPrevious.tonnagePct, this.period) : '';
    },

    // Records
    get recordCount(): number {
      return this.recap?.records.length ?? 0;
    },
    get recordTitle(): string {
      const n = this.recordCount;
      return n ? `${plural(n, 'record battu', 'records battus')}` : 'Pas de record cette fois';
    },
    get recordRows(): Array<{ id: string; name: string; perf: string; gain: string }> {
      return (this.recap?.records ?? []).slice(0, 5).map((r) => ({
        id: r.exerciseId,
        name: this.name(r.exerciseId),
        perf: `${fmt(r.weightKg, 2)} kg × ${r.reps}`,
        gain: `+${fmt(r.gainKg, 1)} kg`,
      }));
    },
    get recordMore(): string {
      const extra = this.recordCount - 5;
      return extra > 0 ? `et ${extra} ${plural(extra, 'autre', 'autres')}` : '';
    },

    // Favori
    get favoriteName(): string {
      const f = this.recap?.favorite;
      return f ? this.name(f.exerciseId) : '';
    },
    get favoriteDetail(): string {
      const f = this.recap?.favorite;
      if (!f) return '';
      return `${f.sessions} ${plural(f.sessions, 'séance', 'séances')}, ${fmt(f.sets)} ${plural(f.sets, 'série', 'séries')} de travail.`;
    },

    // Jours
    get streakText(): string {
      return String(this.recap?.longestDayStreak ?? 0);
    },
    get streakUnit(): string {
      return plural(this.recap?.longestDayStreak ?? 0, 'jour', 'jours');
    },
    get weekdayText(): string {
      return this.recap?.weekday?.label ?? '—';
    },
    get weekdayDetail(): string {
      const w = this.recap?.weekday;
      return w ? `${w.count} ${plural(w.count, 'séance', 'séances')} ce jour-là` : '';
    },

    // Muscles
    get muscleLabel(): string {
      return this.recap?.muscles.top?.label ?? '';
    },
    get muscleDetail(): string {
      const t = this.recap?.muscles.top;
      return t ? `${fmt(t.sets, 1)} séries effectives (secondaires comptées ½).` : '';
    },
    muscleSvg(): string {
      const r = this.recap;
      if (!r?.muscles.top) return '';
      return muscleMapSvg({
        levels: r.muscles.levels,
        selected: r.muscles.top.key,
        compact: true,
        label: `Muscles travaillés : ${r.muscles.top.label} en tête`,
      });
    },

    // Exercice clé
    get keyLiftName(): string {
      const k = this.recap?.keyLift;
      return k ? this.name(k.exerciseId) : '';
    },
    get keyLiftGain(): string {
      const k = this.recap?.keyLift;
      if (!k) return '';
      if (k.gainKg <= 0) return 'Stable';
      return `+${fmt(k.gainKg, 1)} kg`;
    },
    get keyLiftDetail(): string {
      const k = this.recap?.keyLift;
      if (!k) return '';
      const pct = k.gainPct > 0 ? ` (+${k.gainPct} %)` : '';
      return `1RM estimée : ${fmt(k.startE1rm, 1)} → ${fmt(k.endE1rm, 1)} kg${pct}`;
    },
    chartScrub(): ScrubData | null {
      const pts = this.recap?.keyLift?.points;
      if (!pts || pts.length < 2) return null;
      const g = recapChartGeometry(pts.map((p) => p.e1rm));
      return {
        w: g.W,
        h: g.H,
        top: g.top - 6,
        bottom: g.bottom,
        points: pts.map((p, i) => ({
          x: g.coords[i]![0],
          y: g.coords[i]![1],
          label: shortDay(p.day),
          value: `${fmt(p.e1rm, 1)} kg`,
        })),
      };
    },
    chartSvg(): string {
      const pts = this.recap?.keyLift?.points;
      if (!pts || pts.length < 2) return '';
      const { W, H, bottom, coords } = recapChartGeometry(pts.map((p) => p.e1rm));
      const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`);
      const area = `${line.join(' ')} L${coords.at(-1)![0].toFixed(1)} ${bottom} L${coords[0]![0].toFixed(1)} ${bottom} Z`;
      const [lx, ly] = coords.at(-1)!;
      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de 1RM estimée, ${shortDay(pts[0]!.day)} à ${shortDay(pts.at(-1)!.day)}">
        <defs><linearGradient id="rc-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="text-kinetic-neon/100" stop-color="currentColor" stop-opacity="0.32"/>
          <stop offset="1" class="text-kinetic-neon/100" stop-color="currentColor" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#rc-area)"/>
        <path d="${line.join(' ')}" fill="none" class="text-kinetic-neon/100" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="5" class="text-kinetic-neon/100" fill="currentColor"/>
        <text x="12" y="${H - 6}" class="text-gray-500" fill="currentColor" font-size="11.5">${shortDay(pts[0]!.day)}</text>
        <text x="${W - 12}" y="${H - 6}" text-anchor="end" class="text-gray-500" fill="currentColor" font-size="11.5">${shortDay(pts.at(-1)!.day)}</text>
      </svg>`;
    },

    // Régularité
    get regularityText(): string {
      return String(this.recap?.regularityPct ?? 0);
    },
    get regularityStyle(): string {
      return `--p: ${this.recap?.regularityPct ?? 0}`;
    },
    get regularityDetail(): string {
      const r = this.recap;
      if (!r) return '';
      return `${r.activeWeeks} ${plural(r.activeWeeks, 'semaine active', 'semaines actives')} sur ${r.totalWeeks}.`;
    },
    get weeklyGoalsText(): string {
      const n = this.recap?.weeklyGoalsHit ?? 0;
      if (!this.weeklyTarget || !n) return '';
      return `Objectif de la semaine atteint ${n} fois.`;
    },

    // Forme
    get hasForm(): boolean {
      return !!this.recap?.form;
    },
    get formText(): string {
      return String(this.recap?.form?.avg ?? 0);
    },
    get formDetail(): string {
      const f = this.recap?.form;
      if (!f) return '';
      const level = f.level === 'good' ? 'en forme' : f.level === 'ok' ? 'correcte' : 'basse';
      return `Forme moyenne ${level}, sur ${f.count} ${plural(f.count, 'check-in', 'check-ins')} du matin.`;
    },

    // Objectifs
    get hasMilestones(): boolean {
      return (this.recap?.milestones.length ?? 0) > 0;
    },
    get milestoneRows(): Array<{ key: string; title: string; day: string }> {
      return (this.recap?.milestones ?? []).slice(0, 6).map((m, i) => ({
        key: `${i}-${m.at}`,
        title: m.title,
        day: shortDay(/^\d{4}-\d{2}-\d{2}/.exec(m.at)?.[0] ?? ''),
      }));
    },
    get milestoneCount(): string {
      return String(this.recap?.milestones.length ?? 0);
    },

    name(id: string): string {
      return this.exercises.find((e) => e.id === id)?.name ?? id;
    },

    /** Image 1080 × 1920 (module chargé au premier partage). */
    async share(): Promise<void> {
      if (this.sharing || !this.recap || this.recap.empty) return;
      this.sharing = true;
      try {
        const { shareRecapImage } = await import('../lib/recap-share-image');
        const outcome = await shareRecapImage(this.recap, (id) => this.name(id));
        if (outcome === 'downloaded') {
          notify('success', 'Image enregistrée ✓');
        }
      } catch (err) {
        console.error('[bilan] partage impossible :', err);
        notify('error', "Impossible de créer l'image.");
      } finally {
        this.sharing = false;
      }
    },
  };
}
