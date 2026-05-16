/**
 * Composant Alpine pour la page dashboard.
 * Enregistré dans main.ts via Alpine.data('dashboard', dashboard).
 */
import { STORAGE_KEYS } from '@kinetic/core';
import type { StreakState } from '@kinetic/core';
import { getDeps } from '../deps';

interface ActivityDay {
  label: string;
  short: string;
  active: boolean;
}

export function dashboard() {
  return {
    greeting: '',
    todayLabel: '',
    streak: 0,
    bestStreak: 0,
    activityDays: [] as ActivityDay[],

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
      } catch (err) {
        console.error('[dashboard] init failed:', err);
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
            return deps.storage.get<string[]>(`kinetic:vitalite:done:${iso}`);
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
