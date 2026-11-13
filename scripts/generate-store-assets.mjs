#!/usr/bin/env node
/**
 * Visuels de la fiche Google Play, dans docs/play-store/ : icône 512, bannière
 * 1024×500 et captures 1080×1920 prises sur l'application avec les données de démo.
 *
 * Prérequis : `pnpm build && pnpm --filter @kinetic/web preview:ci` (port 3000).
 * Usage : node scripts/generate-store-assets.mjs
 */
/* global window, document */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/play-store');
const BASE = process.env.KINETIC_URL ?? 'http://localhost:3000';
const INK = '#16171A';
const GOLD = '#F2C230';
const SHOTS = [
  ['/', 'accueil'],
  ['/seances', 'seances'],
  ['/progression', 'progression'],
  ['/records', 'records'],
  ['/vitalite', 'routine'],
  ['/nutrition', 'nutrition'],
];

const plate = `
  <circle cx="16" cy="16" r="12" fill="${GOLD}"/>
  <circle cx="16" cy="16" r="8.5" fill="none" stroke="${INK}" stroke-opacity=".25" stroke-width="1.5"/>
  <circle cx="16" cy="16" r="3.2" fill="${INK}"/>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);

const art = await browser.newPage();
await art.setViewportSize({ width: 512, height: 512 });
await art.setContent(
  `<body style="margin:0;line-height:0"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="512" height="512"><rect width="32" height="32" fill="${INK}"/>${plate}</svg></body>`,
);
await art.screenshot({ path: resolve(OUT, 'icon-512.png') });

await art.setViewportSize({ width: 1024, height: 500 });
await art.setContent(`<body style="margin:0;width:1024px;height:500px;background:${INK};display:flex;align-items:center;gap:56px;padding:0 88px;box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="2 2 28 28" width="240" height="240" style="flex:none">${plate}</svg>
  <div>
    <div style="font-size:92px;font-weight:700;letter-spacing:-3px;line-height:1">Kinetic</div>
    <div style="font-size:34px;line-height:1.3;color:#AEAEB2;margin-top:22px">Ton carnet de musculation,<br>hors ligne et sans publicité.</div>
  </div></body>`);
await art.screenshot({ path: resolve(OUT, 'feature-graphic.png') });
await art.close();

const context = await browser.newContext({
  viewport: { width: 360, height: 640 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  locale: 'fr-FR',
  serviceWorkers: 'block',
});
const page = await context.newPage();

async function open(path, skipOnboarding = true) {
  if (skipOnboarding) {
    await page.addInitScript(() => {
      window.__kineticSkipOnboarding = true;
    });
  }
  await page.goto(BASE + path);
  await page.waitForFunction(() => typeof window.Alpine !== 'undefined');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:auth-ready')));
  await page.waitForFunction(
    () => (document.getElementById('app-outlet')?.childElementCount ?? 0) > 0,
  );
  await page.waitForTimeout(1200);
}

await open('/onboarding', false);
await page.getByRole('button', { name: 'Voir la démo' }).click();
await page.waitForURL(BASE + '/');
await page.waitForTimeout(1500);

let index = 1;
for (const [path, name] of SHOTS) {
  await open(path);
  await page.screenshot({ path: resolve(OUT, `screenshot-${index}-${name}.png`) });
  console.log(`  screenshot-${index}-${name}.png`);
  index++;
}
await browser.close();
