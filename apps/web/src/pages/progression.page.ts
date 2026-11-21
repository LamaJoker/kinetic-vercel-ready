import { loc } from '../lib/num';
import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../deps';
import {
  detectPlateau,
  dismissPlateau,
  isPlateauDismissed,
  suggestSubstitutions,
  type PlateauDismissals,
  type PlateauReport,
  type PlateauSuggestion,
  weeklyVolume,
  perExerciseStats,
  muscleDistribution,
  detectPRs,
  consistencyScore,
  buildWeeklyReview,
  type AnalyticsSet,
  type VolumeBucket,
  type ExerciseStats,
  type MuscleShare,
  type PersonalRecord,
  type WeeklyReview,
  workSetsOf,
  comparePeriods,
  presetRanges,
  normalizeRange,
  formatRange,
  type ComparePreset,
  type DayRange,
  type MetricDelta,
  type PeriodComparison,
  type RowDelta,
} from '@kinetic/core';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { loadExercises, loadSessions } from '../lib/training/storage';
import { estimateE1rmKg } from '../lib/training/rpe';
import { loadMuscleMap, loadStrengthGoals } from '../lib/lazy-component';
import type { ScrubData } from '../lib/chart-scrub';

type Tab = 'force' | 'volume' | 'muscles' | 'records' | 'heatmap' | 'compare';

/** Géométrie de la courbe e1RM (viewBox 320 × 172), partagée par le tracé et le parcours au doigt. */
export function forceChartGeometry(pts: ReadonlyArray<{ x: number; y: number }>) {
  const W = 320,
    H = 172,
    padL = 4,
    padR = 38,
    padT = 10,
    padB = 22;
  const minX = pts[0]?.x ?? 0,
    maxX = pts.at(-1)?.x ?? 0;
  const ys = pts.map((p) => p.y);
  const rawMin = Math.min(...ys),
    rawMax = Math.max(...ys);
  // Graduations « rondes » : pas de 1, 2, 2,5 ou 5 × 10^n, 3 intervalles.
  const span = Math.max(1, rawMax - rawMin);
  const rough = span / 3;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const minY = Math.floor(rawMin / step) * step;
  const maxY = Math.max(minY + step, Math.ceil(rawMax / step) * step);
  const dx = Math.max(1, maxX - minX),
    dy = maxY - minY;
  const plotW = W - padL - padR,
    plotH = H - padT - padB;
  const sx = (x: number) => padL + ((x - minX) / dx) * plotW;
  const sy = (y: number) => padT + plotH - ((y - minY) / dy) * plotH;
  return { W, H, padL, padR, padT, padB, plotH, rawMax, step, minY, maxY, sx, sy, ys };
}

