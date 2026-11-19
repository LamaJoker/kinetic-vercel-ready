/**
 * Page Achievements — vue catalogue + état (débloqués / verrouillés).
 * L'état vient du store `achievements` (recalculé au démarrage et après chaque
 * session). Cette page ne fait que filtrer/afficher.
 */
import type { Achievement } from '@kinetic/core';
import {
  achievementProgress,
  isNextTier,
  type AchievementMetrics,
  type AchievementProgress,
} from '../lib/achievement-progress';

type CategoryFilter = 'all' | 'milestone' | 'strength' | 'streak' | 'volume' | 'pr';

interface AchievementsStore {
  catalog: Achievement[];
  isUnlocked: (id: string) => boolean;
  progressPercent?: number;
  metrics?: AchievementMetrics | null;
}

interface AchievementsAlpine {
  filter: CategoryFilter;
  categories: Array<{ key: CategoryFilter; label: string }>;
  $store: { achievements: AchievementsStore };
  readonly filteredCatalog: Achievement[];
  readonly ringStyle: string;
  medalClass: (id: string) => string;
  showProgress: (id: string) => boolean;
  progressLabel: (id: string) => string;
  progressStyle: (id: string) => string;
  _progress: (id: string) => AchievementProgress | null;
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

    /**
     * Médaillon (styles/finitions.css § 6) : la couleur vient de la catégorie
     * (data-cat) et le métal du rang (data-tier) ; verrouillé = silhouette grise.
     */
    medalClass(id: string): string {
      return this.$store.achievements.isUnlocked(id) ? 'k-medal is-unlocked' : 'k-medal is-locked';
    },

    _progress(id: string): AchievementProgress | null {
      return achievementProgress(id, this.$store.achievements.metrics);
    },

    /** Barre de progression : seulement sur le prochain palier de chaque série. */
    showProgress(id: string): boolean {
      const store = this.$store.achievements;
      if (!store.metrics) return false;
      const ids = store.catalog.map((a) => a.id);
      return isNextTier(id, ids, (x) => store.isUnlocked(x)) && this._progress(id) !== null;
    },

    progressLabel(id: string): string {
      return this._progress(id)?.label ?? '';
    },

    progressStyle(id: string): string {
      const r = this._progress(id)?.ratio ?? 0;
      return `transform: scaleX(${Math.max(0.02, Math.min(1, r)).toFixed(3)})`;
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
