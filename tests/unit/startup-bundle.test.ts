/**
 * Marge du JS de démarrage (budget scripts/check-bundle-size.mjs) : deux causes
 * d'embonpoint corrigées, gardées par ces tests.
 *
 * 1. Les règles de fusion de la synchro (domain-merge, merge-strategies) n'étaient
 *    plus utilisées au démarrage, mais un appel au niveau du module (registre construit
 *    à l'import) faisait croire à Rollup qu'elles avaient des effets de bord : ~6 KiB
 *    gzip embarqués partout. Elles sont maintenant annotées @__PURE__ et chargées avec
 *    lib/sync-merge.ts (premier conflit), cf. LAZY_CORE_MODULES.
 * 2. `await import('@kinetic/adapters-web')` (point d'entrée du paquet) gardait TOUS
 *    ses exports (anciens stockages Hybrid/Supabase/Idb, idb-keyval) dans le lot de
 *    démarrage : ~3 KiB gzip.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, type Rollup } from 'vite';
import { LAZY_CORE_MODULES } from '../../apps/web/vite.config';

const ROOT = resolve(__dirname, '../..');

/** Code restant quand le module est seulement importé (`import 'x'`) : ses effets de bord. */
async function sideEffectsOf(file: string): Promise<string> {
  const entry = '\0entry';
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'entry',
        resolveId: (id) => (id === entry ? id : null),
        load: (id) => (id === entry ? `import ${JSON.stringify(file)};` : null),
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: entry, output: { format: 'es' } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(out) ? out : [out];
  return outputs
    .flatMap((o) => o.output)
    .filter((c): c is Rollup.OutputChunk => c.type === 'chunk')
    .map((c) => c.code)
    .join('')
    .trim();
}

describe('lot de démarrage', () => {
  it('règles de fusion de la synchro : sans effet de bord, donc hors démarrage', async () => {
    expect(LAZY_CORE_MODULES).toContain('sync/domain-merge');
    expect(LAZY_CORE_MODULES).toContain('sync/merge-strategies');
    for (const m of ['sync/domain-merge', 'sync/merge-strategies']) {
      const code = await sideEffectsOf(join(ROOT, `packages/core/src/${m}.ts`));
      expect(code, m).toBe('');
    }
  }, 30_000);

  it("aucun import() du point d'entrée d'un paquet interne dans l'app", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(ROOT, 'apps/web/src'));
    const offenders = files.filter((f) =>
      /import\(\s*['"]@kinetic\/(adapters-web|core)['"]\s*\)/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
