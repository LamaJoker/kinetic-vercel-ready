/**
 * Composant Alpine pour la page dashboard.
 * Enregistré dans main.ts via Alpine.data('dashboard', dashboard).
 */
import { STORAGE_KEYS, muscleBalance } from '@kinetic/core';
import type { BalanceReport, StreakState } from '@kinetic/core';
import { getDeps } from '../deps';
import type { WorkoutSession, Exercise } from '../lib/training/types';
import { loadSessions, loadExercises } from '../lib/training/storage';
import { hapticLight } from '../lib/haptics';

interface ActivityDay {
  label: string;
  short: string;
  active: boolean;
}

const PATTERN_LABELS: Record<'push' | 'pull' | 'legs', string> = {
  push: 'pousser',
  pull: 'tirer',
  legs: 'jambes',
};

export function dashboard() {
  return {
    greeting: '',
    todayLabel: '',
    streak: 0,
    bestStreak: 0,
    activityDays: [] as ActivityDay[],
    balance: null as BalanceReport | null,

    // ─── AI Coach ────────────────────────────────────────────────────────
    aiCoachAvailable: false,
    showCoachModal: false,
    coachQuestion: '',
    coachAnswer: '',
    coachLoading: false,
    coachSuggestions: [
      'Pourquoi je stagne au bench ?',
      'Mon volume est-il suffisant pour grossir ?',
      'Quand faire un deload ?',
      'Quel exercice je devrais ajouter ?',
    ] as string[],
    _allSessions: [] as WorkoutSession[],

    openCoachModal(): void {
      this.showCoachModal = true;
      this.coachAnswer = '';
      this.coachQuestion = '';
      hapticLight();
    },

    closeCoachModal(): void {
      this.showCoachModal = false;
    },

    resetCoach(): void {
      this.coachAnswer = '';
      this.coachQuestion = '';
    },

    async askCoachAi(): Promise<void> {
      const q = this.coachQuestion.trim();
      if (!q || this.coachLoading) return;
      this.coachLoading = true;
      try {
        const { askCoach } = await import('../lib/ai-coach');
        const result = await askCoach({ question: q, recentSessions: this._allSessions });
        this.coachAnswer = result.answer || "Je n'ai pas pu répondre. Réessaie.";
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Coach IA indisponible.';
        try {
          const { dispatchCoachError } = await import('../lib/ai-coach');
          dispatchCoachError(msg);
        } catch {
          /* noop */
        }
        this.coachAnswer = `❌ ${msg}`;
      } finally {
        this.coachLoading = false;
      }
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
      // Greeting i18n-aware (les imports dynamiques permettent de ne pas
      // gonfler le bundle si l'utilisateur reste en FR).
      const { t, getLocale } = await import('../lib/i18n');
      const greetingKey =
        hour < 12 ? 'greeting.morning' : hour < 18 ? 'greeting.afternoon' : 'greeting.evening';
      this.greeting = t(greetingKey);

      const localeTag = getLocale() === 'en' ? 'en-US' : 'fr-FR';
      this.todayLabel = new Date().toLocaleDateString(localeTag, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });

      try {
        const deps = await getDeps();

        const streakData = await deps.storage.get<StreakState>(STORAGE_KEYS.STREAK);
        if (streakData) {
          this.streak = streakData.count ?? 0;
          this.bestStreak = streakData.best ?? 0;
        }

        this.activityDays = await this._buildActivityDays();
        this.balance = await this._buildBalanceReport();
        this._allSessions = await loadSessions(deps.storage);

        // AI Coach disponibilité (config Supabase + clé VAPID indépendantes)
        try {
          const { isAiCoachAvailable } = await import('../lib/ai-coach');
          this.aiCoachAvailable = isAiCoachAvailable();
        } catch {
          this.aiCoachAvailable = false;
        }
      } catch (err) {
        console.error('[dashboard] init failed:', err);
      }
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
            entry.sets.map((set) => ({
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

    async _buildActivityDays(): Promise<ActivityDay[]> {
      try {
        const deps = await getDeps();
        const jours = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
        const today = new Date();

        // Lectures parallèles : 7 round-trips IDB → 1 batch
        const indices = Array.from({ length: 7 }, (_, k) => 6 - k);
        const dates = indices.map((i) => {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          return d;
        });
        const dones = await Promise.all(
          dates.map((d) => {
            const iso = d.toISOString().slice(0, 10);
            return deps.storage.get<string[]>(STORAGE_KEYS.VITALITE_DONE(iso));
          }),
        );
        return dates.map((d, k) => ({
          label: d.toISOString().slice(0, 10),
          short: jours[d.getDay()] ?? '',
          active: Array.isArray(dones[k]) && (dones[k] as string[]).length > 0,
        }));
      } catch (err) {
        console.warn('[dashboard] _buildActivityDays failed:', err);
        return [];
      }
    },
  };
}
