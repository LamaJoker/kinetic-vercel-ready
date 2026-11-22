/**
 * Bilan à partager : carte récapitulative 1080 × 1920 (format story), palette
 * « Nuit profonde & corail ». Contenu : recapShareCard (@kinetic/core) ;
 * partage : shareCardImage (feuille native, Web Share, sinon téléchargement).
 * Chargé à la demande au premier partage depuis la page Bilan.
 */
import { recapFileName, recapShareCard, type RecapSummary } from '@kinetic/core';
import {
  accentFromCssVar,
  fitWithEllipsis,
  shareCardImage,
  type ShareOutcome,
} from './session-share-image';

const W = 1080;
const H = 1920;
const PAD = 88;
const INK = '#F4F5FB';
const MUTED = '#A2A9C4';
const VIOLET_RGB = '168, 149, 255';
const TEAL_RGB = '94, 224, 200';
const FONT = 'Inter, -apple-system, "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif';
const font = (weight: number, size: number): string => `${weight} ${size}px ${FONT}`;

function tile(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, 36);
  else ctx.rect(x, y, w, h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(170, 180, 255, 0.12)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Dessine la carte du bilan sur `canvas`. */
export function drawRecapCard(
  canvas: HTMLCanvasElement,
  recap: RecapSummary,
  nameOf: (id: string) => string,
  accentRaw?: string | null,
): void {
  const card = recapShareCard(recap, nameOf);
  const colors = accentFromCssVar(accentRaw);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D indisponible');
  const inner = W - PAD * 2;
  const measure = (t: string): number => ctx.measureText(t).width;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#171C33');
  bg.addColorStop(1, '#090C17');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = (cx: number, cy: number, r: number, rgb: string, a: number): void => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(${rgb}, ${a})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(W * 0.1, 220, 950, colors.accentRgb, 0.34);
  glow(W * 0.95, 160, 640, VIOLET_RGB, 0.22);
  glow(W * 0.85, H - 200, 760, TEAL_RGB, 0.12);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let y = 300;
  ctx.font = font(700, 34);
  ctx.fillStyle = colors.accent;
  ctx.fillText(card.kicker.toUpperCase(), PAD, y);
  y += 120;
  ctx.font = font(800, 112);
  ctx.fillStyle = INK;
  ctx.fillText(fitWithEllipsis(card.title, inner, measure), PAD, y);
  y += 90;

  // Trois tuiles : séances, heures, tonnage.
  const gap = 24;
  const tw = (inner - gap * 2) / 3;
  const th = 230;
  card.tiles.forEach((t, i) => {
    const x = PAD + i * (tw + gap);
    tile(ctx, x, y, tw, th);
    ctx.font = font(600, 30);
    ctx.fillStyle = MUTED;
    ctx.fillText(t.label, x + 32, y + 62);
    let size = 84;
    ctx.font = font(800, size);
    const unitW = (): number => {
      ctx.font = font(600, 36);
      const w = t.unit ? measure(` ${t.unit}`) : 0;
      ctx.font = font(800, size);
      return w;
    };
    while (size > 44 && measure(t.value) + unitW() > tw - 56) {
      size -= 4;
      ctx.font = font(800, size);
    }
    ctx.fillStyle = INK;
    const vy = y + th - 48;
    ctx.fillText(t.value, x + 32, vy);
    if (t.unit) {
      const vw = measure(t.value);
      ctx.font = font(600, 36);
      ctx.fillStyle = MUTED;
      ctx.fillText(` ${t.unit}`, x + 32 + vw, vy);
    }
  });
  y += th + 90;

  // Faits marquants, une ligne chacun.
  ctx.font = font(600, 44);
  for (const line of card.lines) {
    ctx.fillStyle = INK;
    ctx.fillText(fitWithEllipsis(line, inner, measure), PAD, y);
    y += 112;
  }

  // Pied : marque discrète.
  const base = H - 230;
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(PAD + 17, base - 12, 14, -Math.PI * 0.35, Math.PI * 1.45);
  ctx.stroke();
  ctx.font = font(700, 34);
  ctx.fillStyle = 'rgba(244, 245, 251, 0.82)';
  ctx.fillText('Kinetic', PAD + 46, base);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image vide'))), 'image/png');
  });
}

/** Génère puis partage l'image du bilan. */
export async function shareRecapImage(
  recap: RecapSummary,
  nameOf: (id: string) => string,
): Promise<ShareOutcome> {
  try {
    await document.fonts?.ready;
  } catch {
    /* police système */
  }
  const canvas = document.createElement('canvas');
  let accent: string | null = null;
  try {
    accent = getComputedStyle(document.documentElement).getPropertyValue('--kinetic-neon');
  } catch {
    /* corail par défaut */
  }
  drawRecapCard(canvas, recap, nameOf, accent);
  const blob = await toBlob(canvas);
  return shareCardImage({
    blob,
    fileName: recapFileName(recap.period),
    title: `Mon bilan Kinetic — ${recap.label}`,
    dialogTitle: 'Partager ton bilan',
  });
}
