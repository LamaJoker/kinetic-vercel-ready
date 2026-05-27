/**
 * Composant Alpine pour la page dashboard.
 * Enregistré dans main.ts via Alpine.data('dashboard', dashboard).
 */
import { STORAGE_KEYS, muscleBalance } from '@kinetic/core';
import type { BalanceReport, StreakState } from '@kinetic/core';
import { getDeps } from '../deps';
import type { WorkoutSession, Exercise } from '../lib/training/types';
import { loadSessions, loadExercises } from '../lib/training/storage';

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
      this.greeting = hour < 12 ? 'Bonjour 👋' : hour < 18 ? 'Bon après-midi 🌤️' : 'Bonsoir 🌙';

      this.todayLabel = new Date().toLocaleDateString('fr-FR', {
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
