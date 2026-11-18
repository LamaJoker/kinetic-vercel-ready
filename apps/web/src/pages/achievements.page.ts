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
  progressPercent?: number;
}

interface AchievementsAlpine {
  filter: CategoryFilter;
  categories: Array<{ key: CategoryFilter; label: string }>;
  $store: { achievements: AchievementsStore };
  readonly filteredCatalog: Achievement[];
  readonly ringStyle: string;
  medalClass: (id: string) => string;
  medalWellClass: (id: string) => string;
  tierDotClass: (id: string, i: number, tier: number) => string;
  init: () => void;
}

export function achievements(): AchievementsAlpine {
  return {
    filter: 'all',
    categories: [
      { key: 'all', label: 'Tout' },
      { key: 'milestone', label: 'Séances' },
      { key: 'streak', label: 'Séries' },
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

    /** Variable CSS de l'anneau héros (lue par .k-ring-value). */
    get ringStyle(): string {
      const p = this.$store.achievements.progressPercent ?? 0;
      return `--p: ${Math.max(0, Math.min(100, p))}`;
    },

    /** Disque de la médaille : or en relief si débloquée, gris mat sinon. */
    medalClass(id: string): string {
      return this.$store.achievements.isUnlocked(id)
        ? 'bg-[radial-gradient(circle_at_32%_28%,#FFF6C2_0%,#FFD60A_38%,#E0A800_70%,#9A6B00_100%)]'
        : 'bg-kinetic-elevated';
    },

    /** Creux central de la médaille : sombre et chaud sous l'emoji si débloquée. */
    medalWellClass(id: string): string {
      return this.$store.achievements.isUnlocked(id)
        ? 'bg-[radial-gradient(circle_at_50%_35%,#4a3a0c_0%,#1f1704_100%)] ring-white/40'
        : 'ring-white/10';
    },

    /** Point de difficulté : plein (or ou gris) jusqu'au niveau, estompé au-delà. */
    tierDotClass(id: string, i: number, tier: number): string {
      if (i > tier) return 'bg-gray-400 opacity-25';
      return this.$store.achievements.isUnlocked(id) ? 'bg-kinetic-gold' : 'bg-gray-400';
    },

    init(): void {
      // L'init du store est faite globalement dans main.ts. Rien à faire ici.
    },
  };
}
