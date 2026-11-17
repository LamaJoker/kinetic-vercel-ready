#!/usr/bin/env node
/**
 * Génère les icônes et écrans de démarrage Android et iOS à partir du logo Kinetic
 * (disque de fonte jaune, identique à public/favicon.svg).
 * L'icône adaptative (Android 8+) est vectorielle : res/drawable/ic_launcher_foreground.xml.
 *
 * Usage : node scripts/generate-native-assets.mjs
 * (PLAYWRIGHT_CHROMIUM=/chemin/vers/chromium pour imposer un navigateur)
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');
const RES = resolve(APP, 'android/app/src/main/res');
const IOS_ASSETS = resolve(APP, 'ios/App/App/Assets.xcassets');
const INK = '#16171A';
const GOLD = '#F2C230';

/** Disque centré dans un carré de 32 unités. */
const plate = `
  <circle cx="16" cy="16" r="12" fill="${GOLD}"/>
  <circle cx="16" cy="16" r="8.5" fill="none" stroke="${INK}" stroke-opacity=".25" stroke-width="1.5"/>
  <circle cx="16" cy="16" r="3.2" fill="${INK}"/>`;

const icon = (round) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
    <rect width="32" height="32" rx="${round ? 16 : 7}" fill="${INK}"/>${plate}</svg>`;

const splash = (w, h, d = Math.round(Math.min(w, h) * 0.3)) => {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%">
    <rect width="${w}" height="${h}" fill="${INK}"/>
    <svg x="${(w - d) / 2}" y="${(h - d) / 2}" width="${d}" height="${d}" viewBox="0 0 32 32">${plate}</svg></svg>`;
};

const LAUNCHER = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const SPLASHES = {
  drawable: [480, 800],
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
};

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage();

async function render(svg, w, h, file, transparent = false, root = RES) {
  const path = resolve(root, file);
  mkdirSync(dirname(path), { recursive: true });
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(
    `<body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;line-height:0">${svg}</body>`,
  );
  await page.screenshot({ path, omitBackground: transparent });
  console.log(`  ${file} (${w}×${h})`);
}

for (const [density, size] of Object.entries(LAUNCHER)) {
  await render(icon(false), size, size, `mipmap-${density}/ic_launcher.png`, true);
  await render(icon(true), size, size, `mipmap-${density}/ic_launcher_round.png`, true);
}
for (const [folder, [w, h]] of Object.entries(SPLASHES)) {
  await render(splash(w, h), w, h, `${folder}/splash.png`);
}
// iOS : icône carrée opaque (le système arrondit les coins), écran de démarrage
// 2732×2732 recadré au centre par LaunchScreen.storyboard (3 copies attendues).
const iosIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
    <rect width="32" height="32" fill="${INK}"/>${plate}</svg>`;
await render(iosIcon, 1024, 1024, 'AppIcon.appiconset/AppIcon-512@2x.png', false, IOS_ASSETS);
for (const suffix of ['', '-1', '-2']) {
  await render(
    splash(2732, 2732, 420),
    2732,
    2732,
    `Splash.imageset/splash-2732x2732${suffix}.png`,
    false,
    IOS_ASSETS,
  );
}
await browser.close();
