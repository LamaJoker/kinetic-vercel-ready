import { loc } from '../lib/num';
import { ROLE_COLORS } from '../lib/palette';
import {
  MIN_LOG_DATE,
  STORAGE_KEYS,
  localDayDate,
  localIsoDay,
  logDateError,
  placeByDate,
  sortByDate,
} from '@kinetic/core';
import { hapticLight, hapticSuccess } from '../lib/haptics';
import { notifyWriteFailed } from '../lib/write-errors';
import { getDeps } from '../deps';
import { BODY_CHANGED_EVENT } from '../components/body-fat';
import type { ScrubData } from '../lib/chart-scrub';
import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

export interface MeasurementEntry {
  id: string;
  date: string;
  neck?: number;
  shoulders?: number;
  chest?: number;
  waist?: number;
  hips?: number;
  leftBicep?: number;
  rightBicep?: number;
  leftThigh?: number;
  rightThigh?: number;
  leftCalf?: number;
  rightCalf?: number;
  note?: string;
  /** Date de modification (fusion de la synchro : la plus récente l'emporte). */
  updatedAt?: string;
}

type MetricKey =
  | 'neck'
  | 'shoulders'
  | 'chest'
  | 'waist'
  | 'hips'
  | 'leftBicep'
  | 'rightBicep'
  | 'leftThigh'
  | 'rightThigh'
  | 'leftCalf'
  | 'rightCalf';

interface MetricDef {
  key: MetricKey;
  label: string;
  color: string;
}

// Couleurs des séries : rôles de la palette (lib/palette.ts), suivent le mode clair.
const METRICS: readonly MetricDef[] = [
  { key: 'chest', label: 'Poitrine', color: ROLE_COLORS.warning },
  { key: 'waist', label: 'Taille', color: ROLE_COLORS.accent },
  { key: 'hips', label: 'Hanches', color: ROLE_COLORS.info },
  { key: 'shoulders', label: 'Épaules', color: ROLE_COLORS.success },
  { key: 'leftBicep', label: 'Bras G', color: ROLE_COLORS.warning },
  { key: 'rightBicep', label: 'Bras D', color: ROLE_COLORS.warning },
  { key: 'leftThigh', label: 'Cuisse G', color: ROLE_COLORS.accent },
  { key: 'rightThigh', label: 'Cuisse D', color: ROLE_COLORS.accent },
  { key: 'leftCalf', label: 'Mollet G', color: ROLE_COLORS.success },
  { key: 'rightCalf', label: 'Mollet D', color: ROLE_COLORS.success },
  { key: 'neck', label: 'Cou', color: ROLE_COLORS.warning },
] as const;

const STORAGE_KEY = STORAGE_KEYS.MEASUREMENTS_ENTRIES;

/** Mesure ↔ champ du formulaire (propriétés plates pour x-model). */
const FORM_FIELDS: ReadonlyArray<readonly [MetricKey, string]> = [
  ['neck', 'fNeck'],
  ['shoulders', 'fShoulders'],
  ['chest', 'fChest'],
  ['waist', 'fWaist'],
  ['hips', 'fHips'],
  ['leftBicep', 'fLeftBicep'],
  ['rightBicep', 'fRightBicep'],
  ['leftThigh', 'fLeftThigh'],
  ['rightThigh', 'fRightThigh'],
  ['leftCalf', 'fLeftCalf'],
  ['rightCalf', 'fRightCalf'],
];

/**
 * Tracé lissé (interpolation cubique monotone) : passe par chaque mesure
 * sans dépasser les valeurs réelles.
 */
export function smoothLine(pts: ReadonlyArray<readonly [number, number]>): string {
  const n = pts.length;
  if (n === 0) return '';
  const f = (v: number) => v.toFixed(1);
  if (n < 3) return pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${f(x)} ${f(y)}`).join(' ');
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1]![0] - pts[i]![0];
    d.push(h > 0 ? (pts[i + 1]![1] - pts[i]![1]) / h : 0);
  }
  const m: number[] = [d[0]!];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  let path = `M ${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = x1 - x0;
    if (h <= 0) {
      path += ` L ${f(x1)} ${f(y1)}`;
      continue;
    }
    path += ` C ${f(x0 + h / 3)} ${f(y0 + (m[i]! * h) / 3)} ${f(x1 - h / 3)} ${f(y1 - (m[i + 1]! * h) / 3)} ${f(x1)} ${f(y1)}`;
  }
  return path;
}

