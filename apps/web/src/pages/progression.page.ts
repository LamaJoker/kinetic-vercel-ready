import { getDeps } from '../deps';
import {
  weeklyVolume,
  perExerciseStats,
  muscleDistribution,
  detectPRs,
  consistencyScore,
  type AnalyticsSet,
  type VolumeBucket,
  type ExerciseStats,
  type MuscleShare,
  type PersonalRecord,
} from '@kinetic/core';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { loadExercises, loadSessions } from '../lib/training/storage';
import { estimateE1rmKg } from '../lib/training/rpe';

type Tab = 'force' | 'volume' | 'muscles' | 'records';

export function progression() {
  return {
    loading: false,
    activeTab: 'force' as Tab,
    sessions: [] as WorkoutSession[],
    exercises: [] as Exercise[],
    selectedExerciseId: '',

    async init(): Promise<void> {
      this.loading = true;
      try {
        const deps = await getDeps();
        this.exercises = await loadExercises(deps.storage);
        this.sessions = await loadSessions(deps.storage);

        const stats = this._stats();
        if (stats.length > 0) this.selectedExerciseId = stats[0]!.exerciseId;
      } catch (err) {
        console.error('[progression] init failed:', err);
      } finally {
        this.loading = false;
      }
    },

    setTab(t: Tab): void {
      this.activeTab = t;
    },

    // ─── Projection : sessions → AnalyticsSet[] ──────────────

    _analyticsSets(): AnalyticsSet[] {
      const muscleByEx = new Map<string, readonly string[]>();
      for (const ex of this.exercises) muscleByEx.set(ex.id, ex.muscles ?? []);
      return this.sessions.flatMap(sess =>
        sess.entries.flatMap(e =>
          e.sets.map(s => ({
            sessionId:   sess.id,
            exerciseId:  e.exerciseId,
            muscles:     muscleByEx.get(e.exerciseId) ?? [],
            reps:        s.reps,
            weightKg:    s.weightKg,
            rpe:         s.rpe,
            performedAt: s.performedAt,
          }))
        )
      );
    },

    _stats(): ExerciseStats[] {
      return perExerciseStats(this._analyticsSets());
    },

    // ─── Aides UI ─────────────────────────────────────────────

    exerciseName(id: string): string {
      return this.exercises.find(e => e.id === id)?.name ?? id;
    },

    formatDate(iso: string): string {
      try {
        return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
      } catch { return iso; }
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
      return this.sessions.reduce((acc, s) => acc + s.entries.reduce((a, e) => a + e.sets.length, 0), 0);
    },

    get totalTonnage(): number {
      let t = 0;
      for (const s of this.sessions)
        for (const e of s.entries)
          for (const set of e.sets) t += set.reps * set.weightKg;
      return Math.round(t);
    },

    get consistency(): number {
      return consistencyScore(this._analyticsSets(), 8);
    },

    // ─── Onglet FORCE : courbe e1RM par exercice ─────────────

    get exerciseStats(): ExerciseStats[] {
      return this._stats();
    },

    forcePoints(): { x: number; y: number; label: string }[] {
      if (!this.selectedExerciseId) return [];
      const points: { x: number; y: number; label: string }[] = [];
      for (const session of this.sessions) {
        const entry = session.entries.find(e => e.exerciseId === this.selectedExerciseId);
        if (!entry || entry.sets.length === 0) continue;
        let best = 0;
        for (const s of entry.sets) {
          const e = estimateE1rmKg(s.weightKg, s.reps);
          if (e > best) best = e;
        }
        if (best > 0) points.push({ x: Date.parse(session.startedAt), y: best, label: this.formatDate(session.startedAt) });
      }
      return points.sort((a, b) => a.x - b.x);
    },

    forceSvg(): string {
      const pts = this.forcePoints();
      if (pts.length < 2) return '';
      const W = 320, H = 160, padX = 12, padY = 16;
      const minX = pts[0]!.x, maxX = pts.at(-1)!.x;
      const ys = pts.map(p => p.y);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const dx = Math.max(1, maxX - minX), dy = Math.max(0.1, maxY - minY);
      const sx = (x: number) => padX + ((x - minX) / dx) * (W - padX * 2);
      const sy = (y: number) => H - padY - ((y - minY) / dy) * (H - padY * 2);
      const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
      const area = line + ` L ${sx(pts.at(-1)!.x).toFixed(1)} ${H} L ${padX} ${H} Z`;
      const dots = pts.map(p =>
        `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${p.y >= maxY ? 4 : 2.5}" fill="${p.y >= maxY ? '#A8FF00' : '#FF6A00'}"><title>${p.label}: ${p.y.toFixed(1)} kg</title></circle>`
      ).join('');
      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe e1RM">
        <path d="${area}" fill="#FF6A00" fill-opacity="0.15"/>
        <path d="${line}" fill="none" stroke="#FF6A00" stroke-width="2" stroke-linecap="round"/>
        ${dots}
        <text x="${padX}" y="${H - 4}" fill="#6B7280" font-size="9">${minY.toFixed(0)} kg</text>
        <text x="${padX}" y="14" fill="#6B7280" font-size="9">${maxY.toFixed(0)} kg</text>
      </svg>`;
    },

    forceHasData(): boolean {
      return this.forcePoints().length >= 2;
    },

    // ─── Onglet VOLUME : tonnage hebdo ───────────────────────

    get weeklyBuckets(): VolumeBucket[] {
      // Limite aux 12 dernières semaines pour une lecture mobile claire
      const all = weeklyVolume(this._analyticsSets());
      return all.slice(-12);
    },

    volumeMax(): number {
      const max = Math.max(0, ...this.weeklyBuckets.map(b => b.tonnageKg));
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
        chest:    'Pectoraux',
        back:     'Dos',
        shoulders:'Épaules',
        biceps:   'Biceps',
        triceps:  'Triceps',
        legs:     'Jambes',
        quads:    'Quadriceps',
        hamstrings:'Ischios',
        glutes:   'Fessiers',
        calves:   'Mollets',
        core:     'Abdos',
        forearms: 'Avant-bras',
      };
      return map[m] ?? m.charAt(0).toUpperCase() + m.slice(1);
    },

    // ─── Onglet RECORDS : timeline PR ────────────────────────

    get records(): PersonalRecord[] {
      return [...detectPRs(this._analyticsSets())].reverse();
    },
  };
}
