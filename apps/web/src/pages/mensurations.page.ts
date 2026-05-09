import { getDeps } from '../deps';
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
}

type MetricKey =
  | 'neck' | 'shoulders' | 'chest' | 'waist' | 'hips'
  | 'leftBicep' | 'rightBicep' | 'leftThigh' | 'rightThigh'
  | 'leftCalf' | 'rightCalf';

interface MetricDef {
  key: MetricKey;
  label: string;
  color: string;
}

const METRICS: readonly MetricDef[] = [
  { key: 'chest',      label: 'Poitrine',  color: '#A8FF00' },
  { key: 'waist',      label: 'Taille',    color: '#FF6A00' },
  { key: 'hips',       label: 'Hanches',   color: '#7F77DD' },
  { key: 'shoulders',  label: 'Épaules',   color: '#00C2A0' },
  { key: 'leftBicep',  label: 'Bras G',    color: '#FFD166' },
  { key: 'rightBicep', label: 'Bras D',    color: '#FFD166' },
  { key: 'leftThigh',  label: 'Cuisse G',  color: '#FF6B6B' },
  { key: 'rightThigh', label: 'Cuisse D',  color: '#FF6B6B' },
  { key: 'leftCalf',   label: 'Mollet G',  color: '#00C2A0' },
  { key: 'rightCalf',  label: 'Mollet D',  color: '#00C2A0' },
  { key: 'neck',       label: 'Cou',       color: '#FFD166' },
] as const;

const STORAGE_KEY   = 'kinetic:measurements:entries';
const PHOTOS_KEY    = 'kinetic:measurements:photos'; // array of PhotoMeta (sans base64)
const MAX_PHOTO_BYTES = 1_500_000;

/** Métadonnées d'une photo (persisté dans PHOTOS_KEY) */
interface PhotoMeta {
  id:      string;
  date:    string;   // ISO date (YYYY-MM-DD)
  takenAt: string;   // ISO timestamp
  note?:   string;
}

/** Photo complète en mémoire (base64 chargé depuis la clé séparée) */
export interface ProgressPhoto extends PhotoMeta {
  base64: string;  // data:image/jpeg;base64,…
}

/** Clé IDB individuelle pour le base64 d'une photo */
function photoDataKey(id: string): string {
  return `kinetic:measurements:photo:${id}`;
}

function estimateDataUrlBytes(dataUrl: string): number {
  const [, payload = ''] = dataUrl.split(',', 2);
  return Math.floor((payload.length * 3) / 4);
}

function val(entry: MeasurementEntry, key: MetricKey): number | undefined {
  return (entry as unknown as Record<string, unknown>)[key] as number | undefined;
}

