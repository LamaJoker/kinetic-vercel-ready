import { getDeps } from '../deps';
import { UuidGenerator } from '@kinetic/adapters-web';
import type { Exercise, SessionExerciseEntry, WorkoutSession, WorkoutTemplate } from '../lib/training/types';
import { loadExercises, loadSessions, loadTemplates, saveSessions, saveTemplates } from '../lib/training/storage';
import { estimateE1rmKg } from '../lib/training/rpe';
import { estimateStrengthWorkoutCaloriesKcal } from '../lib/training/calories';
import type { UserProfile } from '../lib/user/types';
import { loadUserProfile } from '../lib/user/storage';
import { suggestProgression, needsDeload, type ProgressionSuggestion, type PerformedSet } from '@kinetic/core';
import { suggestedRestSec, requestNotificationPermission } from '../lib/training/rest-timer';
import { exportAsJson, exportAsCsv } from '../lib/training/export';

type Draft = { reps: number; weightKg: number; rpe: number };

const _idGen = new UuidGenerator();
function newId(): string { return _idGen.newId(); }
function nowIso(): string { return new Date().toISOString(); }

function defaultSessionName(): string {
  const d = new Date();
  const label = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  return `Séance libre (${label})`;
}

export function seances() {
  return {
    loading: false,
    exercises: [] as Exercise[],
    templates: [] as WorkoutTemplate[],
    sessions: [] as WorkoutSession[],
    userProfile: null as UserProfile | null,
    latestBodyweight: null as number | null,

    showTemplates: false,
    selectedExerciseId: '',
    showProgress: true,
    progressExerciseId: '',
    progressMetric: 'e1rm' as 'e1rm' | 'weight' | 'volume',
    showRestPresets: false,

    currentSession: null as WorkoutSession | null,
    templateName: '',

    draft: { reps: 8, weightKg: 40, rpe: 8 } as Draft,

    nowMs: Date.now(),
    tickHandle: null as number | null,
    restEndsAtMs: 0,
    restPresetSec: 90,
    _restNotifTimer: null as ReturnType<typeof setTimeout> | null,
    // Cache for progressionSuggestion — keyed by exerciseId, invalidated when
    // sessions array changes (tracked via its length as a cheap version counter).
    _suggestionCache: null as Map<string, ProgressionSuggestion | null> | null,
    _suggestionCacheSessionCount: -1,
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

        // Charger le dernier poids corporel
        const bwEntries = await deps.storage.get<Array<{weight: number}>>('kinetic:bodyweight:entries');
        if (Array.isArray(bwEntries) && bwEntries.length > 0) {
          this.latestBodyweight = bwEntries.at(-1)?.weight ?? null;
        }
      } catch (err) {
        console.error('[seances] init failed:', err);
      } finally {
        this.loading = false;
      }

      if (this.tickHandle === null && typeof window !== 'undefined') {
        this.tickHandle = window.setInterval(() => { this.nowMs = Date.now(); }, 1000) as unknown as number;
      }
    },

    // Alpine calls destroy() automatically via destroyTree() when the router
    // replaces the page. Clears the 1-second ticker and any pending rest timer
    // so they don't accumulate across SPA navigations.
    destroy(): void {
      if (this.tickHandle !== null) {
        window.clearInterval(this.tickHandle);
        this.tickHandle = null;
      }
      this.stopRest();
    },

    // ─── Records (PR) ────────────────────────────────────────

    /** Meilleur e1RM historique pour un exercice */
    pr(exerciseId: string): number | null {
      let best = 0;
      for (const s of this.sessions) {
        const entry = s.entries.find(e => e.exerciseId === exerciseId);
        if (!entry) continue;
        for (const set of entry.sets) {
          const e1rm = estimateE1rmKg(set.weightKg, set.reps);
          if (e1rm > best) best = e1rm;
        }
      }
      return best > 0 ? best : null;
    },

    /** True si la série en cours serait un nouveau PR */
    isNewPr(exerciseId: string, weightKg: number, reps: number): boolean {
      if (!exerciseId || !weightKg || !reps) return false;
      const current = estimateE1rmKg(weightKg, reps);
      const best = this.pr(exerciseId);
      return best === null ? current > 0 : current > best;
    },

    /** True si une série donnée est un PR */
    isSetPr(exerciseId: string, weightKg: number, reps: number): boolean {
      const best = this.pr(exerciseId);
      const e1rm = estimateE1rmKg(weightKg, reps);
      return best !== null && e1rm >= best - 0.1;
    },

    /** e1RM d'une série */
    e1rm(weightKg: number, reps: number): number {
      return estimateE1rmKg(weightKg, reps);
    },

    // ─── Session helpers ─────────────────────────────────────

    exerciseName(id: string): string {
      return this.exercises.find(e => e.id === id)?.name ?? id;
    },

    formatDate(iso: string): string {
      try {
        return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
      } catch { return iso; }
    },

    startFreeSession(): void {
      this.currentSession = {
        id: newId(),
        name: defaultSessionName(),
        startedAt: nowIso(),
        entries: [],
      };
      this.selectedExerciseId = '';
    },

    startFromTemplate(templateId: string): void {
      const t = this.templates.find(x => x.id === templateId);
      if (!t) return;
      this.currentSession = {
        id: newId(),
        name: t.name,
        templateId: t.id,
        startedAt: nowIso(),
        entries: t.exercises.map(ex => ({ exerciseId: ex.exerciseId, sets: [] })),
      };
      this.showTemplates = false;
    },

    async deleteTemplate(templateId: string): Promise<void> {
      const deps = await getDeps();
      this.templates = this.templates.filter(t => t.id !== templateId);
      await saveTemplates(deps.storage, this.templates);
    },

    elapsedSec(): number {
      if (!this.currentSession) return 0;
      const start = Date.parse(this.currentSession.startedAt);
      return Number.isFinite(start) ? Math.max(0, Math.floor((this.nowMs - start) / 1000)) : 0;
    },

    elapsedLabel(): string {
      const sec = this.elapsedSec();
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    },

    restRemainingSec(): number {
      return this.restEndsAtMs ? Math.max(0, Math.ceil((this.restEndsAtMs - this.nowMs) / 1000)) : 0;
    },

    restLabel(): string {
      const sec = this.restRemainingSec();
      if (!sec) return '';
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    },

    startRest(): void {
      const sec = Math.max(15, Math.min(600, Math.floor(Number(this.restPresetSec)) || 90));
      this.restPresetSec = sec;
      this.restEndsAtMs = this.nowMs + sec * 1000;
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(100);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        if (this._restNotifTimer) clearTimeout(this._restNotifTimer);
        this._restNotifTimer = setTimeout(() => {
          new Notification('⏱ Repos terminé !', { body: 'Prêt pour la série suivante', icon: '/icons/icon-96.png', tag: 'rest' });
        }, sec * 1000);
      }
    },

    stopRest(): void {
      this.restEndsAtMs = 0;
      if (this._restNotifTimer) { clearTimeout(this._restNotifTimer); this._restNotifTimer = null; }
    },

    avgRpeOf(session: WorkoutSession | null): number | null {
      if (!session) return null;
      const rpes: number[] = session.entries.flatMap(e => e.sets.map(s => s.rpe));
      if (!rpes.length) return null;
      return Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10;
    },

    estimateCurrentCalories(): number | null {
      if (!this.currentSession) return null;
      return estimateStrengthWorkoutCaloriesKcal({
        durationMin: this.elapsedSec() / 60,
        avgRpe: this.avgRpeOf(this.currentSession),
        profile: this.userProfile,
      });
    },

    addExerciseToSession(): void {
      if (!this.currentSession || !this.selectedExerciseId) return;
      if (this.currentSession.entries.some(e => e.exerciseId === this.selectedExerciseId)) return;
      this.currentSession = {
        ...this.currentSession,
        entries: [...this.currentSession.entries, { exerciseId: this.selectedExerciseId, sets: [] }],
      };
      this.selectedExerciseId = '';
    },

    removeExercise(exerciseId: string): void {
      if (!this.currentSession) return;
      this.currentSession = {
        ...this.currentSession,
        entries: this.currentSession.entries.filter(e => e.exerciseId !== exerciseId),
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

      const entry = this.currentSession.entries.find(e => e.exerciseId === exerciseId);
      if (!entry) return;

      this.currentSession = {
        ...this.currentSession,
        entries: this.currentSession.entries.map(e => {
          if (e.exerciseId !== exerciseId) return e;
          return { ...e, sets: [...e.sets, { setIndex: e.sets.length, reps, weightKg, rpe, performedAt: nowIso() }] };
        }),
      };

      // Auto-démarrer le chrono de repos après chaque série (durée basée sur le RPE)
      this.restPresetSec = this.smartRestSec();
      this.startRest();
    },

    /** Historique de sets pour un exercice, toutes séances confondues (du plus ancien au plus récent). */
    _historyForExercise(exerciseId: string): PerformedSet[] {
      const sorted = [...this.sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return sorted.flatMap(s =>
        (s.entries.find(e => e.exerciseId === exerciseId)?.sets ?? []).map(set => ({
          reps:     set.reps,
          weightKg: set.weightKg,
          rpe:      set.rpe,
          at:       set.performedAt,
        }))
      );
    },

    /** Suggestion de progression complète pour l'exercice courant. */
    progressionSuggestion(exerciseId: string): ProgressionSuggestion | null {
      if (!exerciseId) return null;
      // Invalidate cache when sessions array grows (new session saved).
      if (this._suggestionCacheSessionCount !== this.sessions.length) {
        this._suggestionCache = new Map();
        this._suggestionCacheSessionCount = this.sessions.length;
      }
      if (!this._suggestionCache) this._suggestionCache = new Map();
      if (this._suggestionCache.has(exerciseId)) {
        return this._suggestionCache.get(exerciseId) ?? null;
      }
      const ex = this.exercises.find(e => e.id === exerciseId);
      const history = this._historyForExercise(exerciseId);
      const result = suggestProgression({
        exerciseId,
        targetReps:  8,
        targetRpe:   8,
        incrementKg: ex?.incrementKg ?? 2.5,
        history,
      });
      this._suggestionCache.set(exerciseId, result);
      return result;
    },

    /** Vrai si l'exercice est en état de deload d'après l'historique. */
    exerciseNeedsDeload(exerciseId: string): boolean {
      return needsDeload(this._historyForExercise(exerciseId));
    },

    /** Durée de repos recommandée selon le dernier RPE du draft. */
    smartRestSec(): number {
      return suggestedRestSec(Number(this.draft.rpe) || 8);
    },

    async requestNotifications(): Promise<void> {
      await requestNotificationPermission();
    },

    exportJson(): void {
      exportAsJson(this.sessions, this.exercises);
    },

    exportCsv(): void {
      exportAsCsv(this.sessions, this.exercises);
    },

    // ─── Progression ─────────────────────────────────────────

    progressPoints(): { x: number; y: number; label: string }[] {
      if (!this.progressExerciseId) return [];
      const points: { x: number; y: number; label: string }[] = [];

      for (const session of this.sessions) {
        const entry = session.entries.find(e => e.exerciseId === this.progressExerciseId);
        if (!entry || !entry.sets.length) continue;
        let y = 0;
        if (this.progressMetric === 'weight') {
          y = Math.max(...entry.sets.map(s => s.weightKg));
        } else if (this.progressMetric === 'volume') {
          y = entry.sets.reduce((acc, s) => acc + s.weightKg * s.reps, 0);
        } else {
          for (const s of entry.sets) y = Math.max(y, estimateE1rmKg(s.weightKg, s.reps));
        }
        if (y > 0) points.push({ x: Date.parse(session.startedAt), y, label: this.formatDate(session.startedAt) });
      }

      return points.sort((a, b) => a.x - b.x);
    },

    progressMin(): number {
      const pts = this.progressPoints();
      return pts.length ? Math.min(...pts.map(p => p.y)) : 0;
    },

    progressMax(): number {
      const pts = this.progressPoints();
      return pts.length ? Math.max(...pts.map(p => p.y)) : 0;
    },

    progressSvg(): string {
      const pts = this.progressPoints();
      if (pts.length < 2) return '';
      const W = 320, H = 140, padX = 8, padY = 8;
      const minX = pts[0]!.x, maxX = pts.at(-1)!.x;
      const minY = this.progressMin(), maxY = this.progressMax();
      const dx = Math.max(1, maxX - minX), dy = Math.max(0.1, maxY - minY);
      const sx = (x: number) => padX + ((x - minX) / dx) * (W - padX * 2);
      const sy = (y: number) => H - padY - ((y - minY) / dy) * (H - padY * 2);
      const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
      const area = line + ` L ${sx(pts.at(-1)!.x).toFixed(1)} ${H} L ${padX} ${H} Z`;
      const circles = pts.map(p =>
        `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${p.y >= maxY ? 4 : 2.5}" fill="${p.y >= maxY ? '#FFD166' : '#7F77DD'}"><title>${p.label}: ${p.y.toFixed(1)}</title></circle>`
      ).join('');
      const metric = this.progressMetric === 'weight' ? 'Charge max (kg)' : this.progressMetric === 'volume' ? 'Volume (kg·reps)' : 'e1RM (kg)';
      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="${metric}">
        <path d="${area}" fill="#7F77DD" fill-opacity="0.15"/>
        <path d="${line}" fill="none" stroke="#7F77DD" stroke-width="2" stroke-linecap="round"/>
        ${circles}
        <text x="${padX}" y="${H - 2}" fill="#6B7280" font-size="9">${minY.toFixed(0)}</text>
        <text x="${padX}" y="14" fill="#6B7280" font-size="9">${maxY.toFixed(0)}</text>
      </svg>`;
    },

    // ─── Save ────────────────────────────────────────────────

    async saveCurrentSession(): Promise<void> {
      if (!this.currentSession) return;
      try {
        const deps = await getDeps();
        const endedAt = nowIso();
        const durationMin = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(this.currentSession.startedAt)) / 60000));
        const avgRpe = this.avgRpeOf(this.currentSession);
        const caloriesKcal = estimateStrengthWorkoutCaloriesKcal({ durationMin, avgRpe, profile: this.userProfile });

        const finalized: WorkoutSession = {
          ...this.currentSession,
          endedAt,
          durationMin,
          ...(avgRpe != null      ? { avgRpe }      : {}),
          ...(caloriesKcal != null ? { caloriesKcal } : {}),
        };
        // Persist FIRST so a write failure doesn't leave the UI in an
        // inconsistent state (session shown in history but not on disk).
        const next = [...this.sessions, finalized];
        await saveSessions(deps.storage, next);
        this.sessions = next;
        this.currentSession = null;
        this.templateName = '';
        this.stopRest();

        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'success', message: `Séance sauvegardée — ${durationMin} min${caloriesKcal ? ` · ~${caloriesKcal} kcal` : ''}` },
        }));
        window.dispatchEvent(new CustomEvent('kinetic:session-saved'));
      } catch (err) {
        console.error('[seances] save failed:', err);
        const name = err instanceof Error ? err.name : 'Error';
        const isQuota = /Quota/i.test(name) || /Quota/i.test((err as Error)?.message ?? '');
        const message = isQuota
          ? "Stockage plein — va dans Profil → Stockage et appuie sur \"Compacter\" pour libérer de la place."
          : `Échec de sauvegarde (${name}). Réessaie ou recharge la page.`;
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message },
        }));
      }
    },

    async saveTemplateFromCurrent(): Promise<void> {
      if (!this.currentSession) return;
      const name = this.templateName.trim();
      if (!name) return;
      try {
        const deps = await getDeps();
        const template: WorkoutTemplate = {
          id: newId(), name, createdAt: nowIso(),
          exercises: this.currentSession.entries.map(e => ({
            exerciseId: e.exerciseId, sets: Math.max(1, e.sets.length || 3), targetReps: 8, targetRpe: 8,
          })),
        };
        const next = [...this.templates, template];
        await saveTemplates(deps.storage, next);
        this.templates = next;
        this.templateName = '';
        window.dispatchEvent(new CustomEvent('kinetic:notify', { detail: { kind: 'success', message: `Modèle "${name}" créé` } }));
      } catch (err) {
        console.error('[seances] saveTemplate failed:', err);
        const name = err instanceof Error ? err.name : 'Error';
        const detail = err instanceof Error && err.message ? err.message.slice(0, 120) : '';
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: {
            kind: 'error',
            message: `Échec création du modèle (${name})${detail ? ` — ${detail}` : ''}. Réessaie.`,
          },
        }));
      }
    },
  };
}
