import {
  STORAGE_KEYS,
  defaultComparePair,
  photoGapLabel,
  splitPercent,
  type BodyWeightPoint,
} from '@kinetic/core';
import { UuidGenerator } from '@kinetic/adapters-web';
import { getDeps } from '../deps';
import {
  loadPhotos,
  deletePhoto as deletePhotoLib,
  compressImageFile,
  addPhoto,
  getPhotoObjectUrl,
  type PhotoEntry,
} from '../lib/photos';
import { hapticLight, hapticSuccess, hapticTap } from '../lib/haptics';
import { notifyWriteFailed } from '../lib/write-errors';

const _idGen = new UuidGenerator();
const POSE_LABELS: Record<string, string> = { front: 'Face', side: 'Profil', back: 'Dos' };

type PhotoUrlState = 'pending' | 'resolved' | 'failed';

export function photosPage() {
  return {
    photos: [] as PhotoEntry[],
    adding: false,
    newBodyweight: null as number | null,
    newLabel: 'front' as 'front' | 'side' | 'back',
    showCompare: true,
    compareBeforeId: '' as string,
    compareAfterId: '' as string,
    /** Comparateur : superposé (curseur à glisser) ou côte à côte. */
    compareMode: 'overlay' as 'overlay' | 'side',
    /** Position du curseur, en % de la largeur (partie gauche = avant). */
    split: 50,
    dragging: false,
    fullscreen: false,
    sharing: false,
    weights: [] as BodyWeightPoint[],
    _urlCache: new Map<string, { url: string; state: PhotoUrlState }>(),

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const [photos, weights] = await Promise.all([
          loadPhotos(deps.storage),
          deps.storage.get<BodyWeightPoint[]>(STORAGE_KEYS.BODYWEIGHT_ENTRIES),
        ]);
        this.photos = photos;
        this.weights = Array.isArray(weights) ? weights : [];
        this._resetPair();
        for (const p of this.photos) void this._ensureUrl(p);
      } catch (err) {
        console.error('[photos] init failed:', err);
      }
    },

    /** Paire par défaut : plus ancienne et plus récente d'une même pose. */
    _resetPair(): void {
      const pair = defaultComparePair(this.photos);
      this.compareBeforeId = pair?.beforeId ?? '';
      this.compareAfterId = pair?.afterId ?? '';
    },

    destroy(): void {
      for (const entry of this._urlCache.values()) {
        if (entry.state === 'resolved') URL.revokeObjectURL(entry.url);
      }
      this._urlCache.clear();
    },

    photoUrl(p: PhotoEntry): string {
      const cached = this._urlCache.get(p.id);
      if (cached?.state === 'resolved') return cached.url;
      void this._ensureUrl(p);
      return '';
    },

    async _ensureUrl(p: PhotoEntry): Promise<void> {
      if (this._urlCache.has(p.id)) return;
      this._urlCache.set(p.id, { url: '', state: 'pending' });
      try {
        const deps = await getDeps();
        const url = await getPhotoObjectUrl(deps.storage, p);
        if (url) {
          this._urlCache.set(p.id, { url, state: 'resolved' });
        } else {
          this._urlCache.set(p.id, { url: '', state: 'failed' });
        }
        this.photos = [...this.photos];
      } catch (err) {
        console.warn('[photos] ensureUrl failed:', err);
        this._urlCache.set(p.id, { url: '', state: 'failed' });
      }
    },

    photoDateLabel(p: PhotoEntry): string {
      try {
        return new Date(p.takenAt).toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        });
      } catch {
        return p.takenAt;
      }
    },

    /** Option des menus : « 12 sept. 2026 · Face ». */
    photoOptionLabel(p: PhotoEntry): string {
      const pose = POSE_LABELS[p.label ?? ''];
      return this.photoDateLabel(p) + (pose ? ' · ' + pose : '');
    },

    comparePhoto(id: string): PhotoEntry | null {
      return this.photos.find((p) => p.id === id) ?? null;
    },

    get beforePhoto(): PhotoEntry | null {
      return this.comparePhoto(this.compareBeforeId);
    },

    get afterPhoto(): PhotoEntry | null {
      return this.comparePhoto(this.compareAfterId);
    },

    get beforeUrl(): string {
      return this.beforePhoto ? this.photoUrl(this.beforePhoto) : '';
    },

    get afterUrl(): string {
      return this.afterPhoto ? this.photoUrl(this.afterPhoto) : '';
    },

    get beforeDate(): string {
      return this.beforePhoto ? this.photoDateLabel(this.beforePhoto) : '';
    },

    get afterDate(): string {
      return this.afterPhoto ? this.photoDateLabel(this.afterPhoto) : '';
    },

    /** « 12 semaines · −3,2 kg » (poids de la photo, sinon pesée proche). */
    get gapLabel(): string {
      const a = this.beforePhoto;
      const b = this.afterPhoto;
      if (!a || !b) return '';
      // Ordre chronologique, quel que soit le choix des menus.
      return a.takenAt <= b.takenAt
        ? photoGapLabel(a, b, this.weights)
        : photoGapLabel(b, a, this.weights);
    },

    get isOverlay(): boolean {
      return this.compareMode === 'overlay';
    },

    setOverlay(): void {
      this.compareMode = 'overlay';
    },

    setSide(): void {
      this.compareMode = 'side';
    },

    /** Photo « avant » rognée à gauche du curseur. */
    get beforeClipStyle(): string {
      return `clip-path: inset(0 ${100 - this.split}% 0 0)`;
    },

    get handleStyle(): string {
      return `left: ${this.split}%`;
    },

    get splitText(): string {
      return `${Math.round(this.split)} % avant`;
    },

    _moveSplit(ev: PointerEvent): void {
      const el = ev.currentTarget as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const next = splitPercent(ev.clientX, r.left, r.width);
      // Petit cran au passage du milieu.
      if ((this.split - 50) * (next - 50) < 0) hapticTap();
      this.split = next;
    },

    splitDown(ev: PointerEvent): void {
      if (ev.button > 0) return;
      this.dragging = true;
      try {
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      } catch {
        /* capture indisponible */
      }
      this._moveSplit(ev);
    },

    splitMove(ev: PointerEvent): void {
      if (this.dragging) this._moveSplit(ev);
    },

    splitUp(): void {
      this.dragging = false;
    },

    /** Clavier (curseur ARIA) : flèches ±5 %, Début / Fin. */
    splitKey(ev: KeyboardEvent): void {
      const steps: Record<string, number> = {
        ArrowLeft: -5,
        ArrowDown: -5,
        ArrowRight: 5,
        ArrowUp: 5,
      };
      if (ev.key in steps) this.split = Math.max(0, Math.min(100, this.split + steps[ev.key]!));
      else if (ev.key === 'Home') this.split = 0;
      else if (ev.key === 'End') this.split = 100;
      else return;
      ev.preventDefault();
    },

    openFullscreen(): void {
      this.fullscreen = true;
      hapticLight();
    },

    closeFullscreen(): void {
      this.fullscreen = false;
    },

    /** Inverse avant et après. */
    swapPair(): void {
      const a = this.compareBeforeId;
      this.compareBeforeId = this.compareAfterId;
      this.compareAfterId = a;
    },

    /** Partage en image (côte à côte, dates et écart) — module chargé au premier partage. */
    async shareCompare(): Promise<void> {
      if (this.sharing || !this.beforeUrl || !this.afterUrl) return;
      this.sharing = true;
      try {
        const { shareCompareImage } = await import('../lib/photo-compare-image');
        const outcome = await shareCompareImage(
          { url: this.beforeUrl, date: this.beforeDate },
          { url: this.afterUrl, date: this.afterDate },
          this.gapLabel,
        );
        if (outcome === 'downloaded') {
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'success', message: 'Image enregistrée ✓' },
            }),
          );
        }
      } catch (err) {
        console.error('[photos] shareCompare failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: "Impossible de créer l'image." },
          }),
        );
      } finally {
        this.sharing = false;
      }
    },

    async addPhoto(ev: Event): Promise<void> {
      const target = ev.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'Fichier non reconnu comme image.' },
          }),
        );
        return;
      }
      this.adding = true;
      try {
        const blob = await compressImageFile(file);
        const deps = await getDeps();
        const id = _idGen.newId();
        const takenAt = new Date().toISOString();
        this.photos = await addPhoto(deps.storage, blob, {
          id,
          takenAt,
          ...(typeof this.newBodyweight === 'number' && this.newBodyweight > 0
            ? { bodyweightKg: this.newBodyweight }
            : {}),
          ...(this.newLabel ? { label: this.newLabel } : {}),
        });
        await this._ensureUrl(this.photos.at(-1)!);
        this._resetPair();
        target.value = '';
        hapticSuccess();
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: 'Photo ajoutée ✓' },
          }),
        );
      } catch (err) {
        console.error('[photos] addPhoto failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: "Impossible d'ajouter cette photo." },
          }),
        );
      } finally {
        this.adding = false;
      }
    },

    async removePhoto(id: string): Promise<void> {
      try {
        const deps = await getDeps();
        const next = await deletePhotoLib(deps.storage, id);
        const cached = this._urlCache.get(id);
        if (cached?.state === 'resolved') URL.revokeObjectURL(cached.url);
        this._urlCache.delete(id);
        this.photos = next;
        if (id === this.compareBeforeId || id === this.compareAfterId) this._resetPair();
        hapticLight();
      } catch (err) {
        notifyWriteFailed('la suppression de la photo', err);
      }
    },
  };
}
