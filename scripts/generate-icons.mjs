#!/usr/bin/env node
/**
 * scripts/generate-icons.mjs
 *
 * Génère toutes les icônes PWA depuis un SVG source.
 * Usage : pnpm icons
 * Prérequis : sharp installé (devDependency)
 *
 * Produit dans apps/web/public/icons/ :
 *   icon-72.png   icon-96.png   icon-128.png
 *   icon-144.png  icon-152.png  icon-192.png
 *   icon-384.png  icon-512.png
 *   badge-72.png  (notification badge)
 *   apple-touch-icon.png (180x180)
 *   favicon-32.png  favicon-16.png
 */

import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');
const OUT   = resolve(ROOT, 'apps/web/public/icons');

// ─── SVG source inline ────────────────────────────────────────
// Remplace ce SVG par ton logo Kinetic
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#7F77DD"/>
      <stop offset="100%" stop-color="#00C2A0"/>
    </linearGradient>
  </defs>
  <!-- Fond -->
  <rect width="512" height="512" rx="120" fill="url(#g)"/>
  <!-- Lettre K stylisée -->
  <text x="256" y="360" font-family="system-ui, -apple-system, sans-serif"
        font-size="300" font-weight="900" text-anchor="middle"
        fill="white" opacity="0.95">K</text>
  <!-- Éclair XP -->
  <path d="M290 120 L240 260 L280 260 L230 390 L310 230 L265 230 Z"
        fill="white" opacity="0.4"/>
</svg>`;

// ─── Badge SVG (notification) ─────────────────────────────────
const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <circle cx="48" cy="48" r="48" fill="#7F77DD"/>
  <text x="48" y="64" font-family="system-ui" font-size="56" font-weight="900"
        text-anchor="middle" fill="white">K</text>
</svg>`;

// ─── Tailles à générer ────────────────────────────────────────
const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('🎨 Generating PWA icons...\n');

  await mkdir(OUT, { recursive: true });

  const iconBuffer  = Buffer.from(ICON_SVG);
  const badgeBuffer = Buffer.from(BADGE_SVG);

  // Icônes principales
  for (const size of SIZES) {
    const outPath = resolve(OUT, `icon-${size}.png`);
    await sharp(iconBuffer)
      .resize(size, size)
      .png({ quality: 100, compressionLevel: 9 })
      .toFile(outPath);
    console.log(`  ✅ icon-${size}.png`);
  }

  // Apple Touch Icon (180x180, pas de maskable)
  await sharp(iconBuffer)
    .resize(180, 180)
    .png({ quality: 100 })
    .toFile(resolve(OUT, 'apple-touch-icon.png'));
  console.log('  ✅ apple-touch-icon.png');

  // Favicon 32x32
  await sharp(iconBuffer)
    .resize(32, 32)
    .png({ quality: 100 })
    .toFile(resolve(OUT, '../favicon-32.png'));
  console.log('  ✅ favicon-32.png');

  // Favicon 16x16
  await sharp(iconBuffer)
    .resize(16, 16)
    .png({ quality: 100 })
    .toFile(resolve(OUT, '../favicon-16.png'));
  console.log('  ✅ favicon-16.png');

  // Badge notification
  await sharp(badgeBuffer)
    .resize(72, 72)
    .png({ quality: 100 })
    .toFile(resolve(OUT, '../badge.png'));
  console.log('  ✅ badge.png');

  // Screenshot placeholder (dashboard)
  // En vrai : utiliser Playwright pour screenshot automatique
  console.log('\n  ℹ️  screenshots/ : générer avec "pnpm e2e:headed" + capture manuelle');

  // Manifest screenshot entry (à créer manuellement ou avec Playwright)
  console.log('\n✅ All icons generated in apps/web/public/icons/');
  console.log('   → Mets à jour /icons/icon-512.png avec ton logo final\n');
}

main().catch((err) => {
  console.error('❌ Icon generation failed:', err.message);
  process.exit(1);
});
