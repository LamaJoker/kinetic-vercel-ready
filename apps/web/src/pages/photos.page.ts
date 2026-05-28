import { STORAGE_KEYS } from '@kinetic/core';
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
import { hapticLight, hapticSuccess } from '../lib/haptics';

const _idGen = new UuidGenerator();

type PhotoUrlState = 'pending' | 'resolved' | 'failed';

export function photosPage() {
  return {
    photos: [] as PhotoEntry[],
    adding: false,
    newBodyweight: 0 as number | null,
    newLabel: 'front' as 'front' | 'side' | 'back',
    showCompare: true,
    compareBeforeId: '' as string,
    compareAfterId: '' as string,
    _urlCache: new Map<string, { url: string; state: PhotoUrlState }>(),

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        this.photos = await loadPhotos(deps.storage);
        if (this.photos.length >= 2) {
          this.compareBeforeId = this.photos[0]!.id;
          this.compareAfterId = this.photos[this.photos.length - 1]!.id;
        }
        for (const p of this.photos) void this._ensureUrl(p);
      } catch (err) {
        console.error('[photos] init failed:', err);
      }
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

    comparePhoto(id: string): PhotoEntry | null {
      return this.photos.find((p) => p.id === id) ?? null;
    },

    weightDelta(): number | null {
      const before = this.comparePhoto(this.compareBeforeId);
      const after = this.comparePhoto(this.compareAfterId);
      if (!before?.bodyweightKg || !after?.bodyweightKg) return null;
      return Math.round((after.bodyweightKg - before.bodyweightKg) * 10) / 10;
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
        hapticLight();
      } catch (err) {
        console.error('[photos] removePhoto failed:', err);
      }
    },
  };
}
