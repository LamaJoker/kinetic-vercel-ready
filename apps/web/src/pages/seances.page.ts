import { loc } from '../lib/num';
import { plural } from '../lib/plural';
import {
  STORAGE_KEYS,
  suggestProgression,
  needsDeload,
  generateWorkout,
  encodeWorkout,
  buildShareUrl,
  suggestSubstitutions,
  getExerciseCues,
  type ProgressionSuggestion,
  type PerformedSet,
  type WorkoutFocus,
  type SubstitutionResult,
  type ExerciseCues,
} from '@kinetic/core';
import { UuidGenerator } from '@kinetic/adapters-web';
import { getDeps } from '../deps';
import type {
  Exercise,
  SessionExerciseEntry,
  WorkoutSession,
  WorkoutTemplate,
} from '../lib/training/types';
import {
  loadExercises,
  loadSessions,
  loadTemplates,
  saveSession,
  deleteSession as deleteSessionFromStorage,
  saveTemplates,
} from '../lib/training/storage';
import { estimateE1rmKg } from '../lib/training/rpe';
import { estimateStrengthWorkoutCaloriesKcal } from '../lib/training/calories';
import type { UserProfile } from '../lib/user/types';
import { loadUserProfile } from '../lib/user/storage';
import { suggestedRestSec, requestNotificationPermission } from '../lib/training/rest-timer';
import { exportAsJson, exportAsCsv } from '../lib/training/export';
import { hapticLight, hapticMedium, hapticSuccess, hapticHeavy } from '../lib/haptics';
import { celebrate, recordCelebration } from '../lib/celebration';
import {
  type ActiveSessionSnapshot,
  type ActiveSessionWriter,
  announceActiveSession,
  createActiveSessionWriter,
  isActiveSessionStale,
  loadActiveSession,
  restoreActiveSession,
  snapshotActiveSession,
  summarizeActiveSession,
  writeActiveSession,
  formatActiveAge,
} from '../lib/training/active-session';

type Draft = { reps: number; weightKg: number; rpe: number; note: string; tempo: string };

// ─── Catégorisation par groupe musculaire ────────────────────────────────────

const CATEGORY_ORDER = [
  'Polyarticulaires',
  'Pectoraux',
  'Dos',
  'Épaules',
  'Biceps',
  'Triceps',
  'Jambes',
  'Abdos / Core',
  'Cardio',
  'Autre',
] as const;

type MuscleCategory = (typeof CATEGORY_ORDER)[number];

function getMuscleCategory(muscles: readonly string[]): MuscleCategory {
  const ms = new Set(muscles);

  // Détection polyarticulaire : exercice impliquant 2+ grands groupes
  const upperPush = ms.has('chest') || ms.has('shoulders') || ms.has('triceps');
  const upperPull =
    ms.has('back') ||
    ms.has('upper_back') ||
    ms.has('traps') ||
    ms.has('biceps') ||
    ms.has('rear_delts');
  const lower =
    ms.has('quads') ||
    ms.has('hamstrings') ||
    ms.has('glutes') ||
    ms.has('calves') ||
    ms.has('hip_flexors') ||
    ms.has('legs') ||
    ms.has('adductors') ||
    ms.has('abductors');
  const coreArea = ms.has('core') || ms.has('lower_back');

  const majorCount = [upperPush, upperPull, lower, coreArea].filter(Boolean).length;
  if (majorCount >= 2 || ms.has('full_body') || ms.has('posterior')) return 'Polyarticulaires';

  if (ms.has('chest')) return 'Pectoraux';
  if (ms.has('upper_back') || ms.has('back') || ms.has('traps') || ms.has('rear_delts'))
    return 'Dos';
  if (ms.has('shoulders') || ms.has('rotator_cuff')) return 'Épaules';
  if (ms.has('biceps') || ms.has('brachialis') || ms.has('forearms') || ms.has('grip'))
    return 'Biceps';
  if (ms.has('triceps')) return 'Triceps';
  if (lower) return 'Jambes';
  if (coreArea) return 'Abdos / Core';
  if (ms.has('conditioning')) return 'Cardio';
  return 'Autre';
}

export interface ExerciseGroup {
  category: MuscleCategory;
  exercises: Exercise[];
}

const _idGen = new UuidGenerator();
function newId(): string {
  return _idGen.newId();
}
function nowIso(): string {
  return new Date().toISOString();
}

// ─── Objectifs du coach ──────────────────────────────────────────────────────

type CoachGoal = 'force' | 'hypertrophie' | 'endurance';

interface GoalPreset {
  label: string;
  short: string; // libellé du contrôle segmenté
  emoji: string;
  targetReps: number;
  targetRpe: number;
  rpeZone: string; // description courte de la zone RPE cible
  science: string; // source/référence courte
}

const COACH_GOALS: Record<CoachGoal, GoalPreset> = {
  force: {
    label: 'Force',
    short: 'Force',
    emoji: '',
    targetReps: 4,
    targetRpe: 8.5,
    rpeZone: '3–5 reps @ RPE 8–9',
    science: 'Prilepin (1974) · NSCA Strength Guidelines',
  },
  hypertrophie: {
    label: 'Hypertrophie',
    short: 'Hypertrophie',
    emoji: '',
    targetReps: 9,
    targetRpe: 8,
    rpeZone: '6–12 reps @ RPE 7–9',
    science: 'Schoenfeld (2010) · Helms et al. (2018)',
  },
  endurance: {
    label: 'Endurance musculaire',
    short: 'Endurance',
    emoji: '',
    targetReps: 15,
    targetRpe: 7,
    rpeZone: '15–20 reps @ RPE 6–8',
    science: 'ACSM Position Stand (2009)',
  },
};

function isCoachGoal(value: string | null): value is CoachGoal {
  return value === 'force' || value === 'hypertrophie' || value === 'endurance';
}

/**
 * Lit le coach goal persisté en validant la valeur. Utilisé à l'init du store
 * et factorisable avec setCoachGoal pour garder une seule source de vérité.
 * localStorage peut throw (mode privé iOS, WebView Capacitor restreinte) →
 * try/catch obligatoire avec fallback sur la valeur par défaut.
 */
function _readCoachGoal(): CoachGoal {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.COACH_GOAL);
    return isCoachGoal(stored) ? stored : 'hypertrophie';
  } catch {
    return 'hypertrophie';
  }
}

function sessionsCacheVersion(sessions: readonly WorkoutSession[]): string {
  const last = sessions.at(-1);
  return `${sessions.length}:${last?.id ?? ''}:${last?.startedAt ?? ''}:${last?.endedAt ?? ''}`;
}

function defaultSessionName(): string {
  const d = new Date();
  const label = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  return `Séance libre (${label})`;
}

