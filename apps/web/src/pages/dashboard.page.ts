/**
 * Composant Alpine pour la page dashboard.
 * Enregistré dans main.ts via Alpine.data('dashboard', dashboard).
 */
import Alpine from 'alpinejs';
import { STORAGE_KEYS, muscleBalance, workSetsOf } from '@kinetic/core';
import type { BalanceReport, StreakState } from '@kinetic/core';
import { getDeps } from '../deps';
import type { WorkoutSession, Exercise } from '../lib/training/types';
import { loadSessions, loadExercises, loadTemplates } from '../lib/training/storage';
import {
  buildTrainingSnapshot,
  formatVolume,
  relativeDayLabel,
  type TrainingSnapshot,
} from '../lib/training/next-session';
import { navigate } from '../router';
import { loadActiveSession } from '../lib/training/active-session';
import { hapticLight } from '../lib/haptics';
import { ric } from '../lib/performance';
import {
  loadChallengeCard,
  loadMuscleMap,
  loadStrengthGoals,
  loadWeekPlan,
  loadWellness,
} from '../lib/lazy-component';
import type { PlanTodayDetail } from '../components/week-plan';

const PATTERN_LABELS: Record<'push' | 'pull' | 'legs', string> = {
  push: 'pousser',
  pull: 'tirer',
  legs: 'jambes',
};

/** Visite guidée en attente (onboarding terminé ou relancée depuis le profil). */
function firstRunTourQueued(): boolean {
  try {
    const state = localStorage.getItem(STORAGE_KEYS.FIRST_RUN_TOUR);
    return state === 'pending' || state === 'replay';
  } catch {
    return false;
  }
}

/** Pourcentage arrondi et borné à [0, 100] (anneaux de progression). */
export function ringPercent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

