#!/usr/bin/env node
/**
 * Génère les icônes et écrans de démarrage Android et iOS à partir du logo Kinetic
 * (disque de fonte), en trois variantes choisies dans Profil › Apparence :
 *
 *  - Corail (par défaut) : disque corail sur fond bleu nuit ;
 *  - Nuit : disque sombre cerclé de corail, fond bleu nuit plus profond ;
 *  - Minimaliste : disque au trait sur fond clair.
 *
 * Sorties :
 *  - Android : mipmap-<densité>/ic_launcher[_<variante>][_round].png (repli),
 *    icônes adaptatives vectorielles (drawable/ic_launcher_foreground[_<variante>].xml,
 *    mipmap-anydpi-v26/ic_launcher[_<variante>][_round].xml, couleurs de fond dans
 *    values/ic_launcher_background.xml) et écrans de démarrage ;
 *  - iOS : Assets.xcassets/AppIcon.appiconset (principale) et AppIcon-Nuit /
 *    AppIcon-Minimal (icônes alternatives, déclarées par le réglage
 *    ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES du projet Xcode), écran de démarrage.
 *
 * Usage : node scripts/generate-native-assets.mjs
 * (PLAYWRIGHT_CHROMIUM=/chemin/vers/chromium pour imposer un navigateur)
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');
const RES = resolve(APP, 'android/app/src/main/res');
const IOS_ASSETS = resolve(APP, 'ios/App/App/Assets.xcassets');

/** Palette « Nuit profonde & corail » (src/lib/palette.ts). */
const NIGHT = '#0B0E1A';
const CORAL = '#FF7A66';

/**
 * Variantes d'icône. `suffix` : suffixe des ressources Android ; `ios` : nom du
 * jeu d'icônes iOS (null = icône principale). Garder les identifiants alignés sur
 * APP_ICONS (apps/web/src/lib/app-icon.ts) et les plugins natifs KineticIcon.
 */
const VARIANTS = [
  {
    id: 'corail',
    suffix: '',
    ios: 'AppIcon',
    bg: NIGHT,
    plate: { fill: CORAL },
    ring: { color: NIGHT, opacity: 0.25 },
    hub: NIGHT,
  },
  {
    id: 'nuit',
    suffix: '_nuit',
    ios: 'AppIcon-Nuit',
    bg: '#05070F',
    plate: { fill: '#1A2036' },
    ring: { color: CORAL, opacity: 0.9 },
    hub: CORAL,
  },
  {
    id: 'minimal',
    suffix: '_minimal',
    ios: 'AppIcon-Minimal',
    bg: '#F4F2EE',
    plate: { fill: 'none', stroke: NIGHT },
    ring: { color: NIGHT, opacity: 0.25 },
    hub: NIGHT,
  },
];
const DEFAULT = VARIANTS[0];

/** Disque centré dans un carré de 32 unités. */
const plate = (v) => {
  const disc = v.plate.stroke
    ? `<circle cx="16" cy="16" r="11.2" fill="none" stroke="${v.plate.stroke}" stroke-width="1.6"/>`
    : `<circle cx="16" cy="16" r="12" fill="${v.plate.fill}"/>`;
  return `${disc}
  <circle cx="16" cy="16" r="8.5" fill="none" stroke="${v.ring.color}" stroke-opacity="${v.ring.opacity}" stroke-width="1.5"/>
  <circle cx="16" cy="16" r="3.2" fill="${v.hub}"/>`;
};

const svg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">${inner}</svg>`;

/** Icône Android de repli (avant Android 8) : carré arrondi ou rond. */
const androidIcon = (v, round) =>
  svg(`<rect width="32" height="32" rx="${round ? 16 : 7}" fill="${v.bg}"/>${plate(v)}`);

/** iOS : icône carrée opaque (le système arrondit les coins). */
const iosIcon = (v) => svg(`<rect width="32" height="32" fill="${v.bg}"/>${plate(v)}`);

