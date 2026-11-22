/**
 * Image « Avant / Après » à partager (Photos › Comparaison). Chargé à la
 * demande au premier partage. Les deux photos sont dessinées côte à côte,
 * recadrées au même format 3:4, avec leurs dates et l'écart. Le partage passe
 * par shareCardImage (feuille native, Web Share, sinon téléchargement) : la
 * photo ne quitte l'appareil que si l'utilisateur la partage lui-même.
 */
import { shareCardImage, type ShareOutcome } from './session-share-image';

const FONT = 'Inter, -apple-system, "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif';
const W = 1080;
const PAD = 36;
const GAP = 16;
const HEAD = 150;
const FOOT = 70;

export interface CompareSide {
  url: string;
  date: string;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = src;
  });
}

/** Dessine `img` en remplissant le cadre (recadrage centré, comme object-cover). */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const iw = img.naturalWidth || w;
  const ih = img.naturalHeight || h;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

export async function shareCompareImage(
  before: CompareSide,
  after: CompareSide,
  gap: string,
): Promise<ShareOutcome> {
  const [a, b] = await Promise.all([loadImage(before.url), loadImage(after.url)]);
  const cw = (W - PAD * 2 - GAP) / 2;
  const ch = Math.round((cw * 4) / 3);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = HEAD + ch + FOOT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas indisponible');
  ctx.fillStyle = '#0b0d17';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 54px ${FONT}`;
  ctx.fillText('Avant / Après', PAD, 78);
  ctx.fillStyle = '#ff7a59';
  ctx.font = `600 32px ${FONT}`;
  ctx.fillText(gap, PAD, 124);

  [a, b].forEach((img, i) => {
    const x = PAD + i * (cw + GAP);
    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, HEAD, cw, ch, 28);
    else ctx.rect(x, HEAD, cw, ch);
    ctx.clip();
    drawCover(ctx, img, x, HEAD, cw, ch);
    // Bandeau de date en bas de chaque photo
    const grad = ctx.createLinearGradient(0, HEAD + ch - 120, 0, HEAD + ch);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, HEAD + ch - 120, cw, 120);
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText(
      (i ? 'Après · ' : 'Avant · ') + (i ? after.date : before.date),
      x + 24,
      HEAD + ch - 28,
    );
  });

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `600 26px ${FONT}`;
  ctx.fillText('Kinetic', PAD, HEAD + ch + 48);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((bl) => (bl ? resolve(bl) : reject(new Error('Image vide'))), 'image/png'),
  );
  return shareCardImage({
    blob,
    fileName: 'kinetic-avant-apres.png',
    title: 'Avant / Après',
    dialogTitle: 'Partager ta comparaison',
  });
}
