/**
 * Composant Alpine pour la page dashboard.
 * Enregistré dans main.ts via Alpine.data('dashboard', dashboard).
 */
import { getDeps } from '../deps';
import type { StreakState } from '@kinetic/core';

interface ActivityDay {
  label:  string;
  short:  string;
  active: boolean;
}

export function dashboard() {
  return {
    greeting:     '',
    todayLabel:   '',
    streak:       0,
    bestStreak:   0,
    activityDays: [] as ActivityDay[],

    async init(): Promise<void> {
      const hour = new Date().getHours();
      this.greeting = hour < 12
        ? 'Bonjour 👋'
        : hour < 18
          ? 'Bon après-midi 🌤️'
          : 'Bonsoir 🌙';

      this.todayLabel = new Date().toLocaleDateString('fr-FR', {
        weekday: 'long',
        day:     'numeric',
        month:   'long',
      });

      try {
        const deps = await getDeps();

        const streakData = await deps.storage.get<StreakState>('kinetic:streak');
        if (streakData) {
          this.streak     = streakData.count ?? 0;
          this.bestStreak = streakData.best  ?? 0;
        }

        this.activityDays = await this._buildActivityDays();
      } catch (err) {
        console.error('[dashboard] init failed:', err);
      }
    },

    async _buildActivityDays(): Promise<ActivityDay[]> {
      const deps  = await getDeps();
      const days: ActivityDay[] = [];
      const jours = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
      const today = new Date();

      for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const iso  = d.toISOString().slice(0, 10);
        const done = await deps.storage.get<string[]>(`kinetic:vitalite:done:${iso}`);
        days.push({
          label:  iso,
          short:  jours[d.getDay()] ?? '',
          active: Array.isArray(done) && done.length > 0,
        });
      }
      return days;
    },
  };
}
