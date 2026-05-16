#!/usr/bin/env node
/**
 * scripts/generate-icons.mjs
 *
 * Génère toutes les icônes PWA PNG sans dépendance externe.
 * Utilise uniquement Node.js built-ins : zlib, fs, path.
 *
 * Design : fond #111827 avec dégradé violet (#7F77DD) en cercle,
 * lettre "K" blanche centrée.
 *
 * Usage : node scripts/generate-icons.mjs
 */

import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../apps/web/public/icons');

// ─── CRC32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── PNG chunk ────────────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(d.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, d])), 0);
  return Buffer.concat([len, t, d, crcBuf]);
}

// ─── Pixel rendering ─────────────────────────────────────────────────────────

/** Interpolation linéaire entre deux couleurs [r,g,b] */
function lerp(a, b, t) {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}

/** Distance signée d'un point à un segment — pour dessiner des traits */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Alpha de la lettre "K" en pixels normalisés [0, size].
 * La lettre est centrée et occupe ~50% de l'icône.
 */
function kAlpha(px, py, size) {
  const s = size * 0.28; // demi-hauteur du K
  const cx = size / 2;
  const cy = size / 2;
  const thick = size * 0.065; // épaisseur du trait

  // Tige verticale : de (cx - s*0.32, cy - s) à (cx - s*0.32, cy + s)
  const stemX = cx - s * 0.32;
  const d1 = distToSegment(px, py, stemX, cy - s, stemX, cy + s);

  // Bras supérieur : de (stemX, cy - s*0.05) à (cx + s*0.6, cy - s)
  const d2 = distToSegment(px, py, stemX, cy - s * 0.05, cx + s * 0.6, cy - s);

  // Bras inférieur : de (stemX, cy + s*0.05) à (cx + s*0.6, cy + s)
  const d3 = distToSegment(px, py, stemX, cy + s * 0.05, cx + s * 0.6, cy + s);

  const minDist = Math.min(d1, d2, d3);

  // Anti-aliasing soft
  if (minDist < thick - 1) return 1;
  if (minDist < thick + 1) return (thick + 1 - minDist) / 2;
  return 0;
}

// ─── PNG generator ────────────────────────────────────────────────────────────

function generateIcon(size) {
  const BG = [17, 24, 39]; // #111827
  const PURPLE = [127, 119, 221]; // #7F77DD
  const WHITE = [255, 255, 255];

  // PNG raw data: filter byte per row + RGBA pixels
  const raw = [];

  for (let y = 0; y < size; y++) {
    raw.push(0); // filter: None
    for (let x = 0; x < size; x++) {
      // Normalized distance from center [0..√2]
      const nx = (x - size / 2) / (size / 2);
      const ny = (y - size / 2) / (size / 2);
      const dist = Math.hypot(nx, ny);

      // Radial gradient: purple at center, dark at edge
      const t = Math.min(1, Math.pow(dist * 0.85, 1.8));
      const [r, g, b] = lerp(PURPLE, BG, t);

      // Letter K alpha
      const ka = kAlpha(x, y, size);

      raw.push(
        Math.round(r * (1 - ka) + WHITE[0] * ka),
        Math.round(g * (1 - ka) + WHITE[1] * ka),
        Math.round(b * (1 - ka) + WHITE[2] * ka),
        255, // fully opaque
      );
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA

  const idat = deflateSync(Buffer.from(raw), { level: 7 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];

mkdirSync(OUT, { recursive: true });
console.log('🎨 Generating PWA icons (pure Node.js, no deps)...\n');

for (const size of SIZES) {
  const buf = generateIcon(size);
  const out = resolve(OUT, `icon-${size}.png`);
  writeFileSync(out, buf);
  const kb = (buf.length / 1024).toFixed(1);
  console.log(`  ✅ icon-${size}.png  (${kb} kB)`);
}

console.log(`\n✅ ${SIZES.length} icônes dans apps/web/public/icons/`);
console.log('   Remplace par ton logo final si besoin (SVG → PNG via Figma/Inkscape).\n');
