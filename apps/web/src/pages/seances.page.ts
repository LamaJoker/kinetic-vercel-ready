import { getDeps } from '../deps';
import { UuidGenerator } from '@kinetic/adapters-web';
import type { Exercise, SessionExerciseEntry, WorkoutSession, WorkoutTemplate } from '../lib/training/types';
import { loadExercises, loadSessions, loadTemplates, saveSessions, saveTemplates } from '../lib/training/storage';
import { estimateE1rmKg, suggestNextWeightKg } from '../lib/training/rpe';
import { estimateStrengthWorkoutCaloriesKcal } from '../lib/training/calories';
import type { UserProfile } from '../lib/user/types';
import { loadUserProfile } from '../lib/user/storage';

type Draft = { reps: number; weightKg: number; rpe: number };

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSessionName(): string {
  const d = new Date();
  const label = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  return `Seance libre (${label})`;
}

export function seances() {
  return {
    loading: false,

    exercises: [] as Exercise[],
    templates: [] as WorkoutTemplate[],
    sessions: [] as WorkoutSession[],
    userProfile: null as UserProfile | null,

    showTemplates: false,
    selectedExerciseId: '' as string,
    showProgress: true,
    progressExerciseId: '' as string,
    progressMetric: 'e1rm' as 'e1rm' | 'weight' | 'volume',

    currentSession: null as WorkoutSession | null,
    templateName: '',

    draft: { reps: 8, weightKg: 40, rpe: 8 } as Draft,

    nowMs: Date.now(),
    tickHandle: null as number | null,

    restEndsAtMs: 0,
    restPresetSec: 90,
    
    // Nouveaux états pour le timer
    restHistory: [] as number[],
    showRestPresets: false,
    _restNotifTimer: null as ReturnType<typeof setTimeout> | null,
    restPresets: [
      { label: '1 min', sec: 60 },
      { label: '90 s',  sec: 90 },
      { label: '2 min', sec: 120 },
      { label: '3 min', sec: 180 },
      { label: '5 min', sec: 300 },
    ],

    get currentEntries(): SessionExerciseEntry[] {
      return (this.currentSession?.entries ?? []) as SessionExerciseEntry[];
    },

    async init(): Promise<void> {
      this.loading = true;
      try {
        const deps = await getDeps();
        this.exercises = await loadExercises(deps.storage);
        this.templates = await loadTemplates(deps.storage);
        this.sessions = await loadSessions(deps.storage);
        this.userProfile = await loadUserProfile(deps.storage);
      } catch (err) {
        console.error('[seances] init failed:', err);
      } finally {
        this.loading = false;
      }

      if (this.tickHandle === null && typeof window !== 'undefined') {
        this.tickHandle = window.setInterval(() => {
          this.nowMs = Date.now();
        }, 1000);
      }
    },

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

    startFreeSession(): void {
      const id = new UuidGenerator().generate();
      this.currentSession = {
        id,
        name: defaultSessionName(),
        startedAt: nowIso(),
        entries: [],
      };
      this.selectedExerciseId = '';
    },

    startFromTemplate(templateId: string): void {
      const t = this.templates.find((x) => x.id === templateId);
      if (!t) return;

      const id = new UuidGenerator().generate();
      this.currentSession = {
        id,
        name: t.name,
        templateId: t.id,
        startedAt: nowIso(),
        entries: t.exercises.map((ex) => ({ exerciseId: ex.exerciseId, sets: [] })),
      };
      this.showTemplates = false;
      this.selectedExerciseId = '';
    },

    elapsedSec(): number {
      if (!this.currentSession) return 0;
      const start = Date.parse(this.currentSession.startedAt);
      if (!Number.isFinite(start)) return 0;
      return Math.max(0, Math.floor((this.nowMs - start) / 1000));
    },

    elapsedLabel(): string {
      const sec = this.elapsedSec();
      const mm = Math.floor(sec / 60);
      const ss = sec % 60;
      return `${mm}:${String(ss).padStart(2, '0')}`;
    },

    restRemainingSec(): number {
      if (!this.restEndsAtMs) return 0;
      return Math.max(0, Math.ceil((this.restEndsAtMs - this.nowMs) / 1000));
    },

    restLabel(): string {
      const sec = this.restRemainingSec();
      if (sec <= 0) return '';
      const mm = Math.floor(sec / 60);
      const ss = sec % 60;
      return `${mm}:${String(ss).padStart(2, '0')}`;
    },

    startRest(): void {
      const sec = Number(this.restPresetSec);
      const clamped = Number.isFinite(sec) ? Math.max(15, Math.min(600, Math.floor(sec))) : 90;
      this.restPresetSec = clamped;
      this.restEndsAtMs = this.nowMs + clamped * 1000;
      
      // Vibration PWA si disponible
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(200);
      }
      
      // Notification si app en arrière-plan
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        // Nettoyer le timer précédent s'il existe
        if (this._restNotifTimer) clearTimeout(this._restNotifTimer);
        
        const timer = setTimeout(() => {
          new Notification('Repos terminé !', {
            body: 'Prêt pour la prochaine série',
            icon: '/icons/icon-96.png',
            tag: 'rest-timer',
          });
        }, clamped * 1000);
        
        this._restNotifTimer = timer;
      }
    },

    stopRest(): void {
      this.restEndsAtMs = 0;
      if (this._restNotifTimer) {
        clearTimeout(this._restNotifTimer);
        this._restNotifTimer = null;
      }
    },

    avgRpeOf(session: WorkoutSession | null): number | null {
      if (!session) return null;
      const rpes: number[] = [];
      for (const e of session.entries) {
        for (const s of e.sets) rpes.push(s.rpe);
      }
      if (rpes.length === 0) return null;
      const avg = rpes.reduce((a, b) => a + b, 0) / rpes.length;
      return Math.round(avg * 10) / 10;
    },

    estimateCurrentCalories(): number | null {
      if (!this.currentSession) return null;
      const durationMin = this.elapsedSec() / 60;
      const avgRpe = this.avgRpeOf(this.currentSession);
      return estimateStrengthWorkoutCaloriesKcal({
        durationMin,
        avgRpe,
        profile: this.userProfile,
      });
    },

    addExerciseToSession(): void {
      if (!this.currentSession) return;
      const id = this.selectedExerciseId;
      if (!id) return;

      const has = this.currentSession.entries.some((e) => e.exerciseId === id);
      if (has) return;

      this.currentSession = {
        ...this.currentSession,
        entries: [...this.currentSession.entries, { exerciseId: id, sets: [] }],
      };
      this.selectedExerciseId = '';
    },

    removeExercise(exerciseId: string): void {
      if (!this.currentSession) return;
      this.currentSession = {
        ...this.currentSession,
        entries: this.currentSession.entries.filter((e) => e.exerciseId !== exerciseId),
      };
    },

    addSet(exerciseId: string): void {
      if (!this.currentSession) return;

      const reps = Number(this.draft.reps);
      const weightKg = Number(this.draft.weightKg);
      const rpe = Number(this.draft.rpe);

      if (!Number.isFinite(reps) || reps <= 0) return;
      if (!Number.isFinite(weightKg) || weightKg < 0) return;
      if (!Number.isFinite(rpe) || rpe < 6 || rpe > 10) return;

      const entry = this.currentSession.entries.find((e) => e.exerciseId === exerciseId);
      if (!entry) return;

      const nextIndex = entry.sets.length;
      const newSet = {
        setIndex: nextIndex,
        reps,
        weightKg,
        rpe,
        performedAt: nowIso(),
      };

      const nextEntries = this.currentSession.entries.map((e) => {
        if (e.exerciseId !== exerciseId) return e;
        return { ...e, sets: [...e.sets, newSet] };
      });

      this.currentSession = { ...this.currentSession, entries: nextEntries };
    },

    suggestedNextWeightKg(exerciseId: string): number | null {
      if (!this.currentSession) return null;
      const entry = this.currentSession.entries.find((e) => e.exerciseId === exerciseId);
      if (!entry || entry.sets.length === 0) return null;
      const last = entry.sets[entry.sets.length - 1];
      if (!last) return null;

      const exercise = this.exercises.find((e) => e.id === exerciseId) ?? null;

      return suggestNextWeightKg({
        currentWeightKg: last.weightKg,
        rpe: last.rpe,
        targetRpe: 8,
        exercise,
      });
    },

    progressPoints(): { x: number; y: number; label: string }[] {
      const exId = this.progressExerciseId;
      if (!exId) return [];

      const points: { x: number; y: number; label: string }[] = [];

      for (const session of this.sessions) {
        const entry = session.entries.find((e) => e.exerciseId === exId);
        if (!entry || entry.sets.length === 0) continue;

        let y = 0;
        if (this.progressMetric === 'weight') {
          y = Math.max(...entry.sets.map((s) => s.weightKg));
        } else if (this.progressMetric === 'volume') {
          y = entry.sets.reduce((acc, s) => acc + s.weightKg * s.reps, 0);
        } else {
          for (const s of entry.sets) {
            y = Math.max(y, estimateE1rmKg(s.weightKg, s.reps));
          }
        }
        if (y <= 0) continue;

        const x = Date.parse(session.startedAt);
        points.push({ x, y, label: this.formatDate(session.startedAt) });
      }

      points.sort((a, b) => a.x - b.x);
      return points;
    },

    progressMin(): number {
      const pts = this.progressPoints();
      if (pts.length === 0) return 0;
      return Math.min(...pts.map((p) => p.y));
    },

    progressMax(): number {
      const pts = this.progressPoints();
      if (pts.length === 0) return 0;
      return Math.max(...pts.map((p) => p.y));
    },

    progressSvg(): string {
      const pts = this.progressPoints();
      if (pts.length === 0) return '';

      const width = 320;
      const height = 140;
      const padX = 12;
      const padY = 12;

      const minX = pts[0]?.x ?? 0;
      const maxX = pts[pts.length - 1]?.x ?? 1;
      const minY = this.progressMin();
      const maxY = this.progressMax();

      const dx = Math.max(1, maxX - minX);
      const dy = Math.max(1, maxY - minY);

      const scaleX = (x: number) => padX + ((x - minX) / dx) * (width - padX * 2);
      const scaleY = (y: number) =>
        height - padY - ((y - minY) / dy) * (height - padY * 2);

      const d = pts
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${scaleX(p.x).toFixed(1)} ${scaleY(p.y).toFixed(1)}`)
        .join(' ');

      const circles = pts
        .map((p) => {
          const cx = scaleX(p.x).toFixed(1);
          const cy = scaleY(p.y).toFixed(1);
          const title = `${p.label}: ${p.y.toFixed(1)} kg`;
          return `<circle cx="${cx}" cy="${cy}" r="3" fill="#7F77DD"><title>${title}</title></circle>`;
        })
        .join('');

      const aria =
        this.progressMetric === 'weight'
          ? 'Progression charge (kg)'
          : this.progressMetric === 'volume'
            ? 'Progression volume (kg-reps)'
            : 'Progression e1RM';

      return `
        <svg width="100%" viewBox="0 0 ${width} ${height}" role="img" aria-label="${aria}">
          <path d="${d}" fill="none" stroke="#7F77DD" stroke-width="2" />
          ${circles}
        </svg>
      `;
    },

    async saveCurrentSession(): Promise<void> {
      if (!this.currentSession) return;
      try {
        const deps = await getDeps();
        const endedAt = nowIso();
        const durationMin = Math.max(
          0,
          Math.round((Date.parse(endedAt) - Date.parse(this.currentSession.startedAt)) / 60000),
        );
        const avgRpe = this.avgRpeOf(this.currentSession);
        const caloriesKcal = estimateStrengthWorkoutCaloriesKcal({
          durationMin,
          avgRpe,
          profile: this.userProfile,
        });

        const finalized: WorkoutSession = {
          ...this.currentSession,
          endedAt,
          durationMin,
          avgRpe: avgRpe ?? undefined,
          caloriesKcal: caloriesKcal ?? undefined,
        };
        const next = [...this.sessions, finalized];
        await saveSessions(deps.storage, next);
        this.sessions = next;
        this.currentSession = null;
        this.templateName = '';
        this.restEndsAtMs = 0;
      } catch (err) {
        console.error('[seances] saveCurrentSession failed:', err);
      }
    },

    async saveTemplateFromCurrent(): Promise<void> {
      if (!this.currentSession) return;
      const name = (this.templateName || '').trim();
      if (!name) return;

      try {
        const deps = await getDeps();
        const template: WorkoutTemplate = {
          id: new UuidGenerator().generate(),
          name,
          createdAt: nowIso(),
          exercises: this.currentSession.entries.map((e) => ({
            exerciseId: e.exerciseId,
            sets: Math.max(1, e.sets.length || 3),
            targetReps: 8,
            targetRpe: 8,
          })),
        };
        const next = [...this.templates, template];
        await saveTemplates(deps.storage, next);
        this.templates = next;
        this.templateName = '';
      } catch (err) {
        console.error('[seances] saveTemplateFromCurrent failed:', err);
      }
    },
  };
}