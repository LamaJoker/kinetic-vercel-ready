import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../deps';
import {
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
} from '@kinetic/core';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { loadExercises, loadSessions } from '../lib/training/storage';
import { estimateE1rmKg } from '../lib/training/rpe';

type Tab = 'force' | 'volume' | 'muscles' | 'records' | 'heatmap';

export function progression() {
  return {
    loading: false,
    activeTab: 'force' as Tab,
    sessions: [] as WorkoutSession[],
    exercises: [] as Exercise[],
    selectedExerciseId: '',
    // M1 FIX: cache pour éviter de recalculer O(sessions×sets) à chaque getter Alpine
    _cachedSets: null as AnalyticsSet[] | null,
    _sessionSavedHandler: null as ((e: Event) => void) | null,

    async init(): Promise<void> {
      this.loading = true;
      this._cachedSets = null; // invalider le cache au rechargement
      try {
        const deps = await getDeps();
        this.exercises = await loadExercises(deps.storage);
        this.sessions = await loadSessions(deps.storage);
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
          e.sets.map((s) => ({
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
        return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
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

    // ─── Stats globales (header) ─────────────────────────────

    get totalSessions(): number {
      return this.sessions.length;
    },

    get totalSets(): number {
      return this.sessions.reduce(
        (acc, s) => acc + s.entries.reduce((a, e) => a + e.sets.length, 0),
        0,
      );
    },

    get totalTonnage(): number {
      let t = 0;
      for (const s of this.sessions)
        for (const e of s.entries) for (const set of e.sets) t += set.reps * set.weightKg;
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
          return `+${r.tonnageDeltaPct}% vs semaine dernière`;
        case 'down':
          return `${r.tonnageDeltaPct}% vs semaine dernière`;
        case 'first':
          return 'Première semaine de données';
        default:
          return 'Stable vs semaine dernière';
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
        for (const s of entry.sets) {
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

    /**
     * Courbe e1RM (style Santé iOS) : trait lissé bleu, aire en fondu, grille
     * horizontale discrète, repère sur la dernière valeur et sur le record.
     * Les gris (grille, légendes) suivent `currentColor` pour le mode clair.
     */
    forceSvg(): string {
      const pts = this.forcePoints();
      if (pts.length < 2) return '';
      const LINE = '#0A84FF';
      const BEST = '#FFD60A';
      const W = 320,
        H = 172,
        padL = 4,
        padR = 34,
        padT = 10,
        padB = 22;
      const minX = pts[0]!.x,
        maxX = pts.at(-1)!.x;
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
      const f = (n: number) => n.toFixed(1);

      // Grille + graduations à droite
      let grid = '';
      for (let v = minY; v <= maxY + step / 2; v += step) {
        const y = f(sy(v));
        grid += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity="0.18" stroke-width="1" vector-effect="non-scaling-stroke"${v > minY ? ' stroke-dasharray="2 3"' : ''}/>`;
        grid += `<text x="${W - padR + 6}" y="${y}" fill="currentColor" font-size="10" dominant-baseline="middle">${this.formatNumber(v, 1)}</text>`;
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
                  `<circle cx="${f(xy[i]![0])}" cy="${f(xy[i]![1])}" r="2.5" fill="${LINE}"><title>${p.label} : ${p.y.toFixed(1)} kg</title></circle>`,
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
          ? `<circle cx="${f(bx)}" cy="${f(by)}" r="4" fill="${BEST}"><title>Record ${pts[bestIdx]!.label} : ${rawMax.toFixed(1)} kg</title></circle>`
          : '';
      const lastFill = bestIdx === lastIdx ? BEST : LINE;
      const last = `<circle cx="${f(lx)}" cy="${f(ly)}" r="8" fill="${lastFill}" fill-opacity="0.22"/><circle cx="${f(lx)}" cy="${f(ly)}" r="4.5" fill="${lastFill}"><title>${pts[lastIdx]!.label} : ${pts[lastIdx]!.y.toFixed(1)} kg</title></circle>`;

      // Dates de début et de fin sous l'axe
      const xLabels =
        `<text x="${padL}" y="${H - 4}" fill="currentColor" font-size="10">${pts[0]!.label}</text>` +
        `<text x="${W - padR}" y="${H - 4}" fill="currentColor" font-size="10" text-anchor="end">${pts[lastIdx]!.label}</text>`;

      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe e1RM">
        <defs>
          <linearGradient id="k-force-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${LINE}" stop-opacity="0.32"/>
            <stop offset="1" stop-color="${LINE}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#k-force-fill)"/>
        <path d="${line}" fill="none" stroke="${LINE}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}${best}${last}${xLabels}
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
      const sign = pct > 0 ? '+' : '';
      return `${sign}${pct} % depuis le ${first.label}`;
    },

    /** Sens de l'évolution e1RM : 'up' | 'down' | 'flat'. */
    forceTrend(): 'up' | 'down' | 'flat' {
      const pts = this.forcePoints();
      if (pts.length < 2) return 'flat';
      const d = pts.at(-1)!.y - pts[0]!.y;
      return d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat';
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

    get avgDurationMin(): number {
      const withDuration = this.sessions.filter((s) => s.durationMin);
      if (!withDuration.length) return 0;
      return Math.round(
        withDuration.reduce((a, s) => a + (s.durationMin ?? 0), 0) / withDuration.length,
      );
    },
  };
}
