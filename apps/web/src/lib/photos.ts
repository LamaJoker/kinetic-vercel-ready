/**
 * Progress Photos — capture, compression et persistance.
 *
 * Architecture (post-refactor) :
 *   - **Meta** des photos (id, takenAt, bodyweightKg, label) stockée comme
 *     JSON dans `STORAGE_KEYS.PROGRESS_PHOTOS` via le StoragePort principal.
 *   - **Blobs** (le binaire JPEG) stockés dans un store IDB dédié
 *     `kinetic-photos / blobs`, clé = photo.id, valeur = Blob.
 *
 * Pourquoi cette séparation :
 *   - Le store principal (`keyval-store / keyval`) sérialise tout en JSON →
 *     un Blob deviendrait `{}` (perte de données). En les isolant dans un
 *     store séparé via `createStore()`, idb-keyval stocke le Blob brut.
 *   - L'export JSON (`exportAsJson`) ne touche pas les Blobs → un export
 *     reste léger (~quelques ko même avec 100 photos), pas plusieurs Mo.
 *   - Pour partager/archiver les photos, l'utilisateur peut les télécharger
 *     individuellement via `downloadPhoto()`.
 *
 * Compatibilité ascendante : si on trouve une ancienne photo avec un
 * `dataUrl` (= base64 dans le meta), on la convertit lazy en Blob dans
 * le store IDB dédié et on retire `dataUrl` du meta.
 */

import { STORAGE_KEYS } from '@kinetic/core';
import type { StoragePort } from '@kinetic/core';
import { createStore, get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

export interface PhotoEntry {
  id: string;
  takenAt: string;
  bodyweightKg?: number;
  label?: string;
  /** Taille en bytes du blob stocké (cache utile pour debug / quota). */
  sizeBytes?: number;
  /**
   * @deprecated chemin de migration legacy — lu mais pas écrit.
   * Les photos créées après ce refactor stockent le binaire dans le store
   * IDB dédié `kinetic-photos`.
   */
  dataUrl?: string;
}

const MAX_DIM = 1024;
const JPEG_QUALITY = 0.75;

// Store IDB dédié — Blob friendly (pas de sérialisation JSON).
const photoStore = createStore('kinetic-photos', 'blobs');

// ─── Meta CRUD ──────────────────────────────────────────────────────────────

export async function loadPhotos(storage: StoragePort): Promise<PhotoEntry[]> {
  const raw = await storage.get<PhotoEntry[]>(STORAGE_KEYS.PROGRESS_PHOTOS);
  return Array.isArray(raw) ? raw : [];
}

export async function savePhotos(storage: StoragePort, photos: PhotoEntry[]): Promise<void> {
  // On nettoie le champ `dataUrl` au passage pour ne plus le persister :
  // soit la photo a été migrée (blob existe), soit on garde dataUrl
  // tant que la migration n'a pas eu lieu.
  await storage.set(STORAGE_KEYS.PROGRESS_PHOTOS, photos);
}

/** Supprime la meta + le Blob associé. Idempotent. */
export async function deletePhoto(storage: StoragePort, id: string): Promise<PhotoEntry[]> {
  const current = await loadPhotos(storage);
  const next = current.filter((p) => p.id !== id);
  await savePhotos(storage, next);
  await idbDel(id, photoStore).catch(() => null);
  return next;
}

// ─── Blob CRUD ──────────────────────────────────────────────────────────────

/**
 * Récupère le Blob d'une photo. Migre automatiquement les anciennes photos
 * (dataUrl legacy) vers le store IDB dédié au passage.
 */
export async function getPhotoBlob(storage: StoragePort, photo: PhotoEntry): Promise<Blob | null> {
  // Cas legacy : la photo a encore un dataUrl → on migre en transparence.
  if (photo.dataUrl) {
    try {
      const blob = dataUrlToBlob(photo.dataUrl);
      await idbSet(photo.id, blob, photoStore);
      // On retire le dataUrl du meta (allège le tableau JSON et le réseau si sync)
      const all = await loadPhotos(storage);
      const cleaned: PhotoEntry[] = all.map((p) => {
        if (p.id !== photo.id) return p;
        // Strip dataUrl en omettant la propriété (exactOptionalPropertyTypes friendly)
        const { dataUrl: _du, ...rest } = p;
        void _du;
        return { ...rest, sizeBytes: blob.size };
      });
      await savePhotos(storage, cleaned);
      return blob;
    } catch (err) {
      console.warn('[photos] legacy migration failed for', photo.id, err);
    }
  }
  const blob = await idbGet<Blob>(photo.id, photoStore).catch(() => null);
  return blob ?? null;
}

/**
 * URL objet pour afficher dans <img>. À révoquer (URL.revokeObjectURL) quand
 * l'élément quitte le DOM pour éviter les fuites mémoire.
 */
export async function getPhotoObjectUrl(
  storage: StoragePort,
  photo: PhotoEntry,
): Promise<string | null> {
  const blob = await getPhotoBlob(storage, photo);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

/** Force un download direct depuis le navigateur (utile pour archive perso). */
export async function downloadPhoto(storage: StoragePort, photo: PhotoEntry): Promise<void> {
  const blob = await getPhotoBlob(storage, photo);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kinetic-${photo.label ?? 'photo'}-${photo.takenAt.slice(0, 10)}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Capture + compression ──────────────────────────────────────────────────

/**
 * compressImageFile — File → Image → Canvas → Blob JPEG.
 *
 * Retourne directement un Blob (pas un dataURL) pour stocker tel quel en IDB.
 */
export async function compressImageFile(file: File): Promise<Blob> {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const { width, height } = fitToMax(img.naturalWidth, img.naturalHeight, MAX_DIM);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/** Ajoute une photo (Blob + meta) au stockage. Retourne la liste mise à jour. */
export async function addPhoto(
  storage: StoragePort,
  blob: Blob,
  meta: Omit<PhotoEntry, 'id' | 'takenAt' | 'sizeBytes' | 'dataUrl'> & {
    id: string;
    takenAt: string;
  },
): Promise<PhotoEntry[]> {
  await idbSet(meta.id, blob, photoStore);
  const entry: PhotoEntry = {
    id: meta.id,
    takenAt: meta.takenAt,
    sizeBytes: blob.size,
    ...(meta.bodyweightKg != null ? { bodyweightKg: meta.bodyweightKg } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  };
  const current = await loadPhotos(storage);
  const next = [...current, entry];
  await savePhotos(storage, next);
  return next;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

function fitToMax(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  if (w >= h) {
    const ratio = max / w;
    return { width: max, height: Math.round(h * ratio) };
  }
  const ratio = max / h;
  return { width: Math.round(w * ratio), height: max };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('Invalid data URL');
  const mime = m[1]!;
  const binary = atob(m[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