/** Pourcentage borné 0–100 (anneaux de progression). */
export function ringPct(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

/**
 * Tonnage découpé en valeur + unité : 840 → « 840 » kg, 12 400 → « 12,4 » t.
 * `tonnesFrom` : seuil (kg) à partir duquel on passe en tonnes.
 */
export function volumeParts(kg: number, tonnesFrom = 10000): { value: string; unit: 'kg' | 't' } {
  const v = Number.isFinite(kg) ? Math.max(0, kg) : 0;
  if (v >= tonnesFrom) {
    return { value: (v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }), unit: 't' };
  }
  return { value: Math.round(v).toLocaleString('fr-FR'), unit: 'kg' };
}

/** Tonnage (Σ charge × reps) d'une liste d'exercices. */
export function entriesTonnageKg(
  entries: ReadonlyArray<{ sets: ReadonlyArray<{ weightKg: number; reps: number }> }>,
): number {
  return entries.reduce(
    (acc, e) => acc + e.sets.reduce((a, s) => a + (s.weightKg || 0) * (s.reps || 0), 0),
    0,
  );
}

/** Bilan des 7 derniers jours : nombre de séances, minutes, tonnage. */
export function recentStatsOf(
  sessions: ReadonlyArray<WorkoutSession>,
  nowMs: number,
  days = 7,
): { count: number; minutes: number; volume: { value: string; unit: 'kg' | 't' } } {
  const from = nowMs - days * 86_400_000;
  let count = 0;
  let minutes = 0;
  let kg = 0;
  for (const s of sessions) {
    const t = Date.parse(s.startedAt);
    if (!Number.isFinite(t) || t < from || t > nowMs) continue;
    count += 1;
    minutes += Number(s.durationMin) || 0;
    kg += entriesTonnageKg(s.entries);
  }
  return { count, minutes: Math.round(minutes), volume: volumeParts(kg, 1000) };
}

