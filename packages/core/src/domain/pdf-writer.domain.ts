/**
 * Générateur PDF minimal (PDF 1.4), sans dépendance : pages A4, texte en
 * Helvetica / Helvetica-Bold (polices standard, encodage WinAnsi pour les
 * accents français), rectangles, lignes et polylignes vectorielles.
 *
 * Le fichier produit est entièrement ASCII (texte en chaînes hexadécimales),
 * donc la longueur de la chaîne JS = nombre d'octets : les décalages de la
 * table xref sont exacts. Coordonnées de l'API : origine en HAUT à gauche,
 * en points (1/72 de pouce), converties vers le repère PDF (bas à gauche).
 * Pur, zéro I/O.
 */

export const PDF_A4 = { width: 595.28, height: 841.89 } as const;

export type PdfColor = readonly [number, number, number]; // 0–255

export interface PdfTextOptions {
  size?: number;
  bold?: boolean;
  color?: PdfColor;
  align?: 'left' | 'center' | 'right';
}

export interface PdfStrokeOptions {
  width?: number;
  color?: PdfColor;
  dash?: readonly number[];
}

/** Caractères Unicode hors Latin-1 présents dans WinAnsi (0x80–0x9F). */
const WIN_ANSI_EXTRA: Readonly<Record<number, number>> = {
  0x20ac: 0x80, // €
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85, // …
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c, // Œ
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92, // ’
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c, // œ
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Substituts lisibles pour quelques caractères absents de WinAnsi. */
const FALLBACK: Readonly<Record<string, string>> = {
  '\u202f': ' ', // espace fine insécable
  '\u2009': ' ',
  '−': '-', // signe moins
  '≈': '~', // ≈
  '↑': '+',
  '↓': '-',
  '→': '->',
  '≤': '<=',
  '≥': '>=',
};

/**
 * Texte Unicode → octets WinAnsi (CP1252). Les caractères impossibles à
 * représenter (emojis, symboles) sont retirés, après substitution éventuelle.
 */
export function toWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of String(text)) {
    const fb = FALLBACK[ch];
    if (fb !== undefined) {
      for (const c of fb) out.push(c.charCodeAt(0));
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out.push(0x20);
    else if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else if (WIN_ANSI_EXTRA[cp] !== undefined) out.push(WIN_ANSI_EXTRA[cp]!);
    // sinon : ignoré (emoji, sélecteur de variante, contrôle…)
  }
  return out;
}

// Largeurs Helvetica (unités /1000), codes 32–126 (AFM standard Adobe).
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Largeurs des codes ≥ 0x80 utiles (identiques en gras sauf indication). */
const W_HIGH: Readonly<Record<number, number>> = {
  0x80: 556,
  0x85: 1000,
  0x8c: 1000,
  0x92: 222,
  0x95: 350,
  0x96: 556,
  0x97: 1000,
  0x9c: 944,
  0xa0: 278,
  0xab: 556,
  0xb0: 400,
  0xb7: 278,
  0xbb: 556,
  0xd7: 584,
  0xf7: 584,
};
/** Lettres accentuées Latin-1 → lettre de base (même chasse en Helvetica). */
const BASE_LETTER = 'AAAAAAACEEEEIIIIDNOOOOOxOUUUUYPsaaaaaaaceeeeiiiidnooooo/ouuuuypy'; // 0xC0–0xFF

function charWidth(code: number, bold: boolean): number {
  const table = bold ? W_BOLD : W_REG;
  if (code >= 32 && code <= 126) return table[code - 32]!;
  if (code === 0x92 && bold) return 278;
  if (W_HIGH[code] !== undefined) return W_HIGH[code]!;
  if (code >= 0xc0) {
    if (code === 0xc6) return 1000; // Æ
    if (code === 0xe6) return 889; // æ
    if (code === 0xdf) return 611; // ß
    if (code >= 0xec && code <= 0xef) return 278; // ì í î ï
    return table[BASE_LETTER.charCodeAt(code - 0xc0) - 32]!;
  }
  return 556;
}

/** Largeur d'un texte en points. */
export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const c of toWinAnsi(text)) w += charWidth(c, bold);
  return (w * size) / 1000;
}

/** Coupe un texte en lignes d'au plus `maxWidth` points (mots entiers, sinon coupés). */
export function wrapText(text: string, maxWidth: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= maxWidth) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      // Mot plus long que la ligne : coupé au caractère.
      while (textWidth(line, size, bold) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

const num = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const rgb = (c: PdfColor): string =>
  c.map((v) => num(Math.max(0, Math.min(255, v)) / 255)).join(' ');
const hex = (bytes: readonly number[]): string =>
  bytes
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/** Chaîne de métadonnées (Info) : UTF-16BE avec BOM, en hexadécimal. */
function infoString(text: string): string {
  const bytes = [0xfe, 0xff];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes.push(c >> 8, c & 0xff);
  }
  return `<${hex(bytes)}>`;
}

