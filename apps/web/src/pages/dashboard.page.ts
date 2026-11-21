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
import { loadMuscleMap, loadStrengthGoals, loadWeekPlan } from '../lib/lazy-component';
import type { PlanTodayDetail } from '../components/week-plan';

const PATTERN_LABELS: Record<'push' | 'pull' | 'legs', string> = {
  push: 'pousser',
  pull: 'tirer',
  legs: 'jambes',
};

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

    startLabel(): string {
      return this.hasActiveSession ? 'Reprendre la séance' : 'Commencer la séance';
    },

    /** « 3 exercices, 10 séries » */
    get nextDetail(): string {
      const n = this.training?.next;
      if (!n) return '';
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

      try {
        const deps = await getDeps();

        void loadActiveSession(deps.storage).then((snap) => {
          this.hasActiveSession = !!snap;
        });

        // Avatar : initiale du prénom saisi dans le profil (même sans compte)
        void deps.storage
          .get<{ displayName?: string }>(STORAGE_KEYS.PROFILE)
          .then((profile) => {
            const auth = Alpine.store('auth') as
              | { setProfileName?: (name: string | undefined) => void }
              | undefined;
            auth?.setProfileName?.(profile?.displayName);
          })
          .catch(() => undefined);

        const streakData = await deps.storage.get<StreakState>(STORAGE_KEYS.STREAK);
        if (streakData) {
          this.streak = streakData.count ?? 0;
          this.bestStreak = streakData.best ?? 0;
        }

        this.balance = await this._buildBalanceReport();
        this._allSessions = await loadSessions(deps.storage);
        const templates = await loadTemplates(deps.storage);
        this.training = buildTrainingSnapshot(this._allSessions, templates);
        this._loadMuscleMapPreview(deps.storage);
        void this._loadWeekPlan(deps.storage);
        const goals = await deps.storage.get<unknown[]>(STORAGE_KEYS.STRENGTH_GOALS);
        if (Array.isArray(goals) && goals.length > 0) {
          void loadStrengthGoals().then(
            () => {
              this.goalsReady = true;
            },
            (err: unknown) => console.warn('[dashboard] objectifs indisponibles :', err),
          );
        }
      } catch (err) {
        console.error('[dashboard] init failed:', err);
      }
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

    async _buildBalanceReport(): Promise<BalanceReport | null> {
      try {
        const deps = await getDeps();
        const [sessions, exercises] = await Promise.all([
          loadSessions(deps.storage),
          loadExercises(deps.storage),
        ]);
        const musclesById = new Map(exercises.map((e: Exercise) => [e.id, e.muscles]));
        const sets = (sessions as WorkoutSession[]).flatMap((s) =>
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
