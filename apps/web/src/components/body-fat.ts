/**
 * bodyFatCard — taux de masse grasse estimé (méthode US Navy), affiché dans
 * Mensurations et Poids. Lit les mensurations (cou, taille, hanches), les
 * pesées et le profil (sexe, taille) ; aucune donnée propre : rien de plus à
 * sauvegarder. Logique dans @kinetic/core (body-composition.domain).
 *
 * Le % saisi à la main avec une pesée n'est jamais remplacé : les deux valeurs
 * sont montrées côte à côte. Mise à jour après chaque enregistrement via
 * l'événement BODY_CHANGED_EVENT (émis par les deux pages).
 */
import {
  STORAGE_KEYS,
  NAVY_MARGIN_PCT,
  bodyFatCategory,
  bodyFatMasses,
  bodyFatSeries,
  missingNavyInputs,
  navyInputIssue,
  type BodyFatMeasurement,
  type BodyFatPoint,
  type BodySex,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { loadUserProfile } from '../lib/user/storage';
import type { ScrubData } from '../lib/chart-scrub';

/** Émis par Mensurations et Poids après un enregistrement ou une suppression. */
export const BODY_CHANGED_EVENT = 'k-body-changed';

interface WeightEntry {
  date: string;
  weight: number;
  bodyFatPct?: number | null;
}

const fr1 = (v: number): string =>
  v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const shortDate = (iso: string): string =>
  new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
  });

/** Géométrie de la courbe (viewBox 320 × 128). */
function geometry(points: readonly BodyFatPoint[]) {
  const W = 320,
    H = 128,
    padL = 4,
    padR = 34,
    top = 12,
    bottom = 104;
  const ys = points.map((p) => p.pct);
  const lo = Math.floor(Math.min(...ys) - 1);
  let hi = Math.ceil(Math.max(...ys) + 1);
  if (hi - lo < 4) hi = lo + 4;
  const xs = points.map((p) => Date.parse(p.date));
  const x0 = xs[0]!;
  const dx = Math.max(1, xs.at(-1)! - x0);
  const sx = (t: number) => padL + ((t - x0) / dx) * (W - padL - padR);
  const sy = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const coords = points.map((p, i) => [sx(xs[i]!), sy(p.pct)] as const);
  return { W, H, padL, padR, top, bottom, lo, hi, sy, coords };
}

