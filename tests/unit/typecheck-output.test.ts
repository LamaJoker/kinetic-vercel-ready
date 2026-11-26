/**
 * QA-05 : `pnpm typecheck` (tsc --build) ne doit rien écrire dans apps/web/dist, la sortie
 * de Vite que `cap sync` copie dans les apps natives (sinon l'IPA/APK embarque le code
 * TypeScript compilé, ses déclarations et ses sourcemaps).
 */
import { describe, expect, it } from 'vitest';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import { compilerLeftovers } from '../../scripts/check-bundle-size.mjs';

const ROOT = resolve(__dirname, '../..');
const WEB_DIST = resolve(ROOT, 'apps/web/dist');

function parsed(configPath: string): ts.ParsedCommandLine {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  };
  const cfg = ts.getParsedCommandLineOfConfigFile(resolve(ROOT, configPath), {}, host);
  if (!cfg) throw new Error(`tsconfig illisible : ${configPath}`);
  return cfg;
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

describe('typecheck : aucune sortie dans le dossier livré', () => {
  it('apps/web : sorties de tsc dans le cache, déclarations seules, sans sourcemap', () => {
    const { options } = parsed('apps/web/tsconfig.json');
    const out = options.outDir!;
    expect(out).toBeTruthy();
    expect(inside(out, WEB_DIST)).toBe(false);
    expect(inside(out, resolve(ROOT, 'apps/web'))).toBe(false);
    expect(relative(ROOT, out).split(/[\\/]/).slice(0, 2)).toEqual(['node_modules', '.cache']);
    expect(options.emitDeclarationOnly).toBe(true);
    expect(options.sourceMap).toBe(false);
    expect(options.declarationMap).toBe(false);
    // tsbuildinfo à côté des sorties (jamais dans dist).
    const info = options.tsBuildInfoFile ? resolve(options.tsBuildInfoFile) : out;
    expect(inside(info, WEB_DIST)).toBe(false);
  });

  it('aucun projet référencé par tsc --build n écrit dans apps/web/dist', () => {
    const root = parsed('tsconfig.json');
    const refs = (root.projectReferences ?? []).map((r) =>
      r.path.endsWith('.json') ? r.path : resolve(r.path, 'tsconfig.json'),
    );
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const ref of refs) {
      const { options } = parsed(relative(ROOT, ref));
      const out = options.outDir ?? dirname(ref);
      expect(inside(out, WEB_DIST), `${relative(ROOT, ref)} → ${out}`).toBe(false);
    }
  });

  it('check-bundle-size refuse les sorties de tsc égarées dans dist', () => {
    expect(
      compilerLeftovers([
        'index.html',
        'static/assets/main-abc.js',
        'static/assets/style.css',
        'src/deps.js',
        'src/deps.d.ts',
        'static/assets/main-abc.js.map',
        'tsconfig.tsbuildinfo',
      ]),
    ).toEqual([
      'src/deps.js',
      'src/deps.d.ts',
      'static/assets/main-abc.js.map',
      'tsconfig.tsbuildinfo',
    ]);
    expect(compilerLeftovers(['index.html', 'static/assets/a.js', 'exercises.v1.json'])).toEqual(
      [],
    );
  });
});
