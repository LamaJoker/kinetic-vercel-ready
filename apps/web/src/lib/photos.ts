/**
 * Progress Photos — capture, compression et persistance des photos de
 * progression corporelle.
 *
 * Architecture :
 *   - Stockage : un tableau de PhotoEntry dans IndexedDB (clé STORAGE_KEYS.PROGRESS_PHOTOS).
 *   - Le blob image est stocké en **base64 dataURL** (pas un Blob brut) pour
 *     rester compatible avec l'export JSON existant et la sync Supabase JSON.
 *   - Compression côté browser via canvas : max 1024px de côté, JPEG q=0.75.
 *     → photo d'iPhone (~4 Mo) compresse en ~150 ko, parfait pour IDB.
 *
 * Aucune photo n'est jamais envoyée à un serveur sans action explicite
 * (export ou partage). C'est de la donnée privée.
 */

import { STORAGE_KEYS } from '@kinetic/core';
import type { StoragePort } from '@kinetic/core';

export interface PhotoEntry {
  id: string;
  /** ISO datetime de la prise de vue. */
  takenAt: string;
  /** Poids corporel optionnel à la prise de vue (kg). */
  bodyweightKg?: number;
  /** Étiquette libre : "front", "side", "back"... */
  label?: string;
  /** DataURL JPEG compressé. */
  dataUrl: string;
}

const MAX_DIM = 1024;
const JPEG_QUALITY = 0.75;

export async function loadPhotos(storage: StoragePort): Promise<PhotoEntry[]> {
  const raw = await storage.get<PhotoEntry[]>(STORAGE_KEYS.PROGRESS_PHOTOS);
  return Array.isArray(raw) ? raw : [];
}

export async function savePhotos(storage: StoragePort, photos: PhotoEntry[]): Promise<void> {
  await storage.set(STORAGE_KEYS.PROGRESS_PHOTOS, photos);
}

export async function deletePhoto(storage: StoragePort, id: string): Promise<PhotoEntry[]> {
  const current = await loadPhotos(storage);
  const next = current.filter((p) => p.id !== id);
  await savePhotos(storage, next);
  return next;
}

/**
 * compressImageFile — pipeline File → Image → Canvas → JPEG dataURL.
 *
 * Côté browser, on lit le File via FileReader, on le rend dans un canvas
 * en limitant la dimension max, puis on exporte en JPEG.
 */
export async function compressImageFile(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const { width, height } = fitToMax(img.naturalWidth, img.naturalHeight, MAX_DIM);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

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
