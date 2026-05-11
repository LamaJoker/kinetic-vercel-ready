import { getDeps } from '../deps';

interface BodyweightEntry {
  date: string;
  weight: number;
  bodyFatPct: number | null;
  note: string | null;
}

const STORAGE_KEY_ENTRIES = 'kinetic:bodyweight:entries';
const STORAGE_KEY_GOAL    = 'kinetic:bodyweight:goal';

export function bodyweight() {
  return {
    entries: [] as BodyweightEntry[],
    newWeight: null as number | null,
    newBf:     null as number | null,
    newNote:   '',
    goalWeight: null as number | null,
    period: 90,

    get filteredEntries(): BodyweightEntry[] {
      if (this.period >= 9999) return this.entries;
      const cutoff = Date.now() - this.period * 24 * 60 * 60 * 1000;
      return this.entries.filter(e => Date.parse(e.date) >= cutoff);
    },

    get latest(): BodyweightEntry | null   { return this.entries.at(-1) ?? null; },
    get earliest(): BodyweightEntry | null { return this.filteredEntries[0] ?? null; },

    get minWeight(): number | null {
      const e = this.filteredEntries;
      return e.length ? Math.min(...e.map(x => x.weight)) : null;
    },
    get maxWeight(): number | null {
      const e = this.filteredEntries;
      return e.length ? Math.max(...e.map(x => x.weight)) : null;
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
      const recent = this.entries.filter(e => Date.now() - Date.parse(e.date) <= 7 * 86400000);
      if (recent.length < 2) return null;
      return (recent.at(-1)?.weight ?? 0) - (recent[0]?.weight ?? 0);
    },
    get goalProgress(): number {
      if (!this.goalWeight || !this.latest) return 0;
      const start = this.entries[0]?.weight ?? this.latest.weight;
      if (Math.abs(this.goalWeight - start) < 0.01) return 100;
      return Math.abs(this.latest.weight - start) / Math.abs(this.goalWeight - start) * 100;
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
      const idx  = list.findIndex(e => e.date === entry.date);

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
      const idx = this.entries.findIndex(e => e.date === today);
      const entry: BodyweightEntry = {
        date: today,
        weight: +this.newWeight,
        bodyFatPct: this.newBf != null ? +this.newBf : null,
        note: this.newNote.trim() || null,
      };
      const next = idx >= 0
        ? this.entries.map((e, i) => i === idx ? entry : e)
        : [...this.entries, entry].sort((a, b) => a.date.localeCompare(b.date));
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY_ENTRIES, next);
        if (this.goalWeight) {
          await deps.storage.set(STORAGE_KEY_GOAL, this.goalWeight);
        }
        this.entries = next;
        this.newWeight = null; this.newBf = null; this.newNote = '';
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'success', message: entry.weight.toFixed(1) + ' kg enregistré' },
        }));
      } catch (err) {
        console.error('[bodyweight] addEntry failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Échec enregistrement du poids. Réessaie.' },
        }));
      }
    },

    async removeEntry(date: string): Promise<void> {
      const next = this.entries.filter(e => e.date !== date);
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY_ENTRIES, next);
        this.entries = next;
      } catch (err) {
        console.error('[bodyweight] removeEntry failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Échec de suppression. Réessaie.' },
        }));
      }
    },

    formatDate(iso: string): string {
      try {
        return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
      } catch { return iso; }
    },

    chartSvg(): string {
      const pts = this.filteredEntries;
      if (pts.length < 2) return '';

      const W = 320, H = 140, padX = 10, padY = 20, labelH = 14;
      const weights = pts.map(e => e.weight);
      const minY = Math.min(...weights) - 0.5;
      const maxY = Math.max(...weights) + 0.5;
      const minX = Date.parse(pts[0]!.date);
      const maxX = Date.parse(pts.at(-1)!.date);
      const dx = Math.max(1, maxX - minX);
      const dy = Math.max(0.1, maxY - minY);
      const chartH = H - labelH;

      const sx = (d: number) => padX + (d - minX) / dx * (W - padX * 2);
      const sy = (y: number) => chartH - padY - (y - minY) / dy * (chartH - padY * 2);

      const linePath = pts.map((e, i) =>
        `${i === 0 ? 'M' : 'L'} ${sx(Date.parse(e.date)).toFixed(1)} ${sy(e.weight).toFixed(1)}`
      ).join(' ');
      const areaPath = linePath
        + ` L ${sx(Date.parse(pts.at(-1)!.date)).toFixed(1)} ${chartH}`
        + ` L ${padX} ${chartH} Z`;

      const gridLines = [0, 0.5, 1].map(ratio => {
        const y = padY + ratio * (chartH - padY * 2);
        return `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${W - padX}" y2="${y.toFixed(1)}" stroke="#ffffff08" stroke-width="1"/>`;
      }).join('');

      const lastPt = pts.at(-1)!;
      const lastCx = sx(Date.parse(lastPt.date)).toFixed(1);
      const lastCy = sy(lastPt.weight).toFixed(1);

      let goalLine = '';
      if (this.goalWeight && this.goalWeight >= minY && this.goalWeight <= maxY + 2) {
        const gy = sy(this.goalWeight).toFixed(1);
        goalLine = `
          <line x1="${padX}" y1="${gy}" x2="${W - padX}" y2="${gy}"
                stroke="#A8FF00" stroke-width="1" stroke-dasharray="4 3" opacity="0.4"/>
          <text x="${W - padX + 2}" y="${+gy + 4}" fill="#A8FF00" font-size="8" opacity="0.6">${this.goalWeight}</text>`;
      }

      const startLabel = this.formatDate(pts[0]!.date);
      const endLabel = this.formatDate(lastPt.date);

      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de poids">
        ${gridLines}
        ${goalLine}
        <path d="${areaPath}" fill="#A8FF00" fill-opacity="0.07"/>
        <path d="${linePath}" fill="none" stroke="#A8FF00" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${lastCx}" cy="${lastCy}" r="5" fill="#A8FF00" filter="drop-shadow(0 0 4px rgba(168,255,0,0.8))"/>
        <circle cx="${lastCx}" cy="${lastCy}" r="2.5" fill="#0A0A0F"/>
        <text x="${padX}" y="${H - 2}" fill="#4B5563" font-size="9">${startLabel}</text>
        <text x="${W - padX}" y="${H - 2}" text-anchor="end" fill="#4B5563" font-size="9">${endLabel}</text>
        <text x="${padX}" y="12" fill="#6B7280" font-size="9">${maxY.toFixed(1)} kg</text>
        <text x="${padX}" y="${chartH - 4}" fill="#6B7280" font-size="9">${minY.toFixed(1)} kg</text>
      </svg>`;
    },
  };
}