/** Année affichée seulement hors de l'année en cours (« 11 nov. » / « 16 sept. 2025 »). */
function yearOption(iso: string): { year?: 'numeric' } {
  return (localDayDate(iso) ?? new Date(iso)).getFullYear() !== new Date().getFullYear()
    ? { year: 'numeric' }
    : {};
}
const PHOTOS_KEY = STORAGE_KEYS.MEASUREMENTS_PHOTOS;
// Limite IDB côté validateStorageValue = 1 MB. On garde 48 KB de marge pour
// l'overhead JSON ({"base64":""}) + l'enrobage de la valeur stockée.
const MAX_PHOTO_BYTES = 1_000_000;

/** Métadonnées d'une photo (persisté dans PHOTOS_KEY) */
interface PhotoMeta {
  id: string;
  date: string; // ISO date (YYYY-MM-DD)
  takenAt: string; // ISO timestamp
  note?: string;
}

/** Photo complète en mémoire (base64 chargé depuis la clé séparée) */
export interface ProgressPhoto extends PhotoMeta {
  base64: string; // data:image/jpeg;base64,…
}

/** Clé IDB individuelle pour le base64 d'une photo */
function photoDataKey(id: string): string {
  return STORAGE_KEYS.MEASUREMENT_PHOTO_DATA(id);
}

function estimateDataUrlBytes(dataUrl: string): number {
  const [, payload = ''] = dataUrl.split(',', 2);
  return Math.floor((payload.length * 3) / 4);
}

function val(entry: MeasurementEntry, key: MetricKey): number | undefined {
  return (entry as unknown as Record<string, unknown>)[key] as number | undefined;
}

type ProgressPhotoLike = { id: string };

/** Géométrie de la courbe de mensurations (viewBox 320 × 150), partagée par le tracé et le parcours au doigt. */
export function mensurationsChartGeometry(pts: ReadonlyArray<{ x: number; y: number }>) {
  const W = 320,
    H = 150,
    padL = 4,
    padR = 34,
    padY = 10,
    labelH = 18;
  const ys = pts.map((p) => p.y);
  const pad = Math.max(0.5, (Math.max(...ys) - Math.min(...ys)) * 0.08);
  // Bornes arrondies à un pas « rond » pour que les repères tombent sur des valeurs nettes.
  const rawMin = Math.min(...ys) - pad;
  const rawMax = Math.max(...ys) + pad;
  const span = rawMax - rawMin;
  const step = span <= 4 ? 0.5 : span <= 10 ? 1 : 5;
  const minY = Math.floor(rawMin / step) * step;
  let maxY = Math.ceil(rawMax / step) * step;
  // Nombre pair de pas : le repère du milieu tombe lui aussi sur un multiple du pas.
  if (Math.round((maxY - minY) / step) % 2 === 1) maxY += step;
  const minX = pts[0]?.x ?? 0;
  const maxX = pts.at(-1)?.x ?? 0;
  const dx = Math.max(1, maxX - minX);
  const dy = Math.max(0.1, maxY - minY);
  const chartH = H - labelH;
  const plotW = W - padL - padR;
  const sx = (d: number) => padL + ((d - minX) / dx) * plotW;
  const sy = (y: number) => chartH - padY - ((y - minY) / dy) * (chartH - padY * 2);
  return { W, H, padL, padR, padY, chartH, step, minY, maxY, dy, sx, sy };
}

