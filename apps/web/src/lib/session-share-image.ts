/**
 * « Partager en image » : dessine la carte récapitulative d'une séance terminée
 * (canvas 1080×1350 ou story 1080×1920, palette « Nuit profonde & corail »),
 * puis la partage :
 *  - app native : fichier PNG écrit dans le cache (Filesystem, Directory.Cache)
 *    puis feuille de partage système (@capacitor/share) ;
 *  - web : navigator.share avec le fichier si le navigateur sait le faire,
 *    sinon téléchargement.
 *
 * Chargé à la demande (import() depuis lib/session-share-sheet.ts) : rien au
 * démarrage ni à l'ouverture de la page Séances. Le contenu (textes, chiffres,
 * records) vient du domaine pur `buildShareCardSummary` (@kinetic/core).
 */
import { Capacitor } from '@capacitor/core';
import {
  SHARE_CARD_SIZES,
  buildShareCardSummary,
  shareCardFileName,
  type ShareCardFormat,
  type ShareCardSummary,
  type ShareSessionInput,
} from '@kinetic/core';

// ─── Mise en page (fonctions pures, testées sans canvas) ─────────────────────

/** Mesure d'un texte dans la police courante (ctx.measureText en vrai). */
export type MeasureText = (text: string) => number;

/**
 * Coupe `text` en lignes de largeur ≤ `maxWidth`, au plus `maxLines` ; la
 * dernière ligne se termine par « … » si le texte ne tient pas.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: MeasureText,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    const word = words[i]!;
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) {
    lines.push(line);
    line = '';
    i = words.length;
  }
  const truncated = i < words.length || line !== '';
  if (lines.length) {
    const last = lines.length - 1;
    lines[last] = fitWithEllipsis(lines[last]!, maxWidth, measure, truncated);
  }
  return lines;
}

/** Raccourcit `text` avec « … » s'il dépasse (ou s'il a été tronqué en amont). */
export function fitWithEllipsis(
  text: string,
  maxWidth: number,
  measure: MeasureText,
  forceEllipsis = false,
): string {
  if (!forceEllipsis && measure(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && measure(`${t}…`) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/**
 * Taille du titre : la plus grande (de `maxSize` à `minSize`, pas de 4 px)
 * qui le garde sur UNE ligne ; s'il ne tient pas même au minimum, retour à
 * `maxSize` sur deux lignes au plus (coupées entre les mots, « … » au bout).
 * `measureAt(size)` mesure un texte dans la police du titre à cette taille.
 */
export function fitTitle(
  text: string,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  measureAt: (size: number) => MeasureText,
): { size: number; lines: string[] } {
  for (let size = maxSize; size >= minSize; size -= 4) {
    if (measureAt(size)(text.trim()) <= maxWidth) return { size, lines: [text.trim()] };
  }
  return { size: maxSize, lines: wrapText(text, maxWidth, 2, measureAt(maxSize)) };
}

/** Nombre de rangées de hauteur `rowH` qui tiennent dans `available` (≤ max). */
export function rowsThatFit(available: number, rowH: number, max: number): number {
  if (!(available > 0) || !(rowH > 0)) return 0;
  return Math.max(0, Math.min(max, Math.floor(available / rowH)));
}

// ─── Couleurs ────────────────────────────────────────────────────────────────

interface CardColors {
  accent: string;
  accentRgb: string;
}

/** « 255 122 102 » (variable CSS) → « 255, 122, 102 » ; corail par défaut. */
export function accentFromCssVar(raw: string | null | undefined): CardColors {
  const parts = (raw ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const ok = parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255);
  const rgb = ok ? parts.join(', ') : '255, 122, 102';
  return { accent: `rgb(${rgb})`, accentRgb: rgb };
}

function readAccent(): CardColors {
  try {
    return accentFromCssVar(
      getComputedStyle(document.documentElement).getPropertyValue('--kinetic-neon'),
    );
  } catch {
    return accentFromCssVar(null);
  }
}

const INK = '#F4F5FB';
const MUTED = '#A2A9C4';
const FAINT = 'rgba(170, 180, 255, 0.10)';
const AMBER = '#FFC56B';
const VIOLET_RGB = '168, 149, 255';
const FONT = 'Inter, -apple-system, "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif';

function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT}`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Petite coupe (records) : tracé au trait, 1 unité = 1 px à l'échelle `s`. */
function drawTrophy(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 24, s / 24);
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(7, 4);
  ctx.lineTo(17, 4);
  ctx.lineTo(17, 9);
  ctx.bezierCurveTo(17, 12, 14.8, 14, 12, 14);
  ctx.bezierCurveTo(9.2, 14, 7, 12, 7, 9);
  ctx.closePath();
  ctx.moveTo(7, 6);
  ctx.lineTo(4, 6);
  ctx.bezierCurveTo(4, 9, 5.5, 10.5, 7.4, 10.8);
  ctx.moveTo(17, 6);
  ctx.lineTo(20, 6);
  ctx.bezierCurveTo(20, 9, 18.5, 10.5, 16.6, 10.8);
  ctx.moveTo(12, 14);
  ctx.lineTo(12, 18);
  ctx.moveTo(8, 20);
  ctx.lineTo(16, 20);
  ctx.stroke();
  ctx.restore();
}

/** Marque Kinetic discrète : anneau d'accent + nom. */
function drawBrand(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseline: number,
  colors: CardColors,
): void {
  ctx.save();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(x + 17, baseline - 12, 14, -Math.PI * 0.35, Math.PI * 1.45);
  ctx.stroke();
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.arc(x + 17, baseline - 12, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = font(700, 32);
  ctx.fillStyle = 'rgba(244, 245, 251, 0.82)';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Kinetic', x + 46, baseline);
  ctx.restore();
}

/** Dessine la carte complète sur `canvas` (dimensions fixées ici). */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  summary: ShareCardSummary,
  format: ShareCardFormat,
  colors: CardColors = readAccent(),
): void {
  const { width: W, height: H } = SHARE_CARD_SIZES[format];
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D indisponible');
  const story = format === 'story';
  const PAD = 88;
  const inner = W - PAD * 2;
  // Story : marges hautes/basses réservées à l'interface des réseaux sociaux.
  const top = story ? 250 : 112;
  const bottom = story ? H - 230 : H - 92;

  // Fond nuit + lueurs (accent en haut à gauche, violet en haut à droite).
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#171C33');
  bg.addColorStop(1, '#090C17');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = (cx: number, cy: number, r: number, rgb: string, a: number) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(${rgb}, ${a})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(W * 0.12, story ? 160 : 40, story ? 900 : 760, colors.accentRgb, 0.3);
  glow(W * 0.95, story ? 120 : 20, 620, VIOLET_RGB, 0.2);
  glow(W * 0.5, H + 120, 700, colors.accentRgb, 0.1);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  let y = top;

  // Date.
  ctx.font = font(600, 30);
  ctx.fillStyle = MUTED;
  ctx.fillText(summary.dateLabel, PAD, y + 30);
  y += 64;

  // Titre : une ligne en réduisant un peu la taille, sinon deux lignes au plus.
  const titleMax = story ? 88 : 78;
  const title = fitTitle(summary.title, inner, titleMax, story ? 64 : 58, (size) => {
    ctx.font = font(800, size);
    return (t) => ctx.measureText(t).width;
  });
  ctx.font = font(800, title.size);
  ctx.fillStyle = INK;
  const titleLH = Math.round(title.size * 1.12);
  for (const line of title.lines) {
    y += titleLH;
    ctx.fillText(line, PAD, y - 14);
  }
  y += story ? 56 : 40;

  // Trois tuiles : durée, tonnage, séries.
  const gap = 22;
  const tileW = (inner - gap * 2) / 3;
  const tileH = story ? 210 : 190;
  const stats: Array<{ label: string; value: string; unit: string }> = [
    { label: 'Durée', ...summary.duration },
    { label: 'Tonnage', ...summary.tonnage },
    { label: 'Séries', value: String(summary.setCount), unit: '' },
  ];
  stats.forEach((s, i) => {
    const x = PAD + i * (tileW + gap);
    roundRect(ctx, x, y, tileW, tileH, 36);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
    ctx.fill();
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = font(600, 28);
    ctx.fillStyle = MUTED;
    ctx.fillText(s.label, x + 32, y + 58);
    ctx.font = font(600, 34);
    const unitW = s.unit ? ctx.measureText(` ${s.unit}`).width : 0;
    let size = story ? 78 : 72;
    ctx.font = font(800, size);
    while (size > 40 && ctx.measureText(s.value).width + unitW > tileW - 60) {
      size -= 4;
      ctx.font = font(800, size);
    }
    ctx.fillStyle = INK;
    const vy = y + tileH - 44;
    ctx.fillText(s.value, x + 32, vy);
    if (s.unit) {
      const vw = ctx.measureText(s.value).width;
      ctx.font = font(600, 34);
      ctx.fillStyle = MUTED;
      ctx.fillText(` ${s.unit}`, x + 32 + vw, vy);
    }
  });
  y += tileH + (story ? 64 : 48);

  // Records battus (ambre).
  const footerTop = bottom - 70;
  if (summary.records.length) {
    const maxRecords = story ? 3 : 2;
    const shown = summary.records.slice(0, maxRecords);
    const lineH = 58;
    const boxH = 92 + shown.length * lineH;
    roundRect(ctx, PAD, y, inner, boxH, 36);
    ctx.fillStyle = 'rgba(255, 197, 107, 0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 197, 107, 0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();
    drawTrophy(ctx, PAD + 30, y + 26, 44);
    ctx.font = font(700, 34);
    ctx.fillStyle = AMBER;
    const n = summary.records.length;
    ctx.fillText(n > 1 ? `${n} records battus` : 'Record battu', PAD + 90, y + 62);
    if (n > shown.length) {
      // Records qui ne tiennent pas dans l'encadré : signalés plutôt que tus.
      ctx.font = font(600, 28);
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'right';
      ctx.fillText(
        `+ ${n - shown.length} autre${n - shown.length > 1 ? 's' : ''}`,
        PAD + inner - 32,
        y + 62,
      );
      ctx.textAlign = 'left';
    }
    let ry = y + 62;
    for (const r of shown) {
      ry += lineH;
      ctx.font = font(700, 32);
      ctx.fillStyle = INK;
      const labelW = ctx.measureText(r.label).width;
      ctx.textAlign = 'right';
      ctx.fillText(r.label, PAD + inner - 32, ry);
      ctx.textAlign = 'left';
      ctx.font = font(500, 32);
      ctx.fillStyle = 'rgba(244, 245, 251, 0.86)';
      ctx.fillText(
        fitWithEllipsis(r.name, inner - 64 - labelW - 28, (t) => ctx.measureText(t).width),
        PAD + 32,
        ry,
      );
    }
    y += boxH + (story ? 64 : 46);
  }

  // Exercices phares : nom, détail, barre de tonnage relative.
  const rowH = story ? 112 : 108;
  const headH = 58;
  const rows = rowsThatFit(footerTop - y - headH, rowH, summary.top.length);
  if (rows > 0) {
    ctx.font = font(600, 28);
    ctx.fillStyle = MUTED;
    ctx.fillText('Exercices phares', PAD, y + 30);
    y += headH;
    for (const ex of summary.top.slice(0, rows)) {
      ctx.font = font(600, 28);
      const detailW = ctx.measureText(ex.detail).width;
      ctx.textAlign = 'right';
      ctx.fillStyle = MUTED;
      ctx.fillText(ex.detail, PAD + inner, y + 44);
      ctx.textAlign = 'left';
      ctx.font = font(700, 38);
      ctx.fillStyle = INK;
      ctx.fillText(
        fitWithEllipsis(ex.name, inner - detailW - 32, (t) => ctx.measureText(t).width),
        PAD,
        y + 44,
      );
      const barY = y + 66;
      roundRect(ctx, PAD, barY, inner, 12, 6);
      ctx.fillStyle = 'rgba(110, 120, 175, 0.22)';
      ctx.fill();
      // Sans tonnage (exercice chronométré ou au poids du corps) : piste seule.
      if (ex.share > 0) {
        const fillW = Math.max(12, inner * Math.min(1, ex.share));
        const grad = ctx.createLinearGradient(PAD, 0, PAD + fillW, 0);
        grad.addColorStop(0, `rgba(${colors.accentRgb}, 0.75)`);
        grad.addColorStop(1, colors.accent);
        roundRect(ctx, PAD, barY, fillW, 12, 6);
        ctx.fillStyle = grad;
        ctx.fill();
      }
      y += rowH;
    }
  }

  // Pied : filet + marque discrète + nombre d'exercices.
  ctx.strokeStyle = FAINT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, footerTop + 6);
  ctx.lineTo(PAD + inner, footerTop + 6);
  ctx.stroke();
  drawBrand(ctx, PAD, bottom, colors);
  ctx.font = font(500, 28);
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'right';
  const n = summary.exerciseCount;
  ctx.fillText(`${n} exercice${n > 1 ? 's' : ''}`, PAD + inner, bottom);
  ctx.textAlign = 'left';
}

// ─── Image et partage ────────────────────────────────────────────────────────

export interface ShareCardImage {
  blob: Blob;
  fileName: string;
  title: string;
}

/** Attend Inter (si elle est chargée par la page) pour ne pas dessiner en police système. */
async function fontsReady(): Promise<void> {
  try {
    const fonts = document.fonts;
    if (!fonts) return;
    await Promise.race([
      Promise.all([fonts.load(font(800, 80)), fonts.load(font(600, 30))]).then(() => fonts.ready),
      new Promise((r) => setTimeout(r, 800)),
    ]);
  } catch {
    /* police système */
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image vide'))), 'image/png');
  });
}

/** Génère l'image PNG d'une séance. */
export async function createShareCardImage(
  session: ShareSessionInput,
  history: readonly ShareSessionInput[],
  nameOf: (exerciseId: string) => string,
  format: ShareCardFormat,
): Promise<ShareCardImage> {
  await fontsReady();
  const summary = buildShareCardSummary(session, history, nameOf, format);
  const canvas = document.createElement('canvas');
  drawShareCard(canvas, summary, format);
  const blob = await canvasToBlob(canvas);
  return { blob, fileName: shareCardFileName(session), title: summary.title };
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

/** Plateforme, injectable pour les tests. */
export interface ShareEnv {
  isNative(): boolean;
  shareNative(image: ShareCardImage): Promise<void>;
  canShareFiles(file: File): boolean;
  shareWeb(file: File, title: string): Promise<void>;
  download(blob: Blob, fileName: string): void;
}

/** Vrai pour une annulation par l'utilisateur (feuille de partage fermée). */
export function isShareCancel(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name ?? '';
  const msg = String((err as { message?: string }).message ?? err);
  return name === 'AbortError' || /cancel|annul/i.test(msg);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Lecture impossible'));
    reader.readAsDataURL(blob);
  });
}

const defaultEnv: ShareEnv = {
  isNative: () => Capacitor.isNativePlatform(),
  async shareNative(image) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor/share'),
    ]);
    const written = await Filesystem.writeFile({
      path: image.fileName,
      data: await blobToBase64(image.blob),
      directory: Directory.Cache,
    });
    await Share.share({
      title: image.title,
      files: [written.uri],
      dialogTitle: 'Partager ta séance',
    });
  },
  canShareFiles(file) {
    try {
      return typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [file] });
    } catch {
      return false;
    }
  },
  async shareWeb(file, title) {
    await navigator.share({ files: [file], title });
  },
  download(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

/** Partage l'image : natif, sinon Web Share avec fichier, sinon téléchargement. */
export async function shareCardImage(
  image: ShareCardImage,
  env: ShareEnv = defaultEnv,
): Promise<ShareOutcome> {
  try {
    if (env.isNative()) {
      await env.shareNative(image);
      return 'shared';
    }
    const file = new File([image.blob], image.fileName, { type: 'image/png' });
    if (env.canShareFiles(file)) {
      await env.shareWeb(file, image.title);
      return 'shared';
    }
  } catch (err) {
    if (isShareCancel(err)) return 'cancelled';
    throw err;
  }
  env.download(image.blob, image.fileName);
  return 'downloaded';
}