export function seances() {
  return {
    loading: false,
    exercises: [] as Exercise[],
    templates: [] as WorkoutTemplate[],
    sessions: [] as WorkoutSession[],
    userProfile: null as UserProfile | null,
    latestBodyweight: null as number | null,

    coachGoal: _readCoachGoal(),
    coachGoals: COACH_GOALS,

    showTemplates: false,
    selectedExerciseId: '',
    showProgress: true,
    progressExerciseId: '',
    progressMetric: 'e1rm' as 'e1rm' | 'weight' | 'volume',
    showRestPresets: false,

    currentSession: null as WorkoutSession | null,
    templateName: '',

    draft: { reps: 8, weightKg: 40, rpe: 8, note: '', tempo: '' } as Draft,
    showSetExtras: false,

    nowMs: Date.now(),
    tickHandle: null as number | null,
    restEndsAtMs: 0,
    restPresetSec: 90,
    /** Durée totale du repos en cours (s), pour l'anneau. Suit les +15 s. */
    restTotalSec: 90,
    fullscreenRest: false,
    _restNotifTimer: null as ReturnType<typeof setTimeout> | null,

    // ─── Séance en cours persistée (lib/training/active-session.ts) ─────
    /** Séance enregistrée de plus de 12 h : on demande avant de la reprendre. */
    resumePrompt: null as ActiveSessionSnapshot | null,
    confirmAbandon: false,
    _activeWriter: null as ActiveSessionWriter | null,
    /** Coupé au démontage : stopRest() du destroy ne doit pas effacer le repos enregistré. */
    _persistOff: false,
    _onHide: null as (() => void) | null,
    // Alpine attache $watch dynamiquement — typage minimal
    $watch: undefined as ((path: string, cb: () => void) => void) | undefined,

    // ─── Consignes d'exécution ───────────────────────────────
    cuesFor: null as string | null,

    /** Ouvre/ferme le panneau de consignes d'un exercice. */
    toggleCues(exerciseId: string): void {
      this.cuesFor = this.cuesFor === exerciseId ? null : exerciseId;
    },

    /** Consignes de forme d'un exercice (null si non documenté). */
    cues(exerciseId: string): ExerciseCues | null {
      return getExerciseCues(exerciseId);
    },

    // ─── Substitution ────────────────────────────────────────
    substitutionFor: null as string | null,
    substitutionResults: [] as SubstitutionResult[],

    /** Ouvre/ferme le panneau de substitution pour un exercice. */
    openSubstitution(exerciseId: string): void {
      if (this.substitutionFor === exerciseId) {
        this.substitutionFor = null;
        return;
      }
      const target = this.exercises.find((e) => e.id === exerciseId);
      if (!target) return;
      const candidates = this.exercises.map((ex) => ({
        id: ex.id,
        name: ex.name,
        muscles: ex.muscles,
        equipment: ex.equipment ? [ex.equipment] : [],
      }));
      this.substitutionResults = suggestSubstitutions({
        target: {
          id: target.id,
          name: target.name,
          muscles: target.muscles,
          equipment: target.equipment ? [target.equipment] : [],
        },
        candidates,
        limit: 3,
      });
      this.substitutionFor = exerciseId;
    },

    /** Remplace un exo dans la séance courante en gardant les sets déjà faits. */
    applySubstitution(oldExerciseId: string, newExerciseId: string): void {
      if (!this.currentSession) return;
      const replacement = this.exercises.find((e) => e.id === newExerciseId);
      if (!replacement) return;
      // Évite les doublons : si l'exo cible est déjà dans la séance, fusion
      const alreadyHasNew = this.currentSession.entries.some((e) => e.exerciseId === newExerciseId);
      if (alreadyHasNew) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'warning',
              message: 'Cet exercice est déjà dans ta séance.',
            },
          }),
        );
        return;
      }
      this.currentSession = {
        ...this.currentSession,
        entries: this.currentSession.entries.map((e) =>
          e.exerciseId === oldExerciseId ? { ...e, exerciseId: newExerciseId } : e,
        ),
      };
      if (this.activeExerciseId === oldExerciseId) this.setActiveEntry(newExerciseId);
      this.substitutionFor = null;
      this.substitutionResults = [];
      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: {
            kind: 'success',
            message: `Remplacé par "${replacement.name}".`,
          },
        }),
      );
    },
    // Cache for progressionSuggestion — keyed by exerciseId, invalidated when
    // sessions array changes (tracked via its length as a cheap version counter).
    _suggestionCache: null as Map<string, ProgressionSuggestion | null> | null,
    _suggestionCacheVersion: '',
    _exercisesByGroupCache: null as ExerciseGroup[] | null,
    _exercisesByGroupVersion: -1,
    restPresets: [
      { label: '1 min', sec: 60 },
      { label: '90 s', sec: 90 },
      { label: '2 min', sec: 120 },
      { label: '3 min', sec: 180 },
      { label: '5 min', sec: 300 },
    ],

    get currentEntries(): SessionExerciseEntry[] {
      return (this.currentSession?.entries ?? []) as SessionExerciseEntry[];
    },

    // ─── Exercice actif (saisie ouverte sur un seul exercice à la fois) ──────
    activeExerciseId: null as string | null,
    _activeSessionId: null as string | null,

    /** Ouvre la saisie sur un exercice de la séance en cours. */
    setActiveEntry(exerciseId: string): void {
      this.activeExerciseId = exerciseId;
      this._activeSessionId = this.currentSession?.id ?? null;
    },

    /**
     * Vrai si la saisie est ouverte sur cet exercice. Sans choix explicite
     * (ou si l'exercice choisi n'est plus dans la séance) : le premier exercice
     * sans série, à défaut le dernier.
     */
    isActiveEntry(exerciseId: string): boolean {
      const entries = this.currentEntries;
      if (!entries.length) return false;
      const chosen = this.activeExerciseId;
      if (
        chosen &&
        this._activeSessionId === this.currentSession?.id &&
        entries.some((e) => e.exerciseId === chosen)
      ) {
        return chosen === exerciseId;
      }
      const fallback = entries.find((e) => e.sets.length === 0) ?? entries.at(-1);
      return fallback?.exerciseId === exerciseId;
    },

    /** Nombre total de séries de la séance en cours. */
    sessionSetCount(): number {
      return this.currentEntries.reduce((n, e) => n + e.sets.length, 0);
    },

    /** Tonnage de la séance en cours : « 840 kg » ou « 12,4 t ». */
    sessionVolumeLabel(): string {
      const v = this.sessionVolumeParts();
      return `${v.value} ${v.unit}`;
    },

    /** Tonnage de la séance en cours, valeur et unité séparées (grand chiffre). */
    sessionVolumeParts(): { value: string; unit: 'kg' | 't' } {
      return volumeParts(entriesTonnageKg(this.currentEntries));
    },

    /** Exercices entamés (au moins une série) dans la séance en cours. */
    sessionStartedCount(): number {
      return this.currentEntries.filter((e) => e.sets.length > 0).length;
    },

    /** Anneau de la séance : part des exercices entamés (style CSP « --p: N »). */
    sessionRingStyle(): string {
      return `--p: ${ringPct(this.sessionStartedCount(), this.currentEntries.length)}`;
    },

    /** Bilan des 7 derniers jours pour la carte héros de l'écran. */
    recentStats(): { count: number; minutes: number; volume: { value: string; unit: 'kg' | 't' } } {
      return recentStatsOf(this.sessions, this.nowMs);
    },

    /** Tonnage d'une séance de l'historique, valeur et unité séparées. */
    sessionTonnage(session: WorkoutSession): { value: string; unit: 'kg' | 't' } {
      return volumeParts(entriesTonnageKg(session.entries), 1000);
    },

    /** Exercices regroupés par groupe musculaire, dans l'ordre CATEGORY_ORDER. */
    get exercisesByGroup(): ExerciseGroup[] {
      if (
        this._exercisesByGroupCache !== null &&
        this._exercisesByGroupVersion === this.exercises.length
      ) {
        return this._exercisesByGroupCache;
      }
      const map = new Map<MuscleCategory, Exercise[]>();
      for (const cat of CATEGORY_ORDER) map.set(cat, []);
      for (const ex of this.exercises) {
        const cat = getMuscleCategory(ex.muscles);
        map.get(cat)!.push(ex);
      }
      const result = CATEGORY_ORDER.filter((cat) => map.get(cat)!.length > 0).map((cat) => ({
        category: cat,
        exercises: map.get(cat)!,
      }));
      this._exercisesByGroupCache = result;
      this._exercisesByGroupVersion = this.exercises.length;
      return result;
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
        const bwEntries = await deps.storage.get<Array<{ weight: number }>>(
          STORAGE_KEYS.BODYWEIGHT_ENTRIES,
        );
        if (Array.isArray(bwEntries) && bwEntries.length > 0) {
          this.latestBodyweight = bwEntries.at(-1)?.weight ?? null;
        }

        // ── Import partagé en attente (depuis ?import=… au boot) ─────────
        try {
          const pending = sessionStorage.getItem(STORAGE_KEYS.PENDING_SHARED_IMPORT);
          if (pending) {
            sessionStorage.removeItem(STORAGE_KEYS.PENDING_SHARED_IMPORT);
            const workout = JSON.parse(pending) as {
              name: string;
              exercises: Array<{
                exerciseId: string;
                sets: number;
                targetReps: number;
                targetRpe: number;
              }>;
            };
            // Crée un template à partir du payload partagé
            const newTemplate = {
              id: newId(),
              name: `${workout.name} (partagé)`,
              createdAt: nowIso(),
              exercises: workout.exercises,
            };
            const updated = [...this.templates, newTemplate];
            await saveTemplates(deps.storage, updated);
            this.templates = updated;
            window.dispatchEvent(
              new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
                detail: {
                  kind: 'success',
                  message: `Modèle "${workout.name}" importé depuis le lien partagé.`,
                },
              }),
            );
          }
        } catch (err) {
          console.warn('[seances] shared import handling failed:', err);
        }

        // ── Reprise de la séance en cours (changement d'onglet, rechargement,
        // app fermée par l'OS) : automatique sous 12 h, sinon on demande.
        const saved = await loadActiveSession(deps.storage);
        if (saved && !this.currentSession) {
          if (isActiveSessionStale(saved, Date.now())) this.resumePrompt = saved;
          else this._applyActiveSnapshot(saved);
        }

        // ── Auto-démarrer depuis le programme du jour ─────────────────────
        // sessionStorage peut throw en mode privé / WebView restreint
        let autoTemplateId: string | null = null;
        try {
          autoTemplateId = sessionStorage.getItem(STORAGE_KEYS.PROGRAM_AUTO_TEMPLATE);
          if (autoTemplateId) sessionStorage.removeItem(STORAGE_KEYS.PROGRAM_AUTO_TEMPLATE);
        } catch {
          /* sessionStorage indisponible — on saute silencieusement */
        }

        if (autoTemplateId && this.currentSession) {
          // Une séance est déjà en cours : on ne l'écrase pas.
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'info', message: 'Séance en cours reprise.' },
            }),
          );
        } else if (autoTemplateId) {
          const t = this.templates.find((x) => x.id === autoTemplateId);
          if (t) {
            this.startFromTemplate(t.id);
            window.dispatchEvent(
              new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
                detail: {
                  kind: 'info',
                  message: `Séance « ${t.name} » prête`,
                },
              }),
            );
          }
        }
      } catch (err) {
        console.error('[seances] init failed:', err);
      } finally {
        this.loading = false;
      }

      if (this.tickHandle === null && typeof window !== 'undefined') {
        this.tickHandle = window.setInterval(() => {
          this.nowMs = Date.now();
        }, 1000) as unknown as number;
      }
      this._watchActiveSession();
    },

    /**
     * Enregistre la séance en cours à chaque changement significatif (séries,
     * exercices, repos). Les frappes dans le brouillon ne déclenchent rien.
     */
    _watchActiveSession(): void {
      if (this._activeWriter || typeof window === 'undefined') return;
      this._activeWriter = createActiveSessionWriter(async (snap) => {
        const deps = await getDeps();
        await writeActiveSession(deps.storage, snap);
      });
      const persist = (): void => this._persistActive();
      this.$watch?.('currentSession', persist);
      this.$watch?.('restEndsAtMs', persist);
      this.$watch?.('activeExerciseId', persist);
      // iOS peut tuer l'app en arrière-plan : on écrit tout de suite en partant.
      this._onHide = () => {
        if (document.visibilityState === 'hidden') void this._activeWriter?.flush();
      };
      document.addEventListener('visibilitychange', this._onHide);
      window.addEventListener('pagehide', this._onHide);
      // La séance reprise (ou démarrée pendant le chargement) est réenregistrée.
      if (this.currentSession) persist();
    },

    _persistActive(): void {
      if (this._persistOff || !this._activeWriter) return;
      if (this.currentSession) {
        this.resumePrompt = null;
        this.confirmAbandon = false;
      } else if (this.resumePrompt) {
        return; // séance ancienne en attente de décision : on ne l'efface pas
      }
      const snap = snapshotActiveSession(
        {
          session: this.currentSession,
          restEndsAtMs: this.restEndsAtMs,
          restTotalSec: this.restTotalSec,
          restPresetSec: Number(this.restPresetSec),
          activeExerciseId: this.activeExerciseId,
        },
        Date.now(),
      );
      this._activeWriter.schedule(snap);
      announceActiveSession(summarizeActiveSession(snap));
    },

    /** Réinjecte une séance enregistrée : durée depuis l'heure de début, repos restant recalculé. */
    _applyActiveSnapshot(snap: ActiveSessionSnapshot): void {
      const now = Date.now();
      const state = restoreActiveSession(snap, now);
      this.nowMs = now;
      this.currentSession = state.session;
      this.restPresetSec = state.restPresetSec;
      this.restTotalSec = state.restTotalSec;
      if (state.activeExerciseId) this.setActiveEntry(state.activeExerciseId);
      if (state.restRemainingSec > 0) {
        this.restEndsAtMs = state.restEndsAtMs;
        this.fullscreenRest = true;
        this._scheduleRestEndCallback(state.restRemainingSec);
      } else {
        this.restEndsAtMs = 0;
      }
    },

    /** Âge de la séance ancienne proposée à la reprise (« 13 h »). */
    resumePromptAge(): string {
      return this.resumePrompt
        ? formatActiveAge(this.resumePrompt.session.startedAt, this.nowMs)
        : '';
    },

    resumePromptName(): string {
      return this.resumePrompt?.session.name ?? '';
    },

    /** Reprend la séance ancienne malgré son âge. */
    resumeSavedSession(): void {
      const snap = this.resumePrompt;
      if (!snap) return;
      this.resumePrompt = null;
      this._applyActiveSnapshot(snap);
    },

    /** Abandonne la séance ancienne enregistrée (rien n'est ajouté à l'historique). */
    discardSavedSession(): void {
      this.resumePrompt = null;
      if (!this.currentSession) {
        this._activeWriter?.schedule(null);
        announceActiveSession(null);
      }
    },

    askAbandon(): void {
      this.confirmAbandon = true;
    },

    cancelAbandon(): void {
      this.confirmAbandon = false;
    },

    /** Abandon explicite de la séance en cours : rien n'est enregistré dans l'historique. */
    abandonCurrentSession(): void {
      if (!this.currentSession) return;
      this.stopRest();
      this.currentSession = null;
      this.confirmAbandon = false;
      this.templateName = '';
      this._persistActive();
      hapticMedium();
      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'info', message: 'Séance abandonnée.' },
        }),
      );
    },

    /**
     * Tirer pour rafraîchir (lib/native-gestures.ts) : relit exercices, modèles et
     * historique sans toucher à la séance en cours ni aux imports en attente.
     */
    async refresh(): Promise<void> {
      try {
        const deps = await getDeps();
        this.exercises = await loadExercises(deps.storage);
        this.templates = await loadTemplates(deps.storage);
        this.sessions = await loadSessions(deps.storage);
        this.userProfile = await loadUserProfile(deps.storage);
      } catch (err) {
        console.warn('[seances] refresh failed:', err);
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
      // La séance reste enregistrée (bandeau « Séance en cours » sur les autres écrans).
      void this._activeWriter?.flush();
      this._persistOff = true;
      if (this._onHide) {
        document.removeEventListener('visibilitychange', this._onHide);
        window.removeEventListener('pagehide', this._onHide);
        this._onHide = null;
      }
      this.stopRest();
    },

    // ─── Records (PR) ────────────────────────────────────────

    /**
     * Meilleur e1RM pour un exercice — inclut TOUTES les séries déjà
     * enregistrées (séances passées + séance en cours). Sans ça, faire 5×
     * la même série dans la séance actuelle déclencherait 5× la célébration
     * PR car la séance en cours n'est pas dans `this.sessions`.
     */
    /** Record formaté à la française pour l'en-tête d'exercice (« 154 kg », « 97,5 kg »). */
    prLabel(exerciseId: string): string {
      const v = this.pr(exerciseId);
      return v ? v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' kg' : '';
    },

    pr(exerciseId: string): number | null {
      let best = 0;
      for (const s of this.sessions) {
        const entry = s.entries.find((e) => e.exerciseId === exerciseId);
        if (!entry) continue;
        for (const set of entry.sets) {
          const e1rm = estimateE1rmKg(set.weightKg, set.reps);
          if (e1rm > best) best = e1rm;
        }
      }
      // ── Inclure aussi les séries déjà ajoutées à la séance en cours ──
      const currentEntry = this.currentSession?.entries.find((e) => e.exerciseId === exerciseId);
      if (currentEntry) {
        for (const set of currentEntry.sets) {
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
      this.currentSession = {
        id: newId(),
        name: defaultSessionName(),
        startedAt: nowIso(),
        entries: [],
      };
      this.selectedExerciseId = '';
    },

    showAutoGen: false,
    autoGenFocus: 'push' as WorkoutFocus,

    /**
     * Démarre une séance auto-générée pour le focus choisi, en utilisant
     * l'objectif coach courant (force/hypertrophie/endurance).
     */
    startAutoWorkout(focus: WorkoutFocus): void {
      const generated = generateWorkout({
        goal: this.coachGoal,
        focus,
        exercises: this.exercises.map((ex) => ({
          id: ex.id,
          name: ex.name,
          muscles: ex.muscles,
          equipment: ex.equipment,
        })),
      });
      if (generated.exercises.length === 0) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'warning',
              message: 'Aucun exercice adapté trouvé pour ce focus. Ajoute-en dans ton catalogue.',
            },
          }),
        );
        return;
      }
      this.currentSession = {
        id: newId(),
        name: generated.name,
        startedAt: nowIso(),
        entries: generated.exercises.map((ex) => ({ exerciseId: ex.exerciseId, sets: [] })),
      };
      this.showAutoGen = false;
      this.showTemplates = false;
      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: {
            kind: 'success',
            message: `Séance auto-générée : ${generated.exercises.length} exercices`,
          },
        }),
      );
    },

    /**
     * Re-démarre la dernière séance terminée : clone ses exercices dans une
     * nouvelle séance. Les séries restent vides (l'utilisateur les remplit en
     * temps réel) — il a juste à pas se reposer la question "quels exos ?".
     */
    quickRestartLast(): void {
      const lastFinished = [...this.sessions]
        .filter((s) => s.endedAt)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (!lastFinished) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'info', message: 'Aucune séance précédente à reprendre.' },
          }),
        );
        return;
      }
      this.currentSession = {
        id: newId(),
        name: `${lastFinished.name} (reprise)`,
        startedAt: nowIso(),
        entries: lastFinished.entries.map((e) => ({ exerciseId: e.exerciseId, sets: [] })),
      };
      this.showTemplates = false;
      this.showAutoGen = false;
      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: {
            kind: 'success',
            message: `Reprise : ${plural(lastFinished.entries.length, 'exercice chargé', 'exercices chargés')}.`,
          },
        }),
      );
    },

    get hasFinishedSession(): boolean {
      return this.sessions.some((s) => s.endedAt);
    },

    /**
     * Partage un template via URL. On utilise targetReps/Rpe=8 comme défaut
     * si non renseigné — l'app destinataire les recevra et pourra les ajuster.
     */
    async shareTemplate(templateId: string): Promise<void> {
      const t = this.templates.find((x) => x.id === templateId);
      if (!t) return;
      const token = encodeWorkout({
        name: t.name,
        exercises: t.exercises.map((ex) => ({
          exerciseId: ex.exerciseId,
          sets: ex.sets,
          targetReps: ex.targetReps,
          targetRpe: ex.targetRpe,
        })),
      });
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const url = buildShareUrl(origin, token);

      // Tentative API Web Share native, fallback clipboard
      try {
        const nav = navigator as Navigator & {
          share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
        };
        if (typeof nav.share === 'function') {
          await nav.share({ title: `Séance Kinetic — ${t.name}`, url });
          return;
        }
      } catch {
        /* L'utilisateur a annulé OU pas supporté → fallback clipboard */
      }
      try {
        await navigator.clipboard.writeText(url);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: 'Lien copié dans le presse-papier ✓' },
          }),
        );
      } catch {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'info',
              message: `Lien : ${url.slice(0, 60)}…`,
            },
          }),
        );
      }
    },

    startFromTemplate(templateId: string): void {
      const t = this.templates.find((x) => x.id === templateId);
      if (!t) return;
      this.currentSession = {
        id: newId(),
        name: t.name,
        templateId: t.id,
        startedAt: nowIso(),
        entries: t.exercises.map((ex) => ({ exerciseId: ex.exerciseId, sets: [] })),
      };
      this.showTemplates = false;
    },

    async deleteTemplate(templateId: string): Promise<void> {
      const deps = await getDeps();
      this.templates = this.templates.filter((t) => t.id !== templateId);
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
      return this.restEndsAtMs
        ? Math.max(0, Math.ceil((this.restEndsAtMs - this.nowMs) / 1000))
        : 0;
    },

    restLabel(): string {
      const sec = this.restRemainingSec();
      if (!sec) return '';
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    },

    /** Résumé d'une ligne du conseil : « 62,5 kg × 9 · RPE 8 » (visible replié). */
    coachSummary(exerciseId: string): string {
      const a = this.coachAdvice(exerciseId) as
        | { weightKg?: number; reps?: number; rpe?: number }
        | null
        | undefined;
      if (!a || !a.weightKg || !a.reps) return 'Voir le conseil';
      const kg = a.weightKg.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
      return `${kg} kg × ${a.reps}${a.rpe ? ` · RPE ${a.rpe}` : ''}`;
    },

    /** Largeur de la barre de progression du repos (objet style, compatible CSP). */
    restProgressStyle(): { width: string } {
      const total = Math.max(1, Number(this.restPresetSec) || 90);
      const left = this.restRemainingSec();
      const pct = Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));
      return { width: `${pct}%` };
    },

    /** Anneau du repos : part restante, se vide jusqu'à zéro (style CSP « --p: N »). */
    restRingStyle(): string {
      return `--p: ${ringPct(this.restRemainingSec(), Math.max(1, this.restTotalSec))}`;
    },

    /** Dernières secondes du repos : l'anneau et le chiffre passent en couleur d'alerte. */
    restEnding(): boolean {
      return this.restRemainingSec() <= 5;
    },

    /** `quiet` : déjà signalé par une vibration (série validée), pas de seconde secousse. */
    startRest(quiet = false): void {
      const sec = Math.max(15, Math.min(600, Math.floor(Number(this.restPresetSec)) || 90));
      this.restPresetSec = sec;
      this.restTotalSec = sec;
      this.restEndsAtMs = this.nowMs + sec * 1000;
      this.fullscreenRest = true;
      if (quiet !== true) hapticMedium();
      this._scheduleRestEndCallback(sec);
    },

    /**
     * (Re)programme le callback de fin de repos. Extrait pour pouvoir
     * être appelé depuis addRestSec() qui modifie restEndsAtMs en cours.
     */
    _scheduleRestEndCallback(sec: number): void {
      if (this._restNotifTimer) clearTimeout(this._restNotifTimer);
      const fire = (): void => {
        hapticHeavy();
        this.fullscreenRest = false;
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            new Notification('Repos terminé !', {
              body: 'Prêt pour la série suivante',
              icon: '/icons/icon-96.png',
              tag: 'rest',
            });
          } catch {
            /* noop */
          }
        }
      };
      this._restNotifTimer = setTimeout(fire, Math.max(0, sec * 1000));
    },

    stopRest(): void {
      this.restEndsAtMs = 0;
      this.fullscreenRest = false;
      if (this._restNotifTimer) {
        clearTimeout(this._restNotifTimer);
        this._restNotifTimer = null;
      }
    },

    /** Termine immédiatement le repos (déclenche le retour à l'action). */
    skipRest(): void {
      this.stopRest();
      hapticMedium();
    },

    /** Ajoute (ou retire) des secondes au repos en cours. Borné à [5s, 10min]. */
    addRestSec(delta: number): void {
      if (this.restEndsAtMs <= 0) return;
      const remaining = Math.max(0, Math.ceil((this.restEndsAtMs - this.nowMs) / 1000));
      const next = Math.max(5, Math.min(600, remaining + delta));
      this.restEndsAtMs = this.nowMs + next * 1000;
      if (next > this.restTotalSec) this.restTotalSec = next;
      this._scheduleRestEndCallback(next);
      hapticLight();
    },

    // ─── Raccourcis +/- sur le draft ───────────────────────────────────────
    bumpReps(delta: number): void {
      const current = Number(this.draft.reps) || 0;
      this.draft.reps = Math.max(1, current + delta);
      hapticLight();
    },

    bumpWeight(delta: number): void {
      // Le pas dépend de l'exercice dont la saisie est ouverte
      const entry =
        this.currentEntries.find((e) => this.isActiveEntry(e.exerciseId)) ??
        this.currentSession?.entries[0];
      const ex = entry ? this.exercises.find((e) => e.id === entry.exerciseId) : null;
      const step = ex?.incrementKg ?? 2.5;
      const current = Number(this.draft.weightKg) || 0;
      const next = Math.max(0, current + delta * step);
      // Snap à un pas de 0.25 pour éviter les flottants moches
      this.draft.weightKg = Math.round(next * 4) / 4;
      hapticLight();
    },

    bumpRpe(delta: number): void {
      const current = Number(this.draft.rpe) || 8;
      const next = Math.max(6, Math.min(10, Math.round((current + delta) * 2) / 2));
      this.draft.rpe = next;
      hapticLight();
    },

    avgRpeOf(session: WorkoutSession | null): number | null {
      if (!session) return null;
      const rpes: number[] = session.entries.flatMap((e) => e.sets.map((s) => s.rpe));
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
      if (this.currentSession.entries.some((e) => e.exerciseId === this.selectedExerciseId)) return;
      this.currentSession = {
        ...this.currentSession,
        entries: [
          ...this.currentSession.entries,
          { exerciseId: this.selectedExerciseId, sets: [] },
        ],
      };
      this.setActiveEntry(this.selectedExerciseId);
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
      if (!Number.isFinite(reps) || reps <= 0) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'Reps invalides (min 1).' },
          }),
        );
        return;
      }
      if (!Number.isFinite(weightKg) || weightKg < 0) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'Charge invalide (≥ 0 kg).' },
          }),
        );
        return;
      }
      if (!Number.isFinite(rpe) || rpe < 6 || rpe > 10) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'RPE invalide (6–10).' },
          }),
        );
        return;
      }

      const entry = this.currentSession.entries.find((e) => e.exerciseId === exerciseId);
      if (!entry) return;

      // ── Détecter PR AVANT d'ajouter la série ─────────────────────────────
      const isPr = this.isNewPr(exerciseId, weightKg, reps);
      // Pas de célébration plein écran pour la toute première série d'un
      // exercice : ce n'est pas un record battu, juste une première référence.
      const hadRecord = this.pr(exerciseId) !== null;

      const note = (this.draft.note ?? '').toString().trim().slice(0, 200);
      this.currentSession = {
        ...this.currentSession,
        entries: this.currentSession.entries.map((e) => {
          if (e.exerciseId !== exerciseId) return e;
          return {
            ...e,
            sets: [
              ...e.sets,
              {
                setIndex: e.sets.length,
                reps,
                weightKg,
                rpe,
                performedAt: nowIso(),
                ...(note ? { note } : {}),
              },
            ],
          };
        }),
      };
      // Vide la note après ajout (le tempo reste pour les sets suivants)
      this.draft.note = '';
      // La saisie reste ouverte sur l'exercice qu'on vient de travailler
      this.setActiveEntry(exerciseId);

      if (isPr && hadRecord) {
        // Carte flottante de la coquille (lib/celebration.ts) : ne bloque pas la
        // saisie et vibre elle-même (impact fort, une fois).
        celebrate(recordCelebration(this.exerciseName(exerciseId), weightKg, reps));
      } else {
        hapticSuccess(); // série validée
      }

      // Auto-démarrer le chrono de repos après chaque série (durée basée sur le RPE)
      this.restPresetSec = this.smartRestSec();
      this.startRest(true);
    },

    /** Historique de sets pour un exercice, toutes séances confondues (du plus ancien au plus récent). */
    _historyForExercise(exerciseId: string): PerformedSet[] {
      const sorted = [...this.sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return sorted.flatMap((s) =>
        (s.entries.find((e) => e.exerciseId === exerciseId)?.sets ?? []).map((set) => ({
          reps: set.reps,
          weightKg: set.weightKg,
          rpe: set.rpe,
          at: set.performedAt,
        })),
      );
    },

    /** Suggestion de progression complète pour l'exercice courant. */
    progressionSuggestion(exerciseId: string): ProgressionSuggestion | null {
      if (!exerciseId) return null;
      // Invalidate cache when sessions array grows (new session saved).
      const cacheVersion = sessionsCacheVersion(this.sessions);
      if (this._suggestionCacheVersion !== cacheVersion) {
        this._suggestionCache = new Map();
        this._suggestionCacheVersion = cacheVersion;
      }
      if (!this._suggestionCache) this._suggestionCache = new Map();
      if (this._suggestionCache.has(exerciseId)) {
        return this._suggestionCache.get(exerciseId) ?? null;
      }
      const ex = this.exercises.find((e) => e.id === exerciseId);
      const history = this._historyForExercise(exerciseId);
      const result = suggestProgression({
        exerciseId,
        targetReps: 8,
        targetRpe: 8,
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

    async exportJson(): Promise<void> {
      try {
        await exportAsJson(this.sessions, this.exercises);
      } catch (err) {
        console.error('[seances] exportJson failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec export JSON. Réessaie.' },
          }),
        );
      }
    },

    async exportCsv(): Promise<void> {
      try {
        await exportAsCsv(this.sessions, this.exercises);
      } catch (err) {
        console.error('[seances] exportCsv failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec export CSV. Réessaie.' },
          }),
        );
      }
    },

    // ─── Détails / suppression d'une séance ─────────────────────────────────

    expandedSessionId: null as string | null,
    confirmDeleteId: null as string | null,
    deletingSession: false,

    /** Nombre de séances affichées dans l'historique (les plus récentes). */
    historyLimit: 5,

    /** Séances visibles dans l'historique, de la plus récente à la plus ancienne. */
    visibleSessions(): WorkoutSession[] {
      return this.sessions.slice().reverse().slice(0, this.historyLimit);
    },

    /** Déplie tout l'historique. */
    showAllHistory(): void {
      this.historyLimit = this.sessions.length;
    },

    /** Bascule l'affichage détaillé d'une séance dans l'historique. */
    toggleSessionDetail(id: string): void {
      this.expandedSessionId = this.expandedSessionId === id ? null : id;
    },

    /** Demande de confirmation avant suppression. */
    askDeleteSession(id: string): void {
      this.confirmDeleteId = id;
    },

    cancelDelete(): void {
      this.confirmDeleteId = null;
    },

    /** Supprime définitivement une séance et persiste. */
    async deleteSession(id: string): Promise<void> {
      if (this.deletingSession) return;
      this.deletingSession = true;
      try {
        const deps = await getDeps();
        const next = this.sessions.filter((s) => s.id !== id);
        await deleteSessionFromStorage(deps.storage, id);
        this.sessions = next;
        this.confirmDeleteId = null;
        this.expandedSessionId = null;
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: 'Séance supprimée.' },
          }),
        );
      } catch (err) {
        console.error('[seances] deleteSession failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec de la suppression.' },
          }),
        );
      } finally {
        this.deletingSession = false;
      }
    },

    /** Retourne le nom de l'exercice à partir de son id. */
    exerciseNameOf(id: string): string {
      return this.exercises.find((e) => e.id === id)?.name ?? id;
    },

    /** e1RM Epley pour un set donné. */
    setE1rm(weightKg: number, reps: number): number {
      return Math.round(estimateE1rmKg(weightKg, reps) * 10) / 10;
    },

    /** Jour du mois (« 14 ») pour la pastille de date de l'historique. */
    dateDay(iso: string): string {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : String(d.getDate());
    },

    /** Mois abrégé (« nov. ») pour la pastille de date de l'historique. */
    dateMonth(iso: string): string {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { month: 'short' });
    },

    /** Date au format long pour l'entête de détail. */
    formatDateLong(iso: string): string {
      try {
        return new Date(iso).toLocaleDateString('fr-FR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
      } catch {
        return iso;
      }
    },

    /** Heure HH:mm. */
    formatTime(iso: string): string {
      try {
        const d = new Date(iso);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      } catch {
        return '';
      }
    },

    // ─── Coach ────────────────────────────────────────────────────────────

    setCoachGoal(goal: CoachGoal): void {
      if (!isCoachGoal(goal)) return;
      this.coachGoal = goal;
      try {
        localStorage.setItem(STORAGE_KEYS.COACH_GOAL, goal);
      } catch (err) {
        // Quota dépassé / mode privé : on garde le choix en mémoire pour la
        // session, sans bloquer l'UI. Au pire, le goal repasse au défaut au reload.
        console.warn('[seances] setCoachGoal: localStorage unavailable', err);
      }
    },

    /**
     * Retourne un conseil de poids personnalisé selon l'objectif choisi.
     * Bases scientifiques :
     *  - Force       : Prilepin (1974), NSCA — 3–5 reps @ RPE 8–9
     *  - Hypertrophie: Schoenfeld (2010), Helms et al. (2018) — 6–12 reps @ RPE 7–9
     *  - Endurance   : ACSM (2009) — 15+ reps @ RPE 6–8
     */
    coachAdvice(exerciseId: string): {
      weightKg: number;
      reps: number;
      rpe: number;
      message: string;
      goalLabel: string;
      science: string;
      periodizationNote: string;
    } | null {
      if (!exerciseId) return null;
      const ex = this.exercises.find((e) => e.id === exerciseId);
      const history = this._historyForExercise(exerciseId);
      const preset = COACH_GOALS[this.coachGoal as CoachGoal];

      if (!history.length) {
        return {
          weightKg: 0,
          reps: preset.targetReps,
          rpe: preset.targetRpe,
          goalLabel: preset.label,
          science: preset.science,
          message: `Première séance. Commence léger (RPE 6–7) pour trouver ta charge, puis vise ${preset.rpeZone}.`,
          periodizationNote: '',
        };
      }

      const last = history[history.length - 1]!;
      const inc = ex?.incrementKg ?? 2.5;

      // e1RM Epley du dernier set
      const lastE1rm = estimateE1rmKg(last.weightKg, last.reps);

      // Poids de travail pour la cible de l'objectif (Epley inverse)
      const rawWeight = lastE1rm / (1 + preset.targetReps / 30);
      const suggestedWeight = Math.round(rawWeight / inc) * inc;

      // Ajustement selon RPE du dernier set vs RPE cible
      const rpeDelta = last.rpe - preset.targetRpe;
      let message = '';

      if (!history.length || last.weightKg === 0) {
        message = `Commence léger pour calibrer — vise ${preset.rpeZone}.`;
      } else if (rpeDelta <= -1.5) {
        const higher = Math.round((suggestedWeight + inc) / inc) * inc;
        message = `Trop facile la dernière fois (RPE ${last.rpe} vs cible ${preset.targetRpe}). Monte à ${higher} kg × ${preset.targetReps}.`;
      } else if (rpeDelta <= -0.5) {
        message = `Légèrement en dessous de la cible (RPE ${last.rpe}). Essaie ${suggestedWeight + inc} kg × ${preset.targetReps} ou reste sur ${suggestedWeight} kg.`;
      } else if (rpeDelta <= 0.5) {
        message = `Tu es exactement dans la zone (RPE ${last.rpe}). Maintiens ${suggestedWeight} kg × ${preset.targetReps} @ RPE ${preset.targetRpe}.`;
      } else if (rpeDelta <= 1.5) {
        message = `Un peu au-dessus de la cible (RPE ${last.rpe}). Reste sur ${suggestedWeight} kg et cible ${preset.targetRpe} de RPE.`;
      } else {
        const lower = Math.max(0, Math.round((suggestedWeight - inc) / inc) * inc);
        message = `RPE ${last.rpe} — c'était trop lourd pour cet objectif. Recule à ${lower} kg × ${preset.targetReps} pour rester dans la zone ${preset.rpeZone}.`;
      }

      // ── Note de périodisation (Coach Avancé, niveau 3+) ─────────────────
      let periodizationNote = '';
      if (history.length >= 3) {
        const recent3 = history.slice(-3);
        const avgRpe = recent3.reduce((s, h) => s + h.rpe, 0) / 3;
        const e1rms = recent3.map((h) => estimateE1rmKg(h.weightKg, h.reps));
        const e1rmProgression = e1rms[2]! - e1rms[0]!;

        if (avgRpe >= 9.0) {
          periodizationNote =
            'Fatigue accumulée détectée (RPE moyen ≥ 9 sur 3 séances). Envisage une semaine de décharge à 60 % du volume habituel.';
        } else if (e1rmProgression > 0 && avgRpe < preset.targetRpe + 0.5) {
          periodizationNote = `Bonne progression : +${loc(e1rmProgression.toFixed(1))} kg d'e1RM sur les 3 dernières séances. Continue la surcharge progressive.`;
        } else if (Math.abs(e1rmProgression) < 1.5 && history.length >= 4) {
          periodizationNote =
            "Stagnation possible : l'e1RM évolue peu depuis 3–4 séances. Envisage de changer le schéma de répétitions ou d'ajouter une série.";
        }
      }

      return {
        weightKg: suggestedWeight,
        reps: preset.targetReps,
        rpe: preset.targetRpe,
        goalLabel: preset.label,
        science: preset.science,
        message,
        periodizationNote,
      };
    },

    /** Calcule le poids de travail recommandé depuis un e1RM entré manuellement. */
    e1rmToWorkingWeight(e1rm: number, reps: number, exerciseId: string): number {
      if (!e1rm || !reps) return 0;
      const ex = this.exercises.find((e) => e.id === exerciseId);
      const inc = ex?.incrementKg ?? 2.5;
      const raw = e1rm / (1 + reps / 30);
      return Math.round(raw / inc) * inc;
    },

    // ─── Progression ─────────────────────────────────────────

    progressPoints(): { x: number; y: number; label: string }[] {
      if (!this.progressExerciseId) return [];
      const points: { x: number; y: number; label: string }[] = [];

      for (const session of this.sessions) {
        const entry = session.entries.find((e) => e.exerciseId === this.progressExerciseId);
        if (!entry || !entry.sets.length) continue;
        let y = 0;
        if (this.progressMetric === 'weight') {
          y = Math.max(...entry.sets.map((s) => s.weightKg));
        } else if (this.progressMetric === 'volume') {
          y = entry.sets.reduce((acc, s) => acc + s.weightKg * s.reps, 0);
        } else {
          for (const s of entry.sets) y = Math.max(y, estimateE1rmKg(s.weightKg, s.reps));
        }
        if (y > 0)
          points.push({
            x: Date.parse(session.startedAt),
            y,
            label: this.formatDate(session.startedAt),
          });
      }

      return points.sort((a, b) => a.x - b.x);
    },

    progressMin(): number {
      const pts = this.progressPoints();
      return pts.length ? Math.min(...pts.map((p) => p.y)) : 0;
    },

    progressMax(): number {
      const pts = this.progressPoints();
      return pts.length ? Math.max(...pts.map((p) => p.y)) : 0;
    },

    progressSvg(): string {
      const pts = this.progressPoints();
      if (pts.length < 2) return '';
      // Style « Santé » iOS : courbe à l'accent, record en ambre (comme « Nouveau
      // Record »), quadrillage et libellés en currentColor (gris du conteneur,
      // donc lisibles en mode clair comme en sombre).
      const W = 320,
        H = 160,
        padL = 6,
        padR = 34, // colonne des valeurs à droite
        padT = 10,
        padB = 22; // ligne des dates en bas
      // Palette : courbe à l'accent (corail), record en ambre ; classes
      // Tailwind car x-svg retire les attributs style.
      const LINE_FILL = 'fill-kinetic-neon';
      const LINE_STROKE = 'stroke-kinetic-neon';
      const RECORD_FILL = 'fill-kinetic-gold';
      const minX = pts[0]!.x,
        maxX = pts.at(-1)!.x;
      const minY = this.progressMin(),
        maxY = this.progressMax();
      const dx = Math.max(1, maxX - minX),
        dy = Math.max(0.1, maxY - minY);
      const plotR = W - padR;
      const plotB = H - padB;
      const sx = (x: number) => padL + ((x - minX) / dx) * (plotR - padL);
      const sy = (y: number) => plotB - ((y - minY) / dy) * (plotB - padT);
      const line = pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`)
        .join(' ');
      const area = `${line} L ${sx(pts.at(-1)!.x).toFixed(1)} ${plotB} L ${sx(minX).toFixed(1)} ${plotB} Z`;
      const fmt = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
      const gridValues = maxY - minY < 0.5 ? [maxY] : [maxY, (maxY + minY) / 2, minY];
      const grid = gridValues
        .map((v) => {
          const y = sy(v).toFixed(1);
          return `<line x1="${padL}" x2="${plotR}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity="0.28" stroke-width="1" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/><text x="${W - 2}" y="${y}" fill="currentColor" font-size="11" text-anchor="end" dominant-baseline="middle">${fmt(v)}</text>`;
        })
        .join('');
      const firstLabel = pts[0]!.label;
      const lastLabel = pts.at(-1)!.label;
      const dates = `<text x="${padL}" y="${H - 4}" fill="currentColor" font-size="11">${firstLabel}</text><text x="${plotR}" y="${H - 4}" fill="currentColor" font-size="11" text-anchor="end">${lastLabel}</text>`;
      const circles = pts
        .map((p) => {
          const isRecord = p.y >= maxY;
          return `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${isRecord ? 5 : 3}" class="${isRecord ? `${RECORD_FILL} stroke-kinetic-surface` : LINE_FILL}"${isRecord ? ' stroke-width="2.5"' : ''}><title>${p.label} : ${p.y.toFixed(1)}</title></circle>`;
        })
        .join('');
      const metric =
        this.progressMetric === 'weight'
          ? 'Charge max (kg)'
          : this.progressMetric === 'volume'
            ? 'Volume (kg·reps)'
            : 'e1RM (kg)';
      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="${metric}">
        ${grid}
        <path d="${area}" class="${LINE_FILL}" fill-opacity="0.12"/>
        <path d="${line}" class="${LINE_STROKE}" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${circles}
        ${dates}
      </svg>`;
    },

    // ─── Save ────────────────────────────────────────────────

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
          ...(avgRpe != null ? { avgRpe } : {}),
          ...(caloriesKcal != null ? { caloriesKcal } : {}),
        };
        // Persist FIRST so a write failure doesn't leave the UI in an
        // inconsistent state (session shown in history but not on disk).
        const next = [...this.sessions, finalized];
        await saveSession(deps.storage, finalized);
        this.sessions = next;
        this.currentSession = null;
        this.templateName = '';
        this.stopRest();
        this._persistActive(); // séance sauvegardée : plus rien à reprendre
        hapticSuccess(); // séance sauvegardée

        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'success',
              message: `Séance sauvegardée — ${durationMin} min${caloriesKcal ? ` · ~${caloriesKcal} kcal` : ''}`,
            },
          }),
        );
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_SESSION_SAVED, {
            detail: { session: finalized },
          }),
        );
      } catch (err) {
        console.error('[seances] save failed:', err);
        const name = err instanceof Error ? err.name : 'Error';
        const isQuota = /Quota/i.test(name) || /Quota/i.test((err as Error)?.message ?? '');
        const message = isQuota
          ? 'Stockage plein — va dans Profil → Stockage et appuie sur "Compacter" pour libérer de la place.'
          : `Échec de sauvegarde (${name}). Réessaie ou recharge la page.`;
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message },
          }),
        );
      }
    },

    async saveTemplateFromCurrent(): Promise<void> {
      if (!this.currentSession) return;
      const name = this.templateName.trim();
      if (!name) return;
      try {
        const deps = await getDeps();
        const template: WorkoutTemplate = {
          id: newId(),
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
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: `Modèle "${name}" créé` },
          }),
        );
      } catch (err) {
        console.error('[seances] saveTemplate failed:', err);
        const name = err instanceof Error ? err.name : 'Error';
        const detail = err instanceof Error && err.message ? err.message.slice(0, 120) : '';
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'error',
              message: `Échec création du modèle (${name})${detail ? ` — ${detail}` : ''}. Réessaie.`,
            },
          }),
        );
      }
    },
  };
}