export function progression() {
  /** Plateaux calculés, par exercice, pour un historique donné (hors état réactif). */
  const plateauCache = {
    sessions: null as unknown,
    map: new Map<string, PlateauReport | null>(),
  };
  return {
    loading: false,
    activeTab: 'force' as Tab,
    sessions: [] as WorkoutSession[],
    exercises: [] as Exercise[],
    selectedExerciseId: '',
    /** Carte des muscles chargée (import() au premier affichage de l'onglet). */
    muscleMapReady: false,
    /** « Mes objectifs » (composant strengthGoals, chargé à la demande). */
    goalsReady: false,
    /** Alertes de plateau masquées (exercice → fin du masquage). */
    plateauDismissed: {} as PlateauDismissals,
    // M1 FIX: cache pour éviter de recalculer O(sessions×sets) à chaque getter Alpine
    _cachedSets: null as AnalyticsSet[] | null,
    _sessionSavedHandler: null as ((e: Event) => void) | null,

    async init(): Promise<void> {
      this.loading = true;
      loadStrengthGoals().then(
        () => {
          this.goalsReady = true;
        },
        (err: unknown) => console.warn('[progression] objectifs indisponibles :', err),
      );
      this._cachedSets = null; // invalider le cache au rechargement
      // Lien direct vers un onglet (« /progression?tab=muscles » depuis l'accueil).
      const tab = new URLSearchParams(window.location?.search ?? '').get('tab');
      if (
        tab === 'force' ||
        tab === 'volume' ||
        tab === 'muscles' ||
        tab === 'records' ||
        tab === 'heatmap' ||
        tab === 'compare'
      ) {
        this.setTab(tab);
      }
      try {
        const deps = await getDeps();
        this.exercises = await loadExercises(deps.storage);
        this.sessions = await loadSessions(deps.storage);
        await this._loadPlateauDismissed();
        // Le premier rendu (avant chargement) a mis en cache une liste vide :
        // sans cette invalidation, bilan hebdo, régularité et courbes restaient à 0.
        this._cachedSets = null;

        const stats = this._stats();
        if (stats.length > 0) this.selectedExerciseId = stats[0]!.exerciseId;
      } catch (err) {
        console.error('[progression] init failed:', err);
      } finally {
        this.loading = false;
      }

      // Invalider le cache et ajouter la session en delta quand une séance est sauvegardée
      this._sessionSavedHandler = (e: Event) => {
        const session = (e as CustomEvent<{ session?: WorkoutSession }>).detail?.session;
        if (session) {
          const idx = this.sessions.findIndex((s) => s.id === session.id);
          this.sessions =
            idx >= 0
              ? this.sessions.map((s, i) => (i === idx ? session : s))
              : [...this.sessions, session];
        }
        this._cachedSets = null; // forcer recalcul au prochain accès getter
      };
      window.addEventListener(STORAGE_KEYS.EVENT_SESSION_SAVED, this._sessionSavedHandler);
    },

    destroy(): void {
      if (this._sessionSavedHandler) {
        window.removeEventListener(STORAGE_KEYS.EVENT_SESSION_SAVED, this._sessionSavedHandler);
        this._sessionSavedHandler = null;
      }
    },

    setTab(t: Tab): void {
      this.activeTab = t;
      if (t === 'compare') this._loadBodyweight();
      if (t === 'muscles' && !this.muscleMapReady) {
        loadMuscleMap().then(
          () => {
            this.muscleMapReady = true;
          },
          (err: unknown) => console.warn('[progression] carte des muscles indisponible :', err),
        );
      }
    },

    // ─── Projection : sessions → AnalyticsSet[] ──────────────

    /** Nombre de séances sur les N dernières semaines. */
    sessionsInLastWeeks(weeks: number): number {
      const since = Date.now() - weeks * 7 * 86_400_000;
      return this.sessions.filter((s) => Date.parse(s.startedAt) >= since).length;
    },

    _analyticsSets(): AnalyticsSet[] {
      // M1 FIX: résultat mémoïzé — recalculé uniquement si le cache est null
      // (invalidé dans init() à chaque rechargement des sessions)
      if (this._cachedSets !== null) return this._cachedSets;
      const muscleByEx = new Map<string, readonly string[]>();
      for (const ex of this.exercises) muscleByEx.set(ex.id, ex.muscles ?? []);
      this._cachedSets = this.sessions.flatMap((sess) =>
        sess.entries.flatMap((e) =>
          workSetsOf(e.sets).map((s) => ({
            sessionId: sess.id,
            exerciseId: e.exerciseId,
            muscles: muscleByEx.get(e.exerciseId) ?? [],
            reps: s.reps,
            weightKg: s.weightKg,
            rpe: s.rpe,
            performedAt: s.performedAt,
          })),
        ),
      );
      return this._cachedSets;
    },

    _stats(): ExerciseStats[] {
      return perExerciseStats(this._analyticsSets());
    },

    // ─── Aides UI ─────────────────────────────────────────────

    exerciseName(id: string): string {
      return this.exercises.find((e) => e.id === id)?.name ?? id;
    },

    formatDate(iso: string): string {
      try {
        return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
      } catch {
        return iso;
      }
    },

    formatWeek(iso: string): string {
      // "2026-W17" → "S17"
      const m = iso.match(/-W(\d+)/);
      return m ? `S${m[1]}` : iso;
    },

    formatNumber(n: number, digits = 0): string {
      return n.toLocaleString('fr-FR', { maximumFractionDigits: digits });
    },

    /** Tonnage compact : en tonnes à partir de 100 000 kg (« 190,9 »), sinon en kg. */
    formatTonnage(kg: number): string {
      return kg >= 100000 ? this.formatNumber(kg / 1000, 1) : this.formatNumber(kg);
    },

    /** Pourcentage signé à la française : vrai signe moins, espace fine insécable avant « % ». */
    formatPct(pct: number): string {
      return (pct > 0 ? '+' : pct < 0 ? '\u2212' : '') + Math.abs(pct) + '\u202F%';
    },

    // ─── Stats globales (header) ─────────────────────────────

    get totalSessions(): number {
      return this.sessions.length;
    },

    get totalSets(): number {
      return this.sessions.reduce(
        (acc, s) => acc + s.entries.reduce((a, e) => a + workSetsOf(e.sets).length, 0),
        0,
      );
    },

    get totalTonnage(): number {
      let t = 0;
      for (const s of this.sessions)
        for (const e of s.entries)
          for (const set of workSetsOf(e.sets)) t += set.reps * set.weightKg;
      return Math.round(t);
    },

    get consistency(): number {
      return consistencyScore(this._analyticsSets(), 8);
    },

    // ─── Bilan de la semaine ─────────────────────────────────

    get weeklyReview(): WeeklyReview {
      return buildWeeklyReview(this._analyticsSets());
    },

    /** Libellé + emoji de tendance pour la carte bilan hebdo. */
    weeklyTrendLabel(): string {
      const r = this.weeklyReview;
      switch (r.trend) {
        case 'up':
        case 'down':
          return r.tonnageDeltaPct === null
            ? 'En avance vs sem. passée'
            : `${this.formatPct(r.tonnageDeltaPct)} vs même période`;
        case 'first':
          return 'Première semaine de données';
        default:
          return 'Stable vs même période';
      }
    },

    // ─── Onglet FORCE : courbe e1RM par exercice ─────────────

    get exerciseStats(): ExerciseStats[] {
      return this._stats();
    },

    forcePoints(): { x: number; y: number; label: string }[] {
      if (!this.selectedExerciseId) return [];
      const points: { x: number; y: number; label: string }[] = [];
      for (const session of this.sessions) {
        const entry = session.entries.find((e) => e.exerciseId === this.selectedExerciseId);
        if (!entry || entry.sets.length === 0) continue;
        let best = 0;
        for (const s of workSetsOf(entry.sets)) {
          const e = estimateE1rmKg(s.weightKg, s.reps);
          if (e > best) best = e;
        }
        if (best > 0)
          points.push({
            x: Date.parse(session.startedAt),
            y: best,
            label: this.formatDate(session.startedAt),
          });
      }
      return points.sort((a, b) => a.x - b.x);
    },

    /** Parcours au doigt de la courbe e1RM (directive x-scrub) : un point par séance. */
    forceScrub(): ScrubData | null {
      const pts = this.forcePoints();
      if (pts.length < 2) return null;
      const g = forceChartGeometry(pts);
      return {
        w: g.W,
        h: g.H,
        top: g.padT - 4,
        bottom: g.padT + g.plotH,
        points: pts.map((p) => ({
          x: g.sx(p.x),
          y: g.sy(p.y),
          label: p.label,
          value: `${this.formatNumber(p.y, 1)} kg`,
        })),
      };
    },

    /**
     * Courbe e1RM (style Santé iOS) : trait lissé bleu, aire en fondu, grille
     * horizontale discrète, repère sur la dernière valeur et sur le record.
     * Les gris (grille, légendes) suivent `currentColor` pour le mode clair.
     */
    forceSvg(): string {
      const pts = this.forcePoints();
      if (pts.length < 2) return '';
      // Couleurs du thème : l'accent suit --kinetic-neon (thèmes débloqués,
      // mode clair) via la classe text-kinetic-neon + currentColor, car x-svg
      // retire les attributs style ; le record reste ambre (--k-warning, via
      // la classe text-kinetic-gold posée sur ses propres tracés).
      const LINE = 'currentColor';
      const BEST_CLASS = 'text-kinetic-gold';
      const { W, H, padL, padR, padT, plotH, rawMax, step, minY, maxY, sx, sy, ys } =
        forceChartGeometry(pts);
      const f = (n: number) => n.toFixed(1);

      // Grille + graduations à droite
      let grid = '';
      for (let v = minY; v <= maxY + step / 2; v += step) {
        const y = f(sy(v));
        grid += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity="0.18" stroke-width="1" vector-effect="non-scaling-stroke"${v > minY ? ' stroke-dasharray="2 3"' : ''}/>`;
        grid += `<text x="${W - padR + 6}" y="${y}" fill="currentColor" font-size="11" dominant-baseline="middle" style="font-variant-numeric:tabular-nums">${this.formatNumber(v, 1)}</text>`;
      }

      // Trait lissé : courbe de Bézier à tangentes horizontales (pas de dépassement)
      const xy = pts.map((p) => [sx(p.x), sy(p.y)] as const);
      let line = `M ${f(xy[0]![0])} ${f(xy[0]![1])}`;
      for (let i = 1; i < xy.length; i++) {
        const [x0, y0] = xy[i - 1]!;
        const [x1, y1] = xy[i]!;
        const mx = (x0 + x1) / 2;
        line += ` C ${f(mx)} ${f(y0)} ${f(mx)} ${f(y1)} ${f(x1)} ${f(y1)}`;
      }
      const base = f(padT + plotH);
      const area = `${line} L ${f(xy.at(-1)![0])} ${base} L ${f(xy[0]![0])} ${base} Z`;

      // Points : seulement quand la série est courte, sinon le trait suffit
      const dots =
        pts.length <= 12
          ? pts
              .map(
                (p, i) =>
                  `<circle cx="${f(xy[i]![0])}" cy="${f(xy[i]![1])}" r="2.5" fill="${LINE}"><title>${p.label} : ${loc(p.y.toFixed(1))} kg</title></circle>`,
              )
              .join('')
          : '';

      // Record (jaune) et dernière valeur (halo bleu)
      const bestIdx = ys.lastIndexOf(rawMax);
      const lastIdx = pts.length - 1;
      const [bx, by] = xy[bestIdx]!;
      const [lx, ly] = xy[lastIdx]!;
      const best =
        bestIdx !== lastIdx
          ? `<circle cx="${f(bx)}" cy="${f(by)}" r="4.5" class="${BEST_CLASS}" fill="currentColor" stroke="#000" stroke-opacity="0.35" stroke-width="1.5"><title>Record ${pts[bestIdx]!.label} : ${loc(rawMax.toFixed(1))} kg</title></circle>`
          : '';
      const lastClass = bestIdx === lastIdx ? ` class="${BEST_CLASS}"` : '';
      const lastFill = LINE;
      const last = `<g${lastClass}><line x1="${f(lx)}" x2="${f(lx)}" y1="${f(ly)}" y2="${base}" stroke="${lastFill}" stroke-opacity="0.35" stroke-width="1" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/><circle cx="${f(lx)}" cy="${f(ly)}" r="9" fill="${lastFill}" fill-opacity="0.2"/><circle cx="${f(lx)}" cy="${f(ly)}" r="4.5" fill="${lastFill}" stroke="#fff" stroke-opacity="0.85" stroke-width="1.5"><title>${pts[lastIdx]!.label} : ${pts[lastIdx]!.y.toFixed(1)} kg</title></circle></g>`;

      // Dates de début et de fin sous l'axe
      const xLabels =
        `<text x="${padL}" y="${H - 4}" fill="currentColor" font-size="11">${pts[0]!.label}</text>` +
        `<text x="${W - padR}" y="${H - 4}" fill="currentColor" font-size="11" text-anchor="end">${pts[lastIdx]!.label}</text>`;

      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe e1RM">
        <defs>
          <linearGradient id="k-force-fill" class="text-kinetic-neon" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="currentColor" stop-opacity="0.36"/>
            <stop offset="0.7" stop-color="currentColor" stop-opacity="0.06"/>
            <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}
        <g class="text-kinetic-neon">
          <path d="${area}" fill="url(#k-force-fill)"/>
          <path d="${line}" fill="none" stroke="${LINE}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
          ${dots}${best}${last}
        </g>${xLabels}
      </svg>`;
    },

    forceHasData(): boolean {
      return this.forcePoints().length >= 2;
    },

    /** Dernière e1RM de l'exercice sélectionné (0 si aucune). */
    forceLatest(): number {
      const pts = this.forcePoints();
      return pts.length ? pts.at(-1)!.y : 0;
    },

    /** Meilleure e1RM de l'exercice sélectionné (0 si aucune). */
    forceBest(): number {
      const pts = this.forcePoints();
      return pts.length ? Math.max(...pts.map((p) => p.y)) : 0;
    },

    /** Évolution depuis la première séance : « +8 % depuis le 03 mars ». */
    forceDeltaLabel(): string {
      const pts = this.forcePoints();
      if (pts.length < 2) return '';
      const first = pts[0]!;
      const pct = Math.round(((pts.at(-1)!.y - first.y) / first.y) * 100);
      return `${this.formatPct(pct)} depuis le ${first.label}`;
    },

    /** Sens de l'évolution e1RM : 'up' | 'down' | 'flat'. */
    forceTrend(): 'up' | 'down' | 'flat' {
      const pts = this.forcePoints();
      if (pts.length < 2) return 'flat';
      const d = pts.at(-1)!.y - pts[0]!.y;
      return d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat';
    },

    // ─── Plateaux (alerte de stagnation) ─────────────────────

    async _loadPlateauDismissed(): Promise<void> {
      const deps = await getDeps();
      this.plateauDismissed =
        (await deps.storage.get<PlateauDismissals>(STORAGE_KEYS.PLATEAU_DISMISSED)) ?? {};
    },

    /** Plateau en cours sur l'exercice (null si aucun ou masqué). Mis en cache par historique. */
    plateau(exerciseId: string): PlateauReport | null {
      const now = Date.now();
      if (!exerciseId || isPlateauDismissed(this.plateauDismissed, exerciseId, now)) return null;
      const cache = plateauCache;
      if (cache.sessions !== this.sessions) {
        cache.sessions = this.sessions;
        cache.map.clear();
      }
      if (!cache.map.has(exerciseId)) {
        const incrementKg = this.exercises.find((e) => e.id === exerciseId)?.incrementKg;
        cache.map.set(
          exerciseId,
          detectPlateau(this.sessions, exerciseId, {
            now,
            ...(incrementKg ? { incrementKg } : {}),
          }),
        );
      }
      return cache.map.get(exerciseId) ?? null;
    },

    /** Exercices en plateau (liste de l'onglet Force). */
    get plateaus(): PlateauReport[] {
      return this.exerciseStats.flatMap((st) => this.plateau(st.exerciseId) ?? []);
    },

    /** Plateau de l'exercice affiché, en liste (0 ou 1) pour nommer la variable dans x-for. */
    get selectedPlateaus(): PlateauReport[] {
      const p = this.plateau(this.selectedExerciseId);
      return p ? [p] : [];
    },

    get otherPlateaus(): PlateauReport[] {
      return this.plateaus.filter((p) => p.exerciseId !== this.selectedExerciseId);
    },

    plateauTitle(p: PlateauReport): string {
      return `Plateau depuis ${p.sessions} séances`;
    },

    /** « Meilleure série : 47,5 kg × 8, le 3 nov. » */
    plateauSince(p: PlateauReport): string {
      const set = p.topKg > 0 ? `${loc(String(p.topKg))} kg × ${p.topReps}` : `${p.topReps} reps`;
      return `Meilleure série : ${set}, le ${this.formatDate(p.since)}`;
    },

    /** Détail d'une piste ; la variante cite les alternatives du catalogue. */
    suggestionDetail(p: PlateauReport, sg: PlateauSuggestion): string {
      if (sg.id !== 'variant') return sg.detail;
      const target = this.exercises.find((e) => e.id === p.exerciseId);
      if (!target) return sg.detail;
      const toLike = (e: Exercise) => ({ ...e, equipment: [e.equipment] });
      const alts = suggestSubstitutions({
        target: toLike(target),
        candidates: this.exercises.filter((e) => !e.hidden).map(toLike),
        limit: 2,
      });
      return alts.length
        ? `${sg.detail} Par exemple : ${alts.map((a) => a.exercise.name).join(', ')}.`
        : sg.detail;
    },

    selectExercise(id: string): void {
      this.selectedExerciseId = id;
    },

    /** « Masquer pour cet exercice » : quelques semaines. */
    async hidePlateau(exerciseId: string): Promise<void> {
      this.plateauDismissed = dismissPlateau(this.plateauDismissed, exerciseId, Date.now());
      const deps = await getDeps();
      await deps.storage.set(STORAGE_KEYS.PLATEAU_DISMISSED, this.plateauDismissed);
      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'info', message: 'Alerte masquée pour 3 semaines sur cet exercice.' },
        }),
      );
    },

    /** Ouvre la feuille « Nouvel objectif » (composant strengthGoals) pour l'exercice affiché. */
    newGoalForSelected(): void {
      window.dispatchEvent(new CustomEvent('k-goal-new', { detail: this.selectedExerciseId }));
    },

    // ─── Présentation (anneaux, barres, trophées) ────────────

    /** Style de l'anneau de régularité : `--p` borné à 0–100 (build CSP). */
    get consistencyRingStyle(): string {
      const p = Math.max(0, Math.min(100, Math.round(Number(this.consistency) || 0)));
      return `--p: ${p}`;
    },

    /** Barre de tonnage : la semaine en cours en accent plein, les autres atténuées. */
    barClass(i: number): string {
      return i === this.weeklyBuckets.length - 1
        ? 'bg-gradient-to-t from-kinetic-neon/80 to-kinetic-neon'
        : 'bg-kinetic-neon/30';
    },

    /** Médaillon de record : or pour le premier, accent atténué ensuite. */
    prGlyphClass(i: number): string {
      return i === 0
        ? 'bg-gradient-to-br from-kinetic-gold to-kinetic-neon text-kinetic-on-accent'
        : 'bg-kinetic-neon/15 text-kinetic-neon';
    },

    // ─── Onglet VOLUME : tonnage hebdo ───────────────────────

    get weeklyBuckets(): VolumeBucket[] {
      // Limite aux 12 dernières semaines pour une lecture mobile claire
      const all = weeklyVolume(this._analyticsSets());
      return all.slice(-12);
    },

    volumeMax(): number {
      const max = Math.max(0, ...this.weeklyBuckets.map((b) => b.tonnageKg));
      return max || 1;
    },

    barHeightPct(tonnageKg: number): number {
      return Math.min(100, Math.round((tonnageKg / this.volumeMax()) * 100));
    },

    // ─── Onglet MUSCLES : répartition ────────────────────────

    get muscles(): MuscleShare[] {
      return muscleDistribution(this._analyticsSets());
    },

    muscleLabel(m: string): string {
      const map: Record<string, string> = {
        chest: 'Pectoraux',
        back: 'Dos',
        shoulders: 'Épaules',
        biceps: 'Biceps',
        triceps: 'Triceps',
        legs: 'Jambes',
        quads: 'Quadriceps',
        hamstrings: 'Ischios',
        glutes: 'Fessiers',
        calves: 'Mollets',
        core: 'Abdos',
        forearms: 'Avant-bras',
        upper_back: 'Haut du dos',
        rear_delts: 'Arrière d’épaule',
        posterior: 'Chaîne postérieure',
      };
      return map[m] ?? m.charAt(0).toUpperCase() + m.slice(1);
    },

    // ─── Onglet RECORDS : timeline PR ────────────────────────

    get records(): PersonalRecord[] {
      return [...detectPRs(this._analyticsSets())].reverse();
    },

    // ─── Onglet HEATMAP : activité 20 semaines ───────────────

    /**
     * Retourne une grille de 20 semaines × 7 jours.
     * Chaque cellule : { iso, count, label }
     * count = nombre de séances ce jour-là (0, 1, 2+)
     */
    get heatmapGrid(): Array<Array<{ iso: string; count: number; label: string; dayIdx: number }>> {
      // Compter les séances par date ISO (YYYY-MM-DD)
      const byDate = new Map<string, number>();
      for (const s of this.sessions) {
        const iso = s.startedAt.slice(0, 10);
        byDate.set(iso, (byDate.get(iso) ?? 0) + 1);
      }

      const WEEKS = 20;
      const today = new Date();
      // Aller au lundi de la semaine en cours
      const dayOfWeek = today.getDay(); // 0=dimanche
      // Reculer jusqu'au dimanche précédent pour avoir des semaines L→D
      const weekStart = new Date(today);
      // On veut que chaque colonne = une semaine (lundi → dimanche)
      // On part du dernier dimanche passé
      const diffToSunday = dayOfWeek; // 0 si dimanche, 1 si lundi…
      weekStart.setDate(today.getDate() - diffToSunday - (WEEKS - 1) * 7);

      const weeks: Array<Array<{ iso: string; count: number; label: string; dayIdx: number }>> = [];
      for (let w = 0; w < WEEKS; w++) {
        const days: Array<{ iso: string; count: number; label: string; dayIdx: number }> = [];
        for (let d = 0; d < 7; d++) {
          const cell = new Date(weekStart);
          cell.setDate(weekStart.getDate() + w * 7 + d);
          const iso = cell.toISOString().slice(0, 10);
          const count = byDate.get(iso) ?? 0;
          const isFuture = cell > today;
          days.push({
            iso,
            count: isFuture ? -1 : count,
            label: isFuture
              ? ''
              : cell.toLocaleDateString('fr-FR', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                }),
            dayIdx: d,
          });
        }
        weeks.push(days);
      }
      return weeks;
    },

    /** Teinte d'une case : vert système en 3 intensités, gris de remplissage sinon. */
    heatmapColor(count: number): string {
      if (count < 0) return 'bg-kinetic-elevated opacity-40'; // futur
      if (count === 0) return 'bg-kinetic-elevated';
      if (count === 1) return 'bg-kinetic-teal/45';
      if (count === 2) return 'bg-kinetic-teal/75';
      return 'bg-kinetic-teal';
    },

    get longestStreak(): number {
      if (this.sessions.length === 0) return 0;
      const dates = [...new Set(this.sessions.map((s) => s.startedAt.slice(0, 10)))].sort();
      let best = 1,
        cur = 1;
      for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1]!);
        const curr = new Date(dates[i]!);
        const diff = (curr.getTime() - prev.getTime()) / 86_400_000;
        if (diff === 1) {
          cur++;
          best = Math.max(best, cur);
        } else cur = 1;
      }
      return best;
    },

    get avgSessionsPerWeek(): number {
      if (this.sessions.length < 2) return this.sessions.length;
      const dates = this.sessions.map((s) => Date.parse(s.startedAt));
      const span = (Math.max(...dates) - Math.min(...dates)) / (7 * 86_400_000);
      return span < 0.5
        ? this.sessions.length
        : Math.round((this.sessions.length / span) * 10) / 10;
    },

    // ─── Onglet COMPARER : deux périodes ─────────────────────

    cmpPreset: 'month' as ComparePreset,
    /** Plages personnalisées (AAAA-MM-JJ, champs date). */
    cmpAStart: '',
    cmpAEnd: '',
    cmpBStart: '',
    cmpBEnd: '',
    _bodyweight: null as Array<{ date: string; weight: number }> | null,
    _cmpCache: null as { key: string; value: PeriodComparison | null } | null,

    async _loadBodyweight(): Promise<void> {
      if (this._bodyweight) return;
      this._bodyweight = [];
      try {
        const deps = await getDeps();
        const bw = await deps.storage.get<Array<{ date: string; weight: number }>>(
          STORAGE_KEYS.BODYWEIGHT_ENTRIES,
        );
        this._bodyweight = Array.isArray(bw) ? bw : [];
      } catch (err) {
        console.warn('[progression] pesées indisponibles :', err);
      }
    },

    setPreset(p: ComparePreset): void {
      if (p === 'custom' && !this.cmpAStart) {
        // Point de départ : les plages du préréglage en cours, modifiables.
        const r = this.cmpRanges();
        if (r) {
          this.cmpAStart = r.a.start;
          this.cmpAEnd = r.a.end;
          this.cmpBStart = r.b.start;
          this.cmpBEnd = r.b.end;
        }
      }
      this.cmpPreset = p;
    },

    cmpRanges(): { a: DayRange; b: DayRange } | null {
      if (this.cmpPreset !== 'custom') return presetRanges(this.cmpPreset, new Date());
      const a = normalizeRange(this.cmpAStart, this.cmpAEnd);
      const b = normalizeRange(this.cmpBStart, this.cmpBEnd);
      return a && b ? { a, b } : null;
    },

    get comparison(): PeriodComparison | null {
      const r = this.cmpRanges();
      const bw = this._bodyweight ?? [];
      const key = `${r?.a.start}|${r?.a.end}|${r?.b.start}|${r?.b.end}|${this.sessions.length}|${bw.length}`;
      if (this._cmpCache?.key === key) return this._cmpCache.value;
      const value = r
        ? comparePeriods(
            {
              sessions: this.sessions,
              musclesByExercise: new Map(this.exercises.map((e) => [e.id, e.muscles ?? []])),
              bodyweight: bw,
            },
            r.a,
            r.b,
          )
        : null;
      this._cmpCache = { key, value };
      return value;
    },

    cmpLabel(which: 'a' | 'b'): string {
      const r = this.cmpRanges();
      return r ? formatRange(r[which]) : '';
    },

    /** Valeur d'un indicateur pour la période A ou B (« — » sans donnée). */
    cmpValue(m: MetricDelta, which: 'a' | 'b'): string {
      const v = m[which];
      if (v === null) return '\u2014';
      const text = m.key === 'tonnage' ? this.formatTonnage(v) : this.formatNumber(v, 1);
      const unit = m.key === 'tonnage' && v >= 100000 ? 't' : m.unit;
      return unit ? `${text}\u00A0${unit}` : text;
    },

    /** Écart en % : « +12 % », « nouveau » si la référence est vide, « = » si stable. */
    cmpDelta(m: MetricDelta | RowDelta): string {
      if (m.pct !== null) return this.formatPct(m.pct);
      const a = m.a ?? 0;
      return a > 0 && !m.b ? 'nouveau' : m.trend === 'flat' ? '=' : '\u2014';
    },

    /** Couleur de l'écart : turquoise si mieux, corail si moins bien, gris sinon. */
    cmpToneClass(m: MetricDelta | RowDelta): string {
      const tone =
        'tone' in m ? m.tone : m.trend === 'up' ? 'good' : m.trend === 'down' ? 'bad' : 'neutral';
      return tone === 'good'
        ? 'text-kinetic-teal'
        : tone === 'bad'
          ? 'text-kinetic-neon'
          : 'text-gray-400';
    },

    get avgDurationMin(): number {
      const withDuration = this.sessions.filter((s) => s.durationMin);
      if (!withDuration.length) return 0;
      return Math.round(
        withDuration.reduce((a, s) => a + (s.durationMin ?? 0), 0) / withDuration.length,
      );
    },
  };
}