export function bodyFatCard() {
  return {
    sex: 'male' as BodySex,
    heightCm: 0,
    hasProfile: false,
    series: [] as BodyFatPoint[],
    missing: [] as string[],
    /** Dernière mesure complète mais incohérente (taille ≤ cou…). */
    issue: '',
    manualPct: null as number | null,
    manualDate: '',
    latestWeight: null as number | null,
    loaded: false,
    margin: NAVY_MARGIN_PCT,

    async init(): Promise<void> {
      await this.refresh();
    },

    async refresh(): Promise<void> {
      try {
        const deps = await getDeps();
        const [measures, weights, profile] = await Promise.all([
          deps.storage.get<BodyFatMeasurement[]>(STORAGE_KEYS.MEASUREMENTS_ENTRIES),
          deps.storage.get<WeightEntry[]>(STORAGE_KEYS.BODYWEIGHT_ENTRIES),
          loadUserProfile(deps.storage),
        ]);
        const m = Array.isArray(measures) ? measures : [];
        const w = Array.isArray(weights) ? weights : [];
        const p =
          profile && profile.heightCm > 0 ? { sex: profile.sex, heightCm: profile.heightCm } : null;
        this.hasProfile = !!p;
        if (p) {
          this.sex = p.sex;
          this.heightCm = p.heightCm;
        }
        this.series = bodyFatSeries(m, w, p);
        const latestM = [...m].sort((a, b) => a.date.localeCompare(b.date)).at(-1) ?? null;
        this.missing = this.series.length ? [] : missingNavyInputs(latestM, p);
        this.issue = navyInputIssue(latestM, p) ?? '';
        const sortedW = [...w].sort((a, b) => a.date.localeCompare(b.date));
        const manual = sortedW.filter((e) => typeof e.bodyFatPct === 'number' && e.bodyFatPct > 0);
        this.manualPct = manual.at(-1)?.bodyFatPct ?? null;
        this.manualDate = manual.at(-1)?.date ?? '';
        this.latestWeight = sortedW.at(-1)?.weight ?? null;
      } catch (err) {
        console.warn('[bodyFat] refresh failed:', err);
      } finally {
        this.loaded = true;
      }
    },

    get latest(): BodyFatPoint | null {
      return this.series.at(-1) ?? null;
    },

    get hasEstimate(): boolean {
      return this.series.length > 0;
    },

    /** « 15,3 » */
    get pctText(): string {
      return this.latest ? fr1(this.latest.pct) : '—';
    },

    get categoryLabel(): string {
      return this.latest ? bodyFatCategory(this.latest.pct, this.sex).label : '';
    },

    /** « Mesuré le 20 nov. · cou, taille » */
    get basisText(): string {
      if (!this.latest) return '';
      const inputs = this.sex === 'female' ? 'cou, taille, hanches' : 'cou et taille';
      return `D'après ${inputs} du ${shortDate(this.latest.date)}`;
    },

    /** Évolution depuis la première estimation : « −1,8 point depuis le 12 sept. ». */
    get deltaText(): string {
      if (this.series.length < 2) return '';
      const d = this.latest!.pct - this.series[0]!.pct;
      const abs = fr1(Math.abs(d));
      const sign = abs === '0,0' ? '' : d > 0 ? '+' : '−';
      const unit = Math.abs(d) >= 2 ? 'points' : 'point';
      return `${sign}${abs} ${unit} depuis le ${shortDate(this.series[0]!.date)}`;
    },

    /** Poids utilisé pour les masses : pesée proche de la mesure, sinon la dernière. */
    get massWeight(): number | null {
      return this.latest?.weightKg ?? this.latestWeight;
    },

    /** Masses maigre et grasse (kg), si un poids est connu. */
    get masses(): { fatKg: number; leanKg: number } | null {
      const w = this.massWeight;
      return this.latest && w !== null ? bodyFatMasses(w, this.latest.pct) : null;
    },

    get leanText(): string {
      return this.masses ? fr1(this.masses.leanKg) : '—';
    },

    get fatText(): string {
      return this.masses ? fr1(this.masses.fatKg) : '—';
    },

    /** « 16,0 % saisi le 20 nov. » — jamais écrasé par l'estimation. */
    get manualText(): string {
      if (this.manualPct === null) return '';
      return `${fr1(this.manualPct)} % saisi le ${shortDate(this.manualDate)}`;
    },

    /** « Pour l'estimer : le tour de cou et le tour de taille. » */
    get missingText(): string {
      if (!this.missing.length) return this.hasEstimate ? '' : this.issue;
      const list =
        this.missing.length === 1
          ? this.missing[0]!
          : this.missing.slice(0, -1).join(', ') + ' et ' + this.missing.at(-1)!;
      return `Pour l'estimer, il manque ${list}.`;
    },

    get needsProfile(): boolean {
      return !this.hasProfile;
    },

    /** Lien vers Mensurations (depuis Poids) quand une mesure manque. */
    get linkMeasures(): boolean {
      return typeof location !== 'undefined' && !location.pathname.startsWith('/mensurations');
    },

    chartScrub(): ScrubData | null {
      if (this.series.length < 2) return null;
      const g = geometry(this.series);
      return {
        w: g.W,
        h: g.H,
        top: g.top - 4,
        bottom: g.bottom,
        points: this.series.map((p, i) => ({
          x: g.coords[i]![0],
          y: g.coords[i]![1],
          label: shortDate(p.date),
          value: `${fr1(p.pct)} %` + (p.leanKg !== null ? ` · ${fr1(p.leanKg)} kg maigre` : ''),
        })),
      };
    },

    chartSvg(): string {
      if (this.series.length < 2) return '';
      const { W, H, padL, padR, lo, hi, sy, coords, bottom } = geometry(this.series);
      const line = coords
        .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
        .join(' ');
      const area = `${line} L${coords.at(-1)![0].toFixed(1)} ${bottom} L${coords[0]![0].toFixed(1)} ${bottom} Z`;
      const grid = [hi, (hi + lo) / 2, lo]
        .map((v) => {
          const y = sy(v).toFixed(1);
          return (
            `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="currentColor" stroke-opacity="0.16" stroke-dasharray="2 5" stroke-linecap="round"/>` +
            `<text x="${W}" y="${(+y + 4).toFixed(1)}" text-anchor="end" fill="currentColor" font-size="11.5">${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</text>`
          );
        })
        .join('');
      const dots = coords
        .map(
          ([x, y]) =>
            `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="fill-kinetic-purple stroke-kinetic-surface" stroke-width="1.5"/>`,
        )
        .join('');
      const first = shortDate(this.series[0]!.date);
      const last = shortDate(this.series.at(-1)!.date);
      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Masse grasse estimée, du ${first} au ${last}" class="block overflow-visible">
        <defs class="text-kinetic-purple"><linearGradient id="bf-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="currentColor" stop-opacity="0.3"/>
          <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
        </linearGradient></defs>
        ${grid}
        <path d="${area}" fill="url(#bf-area)"/>
        <path d="${line}" fill="none" class="stroke-kinetic-purple" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
        <text x="${padL}" y="${H - 4}" fill="currentColor" font-size="11.5">${first}</text>
        <text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="currentColor" font-size="11.5">${last}</text>
      </svg>`;
    },
  };
}
