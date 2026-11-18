/**
 * Carte des muscles — composant Alpine imbriqué (Progression › Muscles et
 * aperçu compact de l'accueil), chargé à la demande (lib/lazy-component.ts).
 * Les séances et exercices viennent de la page via
 * `x-effect="sync(sessions, exercises)"`.
 *
 * Silhouette avant / arrière (components/muscle-map-svg.ts), chaque zone colorée
 * selon les séries de travail par semaine sur 7 ou 30 jours ; toucher une zone
 * (ou une ligne de la liste) affiche ses séries, son tonnage et ses exercices.
 * Calculs : packages/core muscle-map.domain.
 */
import {
  MUSCLE_LEVELS,
  buildMuscleMap,
  type MuscleLevel,
  type MuscleMap,
  type MuscleRegion,
  type RegionStats,
} from '@kinetic/core';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { muscleMapSvg, regionFromClass } from './muscle-map-svg';
import { formatTonnage } from './visual-format';
import './visual-views.css';

export type MuscleMapDays = 7 | 30;

/** « 3 » ; « 2,5 » (séries pondérées : les muscles secondaires comptent ½). */
export function formatSets(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString('fr-FR');
}

export interface RegionDetail {
  key: MuscleRegion;
  label: string;
  sets: string;
  perWeek: string;
  tonnage: string;
  levelLabel: string;
  levelCls: string;
  exercises: Array<{ id: string; name: string; sets: string }>;
}

const LEVEL_LABELS: Readonly<Record<MuscleLevel, string>> = {
  0: 'Pas travaillé',
  1: 'Léger',
  2: 'Modéré',
  3: 'Élevé',
  4: 'Très élevé',
};

/** Lecture d'une zone pour le panneau de détail. */
export function regionDetail(
  r: RegionStats,
  days: number,
  exerciseName: (id: string) => string,
): RegionDetail {
  return {
    key: r.key,
    label: r.label,
    sets: `${formatSets(r.sets)} série${r.sets > 1 ? 's' : ''} en ${days} j`,
    perWeek: `${formatSets(r.setsPerWeek)} / sem.`,
    tonnage: formatTonnage(r.tonnageKg),
    levelLabel: LEVEL_LABELS[r.level],
    levelCls: `k-mm-key k-mm-l${r.level}`,
    exercises: r.exercises.map((e) => ({
      id: e.exerciseId,
      name: exerciseName(e.exerciseId),
      sets: `${e.sets} série${e.sets > 1 ? 's' : ''}`,
    })),
  };
}

/** Légende : de « pas travaillé » à « très élevé » (séries par semaine). */
export function muscleLegend(): Array<{ key: string; label: string; cls: string }> {
  return [
    { key: 'l0', label: '0', cls: 'k-mm-key k-mm-l0' },
    ...MUSCLE_LEVELS.map((l) => ({
      key: `l${l.level}`,
      label: l.label,
      cls: `k-mm-key k-mm-l${l.level}`,
    })),
  ];
}

export function muscleMap() {
  // Mémo hors état réactif : la carte est relue par plusieurs liaisons.
  let memo: { key: string; sessions: unknown; exercises: unknown; value: MuscleMap } | null = null;

  return {
    days: 7 as MuscleMapDays,
    selected: null as MuscleRegion | null,
    /** Aperçu de l'accueil (data-compact sur l'élément) : silhouette seule. */
    compact: false,
    _sessions: [] as WorkoutSession[],
    _exercises: [] as Exercise[],
    legend: muscleLegend(),

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      this.compact = el?.dataset.compact === 'true';
    },

    sync(sessions: WorkoutSession[] | undefined, exercises: Exercise[] | undefined): void {
      this._sessions = sessions ?? [];
      this._exercises = exercises ?? [];
    },

    get map(): MuscleMap {
      const now = new Date();
      // Clé à l'heure près : la fenêtre glissante avance sans recalcul à chaque lecture.
      const key = `${this.days}-${this._sessions.length}-${now.toISOString().slice(0, 13)}`;
      if (
        memo &&
        memo.key === key &&
        memo.sessions === this._sessions &&
        memo.exercises === this._exercises
      ) {
        return memo.value;
      }
      const muscles = new Map(this._exercises.map((e) => [e.id, e.muscles ?? []]));
      const value = buildMuscleMap({
        sessions: this._sessions,
        musclesOf: (id) => muscles.get(id) ?? [],
        days: this.days,
        now,
      });
      memo = { key, sessions: this._sessions, exercises: this._exercises, value };
      return value;
    },

    svg(): string {
      const levels: Partial<Record<MuscleRegion, MuscleLevel>> = {};
      for (const r of Object.values(this.map.regions)) levels[r.key] = r.level;
      const top = this.map.ranked
        .slice(0, 3)
        .map((r) => r.label)
        .join(', ');
      return muscleMapSvg({
        levels,
        selected: this.selected,
        compact: this.compact,
        label: top
          ? `Carte des muscles sur ${this.days} jours. Plus travaillés : ${top}.`
          : `Carte des muscles : aucune série sur ${this.days} jours.`,
      });
    },

    // ─── Période ─────────────────────────────────────────────

    setDays(d: MuscleMapDays): void {
      this.days = d;
    },
    daysPressed(d: MuscleMapDays): string {
      return this.days === d ? 'true' : 'false';
    },

    // ─── Sélection ───────────────────────────────────────────

    /** Toucher sur la silhouette (délégation : x-svg recrée les formes). */
    pickFromEvent(e: Event): void {
      const target = e.target as Element | null;
      const region = regionFromClass(target?.getAttribute?.('class'));
      if (region) this.select(region);
    },
    select(region: MuscleRegion): void {
      this.selected = this.selected === region ? null : region;
    },
    clear(): void {
      this.selected = null;
    },
    isSelected(region: MuscleRegion): boolean {
      return this.selected === region;
    },

    get detail(): RegionDetail | null {
      if (!this.selected) return null;
      const r = this.map.regions[this.selected];
      if (!r) return null;
      const names = new Map(this._exercises.map((e) => [e.id, e.name]));
      return regionDetail(r, this.days, (id) => names.get(id) ?? id);
    },

    // ─── Résumé et liste ─────────────────────────────────────

    hasData(): boolean {
      return this.map.ranked.length > 0;
    },
    /** Zones travaillées, les plus sollicitées d'abord (liste accessible). */
    rows(): Array<{
      key: MuscleRegion;
      label: string;
      value: string;
      cls: string;
      barCls: string;
      width: string;
    }> {
      const ranked = this.map.ranked;
      const max = ranked[0]?.sets ?? 1;
      return ranked.map((r) => ({
        key: r.key,
        label: r.label,
        value: formatSets(r.sets),
        cls: `k-mm-key k-mm-l${r.level}`,
        barCls: `k-mm-bar k-mm-l${r.level}`,
        width: `width: ${Math.max(4, Math.round((r.sets / max) * 100))}%`,
      }));
    },
    /** Zones non travaillées sur la période (« À travailler »). */
    idleLabels(): string {
      return Object.values(this.map.regions)
        .filter((r) => r.sets === 0)
        .map((r) => r.label)
        .join(', ');
    },
    summary(): string {
      const m = this.map;
      const n = m.totalSets;
      if (n === 0) return `Aucune série de travail sur ${m.days} jours`;
      return `${n} série${n > 1 ? 's' : ''} de travail sur ${m.days} jours`;
    },
    /** Aperçu : les trois zones les plus travaillées. */
    topLabels(): string {
      return this.map.ranked
        .slice(0, 3)
        .map((r) => r.label)
        .join(' · ');
    },
  };
}
