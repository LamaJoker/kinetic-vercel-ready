import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — script Node en .mjs sans déclarations de types
import { initialJsFiles, BUDGETS } from '../../scripts/check-bundle-size.mjs';
import { LAZY_CORE_MODULES, LAZY_TRAINING_MODULES } from '../../apps/web/vite.config';

describe('check-bundle-size : JS du chargement initial', () => {
  it("lit le script d'entrée et les modulepreload de index.html", () => {
    const html = `<!doctype html><head>
      <script type="module" crossorigin src="/static/main-abc.js"></script>
      <link rel="modulepreload" crossorigin href="/static/chunks/alpine-1.js">
      <link rel="modulepreload" crossorigin href="/static/chunks/alpine-1.js">
      <link rel="stylesheet" crossorigin href="/static/assets/main.css">
      <link rel="preload" as="font" href="/static/assets/inter.woff2">
      <script src="https://cdn.example.com/x.js" type="module"></script>
      <script>window.x = 1</script></head>`;
    expect((initialJsFiles(html) as string[]).sort()).toEqual([
      'static/chunks/alpine-1.js',
      'static/main-abc.js',
    ]);
  });

  it('budget initial plus serré que le plafond total', () => {
    const b = BUDGETS as Record<string, number>;
    expect(b['initialJsGzip']).toBeLessThan(b['totalJsGzip']!);
  });
});

describe('vite.config : modules sortis du démarrage', () => {
  it('chaque module listé existe', () => {
    for (const m of LAZY_CORE_MODULES) {
      expect(existsSync(resolve(__dirname, `../../packages/core/src/${m}.ts`)), m).toBe(true);
    }
    for (const m of LAZY_TRAINING_MODULES) {
      expect(existsSync(resolve(__dirname, `../../apps/web/src/lib/${m}.ts`)), m).toBe(true);
    }
  });

  it("n'ont pas d'appel au niveau du module non annoté @__PURE__ (sinon importés partout)", () => {
    for (const m of LAZY_CORE_MODULES) {
      const src = readFileSync(resolve(__dirname, `../../packages/core/src/${m}.ts`), 'utf8');
      // Propriété d'un objet de premier niveau initialisée par un appel : `  clé: fn(),`
      const calls = [...src.matchAll(/^ {2}\w+: (\/\* @__PURE__ \*\/ )?[A-Za-z_$][\w$]*\(/gm)];
      for (const c of calls) expect(c[1], `${m} : ${c[0]}`).toBeDefined();
    }
  });
});
