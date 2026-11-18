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
  workSetsOf,
  warmupSetsOf,
  isWarmupSet,
  lastPerformance,
  formatSetsShort,
  formatSetShort,
  matchingLastSet,
  nextSetTarget,
  warmupRamp,
  validateSetInput,
  updateSessionSet,
  removeSessionSet,
  insertSessionSet,
  forgottenSet,
  retimeSession,
  workAvgRpe,
  toLocalInputValue,
  exerciseMeasure,
  isTimedSet,
  loadSetsOf,
  parseDuration,
  parseDistance,
  distanceInputValue,
  defaultDistanceUnit,
  formatDuration,
  formatDistance,
  validateTimedSetInput,
  timedSetFields,
  bestTimed,
  isTimedRecord,
  normalizeSupersets,
  supersetBlocks,
  supersetLabel,
  canLinkWithNext,
  linkWithNext,
  unlinkSuperset,
  indexOfExercise,
  supersetNextStep,
  type ExerciseMeasure,
  type SupersetBlock,
  type TimedBest,
  type LastPerformance,
  type SetTarget,
  type ProgressionSuggestion,
  type PerformedSet,
  type WorkoutFocus,
  type SubstitutionResult,
  type ExerciseCues,
} from '@kinetic/core';
import { UuidGenerator } from '@kinetic/adapters-web';
import { getDeps } from '../deps';
import { openTemplateEditor } from '../lib/training/template-editor-nav';
import type {
  Exercise,
  SetEntry,
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
import { scheduleRestAlert, cancelRestAlert } from '../lib/training/rest-alert';
import { exportAsJson, exportAsCsv } from '../lib/training/export';
import { hapticLight, hapticMedium, hapticSuccess, hapticHeavy } from '../lib/haptics';
import { celebrate, recordCelebration } from '../lib/celebration';
import { loadTrainingCalendar } from '../lib/lazy-component';
import { sessionShareSheet } from '../lib/session-share-sheet';
import { exerciseIllustrations } from '../lib/exercise-illustrations';
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

type Draft = {
  reps: number;
  weightKg: number;
  rpe: number;
  note: string;
  tempo: string;
  /** Exercice chronométré : durée saisie (« 1:30 ») et distance (dans `draftDistUnit`). */
  duration: string;
  distance: string;
};

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
  entries: ReadonlyArray<{
    sets: ReadonlyArray<{ weightKg: number; reps: number; kind?: string | undefined }>;
  }>,
): number {
  return entries.reduce(
    (acc, e) => acc + workSetsOf(e.sets).reduce((a, s) => a + (s.weightKg || 0) * (s.reps || 0), 0),
    0,
  );
}

