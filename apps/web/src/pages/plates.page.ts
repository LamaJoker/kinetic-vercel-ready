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

export interface PlateVisual {
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

/**
 * Géométrie proche du réel : les disques de 10 à 25 kg ont tous 450 mm de
 * diamètre (seule l'épaisseur change), les petits disques sont plus petits.
 */
export function plateGeometry(plateKg: number): { height: number; thick: number } {
  if (plateKg >= 10)
    return { height: 116, thick: plateKg >= 25 ? 15 : plateKg >= 20 ? 13 : plateKg >= 15 ? 11 : 9 };
  if (plateKg >= 5) return { height: 66, thick: 9 };
  if (plateKg >= 2.5) return { height: 54, thick: 7 };
  if (plateKg >= 1.25) return { height: 46, thick: 6 };
  return { height: 38, thick: 5 };
}

/** SVG de la barre chargée (valeurs numériques et couleurs internes uniquement). */
export function renderBarbellSvg(plates: readonly PlateVisual[], barKg: number): string {
  const W = 360;
  const H = 140;
  const cy = H / 2;
  const collarL = 104;
  const collarR = W - collarL;
  const sleeve = collarL - 6 - 6; // place disponible par côté (collier + marge)
  const gap = 1.5;
  const raw = plates.reduce((n, p) => n + p.width + gap, 0);
  const k = raw > sleeve ? sleeve / raw : 1;

  const parts: string[] = [];
  // Manchons + barre
  parts.push(`<rect x="4" y="${cy - 5}" width="${W - 8}" height="10" rx="3" fill="#8a8f98"/>`);
  parts.push(
    `<rect x="${collarL - 6}" y="${cy - 3}" width="${collarR - collarL + 12}" height="6" fill="#b9bec6"/>`,
  );
  parts.push(
    `<rect x="${collarL - 6}" y="${cy - 13}" width="6" height="26" rx="1.5" fill="#d7dbe0"/>`,
  );
  parts.push(`<rect x="${collarR}" y="${cy - 13}" width="6" height="26" rx="1.5" fill="#d7dbe0"/>`);

  let xr = collarR + 6;
  let xl = collarL - 6;
  for (const p of plates) {
    const w = p.width * k;
    const step = (p.width + gap) * k;
    const h = p.height;
    const y = cy - h / 2;
    for (const x of [xr, xl - w]) {
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="2.5" fill="${p.color}" stroke="rgba(0,0,0,.35)" stroke-width="1"/>`,
      );
      if (p.label && w >= 8) {
        const tx = (x + w / 2).toFixed(1);
        parts.push(
          `<text x="${tx}" y="${cy}" fill="${p.text}" font-size="8.5" font-weight="700" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${tx} ${cy})" font-family="Barlow Condensed, Arial Narrow, sans-serif">${p.label}</text>`,
        );
      }
    }
    xr += step;
    xl -= step;
  }
  const label = `Barre de ${barKg} kg chargée : ${
    plates
      .map((p) => p.label || '')
      .filter(Boolean)
      .join(', ') || 'petits disques'
  } par côté`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
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
      for (const p of this.result.perSide as readonly PlateLoad[]) {
        const c = colorFor(p.plateKg);
        const g = plateGeometry(p.plateKg);
        for (let i = 0; i < p.count; i++) {
          visuals.push({
            key: `${p.plateKg}-${i}`,
            width: g.thick,
            height: g.height,
            color: c.bg,
            text: c.text,
            label: p.plateKg < 5 ? '' : String(p.plateKg),
          });
        }
      }
      return visuals;
    },

    /** Barre chargée vue de face, disques aux couleurs de compétition (SVG). */
    get barbellSvg(): string {
      return renderBarbellSvg(this.mirroredPlates, this.barKg);
    },

    /** Pastille de couleur (objet style — compatible build CSP d'Alpine). */
    plateSwatch(plateKg: number): Record<string, string> {
      return { backgroundColor: colorFor(plateKg).bg };
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