export function dashboard() {
  return {
    greeting: '',
    todayLabel: '',
    streak: 0,
    bestStreak: 0,
    balance: null as BalanceReport | null,

    _allSessions: [] as WorkoutSession[],
    /** Aperçu « carte des muscles » : exercices (muscles) et composant chargé à la demande. */
    mmExercises: [] as Exercise[],
    muscleMapReady: false,
    /** Aperçu de l'objectif de force le plus proche (seulement s'il y a des objectifs). */
    goalsReady: false,
    training: null as TrainingSnapshot | null,
    /** Planning de la semaine du programme suivi (components/week-plan.ts, à la demande). */
    weekPlanReady: false,
    /** Une séance non terminée est enregistrée : le bouton la reprend au lieu d'en démarrer une. */
    hasActiveSession: false,
    /** Nom de la séance en cours (affiché par la carte du jour à la place de la séance proposée). */
    activeSessionName: '',
    /** Forme du jour et eau (components/wellness.ts, à la demande). */
    wellnessReady: false,
    /** Défi le plus proche (components/challenges.ts, à la demande). */
    challengeReady: false,
    /** « Ton bilan de novembre est prêt » : les 3 premiers jours du mois. */
    recapTeaser: null as { title: string; href: string } | null,

    startLabel(): string {
      return this.hasActiveSession ? 'Reprendre la séance' : 'Commencer la séance';
    },

    /** Titre de la carte du jour : la séance en cours, sinon la séance proposée. */
    get todayTitle(): string {
      if (this.hasActiveSession && this.activeSessionName) return this.activeSessionName;
      return this.training?.next?.name ?? '';
    },

    /** Petite ligne au-dessus du titre de la carte du jour. */
    get todayKicker(): string {
      if (this.hasActiveSession) return 'Séance en cours';
      const t = this.training;
      if (!t || t.totalSessions === 0) return 'Ta première séance';
      return t.daysSinceLast === 0
        ? 'Déjà entraîné aujourd’hui — prochaine séance'
        : 'Séance du jour';
    },

    /** « 3 exercices, 10 séries » (rien sous une séance en cours : le bouton dit « Reprendre »). */
    get nextDetail(): string {
      const n = this.training?.next;
      if (!n || this.hasActiveSession) return '';
      return `${n.exerciseCount} exercices, ${n.setCount} séries`;
    },

    /** « Push A, hier · 4,2 t · 52 min » */
    get lastDetail(): string {
      const l = this.training?.last;
      if (!l) return '';
      const when = relativeDayLabel(this.training?.daysSinceLast ?? null);
      const dur = l.durationMin ? ` · ${l.durationMin} min` : '';
      return `${l.name}, ${when} · ${formatVolume(l.volumeKg)}${dur}`;
    },

    get weekDetail(): string {
      const w = this.training?.week;
      if (!w) return '';
      const goals = Alpine.store('goals') as { targetSessions?: number } | undefined;
      const target = goals?.targetSessions;
      return target ? `${w.count} / ${target}` : `${w.count}`;
    },

    /** Séances faites cette semaine (centre de l'anneau). */
    get weekCount(): number {
      return this.training?.week.count ?? 0;
    },

    /** Objectif hebdomadaire de séances (3 par défaut). */
    get weekTarget(): number {
      const goals = Alpine.store('goals') as { targetSessions?: number } | undefined;
      const t = Number(goals?.targetSessions);
      return Number.isFinite(t) && t > 0 ? t : 3;
    },

    /** « /3 » sous le compteur de l'anneau. */
    get weekTargetLabel(): string {
      return `/${this.weekTarget}`;
    },

    /** Part de l'objectif hebdomadaire atteinte, 0 à 100. */
    get weekPercent(): number {
      return ringPercent(this.weekCount, this.weekTarget);
    },

    /** Anneaux façon Apple Fitness : variable CSS --p lue par .k-ring-value. */
    get weekRingStyle(): string {
      return `--p: ${this.weekPercent}`;
    },

    get recoveryRingStyle(): string {
      const v = Alpine.store('vitalite') as { progress?: number } | undefined;
      return `--p: ${ringPercent(v?.progress ?? 0, 100)}`;
    },

    get xpRingStyle(): string {
      const x = Alpine.store('xp') as { progressPercent?: number } | undefined;
      return `--p: ${ringPercent(x?.progressPercent ?? 0, 100)}`;
    },

    weekDayClass(day: { trained: boolean; isToday: boolean; isFuture: boolean }): string {
      if (day.trained) return 'bg-kinetic-neon text-kinetic-on-accent font-bold';
      if (day.isToday) return 'ring-2 ring-inset ring-kinetic-neon text-white font-bold';
      return 'bg-white/5 text-gray-500';
    },

    /**
     * Programme suivi : la séance prévue aujourd'hui (éventuellement déplacée)
     * devient la « Séance du jour » si un modèle porte son nom.
     */
    onPlanToday(e: CustomEvent<PlanTodayDetail>): void {
      const d = e.detail;
      if (!this.training || !d || d.done || !d.template) return;
      const t = d.template;
      this.training = {
        ...this.training,
        next: {
          templateId: t.id,
          name: t.name,
          exerciseCount: t.exerciseCount,
          setCount: t.setCount,
          reason: 'program',
        },
      };
    },

    /** Démarre la séance proposée (même mécanisme que « Programme du jour »). */
    startNextSession(): void {
      const next = this.training?.next;
      if (!next || this.hasActiveSession) {
        hapticLight();
        navigate('/seances');
        return;
      }
      try {
        sessionStorage.setItem(STORAGE_KEYS.PROGRAM_AUTO_TEMPLATE, next.templateId);
      } catch {
        /* sessionStorage indisponible : on ouvre simplement la page séances */
      }
      hapticLight();
      navigate('/seances');
    },

    get balanceWarning(): string | null {
      const b = this.balance;
      if (!b || !b.reliable) return null;
      if (b.underWorked) {
        return `Volume "${PATTERN_LABELS[b.underWorked]}" très bas sur 4 semaines — pense à équilibrer.`;
      }
      if (b.overWorked) {
        return `Volume "${PATTERN_LABELS[b.overWorked]}" dominant — varie les patterns pour éviter les déséquilibres.`;
      }
      return null;
    },

    async init(): Promise<void> {
      const hour = new Date().getHours();
      this.greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';
      this.todayLabel = new Date().toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });

      void loadWellness().then(
        () => {
          this.wellnessReady = true;
        },
        (err: unknown) => console.warn('[dashboard] forme du jour indisponible :', err),
      );

      try {
        const deps = await getDeps();

        const storage = deps.storage;

        void loadActiveSession(storage).then((snap) => {
          this.hasActiveSession = !!snap;
          this.activeSessionName = snap?.session.name ?? '';
        });

        // Avatar : initiale du prénom saisi dans le profil (même sans compte)
        void storage
          .get<{ displayName?: string }>(STORAGE_KEYS.PROFILE)
          .then((profile) => {
            const auth = Alpine.store('auth') as
              | { setProfileName?: (name: string | undefined) => void }
              | undefined;
            auth?.setProfileName?.(profile?.displayName);
          })
          .catch(() => undefined);

        // Premier écran : série, séances et modèles lus en parallèle, puis la carte du jour.
        const [streakData, sessions, templates] = await Promise.all([
          storage.get<StreakState>(STORAGE_KEYS.STREAK).catch(() => null),
          loadSessions(storage),
          loadTemplates(storage),
        ]);
        if (streakData) {
          this.streak = streakData.count ?? 0;
          this.bestStreak = streakData.best ?? 0;
        }
        this._allSessions = sessions;
        this.training = buildTrainingSnapshot(sessions, templates);

        // Le reste arrive ensuite, sans retarder la carte du jour.
        this._loadMotivation();
        this._loadMuscleMapPreview(storage);
        void this._loadWeekPlan(storage);
        void this._loadGoalsPreview(storage);
        // Équilibre pousser / tirer / jambes : calcul sur tout l'historique, en tâche de fond.
        ric(
          () => {
            void this._buildBalanceReport(sessions).then((b) => {
              this.balance = b;
            });
          },
          { timeout: 2000 },
        );
      } catch (err) {
        console.error('[dashboard] init failed:', err);
      }
      // Visite guidée après l'onboarding ou « Revoir la visite » (module chargé seulement alors).
      if (firstRunTourQueued()) {
        void import('../lib/first-run-tour')
          .then((m) => m.startFirstRunTourIfQueued())
          .catch((err: unknown) => console.warn('[dashboard] visite indisponible :', err));
      }
    },

    /**
     * Après le premier affichage : défi le plus proche (dès une séance) et, les
     * 3 premiers jours du mois, la carte du bilan du mois écoulé (recap.domain
     * chargé seulement ces jours-là).
     */
    _loadMotivation(): void {
      if (this._allSessions.length > 0) {
        void loadChallengeCard().then(
          () => {
            this.challengeReady = true;
          },
          (err: unknown) => console.warn('[dashboard] défis indisponibles :', err),
        );
      }
      if (new Date().getDate() > 3) return;
      void import('../lib/recap-teaser')
        .then((m) => {
          this.recapTeaser = m.recapTeaser(new Date(), this._allSessions);
        })
        .catch((err: unknown) => console.warn('[dashboard] bilan indisponible :', err));
    },

    /** Planning de la semaine, seulement si un programme est suivi. */
    async _loadWeekPlan(storage: Parameters<typeof loadExercises>[0]): Promise<void> {
      try {
        const [split, catalog] = await Promise.all([
          storage.get(STORAGE_KEYS.PROGRAM_ACTIVE),
          storage.get(STORAGE_KEYS.ACTIVE_PROGRAM),
        ]);
        if (!split && !catalog) return;
        await loadWeekPlan();
        this.weekPlanReady = true;
      } catch (err) {
        console.warn('[dashboard] planning indisponible :', err);
      }
    },

    /**
     * Aperçu de la carte des muscles : seulement s'il y a eu une séance sur
     * 7 jours, et après le premier affichage (import() en tâche de fond).
     */
    _loadMuscleMapPreview(storage: Parameters<typeof loadExercises>[0]): void {
      const since = Date.now() - 7 * 86_400_000;
      if (!this._allSessions.some((s) => Date.parse(s.startedAt) >= since)) return;
      void Promise.all([loadExercises(storage), loadMuscleMap()])
        .then(([exercises]) => {
          this.mmExercises = exercises;
          this.muscleMapReady = true;
        })
        .catch((err: unknown) =>
          console.warn('[dashboard] aperçu des muscles indisponible :', err),
        );
    },

    /** Aperçu de l'objectif de force le plus proche, seulement s'il y a des objectifs. */
    async _loadGoalsPreview(storage: Parameters<typeof loadExercises>[0]): Promise<void> {
      try {
        const goals = await storage.get<unknown[]>(STORAGE_KEYS.STRENGTH_GOALS);
        if (!Array.isArray(goals) || goals.length === 0) return;
        await loadStrengthGoals();
        this.goalsReady = true;
      } catch (err) {
        console.warn('[dashboard] objectifs indisponibles :', err);
      }
    },

    async _buildBalanceReport(sessions: WorkoutSession[]): Promise<BalanceReport | null> {
      try {
        const deps = await getDeps();
        const exercises = await loadExercises(deps.storage);
        const musclesById = new Map(exercises.map((e: Exercise) => [e.id, e.muscles]));
        const sets = sessions.flatMap((s) =>
          s.entries.flatMap((entry) =>
            workSetsOf(entry.sets).map((set) => ({
              muscles: musclesById.get(entry.exerciseId) ?? [],
              performedAt: set.performedAt,
            })),
          ),
        );
        return muscleBalance(sets);
      } catch (err) {
        console.warn('[dashboard] _buildBalanceReport failed:', err);
        return null;
      }
    },
  };
}
