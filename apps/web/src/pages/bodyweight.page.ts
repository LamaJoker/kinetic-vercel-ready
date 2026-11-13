import { loc } from '../lib/num';
import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../deps';

interface BodyweightEntry {
  date: string;
  weight: number;
  bodyFatPct: number | null;
  note: string | null;
}

const STORAGE_KEY_ENTRIES = STORAGE_KEYS.BODYWEIGHT_ENTRIES;
const STORAGE_KEY_GOAL = STORAGE_KEYS.BODYWEIGHT_GOAL;

export function bodyweight() {
  return {
    entries: [] as BodyweightEntry[],
    newWeight: null as number | null,
    newBf: null as number | null,
    newNote: '',
    goalWeight: null as number | null,
    period: 90,
    /** Historique : mode édition (corbeilles visibles) et liste complète. */
    editing: false,
    showAll: false,
    _chartSvgCache: '' as string,
    _chartSvgVersion: '' as string,

    get filteredEntries(): BodyweightEntry[] {
      if (this.period >= 9999) return this.entries;
      const cutoff = Date.now() - this.period * 24 * 60 * 60 * 1000;
      return this.entries.filter((e) => Date.parse(e.date) >= cutoff);
    },

    get latest(): BodyweightEntry | null {
      return this.entries.at(-1) ?? null;
    },
    get earliest(): BodyweightEntry | null {
      return this.filteredEntries[0] ?? null;
    },

    get minWeight(): number | null {
      const e = this.filteredEntries;
      return e.length ? Math.min(...e.map((x) => x.weight)) : null;
    },
    get maxWeight(): number | null {
      const e = this.filteredEntries;
      return e.length ? Math.max(...e.map((x) => x.weight)) : null;
    },
    get avgWeight(): number | null {
      const e = this.filteredEntries;
      if (!e.length) return null;
      return e.reduce((a, x) => a + x.weight, 0) / e.length;
    },
    get delta(): number | null {
      const e = this.filteredEntries;
      if (e.length < 2) return null;
      return (e.at(-1)?.weight ?? 0) - (e[0]?.weight ?? 0);
    },
    get trend7(): number | null {
      const recent = this.entries.filter((e) => Date.now() - Date.parse(e.date) <= 7 * 86400000);
      if (recent.length < 2) return null;
      return (recent.at(-1)?.weight ?? 0) - (recent[0]?.weight ?? 0);
    },
    get goalProgress(): number {
      if (!this.goalWeight || !this.latest) return 0;
      const start = this.entries[0]?.weight ?? this.latest.weight;
      if (Math.abs(this.goalWeight - start) < 0.01) return 100;
      return (Math.abs(this.latest.weight - start) / Math.abs(this.goalWeight - start)) * 100;
    },

    /**
     * BUG FIX #2 — comparaison par date (string), pas par référence objet.
     *
     * L'ancienne implémentation utilisait `reversed.indexOf(entry)` qui compare
     * des références JavaScript. Alpine.js enveloppe les tableaux dans des Proxy —
     * l'objet `entry` du template et l'objet dans `reversed` ne sont PAS la même
     * référence, donc indexOf retournait toujours -1 et le delta était toujours 0.
     *
     * `posFromTop` est le rang d'affichage (index dans `.slice().reverse()`) passé
     * par le template, mais on ne peut pas s'y fier pour retrouver la position dans
     * `filteredEntries` (pagination possible). On recherche donc par `entry.date`
     * qui est unique par jour de saisie.
     */
    entryDelta(entry: BodyweightEntry, _posFromTop: number): number {
      // On travaille sur filteredEntries (ordre chronologique asc) pour trouver
      // l'entrée précédente, indépendamment de l'ordre d'affichage inversé du template.
      const list = this.filteredEntries;
      const idx = list.findIndex((e) => e.date === entry.date);

      // Première entrée de la période ou date introuvable → pas de delta
      if (idx <= 0) return 0;

      return entry.weight - (list[idx - 1]?.weight ?? entry.weight);
    },

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const [stored, goal] = await Promise.all([
          deps.storage.get(STORAGE_KEY_ENTRIES),
          deps.storage.get(STORAGE_KEY_GOAL),
        ]);
        this.entries = Array.isArray(stored) ? (stored as BodyweightEntry[]) : [];
        if (typeof goal === 'number') this.goalWeight = goal;
      } catch (err) {
        console.error('[bodyweight] init failed:', err);
      }
    },

    async addEntry(): Promise<void> {
      if (!this.newWeight || this.newWeight < 30) return;
      const today = new Date().toISOString().slice(0, 10);
      const idx = this.entries.findIndex((e) => e.date === today);
      const entry: BodyweightEntry = {
        date: today,
        weight: +this.newWeight,
        bodyFatPct: this.newBf != null ? +this.newBf : null,
        note: this.newNote.trim() || null,
      };
      const next =
        idx >= 0
          ? this.entries.map((e, i) => (i === idx ? entry : e))
          : [...this.entries, entry].sort((a, b) => a.date.localeCompare(b.date));
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY_ENTRIES, next);
        if (this.goalWeight) {
          await deps.storage.set(STORAGE_KEY_GOAL, this.goalWeight);
        }
        this.entries = next;
        this.newWeight = null;
        this.newBf = null;
        this.newNote = '';
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: loc(entry.weight.toFixed(1)) + ' kg enregistré' },
          }),
        );
      } catch (err) {
        console.error('[bodyweight] addEntry failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec enregistrement du poids. Réessaie.' },
          }),
        );
      }
    },

    async removeEntry(date: string): Promise<void> {
      const next = this.entries.filter((e) => e.date !== date);
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY_ENTRIES, next);
        this.entries = next;
      } catch (err) {
        console.error('[bodyweight] removeEntry failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec de suppression. Réessaie.' },
          }),
        );
      }
    },

    formatDate(iso: string): string {
      try {
        return new Date(iso).toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: 'short',
          year: '2-digit',
        });
      } catch {
        return iso;
      }
    },

    /**
     * Sens « favorable » d'une variation : si un objectif est fixé, on compare
     * à la direction de l'objectif (perte ou prise) ; sinon une baisse est
     * considérée favorable (comportement historique de l'écran).
     */
    _goodWhenDown(): boolean {
      if (this.goalWeight && this.goalWeight > 0) {
        const start = this.entries[0]?.weight ?? this.latest?.weight ?? this.goalWeight;
        return this.goalWeight <= start;
      }
      return true;
    },

    /** Classe de couleur d'une variation : vert si favorable, rouge sinon, gris si stable. */
    toneClass(d: number | null | undefined): string {
      if (d === null || d === undefined || Math.abs(d) <= 0.05) return 'text-gray-500';
      const good = d < 0 ? this._goodWhenDown() : !this._goodWhenDown();
      return good ? 'text-kinetic-teal' : 'text-kinetic-electric';
    },

    /** Orientation de la flèche de tendance (flèche → tournée vers le haut ou le bas). */
    arrowClass(d: number | null | undefined): string {
      if (d === null || d === undefined || Math.abs(d) <= 0.05) return '';
      return d > 0 ? '-rotate-45' : 'rotate-45';
    },

    /** Variation signée formatée : « +0.4 », « −0.3 », « 0.0 ». */
    signed(d: number | null | undefined): string {
      const v = d ?? 0;
      if (v > 0) return '+' + loc(v.toFixed(1));
      if (v < 0) return '\u2212' + loc(Math.abs(v).toFixed(1));
      return loc(v.toFixed(1));
    },

    chartSvg(): string {
      const pts = this.filteredEntries;
      if (pts.length < 2) return '';

      // Courbe : `text-kinetic-neon/100` garde le jaune d'accent dans les deux modes
      // (la règle claire de `.text-kinetic-neon` vise le texte, pas les tracés).
      const isLight =
        typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-mode') === 'light';
      const areaTop = isLight ? '0.18' : '0.28';
      const version = `${isLight ? 'l' : 'd'}:${pts.length}:${pts[0]?.date ?? ''}:${pts.at(-1)?.date ?? ''}:${pts.at(-1)?.weight ?? ''}:${this.goalWeight ?? ''}:${this.period}`;
      if (this._chartSvgVersion === version && this._chartSvgCache) return this._chartSvgCache;

      // Géométrie : zone de tracé à gauche, graduations à droite (style Santé iOS).
      const W = 320,
        H = 168,
        plotL = 2,
        plotR = 284,
        plotT = 10,
        plotB = 140;
      const weights = pts.map((e) => e.weight);
      let lo = Math.min(...weights);
      let hi = Math.max(...weights);
      const goal = this.goalWeight && this.goalWeight > 0 ? this.goalWeight : null;
      // L'objectif n'étend l'échelle que s'il est proche de la courbe.
      const showGoal = goal !== null && goal >= lo - 3 && goal <= hi + 3;
      if (showGoal && goal !== null) {
        lo = Math.min(lo, goal);
        hi = Math.max(hi, goal);
      }
      lo = Math.floor(lo - 0.5);
      hi = Math.ceil(hi + 0.5);
      if (hi - lo < 2) hi = lo + 2;

      const minX = Date.parse(pts[0]!.date);
      const maxX = Date.parse(pts.at(-1)!.date);
      const dx = Math.max(1, maxX - minX);
      const sx = (d: number) => plotL + ((d - minX) / dx) * (plotR - plotL);
      const sy = (y: number) => plotB - ((y - lo) / (hi - lo)) * (plotB - plotT);
      const fmtKg = (v: number) => (Number.isInteger(v) ? String(v) : loc(v.toFixed(1)));

      const coords = pts.map((e) => [sx(Date.parse(e.date)), sy(e.weight)] as const);
      const linePath = coords
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
        .join(' ');
      const areaPath =
        linePath +
        ` L${coords.at(-1)![0].toFixed(1)} ${plotB} L${coords[0]![0].toFixed(1)} ${plotB} Z`;

      // Grille neutre : 3 graduations (haut, milieu, bas), couleur système.
      const ticks = [hi, (hi + lo) / 2, lo];
      const grid = ticks
        .map((v) => {
          const y = sy(v).toFixed(1);
          return (
            `<line x1="${plotL}" y1="${y}" x2="${plotR}" y2="${y}" class="text-gray-500" stroke="currentColor" stroke-opacity="0.22" stroke-width="1"/>` +
            `<text x="${W - 2}" y="${(+y + 4).toFixed(1)}" text-anchor="end" class="text-gray-500" fill="currentColor" font-size="11.5">${fmtKg(v)}</text>`
          );
        })
        .join('');

      let goalLine = '';
      if (showGoal && goal !== null) {
        const gy = sy(goal).toFixed(1);
        goalLine =
          `<line x1="${plotL}" y1="${gy}" x2="${plotR}" y2="${gy}" class="text-kinetic-teal" stroke="currentColor" stroke-width="1.25" stroke-dasharray="3 4" stroke-linecap="round"/>` +
          `<text x="${plotL + 2}" y="${(+gy - 5).toFixed(1)}" class="text-kinetic-teal" fill="currentColor" font-size="11.5" font-weight="600">Objectif ${fmtKg(goal)}</text>`;
      }

      // Points intermédiaires discrets quand la série est courte.
      const dots =
        pts.length <= 20
          ? coords
              .slice(0, -1)
              .map(
                ([x, y]) =>
                  `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" class="text-kinetic-neon/100" fill="currentColor"/>`,
              )
              .join('')
          : '';

      const [lastX, lastY] = coords.at(-1)!;
      const startLabel = this.formatDate(pts[0]!.date);
      const endLabel = this.formatDate(pts.at(-1)!.date);

      const svg = `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de poids, de ${startLabel} à ${endLabel}">
        <defs>
          <linearGradient id="bw-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="text-kinetic-neon/100" stop-color="currentColor" stop-opacity="${areaTop}"/>
            <stop offset="1" class="text-kinetic-neon/100" stop-color="currentColor" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}
        ${goalLine}
        <path d="${areaPath}" fill="url(#bw-area)"/>
        <path d="${linePath}" fill="none" class="text-kinetic-neon/100" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="5.5" class="text-kinetic-surface" fill="currentColor"/>
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" class="text-kinetic-neon/100" fill="currentColor"/>
        <text x="${plotL}" y="${H - 6}" class="text-gray-500" fill="currentColor" font-size="11.5">${startLabel}</text>
        <text x="${plotR}" y="${H - 6}" text-anchor="end" class="text-gray-500" fill="currentColor" font-size="11.5">${endLabel}</text>
      </svg>`;
      this._chartSvgCache = svg;
      this._chartSvgVersion = version;
      return svg;
    },
  };
}