export interface PdfPage {
  readonly width: number;
  readonly height: number;
  text(x: number, y: number, text: string, opts?: PdfTextOptions): void;
  rect(x: number, y: number, w: number, h: number, fill: PdfColor): void;
  strokeRect(x: number, y: number, w: number, h: number, stroke?: PdfStrokeOptions): void;
  line(x1: number, y1: number, x2: number, y2: number, stroke?: PdfStrokeOptions): void;
  polyline(points: ReadonlyArray<readonly [number, number]>, stroke?: PdfStrokeOptions): void;
  /** Point plein (carré de côté `size` centré). */
  dot(x: number, y: number, size: number, fill: PdfColor): void;
}

export interface PdfDocument {
  addPage(): PdfPage;
  readonly pageCount: number;
  /** Fichier PDF complet (ASCII). */
  build(): string;
}

/** Nouveau document A4. `title` va dans les métadonnées. */
export function createPdf(
  meta: { title?: string; author?: string; createdAt?: Date } = {},
): PdfDocument {
  const pages: string[][] = [];
  const { width, height } = PDF_A4;

  function addPage(): PdfPage {
    const ops: string[] = [];
    pages.push(ops);
    const Y = (y: number) => num(height - y);
    const strokeOps = (s: PdfStrokeOptions = {}) => {
      ops.push(`${num(s.width ?? 1)} w ${rgb(s.color ?? [0, 0, 0])} RG`);
      ops.push(s.dash?.length ? `[${s.dash.map(num).join(' ')}] 0 d` : '[] 0 d');
    };
    return {
      width,
      height,
      text(x, y, text, o = {}) {
        const size = o.size ?? 10;
        const bytes = toWinAnsi(text);
        if (!bytes.length) return;
        let tx = x;
        if (o.align === 'center') tx -= textWidth(text, size, o.bold) / 2;
        else if (o.align === 'right') tx -= textWidth(text, size, o.bold);
        ops.push(
          `BT /${o.bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(o.color ?? [0, 0, 0])} rg ` +
            `${num(tx)} ${Y(y)} Td <${hex(bytes)}> Tj ET`,
        );
      },
      rect(x, y, w, h, fill) {
        ops.push(`${rgb(fill)} rg ${num(x)} ${Y(y + h)} ${num(w)} ${num(h)} re f`);
      },
      strokeRect(x, y, w, h, s) {
        strokeOps(s);
        ops.push(`${num(x)} ${Y(y + h)} ${num(w)} ${num(h)} re S`);
      },
      line(x1, y1, x2, y2, s) {
        strokeOps(s);
        ops.push(`${num(x1)} ${Y(y1)} m ${num(x2)} ${Y(y2)} l S`);
      },
      polyline(points, s) {
        if (points.length < 2) return;
        strokeOps(s);
        ops.push(
          '1 J 1 j ' +
            points.map(([x, y], i) => `${num(x)} ${Y(y)} ${i ? 'l' : 'm'}`).join(' ') +
            ' S 0 J 0 j',
        );
      },
      dot(x, y, size, fill) {
        ops.push(
          `${rgb(fill)} rg ${num(x - size / 2)} ${Y(y + size / 2)} ${num(size)} ${num(size)} re f`,
        );
      },
    };
  }

  function build(): string {
    if (pages.length === 0) addPage();
    // Objets : 1 catalogue, 2 arbre des pages, 3–4 polices, 5 info, puis
    // pour chaque page : l'objet page et son flux de contenu.
    const objects: string[] = [];
    const n = pages.length;
    const pageId = (i: number) => 6 + i * 2;
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] =
      `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] ` +
      `/MediaBox [0 0 ${num(width)} ${num(height)}] >>`;
    objects[3] =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[4] =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    const d = meta.createdAt ?? new Date(0);
    const p2 = (v: number) => String(v).padStart(2, '0');
    const date =
      `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
      `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
    objects[5] =
      `<< /Producer ${infoString('Kinetic')} /CreationDate (${date})` +
      (meta.title ? ` /Title ${infoString(meta.title)}` : '') +
      (meta.author ? ` /Author ${infoString(meta.author)}` : '') +
      ' >>';
    pages.forEach((ops, i) => {
      const content = ops.join('\n');
      objects[pageId(i)] =
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> ` +
        `/Contents ${pageId(i) + 1} 0 R >>`;
      objects[pageId(i) + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    });

    // En-tête : le commentaire binaire est volontairement omis pour rester ASCII.
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
      offsets[id] = out.length;
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++)
      out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return out;
  }

  return {
    addPage,
    get pageCount() {
      return pages.length;
    },
    build,
  };
}
