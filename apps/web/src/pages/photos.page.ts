import { STORAGE_KEYS } from '@kinetic/core';
import { UuidGenerator } from '@kinetic/adapters-web';
import { getDeps } from '../deps';
import { loadPhotos, savePhotos, compressImageFile, type PhotoEntry } from '../lib/photos';
import { hapticLight, hapticSuccess } from '../lib/haptics';

const _idGen = new UuidGenerator();

export function photosPage() {
  return {
    photos: [] as PhotoEntry[],
    adding: false,
    newBodyweight: 0 as number | null,
    newLabel: 'front' as 'front' | 'side' | 'back',
    showCompare: true,
    compareBeforeId: '' as string,
    compareAfterId: '' as string,

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        this.photos = await loadPhotos(deps.storage);
        if (this.photos.length >= 2) {
          this.compareBeforeId = this.photos[0]!.id;
          this.compareAfterId = this.photos[this.photos.length - 1]!.id;
        }
      } catch (err) {
        console.error('[photos] init failed:', err);
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
        const dataUrl = await compressImageFile(file);
        const entry: PhotoEntry = {
          id: _idGen.newId(),
          takenAt: new Date().toISOString(),
          dataUrl,
          ...(typeof this.newBodyweight === 'number' && this.newBodyweight > 0
            ? { bodyweightKg: this.newBodyweight }
            : {}),
          ...(this.newLabel ? { label: this.newLabel } : {}),
        };
        const deps = await getDeps();
        const next = [...this.photos, entry];
        await savePhotos(deps.storage, next);
        this.photos = next;
        target.value = ''; // reset input so the same file can be added again
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
        const next = this.photos.filter((p) => p.id !== id);
        await savePhotos(deps.storage, next);
        this.photos = next;
        hapticLight();
      } catch (err) {
        console.error('[photos] removePhoto failed:', err);
      }
    },
  };
}