export function mensurations() {
  return {
    entries:      [] as MeasurementEntry[],
    activeMetric: 'chest' as MetricKey,
    period:       90,
    metrics:      METRICS as MetricDef[],

    // ── Photos ────────────────────────────────────────────────
    photos:          [] as ProgressPhoto[],
    showPhotos:      false,
    selectedPhotoId: null as string | null,
    takingPhoto:     false,

    // Form bindings (flat — Alpine x-model requires direct properties)
    fNeck:       null as number | null,
    fShoulders:  null as number | null,
    fChest:      null as number | null,
    fWaist:      null as number | null,
    fHips:       null as number | null,
    fLeftBicep:  null as number | null,
    fRightBicep: null as number | null,
    fLeftThigh:  null as number | null,
    fRightThigh: null as number | null,
    fLeftCalf:   null as number | null,
    fRightCalf:  null as number | null,
    fNote:       '',

    // ── Computed ─────────────────────────────────────────────

    get filteredEntries(): MeasurementEntry[] {
      if (this.period >= 9999) return this.entries;
      const cutoff = Date.now() - this.period * 86_400_000;
      return this.entries.filter(e => Date.parse(e.date) >= cutoff);
    },

    get activeMetricDef(): MetricDef {
      return (this.metrics as MetricDef[]).find(m => m.key === this.activeMetric)
        ?? (this.metrics as MetricDef[])[0]!;
    },

    get hasFormData(): boolean {
      return !!(
        this.fNeck || this.fShoulders || this.fChest || this.fWaist || this.fHips ||
        this.fLeftBicep || this.fRightBicep || this.fLeftThigh ||
        this.fRightThigh || this.fLeftCalf || this.fRightCalf
      );
    },

    // ── Per-metric helpers ────────────────────────────────────

    currentValue(key: MetricKey): number | null {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const v = val(this.entries[i]!, key);
        if (v !== undefined) return v;
      }
      return null;
    },

    metricDelta(key: MetricKey): number | null {
      const pts = this.filteredEntries.filter(e => val(e, key) !== undefined);
      if (pts.length < 2) return null;
      return val(pts.at(-1)!, key)! - val(pts[0]!, key)!;
    },

    hasData(key: MetricKey): boolean {
      return this.entries.some(e => val(e, key) !== undefined);
    },

    chartPoints(key?: MetricKey): Array<{ x: number; y: number }> {
      const k = key ?? this.activeMetric;
      return this.filteredEntries
        .filter(e => val(e, k) !== undefined)
        .map(e => ({ x: Date.parse(e.date), y: val(e, k)! }));
    },

    // ── Persistence ───────────────────────────────────────────

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const [stored, storedMeta] = await Promise.all([
          deps.storage.get(STORAGE_KEY),
          deps.storage.get<unknown[]>(PHOTOS_KEY),
        ]);
        this.entries = Array.isArray(stored) ? (stored as MeasurementEntry[]) : [];

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
      await Promise.all(old.map(async (p) => {
        try {
          await deps.storage.set(photoDataKey(p.id), { base64: p.base64 });
        } catch (err) {
          console.warn('[mensurations] migration photo failed for', p.id, err);
        }
      }));
      // Mettre à jour PHOTOS_KEY sans les base64
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
        meta.map(m => deps.storage.get<{ base64: string }>(photoDataKey(m.id)))
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
            canvas.width  = w;
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
        img.onerror = () => reject(new Error('Impossible de charger l\'image'));
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
          // Caméra native via Capacitor
          const photo = await Camera.getPhoto({
            quality:      85,
            allowEditing: false,
            resultType:   CameraResultType.Base64,
            source:       CameraSource.Camera,
            correctOrientation: true,
          });
          base64 = `data:image/jpeg;base64,${photo.base64String ?? ''}`;
        } else {
          // Fallback web — input[type=file]
          base64 = await this._pickPhotoWeb();
        }

        if (!base64 || base64 === 'data:image/jpeg;base64,') return;

        // FIX C3: compresser avant de stocker (max 1 200 px, JPEG 75%)
        let compressed = base64;
        try { compressed = await this._compressPhoto(base64); } catch { /* garder original */ }
        if (estimateDataUrlBytes(compressed) > MAX_PHOTO_BYTES) {
          throw new Error('Photo trop volumineuse apres compression');
        }

        const today = new Date().toISOString().slice(0, 10);
        const entry: ProgressPhoto = {
          id:      crypto.randomUUID(),
          date:    today,
          takenAt: new Date().toISOString(),
          base64:  compressed,
        };

        const deps = await getDeps();

        // FIX C3: stocker le base64 dans une clé dédiée (évite le seuil 1 MB du tableau)
        await deps.storage.set(photoDataKey(entry.id), { base64: compressed });

        // Mettre à jour le tableau de métadonnées (sans base64)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { base64: _b, ...meta } = entry;
        const existingMeta: PhotoMeta[] = this.photos.map(
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ({ base64: _b2, ...m }) => m
        );
        await deps.storage.set(PHOTOS_KEY, [...existingMeta, meta]);
        this.photos = [...this.photos, entry];
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'success', message: 'Photo de progression ajoutée ✓' },
        }));
      } catch (err) {
        console.error('[mensurations] takePhoto failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Impossible de prendre la photo.' },
        }));
      } finally {
        this.takingPhoto = false;
      }
    },

    /** Sélection photo depuis l'appareil photo ou galerie (navigateur web). */
    _pickPhotoWeb(): Promise<string> {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type  = 'file';
        input.accept = 'image/*';
        input.capture = 'environment';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) { resolve(''); return; }
          try {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          } catch (e) { reject(e); }
        };
        input.oncancel = () => resolve('');
        input.click();
      });
    },

    async deletePhoto(id: string): Promise<void> {
      const next = this.photos.filter(p => p.id !== id);
      try {
        const deps = await getDeps();
        // Supprimer aussi la clé de données séparée
        await deps.storage.remove(photoDataKey(id));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const meta: PhotoMeta[] = next.map(({ base64: _b, ...m }) => m);
        await deps.storage.set(PHOTOS_KEY, meta);
        this.photos = next;
        if (this.selectedPhotoId === id) this.selectedPhotoId = null;
      } catch (err) {
        console.error('[mensurations] deletePhoto failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Échec suppression de la photo. Réessaie.' },
        }));
      }
    },

    formatPhotoDate(iso: string): string {
      try {
        return new Date(iso).toLocaleDateString('fr-FR', {
          weekday: 'short', day: 'numeric', month: 'short', year: '2-digit',
        });
      } catch { return iso; }
    },

    async addEntry(): Promise<void> {
      if (!this.hasFormData) return;

      const fieldMap: Record<string, number | null> = {
        neck: this.fNeck, shoulders: this.fShoulders,
        chest: this.fChest, waist: this.fWaist, hips: this.fHips,
        leftBicep: this.fLeftBicep, rightBicep: this.fRightBicep,
        leftThigh: this.fLeftThigh, rightThigh: this.fRightThigh,
        leftCalf:  this.fLeftCalf,  rightCalf:  this.fRightCalf,
      };

      const today = new Date().toISOString().slice(0, 10);
      const entry: MeasurementEntry = { id: crypto.randomUUID(), date: today };
      for (const [k, v] of Object.entries(fieldMap)) {
        if (typeof v === 'number' && v > 0) (entry as unknown as Record<string, unknown>)[k] = v;
      }
      if (this.fNote.trim()) entry.note = this.fNote.trim();

      const existing = this.entries.findIndex(e => e.date === today);
      const next = existing >= 0
        ? this.entries.map((e, i) => i === existing ? { ...e, ...entry, id: e.id } : e)
        : [...this.entries, entry].sort((a, b) => a.date.localeCompare(b.date));

      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY, next);
        this.entries = next;
        this._resetForm();
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'success', message: 'Mensurations enregistrées ✓' },
        }));
      } catch (err) {
        console.error('[mensurations] addEntry failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Échec enregistrement. Réessaie.' },
        }));
      }
    },

    async removeEntry(id: string): Promise<void> {
      const next = this.entries.filter(e => e.id !== id);
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEY, next);
        this.entries = next;
      } catch (err) {
        console.error('[mensurations] removeEntry failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Échec suppression. Réessaie.' },
        }));
      }
    },

    _resetForm(): void {
      this.fNeck = this.fShoulders = this.fChest = this.fWaist = this.fHips = null;
      this.fLeftBicep = this.fRightBicep = this.fLeftThigh = this.fRightThigh = null;
      this.fLeftCalf  = this.fRightCalf  = null;
      this.fNote = '';
    },

    // ── Formatting ────────────────────────────────────────────

    formatDate(iso: string): string {
      try {
        return new Date(iso).toLocaleDateString('fr-FR', {
          day: '2-digit', month: 'short', year: '2-digit',
        });
      } catch { return iso; }
    },

    entrySummary(entry: MeasurementEntry): string {
      const abbrs: Array<[string, MetricKey]> = [
        ['Poit', 'chest'], ['Taille', 'waist'], ['Hanch', 'hips'],
        ['Épau', 'shoulders'], ['Bras G', 'leftBicep'], ['Bras D', 'rightBicep'],
      ];
      const parts: string[] = [];
      for (const [abbr, k] of abbrs) {
        const v = val(entry, k);
        if (v !== undefined) parts.push(`${abbr} ${v}`);
        if (parts.length >= 3) break;
      }
      const extraCount = Object.keys(entry).filter(
        k => k !== 'id' && k !== 'date' && k !== 'note' && val(entry, k as MetricKey) !== undefined
      ).length - parts.length;
      if (extraCount > 0) parts.push(`+${extraCount} autres`);
      return parts.join(' · ') || entry.note || '';
    },

    // ── SVG Chart ─────────────────────────────────────────────

    chartSvg(): string {
      const pts = this.chartPoints();
      if (pts.length < 2) return '';

      const metricDef = this.activeMetricDef;
      const W = 320, H = 140, padX = 12, padY = 22, labelH = 16;
      const ys  = pts.map(p => p.y);
      const pad = Math.max(0.5, (Math.max(...ys) - Math.min(...ys)) * 0.05 + 0.5);
      const minY = Math.min(...ys) - pad;
      const maxY = Math.max(...ys) + pad;
      const minX = pts[0]!.x;
      const maxX = pts.at(-1)!.x;
      const dx   = Math.max(1, maxX - minX);
      const dy   = Math.max(0.1, maxY - minY);
      const chartH = H - labelH;

      const sx = (d: number) => padX + (d - minX) / dx * (W - padX * 2);
      const sy = (y: number) => chartH - padY - (y - minY) / dy * (chartH - padY * 2);

      const color = metricDef.color;

      const linePath = pts.map((p, i) =>
        `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`
      ).join(' ');

      const lastP   = pts.at(-1)!;
      const areaPath = linePath
        + ` L ${sx(lastP.x).toFixed(1)} ${chartH.toFixed(1)}`
        + ` L ${padX} ${chartH.toFixed(1)} Z`;

      const gridLines = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
        const y = padY + ratio * (chartH - padY * 2);
        return `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${W - padX}" y2="${y.toFixed(1)}"
          stroke="#ffffff06" stroke-width="1"/>`;
      }).join('');

      // Data point dots (only for small datasets — avoids visual clutter)
      const dots = pts.length <= 20
        ? pts.map(p =>
            `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2"
              fill="${color}" opacity="0.5"/>`
          ).join('')
        : '';

      const lastCx = sx(lastP.x).toFixed(1);
      const lastCy = sy(lastP.y).toFixed(1);

      const d0  = new Date(pts[0]!.x);
      const dN  = new Date(lastP.x);
      const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });

      return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe ${metricDef.label}">
        ${gridLines}
        <path d="${areaPath}" fill="${color}" fill-opacity="0.06"/>
        <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
        <circle cx="${lastCx}" cy="${lastCy}" r="5" fill="${color}"
                filter="drop-shadow(0 0 5px ${color}90)"/>
        <circle cx="${lastCx}" cy="${lastCy}" r="2.5" fill="#0A0A0F"/>
        <text x="${padX}" y="${H - 3}" fill="#4B5563" font-size="9">${fmt(d0)}</text>
        <text x="${W - padX}" y="${H - 3}" text-anchor="end" fill="#4B5563" font-size="9">${fmt(dN)}</text>
        <text x="${padX}" y="11" fill="#6B7280" font-size="9">${maxY.toFixed(0)} cm</text>
        <text x="${padX}" y="${(chartH - 4).toFixed(0)}" fill="#6B7280" font-size="9">${minY.toFixed(0)} cm</text>
      </svg>`;
    },
  };
}
