/**
 * Page Achievements — vue catalogue + état (débloqués / verrouillés).
 * L'état vient du store `achievements` (recalculé au démarrage et après chaque
 * session). Cette page ne fait que filtrer/afficher.
 */
import type { Achievement } from '@kinetic/core';

type CategoryFilter = 'all' | 'milestone' | 'strength' | 'streak' | 'volume' | 'pr';

interface AchievementsStore {
  catalog: Achievement[];
  isUnlocked: (id: string) => boolean;
}

interface AchievementsAlpine {
  filter: CategoryFilter;
  categories: Array<{ key: CategoryFilter; label: string }>;
  $store: { achievements: AchievementsStore };
  readonly filteredCatalog: Achievement[];
  init: () => void;
}

export function achievements(): AchievementsAlpine {
  return {
    filter: 'all',
    categories: [
      { key: 'all', label: 'Tout' },
      { key: 'milestone', label: 'Séances' },
      { key: 'streak', label: 'Streak' },
      { key: 'pr', label: 'PR' },
      { key: 'volume', label: 'Volume' },
      { key: 'strength', label: 'Force' },
    ],
    $store: { achievements: { catalog: [], isUnlocked: () => false } },

    get filteredCatalog(): Achievement[] {
      const catalog = this.$store.achievements.catalog;
      const list =
        this.filter === 'all' ? catalog : catalog.filter((a) => a.category === this.filter);
      // Unlocked d'abord, puis par tier croissant
      return [...list].sort((a, b) => {
        const ua = this.$store.achievements.isUnlocked(a.id) ? 0 : 1;
        const ub = this.$store.achievements.isUnlocked(b.id) ? 0 : 1;
        if (ua !== ub) return ua - ub;
        return a.tier - b.tier;
      });
    },

    init(): void {
      // L'init du store est faite globalement dans main.ts. Rien à faire ici.
    },
  };
}
