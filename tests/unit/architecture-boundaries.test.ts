/**
 * QA-12 : les frontières de l'architecture hexagonale sont vérifiées par les outils,
 * pas seulement par convention :
 *  - le core compile sans la lib DOM (une API navigateur n'y compile pas) ;
 *  - ESLint refuse un import d'adaptateur, de l'app ou d'un SDK dans le core, et un
 *    import d'adaptateur dans une page (elles passent par getDeps()).
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';

const ROOT = resolve(__dirname, '../..');

function coreDiagnostics(source: string): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    resolve(ROOT, 'packages/core/tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  )!;
  const probe = resolve(ROOT, 'packages/core/src/__probe__.ts');
  const options = { ...parsed.options, noEmit: true, composite: false, declaration: false };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, lang, ...rest) =>
    resolve(file) === probe
      ? ts.createSourceFile(file, source, lang)
      : getSourceFile(file, lang, ...rest);
  const globals = resolve(ROOT, 'packages/core/src/platform-globals.d.ts');
  const program = ts.createProgram([probe, globals], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && resolve(d.file.fileName) === probe)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('core : pas de lib DOM', () => {
  it('la configuration du core n a pas le DOM', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      resolve(ROOT, 'packages/core/tsconfig.json'),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    )!;
    const libs = (parsed.options.lib ?? []).map((l) => l.toLowerCase());
    expect(libs.length).toBeGreaterThan(0);
    expect(libs.some((l) => l.includes('dom'))).toBe(false);
    expect(parsed.options.types).toEqual([]);
  });

  it('une API navigateur ne compile pas dans le core ; btoa/atob restent permis', () => {
    const errors = coreDiagnostics(
      [
        "export const a = localStorage.getItem('x');",
        'export const b = window.innerWidth;',
        "export const c = atob(btoa('ok'));",
      ].join('\n'),
    );
    expect(errors.some((e) => e.includes("'localStorage'"))).toBe(true);
    expect(errors.some((e) => e.includes("'window'"))).toBe(true);
    expect(errors.some((e) => e.includes('btoa') || e.includes('atob'))).toBe(false);
  }, 30_000);
});

describe('ESLint : imports interdits', () => {
  // Sans projet TS (règles d'import seulement) : rapide et indépendant du programme.
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: { languageOptions: { parserOptions: { project: false } } },
  });
  const restricted = async (filePath: string, code: string): Promise<string[]> => {
    const [res] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
    return res!.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
  };

  it('core → adaptateur, app, SDK : refusé', async () => {
    const file = 'packages/core/src/domain/probe.domain.ts';
    expect(
      await restricted(
        file,
        "import { UuidGenerator } from '@kinetic/adapters-web';\nexport { UuidGenerator };\n",
      ),
    ).toHaveLength(1);
    expect(
      await restricted(
        file,
        "import { getDeps } from '../../../../apps/web/src/deps';\nexport { getDeps };\n",
      ),
    ).toHaveLength(1);
    expect(
      await restricted(
        file,
        "import { Capacitor } from '@capacitor/core';\nexport { Capacitor };\n",
      ),
    ).toHaveLength(1);
    expect(
      await restricted(
        file,
        "import { STORAGE_KEYS } from '../constants/storage-keys';\nexport { STORAGE_KEYS };\n",
      ),
    ).toHaveLength(0);
  });

  it('page → adaptateur : refusé (getDeps) ; exceptions documentées acceptées', async () => {
    const code =
      "import { UuidGenerator } from '@kinetic/adapters-web';\nexport { UuidGenerator };\n";
    expect(await restricted('apps/web/src/pages/timers.page.ts', code)).toHaveLength(1);
    expect(await restricted('apps/web/src/pages/nouvelle.page.ts', code)).toHaveLength(1);
    expect(await restricted('apps/web/src/pages/auth-callback.page.ts', code)).toHaveLength(0);
  });
});
