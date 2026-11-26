/**
 * scripts/audit-native.mjs (audit qualité QA-07) : une alerte sur une dépendance native
 * livrée (même en devDependencies) fait échouer le contrôle ; l'outillage non.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error -- module JavaScript (script Node) sans déclaration de types
import { nativeAdvisories, isNativeRuntimePackage } from '../../scripts/audit-native.mjs';

const adv = (module_name: string, severity: string, paths: string[]) => ({
  module_name,
  severity,
  github_advisory_id: `GHSA-${module_name}`,
  title: 't',
  vulnerable_versions: '*',
  findings: [{ version: '1', paths }],
});

describe('audit des dépendances natives', () => {
  it('signale @capacitor/android (devDependency) et une dépendance d un plugin natif', () => {
    const report = {
      advisories: {
        1: adv('@capacitor/android', 'critical', ['apps/web > @capacitor/android@8.3.4']),
        2: adv('leftpad', 'high', ['apps/web > @capgo/capacitor-health@8.13.0 > leftpad@1.0.0']),
        3: adv('tar', 'critical', ['apps/web > @capacitor/cli@8.6.2 > tar@7.5.15']),
        4: adv('vitest', 'critical', ['. > vitest@2.1.9']),
        5: adv('@capacitor/ios', 'low', ['apps/web > @capacitor/ios@8.6.2']),
      },
    };
    const found = nativeAdvisories(report) as Array<{ module: string }>;
    expect(found.map((f) => f.module)).toEqual(['@capacitor/android', 'leftpad']);
  });

  it('paquets natifs livrés : runtime et plugins, pas l outil en ligne de commande', () => {
    expect(isNativeRuntimePackage('@capacitor/android')).toBe(true);
    expect(isNativeRuntimePackage('@capacitor-mlkit/barcode-scanning')).toBe(true);
    expect(isNativeRuntimePackage('@capacitor/cli')).toBe(false);
    expect(isNativeRuntimePackage('vite')).toBe(false);
  });

  it('Capacitor aligné sur une version corrigée (≥ 8.3.5) pour android, ios, core et cli', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../apps/web/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const versions = [
      '@capacitor/android',
      '@capacitor/ios',
      '@capacitor/core',
      '@capacitor/cli',
    ].map((n) => all[n]!.replace(/^[\^~]/, ''));
    expect(new Set(versions).size).toBe(1);
    const [maj, min, patch] = versions[0]!.split('.').map(Number) as [number, number, number];
    expect(maj).toBe(8);
    expect(min > 3 || (min === 3 && patch >= 5)).toBe(true);
  });
});