/** Séries réordonnées : échauffements d'abord, puis travail ; setIndex renuméroté. */
function orderSets(sets: readonly SetEntry[]): SetEntry[] {
  return [...warmupSetsOf(sets), ...workSetsOf(sets)].map((set, i) => ({ ...set, setIndex: i }));
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
    // « Partager en image » (fin de séance, historique) : lib/session-share-sheet.ts
    ...sessionShareSheet(),
    // Schémas d'exercices (consignes, choix d'exercice) : lib/exercise-illustrations.ts
    ...exerciseIllustrations(),
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

    draft: {
      reps: 8,
      weightKg: 40,
      rpe: 8,
      note: '',
      tempo: '',
      duration: '',
      distance: '',
    } as Draft,
    showSetExtras: false,

    // ─── Exercices chronométrés / distance ─────────────────────────
    /** Unité du champ distance de la saisie. */
    draftDistUnit: 'm' as 'm' | 'km',
    /** Chronomètre de la série en cours (heure de départ absolue). */
    stopwatch: null as { exerciseId: string; startMs: number } | null,
    /** Menu « ⋯ » ouvert (superset) : id de l'exercice. */
    menuFor: null as string | null,

    nowMs: Date.now(),
    tickHandle: null as number | null,
    restEndsAtMs: 0,
    restPresetSec: 90,
    /** Durée totale du repos en cours (s), pour l'anneau. Suit les +15 s. */
    restTotalSec: 90,
    fullscreenRest: false,
    _restNotifTimer: null as ReturnType<typeof setTimeout> | null,
    _restAlertTimer: null as ReturnType<typeof setTimeout> | null,

    // ─── Saisie : la dernière fois, échauffement ─────────────────────────
    /** Prochaine série saisie en échauffement (pas de repos auto, ni record). */
    draftWarmup: false,
    /** Exercice + nombre de séries de travail pour lequel le brouillon a été pré-rempli. */
    _draftKey: '',
    _lastCache: new Map<string, LastPerformance<SetEntry> | null>(),
    _lastCacheVersion: '',
    /** Réglages du calculateur de disques (barre, disques disponibles). */
    _plates: null as { barKg?: number; enabledPlates?: number[] } | null,

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
      const fallback = entries.find((e) => workSetsOf(e.sets).length === 0) ?? entries.at(-1);
      return fallback?.exerciseId === exerciseId;
    },

    /** Nombre total de séries de la séance en cours. */
    sessionSetCount(): number {
      return this.currentEntries.reduce((n, e) => n + workSetsOf(e.sets).length, 0);
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
      return this.currentEntries.filter((e) => workSetsOf(e.sets).length > 0).length;
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
        if (ex.hidden) continue; // exercice perso masqué : gardé pour l'historique seulement
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
        this._plates = await deps.storage.get<{ barKg?: number; enabledPlates?: number[] }>(
          STORAGE_KEYS.PLATE_PREFS,
        );

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
      const sync = (): void => this._syncDraft();
      this.$watch?.('currentSession', sync);
      this.$watch?.('activeExerciseId', sync);
      // iOS peut tuer l'app en arrière-plan : on écrit tout de suite en partant.
      // Au retour (déverrouillage, app rouverte), le minuteur figé est recalé.
      this._onHide = () => {
        if (document.visibilityState === 'hidden') void this._activeWriter?.flush();
        else this._resyncRest();
      };
      document.addEventListener('visibilitychange', this._onHide);
      document.addEventListener('resume', this._onHide); // Capacitor : app au premier plan
      window.addEventListener('pagehide', this._onHide);
      // La séance reprise (ou démarrée pendant le chargement) est réenregistrée.
      if (this.currentSession) persist();
      sync();
    },

    /** Retour au premier plan : temps restant recalculé, repos fini pendant l'absence → terminé. */
    _resyncRest(): void {
      this.nowMs = Date.now();
      if (this.restEndsAtMs <= 0) return;
      const left = Math.ceil((this.restEndsAtMs - this.nowMs) / 1000);
      if (left <= 0) this.stopRest();
      else this._scheduleRestEndCallback(left, false);
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
      void cancelRestAlert();
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
      this.stopwatch = null; // le chronomètre ne survit pas à la séance
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
        document.removeEventListener('resume', this._onHide);
        window.removeEventListener('pagehide', this._onHide);
        this._onHide = null;
      }
      // Minuteurs seulement : le repos reste enregistré et son alerte système
      // programmée sonne même si on a quitté l'écran Séances.
      this._clearRestTimers();
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
      if (this.isTimed(exerciseId)) {
        const best = this._bestTimed(exerciseId);
        if (!best) return '';
        return best.distanceM > 0 && this.isDistance(exerciseId)
          ? formatDistance(best.distanceM)
          : best.durationSec > 0
            ? formatDuration(best.durationSec)
            : '';
      }
      const v = this.pr(exerciseId);
      return v ? v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' kg' : '';
    },

    pr(exerciseId: string): number | null {
      let best = 0;
      for (const s of this.sessions) {
        const entry = s.entries.find((e) => e.exerciseId === exerciseId);
        if (!entry) continue;
        for (const set of workSetsOf(entry.sets)) {
          const e1rm = estimateE1rmKg(set.weightKg, set.reps);
          if (e1rm > best) best = e1rm;
        }
      }
      // ── Inclure aussi les séries déjà ajoutées à la séance en cours ──
      const currentEntry = this.currentSession?.entries.find((e) => e.exerciseId === exerciseId);
      if (currentEntry) {
        for (const set of workSetsOf(currentEntry.sets)) {
          const e1rm = estimateE1rmKg(set.weightKg, set.reps);
          if (e1rm > best) best = e1rm;
        }
      }
      return best > 0 ? best : null;
    },

    /** True si la série en cours serait un nouveau PR */
    isNewPr(exerciseId: string, weightKg: number, reps: number): boolean {
      if (exerciseId && this.isTimed(exerciseId)) return this.isNewTimedPr(exerciseId);
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
        entries: normalizeSupersets(
          lastFinished.entries.map((e) => ({
            exerciseId: e.exerciseId,
            sets: [],
            ...(e.group ? { group: e.group } : {}),
          })),
        ),
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
        entries: normalizeSupersets(
          t.exercises.map((ex) => ({
            exerciseId: ex.exerciseId,
            sets: [],
            ...(ex.group ? { group: ex.group } : {}),
          })),
        ),
      };
      this.showTemplates = false;
    },

    // Le build CSP d'Alpine refuse plusieurs instructions dans un @click.
    toggleTemplates(): void {
      this.showTemplates = !this.showTemplates;
      this.showAutoGen = false;
    },
    toggleAutoGen(): void {
      this.showAutoGen = !this.showAutoGen;
      this.showTemplates = false;
    },

    /** Éditeur de modèle (page /modele) : modèle existant ou vide. */
    editTemplate(templateId: string): void {
      openTemplateEditor(templateId);
    },
    newTemplate(): void {
      openTemplateEditor();
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
    _scheduleRestEndCallback(sec: number, native = true): void {
      this._clearRestTimers();
      const ms = Math.max(0, sec * 1000);
      // Application : alerte système à l'heure de fin, pour le téléphone verrouillé.
      if (native) void scheduleRestAlert(Date.now() + ms, this._restExerciseName());
      // Au premier plan, l'écran prend le relais : l'alerte système ferait doublon.
      this._restAlertTimer = setTimeout(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          void cancelRestAlert();
        }
      }, ms - 1500);
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
      this._restNotifTimer = setTimeout(fire, ms);
    },

    _clearRestTimers(): void {
      if (this._restNotifTimer) clearTimeout(this._restNotifTimer);
      if (this._restAlertTimer) clearTimeout(this._restAlertTimer);
      this._restNotifTimer = null;
      this._restAlertTimer = null;
    },

    /** Exercice dont la saisie est ouverte (nom affiché dans l'alerte de fin de repos). */
    _restExerciseName(): string {
      const entry = this.currentEntries.find((e) => this.isActiveEntry(e.exerciseId));
      return entry ? this.exerciseName(entry.exerciseId) : '';
    },

    stopRest(): void {
      this.restEndsAtMs = 0;
      this.fullscreenRest = false;
      this._clearRestTimers();
      void cancelRestAlert();
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

    pickRestPreset(sec: number): void {
      this.restPresetSec = sec;
      this.showRestPresets = false;
    },

    /** « Appliquer » : la cible du coach remplit la saisie. */
    applyCoach(exerciseId: string): void {
      const c = this.coachAdvice(exerciseId);
      if (!c) return;
      this.draft.weightKg = c.weightKg;
      this.draft.reps = c.reps;
      this.draft.rpe = c.rpe;
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
      const rpes: number[] = session.entries.flatMap((e) => workSetsOf(e.sets).map((s) => s.rpe));
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
        entries: normalizeSupersets(
          this.currentSession.entries.filter((e) => e.exerciseId !== exerciseId),
        ),
      };
      if (this.stopwatch?.exerciseId === exerciseId) this.stopwatch = null;
      if (this.menuFor === exerciseId) this.menuFor = null;
    },

    addSet(exerciseId: string): void {
      if (!this.currentSession) return;
      if (this.isTimed(exerciseId)) {
        this._addTimedSet(exerciseId);
        return;
      }
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
      const warmup = this.draftWarmup === true;

      // ── Détecter PR AVANT d'ajouter la série (jamais sur un échauffement) ──
      const isPr = !warmup && this.isNewPr(exerciseId, weightKg, reps);
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
            sets: orderSets([
              ...e.sets,
              {
                setIndex: e.sets.length,
                reps,
                weightKg,
                rpe,
                performedAt: nowIso(),
                ...(note ? { note } : {}),
                ...(warmup ? { kind: 'warmup' as const } : {}),
              },
            ]),
          };
        }),
      };
      // Vide la note après ajout (le tempo reste pour les sets suivants)
      this.draft.note = '';
      // La saisie reste ouverte sur l'exercice qu'on vient de travailler
      this.setActiveEntry(exerciseId);
      if (warmup) {
        hapticLight(); // échauffement : ni célébration ni repos automatique
        return;
      }

      if (isPr && hadRecord) {
        // Carte flottante de la coquille (lib/celebration.ts) : ne bloque pas la
        // saisie et vibre elle-même (impact fort, une fois).
        celebrate(recordCelebration(this.exerciseName(exerciseId), weightKg, reps));
      } else {
        hapticSuccess(); // série validée
      }
      this._afterWorkSet(exerciseId);
    },

    /**
     * Après une série de travail : dans un superset, la saisie passe au membre
     * suivant sans repos ; le repos (durée selon le RPE) ne se lance qu'à la fin
     * du tour, la saisie revenant au premier exercice du superset.
     */
    _afterWorkSet(exerciseId: string): void {
      const step = supersetNextStep(this.currentEntries, exerciseId);
      if (step.nextExerciseId) this.setActiveEntry(step.nextExerciseId);
      if (!step.rest) return;
      this.restPresetSec = this.smartRestSec();
      this.startRest(true);
    },

    /** Série chronométrée ou de distance : durée (m:ss), distance, charge facultative. */
    _addTimedSet(exerciseId: string): void {
      if (!this.currentSession) return;
      const measure = this.measureOf(exerciseId);
      if (this.stopwatch?.exerciseId === exerciseId) this.stopStopwatch();
      const input = {
        durationSec: parseDuration(this.draft.duration),
        distanceM:
          measure === 'distance' ? parseDistance(this.draft.distance, this.draftDistUnit) : 0,
        weightKg: Number(this.draft.weightKg) || 0,
        rpe: Number(this.draft.rpe),
      };
      const error = validateTimedSetInput(input, measure);
      if (error) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: error },
          }),
        );
        return;
      }
      const warmup = this.draftWarmup === true;
      const previous = warmup ? null : this._bestTimed(exerciseId);
      const note = (this.draft.note ?? '').toString().trim().slice(0, 200);
      const set: SetEntry = {
        setIndex: 0,
        ...timedSetFields(input),
        performedAt: nowIso(),
        ...(note ? { note } : {}),
        ...(warmup ? { kind: 'warmup' as const } : {}),
      };
      this._updateSets(exerciseId, (sets) => [...sets, set]);
      this.draft.note = '';
      this.setActiveEntry(exerciseId);
      if (warmup) {
        hapticLight();
        return;
      }
      if (isTimedRecord(set, previous)) {
        celebrate({
          kind: 'record',
          title: 'Nouveau record !',
          subtitle: `${this.exerciseName(exerciseId)} ${formatSetShort(set)}`,
        });
      } else {
        hapticSuccess();
      }
      this._afterWorkSet(exerciseId);
    },

    // ─── Mesure d'un exercice ────────────────────────────────

    /** Reps × charge, durée ou distance (enregistrée, sinon déduite du catalogue / du nom). */
    measureOf(exerciseId: string): ExerciseMeasure {
      return exerciseMeasure(this.exercises.find((e) => e.id === exerciseId) ?? { id: exerciseId });
    },

    isTimed(exerciseId: string): boolean {
      return this.measureOf(exerciseId) !== 'reps';
    },

    isDistance(exerciseId: string): boolean {
      return this.measureOf(exerciseId) === 'distance';
    },

    /** Records chronométrés (séances passées + séance en cours). */
    _bestTimed(exerciseId: string): TimedBest | null {
      const all = this.currentSession ? [...this.sessions, this.currentSession] : this.sessions;
      return bestTimed(all, exerciseId);
    },

    /** Série chronométrée égale au record de durée (ou de distance). */
    isTimedSetPr(exerciseId: string, set: SetEntry): boolean {
      const best = this._bestTimed(exerciseId);
      if (!best || isWarmupSet(set)) return false;
      const d = Number(set.durationSec) || 0;
      const m = Number(set.distanceM) || 0;
      return (d > 0 && d >= best.durationSec) || (m > 0 && m >= best.distanceM);
    },

    /** La durée (ou distance) saisie battrait le record. */
    isNewTimedPr(exerciseId: string): boolean {
      if (this.draftWarmup) return false;
      const dist =
        this.measureOf(exerciseId) === 'distance'
          ? parseDistance(this.draft.distance, this.draftDistUnit)
          : 0;
      return isTimedRecord(
        { durationSec: parseDuration(this.draft.duration) || 0, distanceM: dist || 0 },
        this._bestTimed(exerciseId),
      );
    },

    /** « 1:30 », « 400 m en 1:45 » : valeur principale d'une série chronométrée. */
    timedMain(set: SetEntry): string {
      const dist = Number(set.distanceM) > 0 ? formatDistance(Number(set.distanceM)) : '';
      const dur = Number(set.durationSec) > 0 ? formatDuration(Number(set.durationSec)) : '';
      return dist && dur ? `${dist} en ${dur}` : dist || dur;
    },

    /** « 20 kg » (lesté) ou « — » au poids du corps. */
    timedLoad(set: SetEntry): string {
      const kg = Number(set.weightKg) || 0;
      return kg > 0 ? `${kg.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} kg` : '—';
    },

    isTimedEntrySet(set: SetEntry): boolean {
      return isTimedSet(set);
    },

    // ─── Chronomètre intégré ────────────────────────────────

    stopwatchRunning(exerciseId: string): boolean {
      return this.stopwatch?.exerciseId === exerciseId;
    },

    /** Temps écoulé du chronomètre (« 0:42 »), suit le tic de la page. */
    stopwatchLabel(): string {
      if (!this.stopwatch) return '';
      return formatDuration(Math.max(0, Math.floor((this.nowMs - this.stopwatch.startMs) / 1000)));
    },

    /** « Démarrer » / « Arrêter » : à l'arrêt, la durée mesurée remplit la saisie. */
    toggleStopwatch(exerciseId: string): void {
      if (this.stopwatch?.exerciseId === exerciseId) {
        this.stopStopwatch();
        return;
      }
      const now = Date.now();
      this.nowMs = now;
      this.stopwatch = { exerciseId, startMs: now };
      hapticMedium();
    },

    stopStopwatch(): void {
      const sw = this.stopwatch;
      if (!sw) return;
      const sec = Math.max(1, Math.round((Date.now() - sw.startMs) / 1000));
      this.stopwatch = null;
      this.draft.duration = formatDuration(sec);
      hapticMedium();
    },

    /** ±5 s / ±15 s sur la durée saisie. */
    bumpDuration(delta: number): void {
      const cur = parseDuration(this.draft.duration);
      const next = Math.max(0, (Number.isFinite(cur) ? cur : 0) + delta);
      this.draft.duration = next > 0 ? formatDuration(next) : '';
      hapticLight();
    },

    /** Change l'unité du champ distance en convertissant la valeur saisie. */
    setDistUnit(unit: 'm' | 'km'): void {
      if (unit === this.draftDistUnit) return;
      const m = parseDistance(this.draft.distance, this.draftDistUnit);
      this.draftDistUnit = unit;
      this.draft.distance = Number.isFinite(m) && m > 0 ? distanceInputValue(m, unit) : '';
    },

    distUnitIs(unit: 'm' | 'km'): boolean {
      return this.draftDistUnit === unit;
    },

    // ─── Supersets ───────────────────────────────────────────

    /** Exercices de la séance en blocs : un superset = un cadre, un exercice seul = un bloc. */
    entryBlocks(): SupersetBlock<SessionExerciseEntry>[] {
      return supersetBlocks(this.currentEntries);
    },

    /** Clé stable d'un bloc pour x-for. */
    blockKey(block: SupersetBlock<SessionExerciseEntry>): string {
      return block.group ? `g:${block.group}` : `e:${block.items[0]?.exerciseId ?? ''}`;
    },

    /** « A1 », « A2 »… (vide hors superset). */
    supersetTag(exerciseId: string): string {
      return supersetLabel(this.currentEntries, exerciseId);
    },

    toggleMenu(exerciseId: string): void {
      this.menuFor = this.menuFor === exerciseId ? null : exerciseId;
    },

    closeMenu(): void {
      this.menuFor = null;
    },

    _entryIndex(exerciseId: string): number {
      return indexOfExercise(this.currentEntries, exerciseId);
    },

    canLinkNext(exerciseId: string): boolean {
      return canLinkWithNext(this.currentEntries, this._entryIndex(exerciseId));
    },

    canLinkPrev(exerciseId: string): boolean {
      const i = this._entryIndex(exerciseId);
      return i > 0 && canLinkWithNext(this.currentEntries, i - 1);
    },

    /** « Lier en superset avec Tractions » (exercice suivant). */
    linkNextLabel(exerciseId: string): string {
      const next = this.currentEntries[this._entryIndex(exerciseId) + 1];
      return next ? `Lier en superset avec ${this.exerciseName(next.exerciseId)}` : '';
    },

    linkPrevLabel(exerciseId: string): string {
      const i = this._entryIndex(exerciseId);
      const prev = i > 0 ? this.currentEntries[i - 1] : undefined;
      return prev ? `Lier en superset avec ${this.exerciseName(prev.exerciseId)}` : '';
    },

    _setEntries(entries: SessionExerciseEntry[]): void {
      if (!this.currentSession) return;
      this.currentSession = { ...this.currentSession, entries };
    },

    linkNext(exerciseId: string): void {
      this._setEntries(linkWithNext(this.currentEntries, this._entryIndex(exerciseId)));
      this.menuFor = null;
      hapticLight();
    },

    linkPrev(exerciseId: string): void {
      this._setEntries(linkWithNext(this.currentEntries, this._entryIndex(exerciseId) - 1));
      this.menuFor = null;
      hapticLight();
    },

    unlink(exerciseId: string): void {
      this._setEntries(unlinkSuperset(this.currentEntries, this._entryIndex(exerciseId)));
      this.menuFor = null;
      hapticLight();
    },

    /** Historique de sets pour un exercice, toutes séances confondues (du plus ancien au plus récent). */
    _historyForExercise(exerciseId: string): PerformedSet[] {
      const sorted = [...this.sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return sorted.flatMap((s) =>
        loadSetsOf(s.entries.find((e) => e.exerciseId === exerciseId)?.sets ?? []).map((set) => ({
          reps: set.reps,
          weightKg: set.weightKg,
          rpe: set.rpe,
          at: set.performedAt,
        })),
      );
    },

    /** Suggestion de progression complète pour l'exercice courant. */
    progressionSuggestion(exerciseId: string): ProgressionSuggestion | null {
      if (!exerciseId || this.isTimed(exerciseId)) return null;
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
      if (this.isTimed(exerciseId)) return false;
      return needsDeload(this._historyForExercise(exerciseId));
    },

    // ─── La dernière fois ────────────────────────────────────

    /** Séries de travail de la dernière séance où l'exercice a été fait (hors séance en cours). */
    lastTime(exerciseId: string): LastPerformance<SetEntry> | null {
      const version = sessionsCacheVersion(this.sessions);
      if (this._lastCacheVersion !== version) {
        this._lastCache = new Map();
        this._lastCacheVersion = version;
      }
      if (!this._lastCache.has(exerciseId)) {
        this._lastCache.set(
          exerciseId,
          lastPerformance(this.sessions, exerciseId, this.currentSession?.id),
        );
      }
      return this._lastCache.get(exerciseId) ?? null;
    },

    /** « Dernière fois · 40×8 · 42,5×8 · 42,5×7 » (vide sans historique). */
    lastTimeLabel(exerciseId: string): string {
      const last = this.lastTime(exerciseId);
      return last ? `Dernière fois · ${formatSetsShort(last.sets)}` : '';
    },

    /** Série de la dernière fois qui correspond à la prochaine série de travail. */
    _sameAsLast(entry: SessionExerciseEntry): SetEntry | null {
      const last = this.lastTime(entry.exerciseId);
      return last ? matchingLastSet(last.sets, workSetsOf(entry.sets).length) : null;
    },

    /** « 42,5×8 » pour le bouton « Même chose » (vide sans historique). */
    sameAsLastLabel(entry: SessionExerciseEntry): string {
      const set = this._sameAsLast(entry);
      return set ? formatSetShort(set) : '';
    },

    /** Valide en un geste la série correspondante de la dernière fois. */
    repeatLast(entry: SessionExerciseEntry): void {
      const set = this._sameAsLast(entry);
      if (!set) return;
      this.draftWarmup = false;
      this.draft.weightKg = set.weightKg;
      if (this.isTimed(entry.exerciseId)) this._fillTimedDraft(entry.exerciseId, set);
      else this.draft.reps = set.reps;
      this.addSet(entry.exerciseId);
    },

    /** Cible de la n-ième série de travail : la dernière fois, ou le coach s'il propose de monter. */
    setTarget(exerciseId: string, workIndex: number): SetTarget | null {
      return nextSetTarget({
        lastSets: this.lastTime(exerciseId)?.sets ?? [],
        workIndex,
        coach: this.coachAdvice(exerciseId),
      });
    },

    /**
     * Pré-remplit charge et reps quand on arrive sur une nouvelle série de travail
     * (autre exercice, série validée). Rien sans historique : la saisie précédente reste.
     */
    _syncDraft(): void {
      const entry = this.currentEntries.find((e) => this.isActiveEntry(e.exerciseId));
      if (!entry || this.draftWarmup) return;
      const n = workSetsOf(entry.sets).length;
      const key = `${this.currentSession?.id}:${entry.exerciseId}:${n}`;
      if (key === this._draftKey) return;
      this._draftKey = key;
      if (this.isTimed(entry.exerciseId)) {
        if (this.stopwatch && this.stopwatch.exerciseId !== entry.exerciseId) this.stopwatch = null;
        const last = this._sameAsLast(entry);
        if (last && isTimedSet(last)) this._fillTimedDraft(entry.exerciseId, last);
        else this._fillTimedDraft(entry.exerciseId, null);
        return;
      }
      const target = this.setTarget(entry.exerciseId, n);
      if (target) {
        this.draft.weightKg = target.weightKg;
        this.draft.reps = target.reps;
      }
    },

    /** Pré-remplit durée, distance et charge (série de la dernière fois, ou vide). */
    _fillTimedDraft(exerciseId: string, set: SetEntry | null): void {
      const ex = this.exercises.find((e) => e.id === exerciseId) ?? { id: exerciseId };
      const dist = Number(set?.distanceM) || 0;
      this.draftDistUnit = dist >= 1000 ? 'km' : dist > 0 ? 'm' : defaultDistanceUnit(ex);
      this.draft.duration =
        Number(set?.durationSec) > 0 ? formatDuration(Number(set!.durationSec)) : '';
      this.draft.distance = distanceInputValue(dist, this.draftDistUnit);
      this.draft.weightKg = Number(set?.weightKg) || 0;
    },

    // ─── Échauffement ────────────────────────────────────────

    isWarmup(set: SetEntry): boolean {
      return isWarmupSet(set);
    },

    warmupSets(entry: SessionExerciseEntry): SetEntry[] {
      return warmupSetsOf(entry.sets);
    },

    workSets(entry: SessionExerciseEntry): SetEntry[] {
      return workSetsOf(entry.sets);
    },

    workSetCount(entry: SessionExerciseEntry): number {
      return workSetsOf(entry.sets).length;
    },

    /** « #2 » pour une série de travail, « É » pour un échauffement (historique). */
    setTag(entry: SessionExerciseEntry, set: SetEntry): string {
      if (isWarmupSet(set)) return 'É';
      return `#${workSetsOf(entry.sets).filter((s) => s.setIndex <= set.setIndex).length}`;
    },

    /** « Série 3 », ou « Échauffement » quand la prochaine série en est un. */
    draftTitle(entry: SessionExerciseEntry): string {
      return this.draftWarmup ? 'Échauffement' : `Série ${workSetsOf(entry.sets).length + 1}`;
    },

    /** Bascule la prochaine série entre échauffement et travail. */
    toggleDraftWarmup(): void {
      this.draftWarmup = !this.draftWarmup;
      this._draftKey = '';
      this._syncDraft();
      hapticLight();
    },

    /** « Ajouter l'échauffement » : avant la première série, et pas au poids du corps. */
    canAddWarmup(entry: SessionExerciseEntry): boolean {
      if (entry.sets.length > 0 || this.isTimed(entry.exerciseId)) return false;
      return this.exercises.find((e) => e.id === entry.exerciseId)?.equipment !== 'bodyweight';
    },

    /**
     * Génère l'échauffement pour la charge de travail saisie : barre seule ×10,
     * 40 % ×8, 60 % ×5, 80 % ×3, arrondis aux disques disponibles (calculateur
     * de disques) ; sans barre, au pas de charge de l'exercice.
     */
    addWarmups(exerciseId: string): void {
      if (!this.currentSession) return;
      const ex = this.exercises.find((e) => e.id === exerciseId);
      const ramp = warmupRamp({
        workKg: Number(this.draft.weightKg) || 0,
        barbell: ex?.equipment === 'barbell',
        ...(this._plates?.barKg ? { barKg: this._plates.barKg } : {}),
        ...(this._plates?.enabledPlates?.length ? { plates: this._plates.enabledPlates } : {}),
        ...(ex?.incrementKg ? { incrementKg: ex.incrementKg } : {}),
      });
      if (ramp.length === 0) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'info', message: 'Charge trop légère pour un échauffement.' },
          }),
        );
        return;
      }
      const at = nowIso();
      const warmups: SetEntry[] = ramp.map((w) => ({
        setIndex: 0,
        reps: w.reps,
        weightKg: w.weightKg,
        rpe: 6,
        performedAt: at,
        kind: 'warmup',
      }));
      this._updateSets(exerciseId, (sets) => [...warmups, ...workSetsOf(sets)]);
      hapticLight();
    },

    /** Corrige la charge ou les reps d'un échauffement. */
    editWarmup(
      exerciseId: string,
      setIndex: number,
      field: 'weightKg' | 'reps',
      raw: string,
    ): void {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || (field === 'reps' && v < 1)) return;
      this._updateSets(exerciseId, (sets) =>
        sets.map((s) =>
          s.setIndex === setIndex && isWarmupSet(s)
            ? { ...s, [field]: field === 'reps' ? Math.round(v) : v }
            : s,
        ),
      );
    },

    removeWarmup(exerciseId: string, setIndex: number): void {
      this._updateSets(exerciseId, (sets) =>
        sets.filter((s) => !(s.setIndex === setIndex && isWarmupSet(s))),
      );
    },

    /** Seul chemin de modification des séries hors saisie : séance remplacée (donc enregistrée). */
    _updateSets(exerciseId: string, fn: (sets: readonly SetEntry[]) => SetEntry[]): void {
      if (!this.currentSession) return;
      this.currentSession = {
        ...this.currentSession,
        entries: this.currentSession.entries.map((e) =>
          e.exerciseId === exerciseId ? { ...e, sets: orderSets(fn(e.sets)) } : e,
        ),
      };
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

    /** Historique en liste ou en calendrier du mois (chargé à la demande). */
    historyView: 'list' as 'list' | 'calendar',
    calendarReady: false,
    calendarError: false,

    setHistoryView(view: 'list' | 'calendar'): void {
      this.historyView = view;
      if (view !== 'calendar' || this.calendarReady) return;
      this.calendarError = false;
      loadTrainingCalendar().then(
        () => {
          this.calendarReady = true;
        },
        (err: unknown) => {
          console.warn('[seances] calendrier indisponible :', err);
          this.calendarError = true;
        },
      );
    },
    historyViewPressed(view: 'list' | 'calendar'): string {
      return this.historyView === view ? 'true' : 'false';
    },
    /** Depuis le calendrier : ouvre la séance dépliée dans la liste. */
    showSessionInList(id: string): void {
      const fromEnd = this.sessions.length - this.sessions.findIndex((s) => s.id === id);
      if (fromEnd > this.historyLimit) this.historyLimit = fromEnd;
      this.historyView = 'list';
      if (this.expandedSessionId !== id) this.toggleSessionDetail(id);
      requestAnimationFrame(() => {
        document
          .getElementById(`history-${id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },

    /** Bascule l'affichage détaillé d'une séance dans l'historique. */
    toggleSessionDetail(id: string): void {
      if (this.editingSession) this.cancelEditSession();
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

    // ─── Corriger / supprimer une série, modifier une séance passée ─────────
    // Séance en cours : la séance est remplacée (donc enregistrée, cf. _watchActiveSession).
    // Séance passée : on modifie un brouillon, enregistré d'un bloc (saveSession → synchro).

    setEditor: null as {
      scope: 'current' | 'history';
      exerciseId: string;
      setIndex: number;
      isNew: boolean;
    } | null,
    setForm: {
      weightKg: '',
      reps: '',
      rpe: '',
      note: '',
      warmup: false,
      timed: false,
      distanceOn: false,
      duration: '',
      distance: '',
    } as {
      weightKg: string | number;
      reps: string | number;
      rpe: string | number;
      note: string;
      warmup: boolean;
      /** Série chronométrée : durée (m:ss) et distance (« 400 m », « 2,5 km ») au lieu des reps. */
      timed: boolean;
      distanceOn: boolean;
      duration: string;
      distance: string;
    },
    setFormError: '',
    /** Dernière série supprimée, pour « Annuler » (toast de la page). */
    undoSet: null as {
      scope: 'current' | 'history';
      sessionId: string;
      exerciseId: string;
      set: SetEntry;
    } | null,
    _undoTimer: null as ReturnType<typeof setTimeout> | null,
    /** Brouillon de la séance passée en cours de modification. */
    editingSession: null as WorkoutSession | null,
    editName: '',
    editStart: '',
    savingEdit: false,

    _scopeSession(scope: 'current' | 'history'): WorkoutSession | null {
      return scope === 'current' ? this.currentSession : this.editingSession;
    },

    _setScopeSession(scope: 'current' | 'history', session: WorkoutSession): void {
      if (scope === 'current') this.currentSession = session;
      else this.editingSession = session;
    },

    _openSetEditor(
      scope: 'current' | 'history',
      exerciseId: string,
      setIndex: number,
      isNew = false,
    ): void {
      const entry = this._scopeSession(scope)?.entries.find((e) => e.exerciseId === exerciseId);
      const set = entry?.sets.find((s) => s.setIndex === setIndex);
      if (!set) return;
      // Virgule décimale à la française (« 62,5 ») : la saisie l'accepte aussi.
      const fr = (v: number): string => String(v).replace('.', ',');
      const timed = isTimedSet(set) || this.isTimed(exerciseId);
      this.setForm = {
        weightKg: fr(set.weightKg),
        reps: set.reps,
        rpe: fr(set.rpe),
        note: set.note ?? '',
        warmup: isWarmupSet(set),
        timed,
        distanceOn: timed && (this.isDistance(exerciseId) || Number(set.distanceM) > 0),
        duration: Number(set.durationSec) > 0 ? formatDuration(Number(set.durationSec)) : '',
        distance: Number(set.distanceM) > 0 ? formatDistance(Number(set.distanceM)) : '',
      };
      this.setFormError = '';
      this.setEditor = { scope, exerciseId, setIndex, isNew };
      hapticLight();
    },

    /** Toucher une série validée de la séance en cours. */
    openSetEditor(exerciseId: string, setIndex: number): void {
      this._openSetEditor('current', exerciseId, setIndex);
    },

    /** Toucher une série d'une séance passée (en mode « Modifier » seulement). */
    openPastSetEditor(sessionId: string, exerciseId: string, setIndex: number): void {
      if (this.editingSession?.id !== sessionId) return;
      this._openSetEditor('history', exerciseId, setIndex);
    },

    setEditorTitle(): string {
      const ed = this.setEditor;
      if (!ed) return '';
      const kind = ed.isNew ? 'Série ajoutée' : 'Modifier la série';
      return `${kind} · ${this.exerciseName(ed.exerciseId)}`;
    },

    setFormWork(): void {
      this.setForm.warmup = false;
    },

    setFormWarmup(): void {
      this.setForm.warmup = true;
    },

    /** Ferme sans enregistrer (une série oubliée tout juste ajoutée est retirée). */
    closeSetEditor(): void {
      const ed = this.setEditor;
      this.setEditor = null;
      if (!ed?.isNew) return;
      const session = this._scopeSession(ed.scope);
      if (session) {
        this._setScopeSession(ed.scope, removeSessionSet(session, ed.exerciseId, ed.setIndex));
      }
    },

    saveSetEditor(): void {
      const ed = this.setEditor;
      const session = ed ? this._scopeSession(ed.scope) : null;
      if (!ed || !session) return;
      // Champ vide = invalide (Number('') vaudrait 0) ; virgule décimale acceptée.
      const num = (v: string | number): number => {
        const t = String(v ?? '')
          .trim()
          .replace(',', '.');
        return t === '' ? Number.NaN : Number(t);
      };
      const timed = this.setForm.timed === true;
      const input = {
        weightKg:
          timed && String(this.setForm.weightKg).trim() === '' ? 0 : num(this.setForm.weightKg),
        reps: timed ? 0 : num(this.setForm.reps),
        rpe: num(this.setForm.rpe),
        note: String(this.setForm.note ?? ''),
        warmup: this.setForm.warmup === true,
        ...(timed
          ? {
              durationSec: parseDuration(this.setForm.duration),
              distanceM: this.setForm.distanceOn ? parseDistance(this.setForm.distance, 'm') : 0,
            }
          : {}),
      };
      const error = validateSetInput(input);
      if (error) {
        this.setFormError = error;
        return;
      }
      this._setScopeSession(ed.scope, updateSessionSet(session, ed.exerciseId, ed.setIndex, input));
      this.setEditor = null;
      hapticSuccess();
    },

    deleteEditedSet(): void {
      const ed = this.setEditor;
      const session = ed ? this._scopeSession(ed.scope) : null;
      if (!ed || !session) return;
      const set = session.entries
        .find((e) => e.exerciseId === ed.exerciseId)
        ?.sets.find((s) => s.setIndex === ed.setIndex);
      this._setScopeSession(ed.scope, removeSessionSet(session, ed.exerciseId, ed.setIndex));
      this.setEditor = null;
      hapticMedium();
      if (!set || ed.isNew) return;
      this.undoSet = {
        scope: ed.scope,
        sessionId: session.id,
        exerciseId: ed.exerciseId,
        set: { ...set },
      };
      if (this._undoTimer) clearTimeout(this._undoTimer);
      this._undoTimer = setTimeout(() => {
        this.undoSet = null;
        this._undoTimer = null;
      }, 6000);
    },

    /** « Série supprimée · Annuler » : la série revient à sa place. */
    undoDeleteSet(): void {
      const u = this.undoSet;
      this.undoSet = null;
      if (this._undoTimer) clearTimeout(this._undoTimer);
      this._undoTimer = null;
      const session = u ? this._scopeSession(u.scope) : null;
      if (!u || !session || session.id !== u.sessionId) return;
      if (!session.entries.some((e) => e.exerciseId === u.exerciseId)) return;
      this._setScopeSession(u.scope, insertSessionSet(session, u.exerciseId, u.set));
      hapticLight();
    },

    // ── Séance passée ──

    isEditingSession(id: string): boolean {
      return this.editingSession?.id === id;
    },

    /** Ligne de série de l'historique : atténuée si échauffement, touchable en modification. */
    pastSetClass(sessionId: string, set: SetEntry): string {
      const warm = isWarmupSet(set) ? 'opacity-50 ' : '';
      return this.editingSession?.id === sessionId
        ? `${warm}min-h-10 px-2 -mx-2 bg-kinetic-raised/60 active:bg-kinetic-raised`
        : warm;
    },

    /** Exercices affichés dans le détail : le brouillon si la séance est en modification. */
    detailEntries(session: WorkoutSession): readonly SessionExerciseEntry[] {
      return this.editingSession?.id === session.id ? this.editingSession.entries : session.entries;
    },

    startEditSession(id: string): void {
      const s = this.sessions.find((x) => x.id === id);
      if (!s) return;
      this.editingSession = JSON.parse(JSON.stringify(s)) as WorkoutSession;
      this.editName = s.name;
      this.editStart = toLocalInputValue(s.startedAt);
      this.confirmDeleteId = null;
      this.expandedSessionId = id;
    },

    cancelEditSession(): void {
      this.editingSession = null;
      this.setEditor = null;
      if (this.undoSet?.scope === 'history') this.undoSet = null;
    },

    /** Ajoute une série oubliée (copie de la dernière) et ouvre son édition. */
    addPastSet(exerciseId: string): void {
      const session = this.editingSession;
      const entry = session?.entries.find((e) => e.exerciseId === exerciseId);
      if (!session || !entry) return;
      const set = forgottenSet(entry.sets, session.startedAt);
      this.editingSession = insertSessionSet(session, exerciseId, set as SetEntry);
      this._openSetEditor('history', exerciseId, entry.sets.length, true);
    },

    async saveEditedSession(): Promise<void> {
      const draft = this.editingSession;
      if (!draft || this.savingEdit) return;
      const entries = normalizeSupersets(draft.entries.filter((e) => e.sets.length > 0));
      if (entries.length === 0) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'warning',
              message: 'Plus aucune série : supprime plutôt la séance.',
            },
          }),
        );
        return;
      }
      let next: WorkoutSession = {
        ...draft,
        name: this.editName.trim().slice(0, 80) || draft.name,
        entries,
      };
      const start = new Date(this.editStart);
      if (this.editStart && Number.isFinite(start.getTime())) {
        next = retimeSession(next, start.toISOString());
      }
      // Champs dérivés stockés : RPE moyen et calories recalculés.
      const avgRpe = workAvgRpe(next);
      const caloriesKcal = estimateStrengthWorkoutCaloriesKcal({
        durationMin: Number(next.durationMin) || 0,
        avgRpe,
        profile: this.userProfile,
      });
      const hadCalories = next.caloriesKcal != null;
      next = { ...next };
      delete next.avgRpe;
      delete next.caloriesKcal;
      if (avgRpe != null) next.avgRpe = avgRpe;
      if (hadCalories && caloriesKcal != null) next.caloriesKcal = caloriesKcal;
      this.savingEdit = true;
      try {
        const deps = await getDeps();
        await saveSession(deps.storage, next);
        this.sessions = this.sessions
          .map((s) => (s.id === next.id ? next : s))
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        // Caches « la dernière fois » / progression : la séance a pu changer sans changer la longueur.
        this._lastCacheVersion = '';
        this._suggestionCacheVersion = '';
        this.editingSession = null;
        this.setEditor = null;
        if (this.undoSet?.scope === 'history') this.undoSet = null;
        hapticSuccess();
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: 'Séance modifiée.' },
          }),
        );
        // Objectifs (remplacement par id), succès et progression se recalculent.
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_SESSION_SAVED, { detail: { session: next } }),
        );
      } catch (err) {
        console.error('[seances] saveEditedSession failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec de l’enregistrement. Réessaie.' },
          }),
        );
      } finally {
        this.savingEdit = false;
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
      if (!exerciseId || this.isTimed(exerciseId)) return null;
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

      const timed = this.isTimed(this.progressExerciseId);
      const byDistance = timed && this.isDistance(this.progressExerciseId);
      for (const session of this.sessions) {
        const found = session.entries.find((e) => e.exerciseId === this.progressExerciseId);
        // Exercice chronométré : meilleure durée (ou distance) ; sinon reps × charge seulement.
        const entry = found
          ? { sets: timed ? workSetsOf(found.sets) : loadSetsOf(found.sets) }
          : null;
        if (!entry || !entry.sets.length) continue;
        let y = 0;
        if (timed) {
          y = Math.max(
            0,
            ...entry.sets.map((s) => Number(byDistance ? s.distanceM : s.durationSec) || 0),
          );
        } else if (this.progressMetric === 'weight') {
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

    /** Exercice de la courbe mesuré en durée ou distance (pas de choix e1RM/charge/volume). */
    progressIsTimed(): boolean {
      return !!this.progressExerciseId && this.isTimed(this.progressExerciseId);
    },

    progressRecordTitle(): string {
      if (this.progressIsTimed()) {
        return this.isDistance(this.progressExerciseId) ? 'Record (distance)' : 'Record (durée)';
      }
      if (this.progressMetric === 'volume') return 'Record (volume)';
      return this.progressMetric === 'weight' ? 'Record (charge max)' : 'Record (e1RM)';
    },

    /** Valeur seule (« 62,5 », « 1:30 », « 400 m ») ; l'unité kg est à part. */
    progressValueText(v: number): string {
      if (!this.progressIsTimed()) return (Number(v) || 0).toFixed(1);
      return this.isDistance(this.progressExerciseId) ? formatDistance(v) : formatDuration(v);
    },

    progressUnit(): string {
      return this.progressIsTimed() ? '' : 'kg';
    },

    /** Valeur avec unité : « 62.5 kg », « 1:30 », « 400 m ». */
    progressValueLabel(v: number): string {
      const unit = this.progressUnit();
      return unit ? `${this.progressValueText(v)} ${unit}` : this.progressValueText(v);
    },

    progressLastLabel(): string {
      return this.progressValueLabel(this.progressPoints().at(-1)?.y ?? 0);
    },

    // ─── Affichage des séries chronométrées et supersets (historique) ─────

    /** « Durée », « Distance » ou « kg × reps » (en-tête des séries faites). */
    setsColumnLabel(exerciseId: string): string {
      const m = this.measureOf(exerciseId);
      return m === 'time' ? 'Durée' : m === 'distance' ? 'Distance · durée' : 'kg × reps';
    },

    /** « · Durée » / « · Distance » sous le nom d'un exercice chronométré. */
    measureLabel(exerciseId: string): string {
      const m = this.measureOf(exerciseId);
      return m === 'time' ? ' · Durée' : m === 'distance' ? ' · Distance' : '';
    },

    /** Colonne de droite d'une série : e1RM, ou charge (« 20 », « — ») si chronométrée. */
    setSideValue(set: SetEntry): string {
      if (isTimedSet(set)) {
        const kg = Number(set.weightKg) || 0;
        return kg > 0 ? kg.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : '—';
      }
      return estimateE1rmKg(set.weightKg, set.reps).toFixed(0);
    },

    /** Historique : e1RM (« 85 kg »), ou charge d'une série chronométrée. */
    pastSetSide(set: SetEntry): string {
      if (isTimedSet(set)) return this.timedLoad(set) === '—' ? '' : this.timedLoad(set);
      return `${String(this.setE1rm(set.weightKg, set.reps)).replace('.', ',')} kg`;
    },

    /** « A1 · Développé couché » dans le détail d'une séance passée. */
    historyEntryTitle(session: WorkoutSession, entry: SessionExerciseEntry): string {
      const tag = supersetLabel(session.entries, entry.exerciseId);
      const name = this.exerciseNameOf(entry.exerciseId);
      return tag ? `${tag} · ${name}` : name;
    },

    /** « Superset A » (2 exercices) ou « Circuit A » (3) ; vide pour un exercice seul. */
    supersetTitle(block: SupersetBlock<SessionExerciseEntry>): string {
      if (!block.group) return '';
      return `${block.items.length >= 3 ? 'Circuit' : 'Superset'} ${block.letter}`;
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
      const timedProgress = this.isTimed(this.progressExerciseId);
      const distProgress = timedProgress && this.isDistance(this.progressExerciseId);
      const fmt = (v: number) =>
        distProgress
          ? formatDistance(v)
          : timedProgress
            ? formatDuration(v)
            : v.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
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
          const value = timedProgress ? fmt(p.y) : p.y.toFixed(1);
          return `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${isRecord ? 5 : 3}" class="${isRecord ? `${RECORD_FILL} stroke-kinetic-surface` : LINE_FILL}"${isRecord ? ' stroke-width="2.5"' : ''}><title>${p.label} : ${value}</title></circle>`;
        })
        .join('');
      const metric = distProgress
        ? 'Distance max'
        : timedProgress
          ? 'Durée max'
          : this.progressMetric === 'weight'
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
        this.stopwatch = null; // le chronomètre s'arrête avec la séance
        this._persistActive(); // séance sauvegardée : plus rien à reprendre
        this.justSavedSessionId = finalized.id; // carte « Séance terminée » (partage)
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
          exercises: normalizeSupersets(this.currentSession.entries).map((e) => ({
            exerciseId: e.exerciseId,
            sets: Math.max(1, workSetsOf(e.sets).length || 3),
            targetReps: 8,
            targetRpe: 8,
            ...(e.group ? { group: e.group } : {}),
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
