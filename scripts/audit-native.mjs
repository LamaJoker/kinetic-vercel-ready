#!/usr/bin/env node
/**
 * scripts/audit-native.mjs — audit des dépendances NATIVES livrées dans l'app mobile.
 *
 * `pnpm audit --prod` ne voit pas @capacitor/android ni @capacitor/ios : ils sont en
 * devDependencies alors qu'ils sont compilés dans l'APK / l'app iOS (audit qualité QA-07 :
 * @capacitor/android 8.3.4, GHSA-rvm3-566m-v7fv, critique, passé inaperçu).
 *
 * Ce script lance `pnpm audit --json` (toutes dépendances) et échoue (exit 1) si une alerte
 * de sévérité ≥ modérée touche un paquet embarqué dans l'app native : @capacitor/* (sauf
 * l'outil en ligne de commande @capacitor/cli), @capacitor-mlkit/*, @capgo/*, ou une de
 * leurs dépendances. L'outillage de développement (vitest, eslint, cli) n'est pas concerné.
 *
 * Utilisation : pnpm audit:native   (ou : node scripts/audit-native.mjs rapport.json)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEVERITIES = ['low', 'moderate', 'high', 'critical'];
const BUILD_TOOLS = new Set(['@capacitor/cli']);

/** Paquet embarqué dans l'app native (runtime Capacitor ou plugin). */
export function isNativeRuntimePackage(name) {
  if (BUILD_TOOLS.has(name)) return false;
  return (
    name.startsWith('@capacitor/') ||
    name.startsWith('@capacitor-mlkit/') ||
    name.startsWith('@capgo/')
  );
}

/** « apps/web > @capacitor/android@8.3.4 > x@1 » → ['@capacitor/android', 'x']. */
function packagesOfPath(path) {
  return path
    .split('>')
    .slice(1)
    .map((p) => p.trim())
    .map((p) => p.slice(0, p.lastIndexOf('@') > 0 ? p.lastIndexOf('@') : p.length));
}

/**
 * Alertes (≥ `minSeverity`) qui touchent l'app native, d'après un rapport
 * `pnpm audit --json`. Une alerte compte si le paquet vulnérable est natif, ou si un
 * chemin vers lui passe par un paquet natif (hors outil de build).
 */
export function nativeAdvisories(report, minSeverity = 'moderate') {
  const min = SEVERITIES.indexOf(minSeverity);
  const out = [];
  for (const adv of Object.values(report?.advisories ?? {})) {
    if (SEVERITIES.indexOf(adv.severity) < min) continue;
    const paths = (adv.findings ?? []).flatMap((f) => f.paths ?? []);
    const viaNative = paths.some((p) => {
      const chain = packagesOfPath(p);
      return chain.length > 0 && isNativeRuntimePackage(chain[0]);
    });
    if (isNativeRuntimePackage(adv.module_name) || viaNative) {
      out.push({
        module: adv.module_name,
        severity: adv.severity,
        id: adv.github_advisory_id ?? String(adv.id ?? ''),
        title: adv.title,
        vulnerable: adv.vulnerable_versions,
      });
    }
  }
  return out;
}

function main() {
  const file = process.argv[2];
  let raw;
  if (file) {
    raw = readFileSync(file, 'utf8');
  } else {
    try {
      raw = execFileSync('pnpm', ['audit', '--json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      // pnpm audit sort en erreur dès qu'il trouve une alerte : le rapport est sur stdout.
      raw = err.stdout;
      if (!raw) {
        console.error('[audit:native] pnpm audit a échoué :', err.message);
        process.exit(2);
      }
    }
  }
  const found = nativeAdvisories(JSON.parse(raw));
  if (found.length === 0) {
    console.log('[audit:native] aucune alerte connue sur les dépendances natives livrées.');
    return;
  }
  console.error(`[audit:native] ${found.length} alerte(s) sur des dépendances natives livrées :`);
  for (const a of found) {
    console.error(`  - ${a.severity} ${a.module} (${a.vulnerable}) ${a.id} : ${a.title}`);
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