const splash = (w, h, d = Math.round(Math.min(w, h) * 0.3)) => {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%">
    <rect width="${w}" height="${h}" fill="${DEFAULT.bg}"/>
    <svg x="${(w - d) / 2}" y="${(h - d) / 2}" width="${d}" height="${d}" viewBox="0 0 32 32">${plate(DEFAULT)}</svg></svg>`;
};

/** Couleur Android #AARRGGBB. */
const argb = (hex, opacity = 1) =>
  `#${Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()}${hex.slice(1).toUpperCase()}`;

const circlePath = (r) => `M54,54m-${r},0a${r},${r} 0,1 1,${r * 2} 0a${r},${r} 0,1 1,-${r * 2} 0`;

/** Premier plan vectoriel de l'icône adaptative, tenu dans la zone sûre (66 dp). */
function adaptiveForeground(v) {
  const disc = v.plate.stroke
    ? `    <path
        android:pathData="${circlePath(25.2)}"
        android:strokeColor="${argb(v.plate.stroke)}"
        android:strokeWidth="3.6" />`
    : `    <path
        android:fillColor="${argb(v.plate.fill)}"
        android:pathData="${circlePath(27)}" />`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Généré par scripts/generate-native-assets.mjs (variante « ${v.id} »). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
${disc}
    <path
        android:pathData="${circlePath(19)}"
        android:strokeColor="${argb(v.ring.color, v.ring.opacity)}"
        android:strokeWidth="3.4" />
    <path
        android:fillColor="${argb(v.hub)}"
        android:pathData="${circlePath(7.2)}" />
</vector>
`;
}

const adaptiveIcon = (v) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background${v.suffix}"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground${v.suffix}"/>
    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>
</adaptive-icon>
`;

const backgroundColors = () => `<?xml version="1.0" encoding="utf-8"?>
<resources>
${VARIANTS.map((v) => `    <color name="ic_launcher_background${v.suffix}">${v.bg}</color>`).join('\n')}
</resources>
`;

const appIconSet = (file) =>
  `${JSON.stringify(
    {
      images: [{ filename: file, idiom: 'universal', platform: 'ios', size: '1024x1024' }],
      info: { author: 'xcode', version: 1 },
    },
    null,
    2,
  )}\n`;

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`  ${path.replace(`${APP}/`, '')}`);
}

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

// Fichiers texte (sans navigateur).
write(resolve(RES, 'values/ic_launcher_background.xml'), backgroundColors());
for (const v of VARIANTS) {
  write(resolve(RES, `drawable/ic_launcher_foreground${v.suffix}.xml`), adaptiveForeground(v));
  write(resolve(RES, `mipmap-anydpi-v26/ic_launcher${v.suffix}.xml`), adaptiveIcon(v));
  write(resolve(RES, `mipmap-anydpi-v26/ic_launcher${v.suffix}_round.xml`), adaptiveIcon(v));
  const file = v === DEFAULT ? 'AppIcon-512@2x.png' : `${v.ios}-1024.png`;
  write(resolve(IOS_ASSETS, `${v.ios}.appiconset/Contents.json`), appIconSet(file));
}

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage();

async function render(svgText, w, h, file, transparent = false, root = RES) {
  const path = resolve(root, file);
  mkdirSync(dirname(path), { recursive: true });
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(
    `<body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;line-height:0">${svgText}</body>`,
  );
  await page.screenshot({ path, omitBackground: transparent });
  console.log(`  ${file} (${w}×${h})`);
}

for (const v of VARIANTS) {
  for (const [density, size] of Object.entries(LAUNCHER)) {
    await render(
      androidIcon(v, false),
      size,
      size,
      `mipmap-${density}/ic_launcher${v.suffix}.png`,
      true,
    );
    await render(
      androidIcon(v, true),
      size,
      size,
      `mipmap-${density}/ic_launcher${v.suffix}_round.png`,
      true,
    );
  }
  const file = v === DEFAULT ? 'AppIcon-512@2x.png' : `${v.ios}-1024.png`;
  await render(iosIcon(v), 1024, 1024, `${v.ios}.appiconset/${file}`, false, IOS_ASSETS);
}
for (const [folder, [w, h]] of Object.entries(SPLASHES)) {
  await render(splash(w, h), w, h, `${folder}/splash.png`);
}
// iOS : écran de démarrage 2732×2732 recadré au centre par LaunchScreen.storyboard
// (3 copies attendues).
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
