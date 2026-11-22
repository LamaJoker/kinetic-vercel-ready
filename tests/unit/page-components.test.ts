import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PAGE_COMPONENTS,
  loadPageComponents,
  _resetPageComponentsForTesting,
} from '../../apps/web/src/page-components';
import { LAZY_COMPONENTS } from '../../apps/web/src/lib/lazy-component';

// Les modules de pages importent Alpine (MutationObserver absent sous Node).
vi.mock('alpinejs', () => ({ default: { store: () => undefined, data: () => undefined } }));

const WEB = resolve(__dirname, '../../apps/web');
const mainSource = readFileSync(resolve(WEB, 'src/main.ts'), 'utf8');
const routerSource = readFileSync(resolve(WEB, 'src/router.ts'), 'utf8');
const indexHtml = readFileSync(resolve(WEB, 'index.html'), 'utf8');

/** Noms de composants Alpine (x-data="nom") d'un gabarit. */
function xDataNames(html: string): string[] {
  return [...html.matchAll(/x-data="([A-Za-z_$][\w$]*)"/g)].map((m) => m[1]!);
}

/** Composants enregistrés au démarrage par main.ts. */
const eager = new Set([...mainSource.matchAll(/Alpine\.data\(\s*'([^']+)'/g)].map((m) => m[1]!));

/**
 * Composants imbriqués chargés à la demande (lib/lazy-component.ts) : seulement
 * admis dans un `<template x-if>` (inséré après leur enregistrement), jamais
 * directement dans la page.
 */
function lazyGuarded(html: string, name: string): boolean {
  const re = new RegExp(`<template\\s+x-if="[^"]+">\\s*<[a-z]+[^>]*?\\sx-data="${name}"`, 'g');
  const all = html.split(`x-data="${name}"`).length - 1;
  return all > 0 && (html.match(re) ?? []).length === all;
}

describe('page-components : chargement des pages à la demande', () => {
  beforeEach(() => _resetPageComponentsForTesting());

  it("main.ts n'importe plus aucune page", () => {
    expect(mainSource).not.toMatch(/from '\.\/pages\//);
    expect(mainSource).not.toMatch(/from '\.\/components\/help-tip'/);
  });

  it('chaque clé correspond à un gabarit routé', () => {
    const routed = new Set(
      [...routerSource.matchAll(/:\s*'(\.\/pages\/[\w-]+\.html)'/g)].map((m) => m[1]),
    );
    for (const file of Object.keys(PAGE_COMPONENTS)) expect(routed.has(file), file).toBe(true);
  });

  it('le shell (index.html) ne dépend que de composants enregistrés au démarrage', () => {
    for (const name of xDataNames(indexHtml)) expect(eager.has(name), name).toBe(true);
  });

  it.each(readdirSync(resolve(WEB, 'src/pages')).filter((f) => f.endsWith('.html')))(
    '%s : tous ses composants sont enregistrés avant affichage',
    async (name) => {
      const file = `./pages/${name}`;
      const html = readFileSync(resolve(WEB, 'src/pages', name), 'utf8');
      const registered = new Set<string>();
      await loadPageComponents(file, (n, factory) => {
        expect(typeof factory).toBe('function');
        registered.add(n);
      });
      for (const n of xDataNames(html)) {
        if (n in LAZY_COMPONENTS) {
          expect(lazyGuarded(html, n), `${name} → ${n} hors <template x-if>`).toBe(true);
          continue;
        }
        expect(eager.has(n) || registered.has(n), `${name} → ${n}`).toBe(true);
      }
    },
    20_000,
  );

  it('charge une seule fois, et recommence après un échec', async () => {
    const factory = () => ({});
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('hors-ligne'))
      .mockResolvedValue({ demo: factory });
    const loaders = { './pages/demo.html': load };
    const register = vi.fn();

    await expect(loadPageComponents('./pages/demo.html', register, loaders)).rejects.toThrow(
      'hors-ligne',
    );
    expect(register).not.toHaveBeenCalled();

    await loadPageComponents('./pages/demo.html', register, loaders);
    await loadPageComponents('./pages/demo.html', register, loaders);
    expect(load).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('demo', factory);
  });

  it('page sans composant propre : rien à charger', async () => {
    const register = vi.fn();
    await loadPageComponents('./pages/login.html', register);
    expect(register).not.toHaveBeenCalled();
  });
});

describe('lazy-component : composants imbriqués à la demande', () => {
  it.each(Object.keys(LAZY_COMPONENTS))('%s : le module fournit une fabrique', async (name) => {
    const factory = await LAZY_COMPONENTS[name]!();
    expect(typeof factory).toBe('function');
  });

  it('main.ts ne les importe pas (pas de poids au démarrage)', () => {
    expect(mainSource).not.toMatch(/lazy-component|training-calendar|muscle-map/);
  });
});