export function mensurations() {
  return {
    entries: [] as MeasurementEntry[],
    activeMetric: 'chest' as MetricKey,
    period: 90,
    metrics: METRICS as MetricDef[],
    /** Options du contrôle segmenté de période (valeur en jours). */
    periods: [
      { v: 30, l: '30 j' },
      { v: 90, l: '90 j' },
      { v: 365, l: '1 an' },
      { v: 9999, l: 'Tout' },
    ] as Array<{ v: number; l: string }>,

    // ── Photos ────────────────────────────────────────────────
    photos: [] as ProgressPhoto[],
    showPhotos: false,
    selectedPhotoId: null as string | null,

    /** Photo ouverte (0 ou 1 élément) — pas de fonction fléchée dans le template. */
    get selectedPhotos(): ProgressPhotoLike[] {
      return (this.photos as ProgressPhotoLike[]).filter((p) => p.id === this.selectedPhotoId);
    },
    takingPhoto: false,

    // Form bindings (flat — Alpine x-model requires direct properties)
    fNeck: null as number | null,
    fShoulders: null as number | null,
    fChest: null as number | null,
    fWaist: null as number | null,
    fHips: null as number | null,
    fLeftBicep: null as number | null,
    fRightBicep: null as number | null,
    fLeftThigh: null as number | null,
    fRightThigh: null as number | null,
    fLeftCalf: null as number | null,
    fRightCalf: null as number | null,
    fNote: '',
    /** Date des mesures (jour local), indépendante des valeurs ; aujourd'hui par défaut. */
    fDate: localIsoDay(new Date()),
    minDate: MIN_LOG_DATE,
    /** Identifiant de l'entrée en cours de modification (`null` : nouvelle saisie). */
    editingId: null as string | null,
    /** Date pour laquelle la fusion avec des mesures existantes attend confirmation. */
    pendingMergeDate: '',
    /** Annulation possible quelques secondes après une suppression ou une fusion. */
    undoEntries: null as MeasurementEntry[] | null,
    undoLabel: '',
    _undoTimer: null as ReturnType<typeof setTimeout> | null,

    get maxDate(): string {
      return localIsoDay(new Date());
    },
    get dateError(): string | null {
      return logDateError(this.fDate, localIsoDay(new Date()));
    },
    get canSave(): boolean {
      return this.hasFormData && !this.dateError;
    },
    /** Mesures déjà saisies à la date choisie (hors entrée en cours de modification). */
    get mergeTarget(): MeasurementEntry | null {
      return this.entries.find((e) => e.date === this.fDate && e.id !== this.editingId) ?? null;
    },
    get askMerge(): boolean {
      return !!this.mergeTarget && this.pendingMergeDate === this.fDate;
    },
    get mergeMessage(): string {
      const t = this.mergeTarget;
      return t
        ? `Des mesures existent déjà le ${this.formatDate(t.date)}. Les compléter ? Les valeurs saisies remplacent celles de ce jour-là ; les autres dates ne changent pas.`
        : '';
    },
    get formTitle(): string {
      return this.editingId ? 'Modifier la mesure' : 'Nouvelle mesure';
    },

    // ── Computed ─────────────────────────────────────────────

    get filteredEntries(): MeasurementEntry[] {
      if (this.period >= 9999) return this.entries;
      const cutoff = Date.now() - this.period * 86_400_000;
      return this.entries.filter((e) => Date.parse(e.date) >= cutoff);
    },

    get activeMetricDef(): MetricDef {
      return (
        (this.metrics as MetricDef[]).find((m) => m.key === this.activeMetric) ??
        (this.metrics as MetricDef[])[0]!
      );
    },

    /** « sur 90 jours », « depuis le début »… (suffixe de l'évolution). */
    get periodLabel(): string {
      if (this.period >= 9999) return 'depuis le début';
      if (this.period === 365) return 'sur 1 an';
      return 'sur ' + this.period + ' jours';
    },

    /** Repères de la courbe active, déjà formatés (« 92,5 cm »). */
    get chartStats(): { start: string; min: string; max: string } {
      const pts = this.chartPoints();
      if (pts.length === 0) return { start: '—', min: '—', max: '—' };
      const ys = pts.map((p) => p.y);
      return {
        start: this.formatCm(pts[0]!.y) + ' cm',
        min: this.formatCm(Math.min(...ys)) + ' cm',
        max: this.formatCm(Math.max(...ys)) + ' cm',
      };
    },

    get hasFormData(): boolean {
      return !!(
        this.fNeck ||
        this.fShoulders ||
        this.fChest ||
        this.fWaist ||
        this.fHips ||
        this.fLeftBicep ||
        this.fRightBicep ||
        this.fLeftThigh ||
        this.fRightThigh ||
        this.fLeftCalf ||
        this.fRightCalf
      );
    },

    // ── Per-metric helpers ────────────────────────────────────

    metricDotStyle(color: string): { backgroundColor: string } {
      return { backgroundColor: color };
    },

    /** 37.099999 → « 37,1 » ; null → « — » */
    formatCm(value: number | null): string {
      if (value === null || !Number.isFinite(value)) return '—';
      return value.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    },

    /** Évolution signée sur la période : « +1,2 », « −0,5 », « 0,0 » ; '' sans données. */
    formatDelta(key: MetricKey): string {
      const d = this.metricDelta(key);
      if (d === null) return '';
      const abs = Math.abs(d).toLocaleString('fr-FR', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
      if (abs === '0,0') return abs;
      return (d > 0 ? '+' : '\u2212') + abs;
    },

    currentValue(key: MetricKey): number | null {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const v = val(this.entries[i]!, key);
        if (v !== undefined) return v;
      }
      return null;
    },

    metricDelta(key: MetricKey): number | null {
      const pts = this.filteredEntries.filter((e) => val(e, key) !== undefined);
      if (pts.length < 2) return null;
      return val(pts.at(-1)!, key)! - val(pts[0]!, key)!;
    },

    /** Flèche d'évolution (→ tournée vers le haut ou le bas), '' si stable. */
    deltaArrowClass(key: MetricKey): string {
      const d = this.metricDelta(key);
      if (d === null || Math.abs(d) < 0.05) return '';
      return d > 0 ? '-rotate-45' : 'rotate-45';
    },

    /** Pastille de couleur d'une mesure (tuiles « Toutes les mesures »). */
    metricDot(key: MetricKey): string {
      const def = (this.metrics as MetricDef[]).find((m) => m.key === key);
      return `background-color: ${def ? def.color : ROLE_COLORS.muted}`;
    },

    hasData(key: MetricKey): boolean {
      return this.entries.some((e) => val(e, key) !== undefined);
    },

    chartPoints(key?: MetricKey): Array<{ x: number; y: number }> {
      const k = key ?? this.activeMetric;
      return this.filteredEntries
        .filter((e) => val(e, k) !== undefined)
        .map((e) => ({ x: Date.parse(e.date), y: val(e, k)! }));
    },

    // ── Persistence ───────────────────────────────────────────

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const [stored, storedMeta] = await Promise.all([
          deps.storage.get(STORAGE_KEY),
          deps.storage.get<unknown[]>(PHOTOS_KEY),
        ]);
        this.entries = Array.isArray(stored) ? sortByDate(stored as MeasurementEntry[]) : [];

        // Photos stockées par clé séparée (évite le dépassement du seuil 1 MB par entrée)
        if (Array.isArray(storedMeta) && storedMeta.length > 0) {
          const first = storedMeta[0] as Record<string, unknown>;
          if ('base64' in first) {
            // Migration : ancien format (base64 inline) → nouveau format (clés séparées)
            await this._migratePhotos(storedMeta as ProgressPhoto[], deps);
          } else {
            this.photos = await this._loadPhotos(storedMeta as PhotoMeta[], deps);
          }
        }
      } catch (err) {
        console.error('[mensurations] init failed:', err);
      }
    },

    /** Migration one-shot : déplace le base64 hors du tableau de métadonnées */
    async _migratePhotos(
      old: ProgressPhoto[],
      deps: Awaited<ReturnType<typeof getDeps>>,
    ): Promise<void> {
      await Promise.all(
        old.map(async (p) => {
          try {
            await deps.storage.set(photoDataKey(p.id), { base64: p.base64 });
          } catch (err) {
            console.warn('[mensurations] migration photo failed for', p.id, err);
          }
        }),
      );
      // Mettre à jour PHOTOS_KEY sans les base64
      const meta: PhotoMeta[] = old.map(({ base64: _b, ...rest }) => rest);
      await deps.storage.set(PHOTOS_KEY, meta);
      this.photos = old; // base64 déjà en mémoire
    },

    /** Charge les base64 en parallèle depuis leurs clés individuelles */
    async _loadPhotos(
      meta: PhotoMeta[],
      deps: Awaited<ReturnType<typeof getDeps>>,
    ): Promise<ProgressPhoto[]> {
      const dataArr = await Promise.all(
        meta.map((m) => deps.storage.get<{ base64: string }>(photoDataKey(m.id))),
      );
      return meta.map((m, i) => ({ ...m, base64: dataArr[i]?.base64 ?? '' }));
    },

    /**
     * Compresse une image (dataURL) via Canvas.
     * Max 1 200 px sur le plus grand côté, qualité JPEG 0.75 → ~100-250 KB typique.
     */
    _compressPhoto(dataUrl: string, maxPx = 1200, quality = 0.75): Promise<string> {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          try {
            const scale = Math.min(1, maxPx / Math.max(img.width || 1, img.height || 1));
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              // Canvas 2D context blocked (rare : configurations no-canvas) → fallback original
              resolve(dataUrl);
              return;
            }
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
          } catch (err) {
            reject(err);
          }
        };
        img.onerror = () => reject(new Error("Impossible de charger l'image"));
        img.src = dataUrl;
      });
    },

    // ── Photos de progression ─────────────────────────────────

    get photosDesc(): ProgressPhoto[] {
      return [...this.photos].sort((a, b) => b.takenAt.localeCompare(a.takenAt));
    },

    async takePhoto(): Promise<void> {
      if (this.takingPhoto) return;
      this.takingPhoto = true;
      try {
        let base64 = '';

        if (Capacitor.isNativePlatform()) {
          const photo = await Camera.getPhoto({
            quality: 85,
            allowEditing: false,
            resultType: CameraResultType.Base64,
            source: CameraSource.Camera,
            correctOrientation: true,
          });
          base64 = `data:image/jpeg;base64,${photo.base64String ?? ''}`;
        } else {
          base64 = await this._pickPhotoWeb();
        }

        if (!base64 || base64 === 'data:image/jpeg;base64,') return;

        // ── Compression en cascade ──────────────────────────────────────────
        // Tentative 1 : standard (1 200 px, JPEG 75 %).
        let compressed = base64;
        let compressOk = false;
        try {
          compressed = await this._compressPhoto(base64, 1200, 0.75);
          compressOk = true;
        } catch (err) {
          console.warn('[mensurations] compression standard failed, trying fallback:', err);
        }

        // Tentative 2 : fallback agressif (800 px, 55 %) si T1 a échoué OU si
        // le résultat dépasse encore la limite (photo source déjà très compressée).
        if (!compressOk || estimateDataUrlBytes(compressed) > MAX_PHOTO_BYTES) {
          try {
            compressed = await this._compressPhoto(base64, 800, 0.55);
            compressOk = true;
          } catch (err) {
            console.warn('[mensurations] compression fallback failed:', err);
          }
        }

        // Refus explicite si encore trop gros, plutôt que d'écrire une valeur
        // que validateStorageValue rejettera silencieusement côté IdbStorage.
        const finalBytes = estimateDataUrlBytes(compressed);
        if (finalBytes > MAX_PHOTO_BYTES) {
          const mb = loc((finalBytes / 1_048_576).toFixed(1));
          const maxMb = loc((MAX_PHOTO_BYTES / 1_048_576).toFixed(1));
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: {
                kind: 'error',
                message:
                  `Photo trop volumineuse (${mb} Mo > ${maxMb} Mo max). ` +
                  `Essaie une photo moins détaillée ou depuis l'appli Appareil photo.`,
              },
            }),
          );
          return;
        }

        const today = localIsoDay(new Date());
        const entry: ProgressPhoto = {
          id: crypto.randomUUID(),
          date: today,
          takenAt: new Date().toISOString(),
          base64: compressed,
        };

        const deps = await getDeps();

        await deps.storage.set(photoDataKey(entry.id), { base64: compressed });

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { base64: _b, ...meta } = entry;
        const existingMeta: PhotoMeta[] = this.photos.map(({ base64: _b2, ...m }) => m);
        await deps.storage.set(PHOTOS_KEY, [...existingMeta, meta]);
        this.photos = [...this.photos, entry];
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: 'Photo de progression ajoutée ✓' },
          }),
        );
      } catch (err) {
        console.error('[mensurations] takePhoto failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        const isPermission = /permission|denied|not allowed/i.test(msg);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'error',
              message: isPermission
                ? "Accès à la caméra refusé. Autorise l'accès dans les réglages."
                : 'Impossible de sauvegarder la photo. Réessaie.',
            },
          }),
        );
      } finally {
        this.takingPhoto = false;
      }
    },

    /** Sélection photo depuis l'appareil photo ou galerie (navigateur web). */
    _pickPhotoWeb(): Promise<string> {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.capture = 'environment';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) {
            resolve('');
            return;
          }
          try {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          } catch (e) {
            reject(e);
          }
        };
        input.oncancel = () => resolve('');
        input.click();
      });
    },

    async deletePhoto(id: string): Promise<void> {
      const next = this.photos.filter((p) => p.id !== id);
      try {
        const deps = await getDeps();
        // Supprimer aussi la clé de données séparée
        await deps.storage.remove(photoDataKey(id));
        const meta: PhotoMeta[] = next.map(({ base64: _b, ...m }) => m);
        await deps.storage.set(PHOTOS_KEY, meta);
        this.photos = next;
        if (this.selectedPhotoId === id) this.selectedPhotoId = null;
      } catch (err) {
        console.error('[mensurations] deletePhoto failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec suppression de la photo. Réessaie.' },
          }),
        );
      }
    },

    formatPhotoDate(iso: string): string {
      try {
        return (localDayDate(iso) ?? new Date(iso)).toLocaleDateString('fr-FR', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          ...yearOption(iso),
        });
      } catch {
        return iso;
      }
    },

    async addEntry(): Promise<void> {
      if (!this.canSave) return;
      const date = this.fDate;
      // Des mesures existent déjà ce jour-là : confirmation avant de les compléter.
      if (this.mergeTarget && this.pendingMergeDate !== date) {
        this.pendingMergeDate = date;
        hapticLight();
        return;
      }
      const target = this.mergeTarget;
      const editingId = this.editingId;
      const before = this.entries;
      const form = this as unknown as Record<string, unknown>;
      const entry: MeasurementEntry = {
        id: editingId ?? crypto.randomUUID(),
        date,
        updatedAt: new Date().toISOString(),
      };
      for (const [k, f] of FORM_FIELDS) {
        const v = form[f];
        if (typeof v === 'number' && v > 0) (entry as unknown as Record<string, unknown>)[k] = v;
      }
      if (this.fNote.trim()) entry.note = this.fNote.trim();
      // Fusion avec les mesures de ce jour (seulement celles-là) ; les autres dates restent intactes.
      const saved: MeasurementEntry = target ? { ...target, ...entry, id: target.id } : entry;
      const next = placeByDate(
        before,
        saved,
        (e) => e.id === editingId || (target !== null && e.id === target.id),
      );
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY, next);
        this.entries = next;
        window.dispatchEvent(new Event(BODY_CHANGED_EVENT));
        this._resetForm();
        if (this.period < 9999 && Date.parse(date) < Date.now() - this.period * 86_400_000) {
          this.period = 9999;
        }
        hapticSuccess();
        const when = date === localIsoDay(new Date()) ? '' : ` pour le ${this.formatDate(date)}`;
        if (target || editingId) {
          this._offerUndo(before, `Mensurations${when} mises à jour`);
        } else {
          // L'annulation précédente ne doit pas effacer cette nouvelle mesure.
          this.undoEntries = null;
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'success', message: `Mensurations enregistrées${when} ✓` },
            }),
          );
        }
      } catch (err) {
        notifyWriteFailed('les mensurations', err);
      }
    },

    /** Charge une entrée de l'historique dans le formulaire (valeurs et date modifiables). */
    startEdit(entry: MeasurementEntry): void {
      const form = this as unknown as Record<string, unknown>;
      for (const [k, f] of FORM_FIELDS) form[f] = val(entry, k) ?? null;
      this.fNote = entry.note ?? '';
      this.fDate = entry.date;
      this.editingId = entry.id;
      this.pendingMergeDate = '';
      hapticLight();
      document.getElementById('mens-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    cancelEdit(): void {
      this._resetForm();
    },

    cancelMerge(): void {
      this.pendingMergeDate = '';
    },

    async removeEntry(id: string): Promise<void> {
      const before = this.entries;
      const removed = before.find((e) => e.id === id);
      const next = before.filter((e) => e.id !== id);
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY, next);
        this.entries = next;
        if (this.editingId === id) this._resetForm();
        window.dispatchEvent(new Event(BODY_CHANGED_EVENT));
        hapticLight();
        this._offerUndo(
          before,
          removed ? `Mesures du ${this.formatDate(removed.date)} supprimées` : 'Mesures supprimées',
        );
      } catch (err) {
        console.error('[mensurations] removeEntry failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec suppression. Réessaie.' },
          }),
        );
      }
    },

    _offerUndo(before: MeasurementEntry[], label: string): void {
      this.undoEntries = before;
      this.undoLabel = label;
      if (this._undoTimer) clearTimeout(this._undoTimer);
      this._undoTimer = setTimeout(() => {
        this.undoEntries = null;
      }, 6000);
    },

    async undoLast(): Promise<void> {
      const before = this.undoEntries;
      if (!before) return;
      this.undoEntries = null;
      if (this._undoTimer) clearTimeout(this._undoTimer);
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY, before);
        this.entries = before;
        window.dispatchEvent(new Event(BODY_CHANGED_EVENT));
      } catch (err) {
        notifyWriteFailed('les mensurations', err);
      }
    },

    _resetForm(): void {
      this.fNeck = this.fShoulders = this.fChest = this.fWaist = this.fHips = null;
      this.fLeftBicep = this.fRightBicep = this.fLeftThigh = this.fRightThigh = null;
      this.fLeftCalf = this.fRightCalf = null;
      this.fNote = '';
      this.fDate = localIsoDay(new Date());
      this.editingId = null;
      this.pendingMergeDate = '';
    },

    // ── Formatting ────────────────────────────────────────────

    formatDate(iso: string): string {
      try {
        return (localDayDate(iso) ?? new Date(iso)).toLocaleDateString('fr-FR', {
          day: 'numeric',
          month: 'short',
          ...yearOption(iso),
        });
      } catch {
        return iso;
      }
    },

    entrySummary(entry: MeasurementEntry): string {
      const abbrs: Array<[string, MetricKey]> = [
        ['Poitrine', 'chest'],
        ['Taille', 'waist'],
        ['Hanches', 'hips'],
        ['Épaules', 'shoulders'],
        ['Bras G', 'leftBicep'],
        ['Bras D', 'rightBicep'],
      ];
      const parts: string[] = [];
      for (const [abbr, k] of abbrs) {
        const v = val(entry, k);
        if (v !== undefined) parts.push(`${abbr} ${this.formatCm(v)}`);
        if (parts.length >= 2) break;
      }
      const extraCount =
        FORM_FIELDS.filter(([k]) => val(entry, k) !== undefined).length - parts.length;
      if (extraCount > 0) parts.push(`+${extraCount}\u00a0autres`);
      return parts.join(' · ') || entry.note || '';
    },

    // ── SVG Chart ─────────────────────────────────────────────

    /** Parcours au doigt de la courbe (directive x-scrub) : un point par mesure. */
    chartScrub(): ScrubData | null {
      const pts = this.chartPoints();
      if (pts.length < 2) return null;
      const g = mensurationsChartGeometry(pts);
      return {
        w: g.W,
        h: g.H,
        top: g.padY - 4,
        bottom: g.chartH,
        points: pts.map((p) => ({
          x: g.sx(p.x),
          y: g.sy(p.y),
          label: new Date(p.x).toLocaleDateString('fr-FR', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
          value: `${this.formatCm(p.y)} cm`,
        })),
      };
    },

    chartSvg(): string {
      const pts = this.chartPoints();
      if (pts.length < 2) return '';

      const metricDef = this.activeMetricDef;
      // Les textes et la grille utilisent currentColor (gris système du conteneur),
      // ce qui fonctionne en mode sombre comme en mode clair.
      const { W, H, padL, padR, padY, chartH, step, maxY, dy, sx, sy } =
        mensurationsChartGeometry(pts);

      // Une seule teinte pour la série : violet (--k-info), l'accent corail
      // reste réservé à l'action principale. Classes Tailwind (fill-/stroke-,
      // currentColor des dégradés) car x-svg retire les attributs style.
      const FILL = 'fill-kinetic-purple';
      const STROKE = 'stroke-kinetic-purple';

      const linePath = smoothLine(pts.map((p) => [sx(p.x), sy(p.y)] as const));

      const lastP = pts.at(-1)!;
      const areaPath =
        linePath +
        ` L ${sx(lastP.x).toFixed(1)} ${chartH.toFixed(1)}` +
        ` L ${padL} ${chartH.toFixed(1)} Z`;

      const fmtCm = (v: number) =>
        v.toLocaleString('fr-FR', { maximumFractionDigits: step < 1 ? 1 : 0 });

      // 3 lignes de repère (haut, milieu, bas) avec leur valeur à droite
      const gridLines = [0, 0.5, 1]
        .map((ratio) => {
          const y = padY + ratio * (chartH - padY * 2);
          const v = maxY - ratio * dy;
          return (
            `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"` +
            ` stroke="currentColor" stroke-opacity="${ratio === 1 ? '0.22' : '0.16'}" stroke-width="1"` +
            ` stroke-linecap="round" stroke-dasharray="${ratio === 1 ? '0' : '2 5'}"/>` +
            `<text x="${W}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="currentColor"` +
            ` font-size="12">${fmtCm(v)}</text>`
          );
        })
        .join('');

      // Points de mesure (petits jeux de données seulement — évite le bruit visuel)
      const dots =
        pts.length <= 20
          ? pts
              .slice(0, -1)
              .map(
                (p) =>
                  `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.5"` +
                  ` class="${FILL} stroke-kinetic-surface" stroke-width="1.5"/>`,
              )
              .join('')
          : '';

      const lastCx = sx(lastP.x).toFixed(1);
      const lastCy = sy(lastP.y).toFixed(1);

      const d0 = new Date(pts[0]!.x);
      const dN = new Date(lastP.x);
      const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe ${metricDef.label}" class="block overflow-visible">
        <defs class="text-kinetic-purple">
          <linearGradient id="mens-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="currentColor" stop-opacity="0.34"/>
            <stop offset="0.6" stop-color="currentColor" stop-opacity="0.07"/>
            <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="mens-line" gradientUnits="userSpaceOnUse" x1="${padL}" y1="0" x2="${W - padR}" y2="0">
            <stop offset="0" stop-color="currentColor" stop-opacity="0.6"/>
            <stop offset="1" stop-color="currentColor"/>
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${areaPath}" fill="url(#mens-area)"/>
        <path d="${linePath}" fill="none" class="${STROKE}" stroke-opacity="0.22" stroke-width="7"
              stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${linePath}" fill="none" stroke="url(#mens-line)" stroke-width="2.75"
              stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
        <circle cx="${lastCx}" cy="${lastCy}" r="9" class="${FILL}" fill-opacity="0.22"/>
        <circle cx="${lastCx}" cy="${lastCy}" r="5.5"
                class="${FILL} stroke-kinetic-surface" stroke-width="2.5"/>
        <text x="${padL}" y="${H - 2}" fill="currentColor" font-size="12">${fmt(d0)}</text>
        <text x="${W - padR}" y="${H - 2}" text-anchor="end" fill="currentColor" font-size="12">${fmt(dN)}</text>
      </svg>`;
    },
  };
}
