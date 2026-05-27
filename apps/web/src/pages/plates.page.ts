/**
 * Page Plates — calculateur de combinaison de disques pour une barre.
 * Logique pure dans @kinetic/core/domain/plate-calculator.
 */
import {
  STORAGE_KEYS,
  calculatePlates,
  DEFAULT_PLATES_METRIC,
  type PlateLoad,
} from '@kinetic/core';
import { getDeps } from '../deps';

const KEY_PLATE_PREFS = STORAGE_KEYS.PLATE_PREFS;

interface PlatePrefs {
  barKg: number;
  targetKg: number;
  enabledPlates: number[];
}

interface PlateVisual {
  key: string;
  width: number;
  height: number;
  color: string;
  text: string;
  label: string;
}

// Palette de couleurs IPF (poids olympiques)
const PLATE_COLORS: Record<number, { bg: string; text: string }> = {
  25: { bg: '#dc2626', text: '#fff' }, // rouge
  20: { bg: '#1d4ed8', text: '#fff' }, // bleu
  15: { bg: '#ca8a04', text: '#000' }, // jaune
  10: { bg: '#16a34a', text: '#fff' }, // vert
  5: { bg: '#f3f4f6', text: '#000' }, // blanc
  2.5: { bg: '#374151', text: '#fff' }, // gris foncé
  1.25: { bg: '#9ca3af', text: '#000' }, // gris clair
  0.5: { bg: '#a16207', text: '#fff' }, // bronze
};

function colorFor(plateKg: number): { bg: string; text: string } {
  return PLATE_COLORS[plateKg] ?? { bg: '#6b7280', text: '#fff' };
}

export function plates() {
  return {
    BAR_PRESETS: [20, 15, 12, 7] as const,
    PLATE_OPTIONS: [25, 20, 15, 10, 5, 2.5, 1.25, 0.5] as const,

    barKg: 20,
    targetKg: 100,
    enabledPlates: [...DEFAULT_PLATES_METRIC] as number[],
    showPlates: false,

    get result() {
      return calculatePlates({
        targetKg: this.targetKg,
        barKg: this.barKg,
        availablePlates: this.enabledPlates,
      });
    },

    get resultLabel(): string {
      const r = this.result;
      if (r.underBar) return 'Cible < barre';
      if (r.perSide.length === 0) return 'Barre seule';
      if (r.inexact) return `≈ ${r.achievedKg} kg`;
      return `Total ${r.achievedKg} kg`;
    },

    /** Liste de plates pour la visualisation gauche (miroir du côté droit). */
    get mirroredPlates(): PlateVisual[] {
      const visuals: PlateVisual[] = [];
      // Du plus gros au plus petit (proche du sol → vers la barre)
      for (const p of this.result.perSide as readonly PlateLoad[]) {
        const c = colorFor(p.plateKg);
        for (let i = 0; i < p.count; i++) {
          // Largeur/hauteur proportionnelles au poids (clamped)
          const heightPx = Math.max(28, Math.min(56, 14 + p.plateKg * 1.5));
          const widthPx = Math.max(8, Math.min(18, 6 + p.plateKg * 0.4));
          visuals.push({
            key: `${p.plateKg}-${i}`,
            width: widthPx,
            height: heightPx,
            color: c.bg,
            text: c.text,
            label: p.plateKg < 5 ? '' : String(p.plateKg),
          });
        }
      }
      return visuals;
    },

    togglePlate(p: number): void {
      if (this.enabledPlates.includes(p)) {
        this.enabledPlates = this.enabledPlates.filter((x) => x !== p);
      } else {
        this.enabledPlates = [...this.enabledPlates, p].sort((a, b) => b - a);
      }
      void this._persist();
    },

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const saved = await deps.storage.get<PlatePrefs>(KEY_PLATE_PREFS);
        if (saved) {
          this.barKg = saved.barKg ?? 20;
          this.targetKg = saved.targetKg ?? 100;
          if (Array.isArray(saved.enabledPlates) && saved.enabledPlates.length > 0) {
            this.enabledPlates = saved.enabledPlates;
          }
        }
      } catch (err) {
        console.warn('[plates] init failed:', err);
      }

      // Persister sur changement avec un petit debounce manuel
      this.$watch?.('targetKg', () => void this._persistDebounced());
      this.$watch?.('barKg', () => void this._persistDebounced());
    },

    _persistTimer: null as ReturnType<typeof setTimeout> | null,
    _persistDebounced(): void {
      if (this._persistTimer) clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => {
        void this._persist();
      }, 400);
    },

    async _persist(): Promise<void> {
      try {
        const deps = await getDeps();
        await deps.storage.set(KEY_PLATE_PREFS, {
          barKg: this.barKg,
          targetKg: this.targetKg,
          enabledPlates: this.enabledPlates,
        } satisfies PlatePrefs);
      } catch (err) {
        // Non-bloquant — l'utilisateur peut continuer même si la persistance échoue
        console.warn('[plates] persist failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'Préférences non sauvegardées (mode privé ?)' },
          }),
        );
      }
    },

    // Alpine attache $watch dynamiquement — typage minimal
    $watch: undefined as ((path: string, cb: () => void) => void) | undefined,
  };
}
