import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import GoTrueAdminApi from '../../apps/web/src/lib/supabase-stubs/auth-admin';
import * as webauthnStub from '../../apps/web/src/lib/supabase-stubs/auth-webauthn';
import * as web3Stub from '../../apps/web/src/lib/supabase-stubs/auth-web3';
import { SUPABASE_AUTH_UNUSED_STUBS } from '../../apps/web/vite.config';

const require = createRequire(join(process.cwd(), 'apps/web/package.json'));
const authDir = join(dirname(require.resolve('@supabase/auth-js/package.json')), 'dist/module');
const goTrueSource = readFileSync(join(authDir, 'GoTrueClient.js'), 'utf8');

function namedImports(mod: string): string[] {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${mod.replace(/[./]/g, '\\$&')}'`);
  const match = goTrueSource.match(re);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('supabase-stubs (auth-js) : contrat avec GoTrueClient', () => {
  it('remplace exactement les imports relatifs prévus, vers des fichiers existants', () => {
    expect(Object.keys(SUPABASE_AUTH_UNUSED_STUBS).sort()).toEqual([
      './GoTrueAdminApi',
      './lib/web3/ethereum',
      './lib/webauthn',
    ]);
    for (const [spec, file] of Object.entries(SUPABASE_AUTH_UNUSED_STUBS)) {
      expect(goTrueSource, spec).toContain(`from '${spec}'`);
      expect(existsSync(file)).toBe(true);
    }
  });

  it.each([
    ['./lib/webauthn', webauthnStub],
    ['./lib/web3/ethereum', web3Stub],
  ] as const)('exporte tout ce que GoTrueClient importe de %s', (mod, stub) => {
    const names = namedImports(mod);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(stub, name).toHaveProperty(name);
  });

  it("WebAuthnApi expose les méthodes de l'original", () => {
    const real = readFileSync(join(authDir, 'lib/webauthn.js'), 'utf8');
    const bound = [...real.matchAll(/this\.(\w+) = this\._\w+\.bind\(this\)/g)].map((m) => m[1]!);
    expect(bound.length).toBeGreaterThan(0);
    const api = new webauthnStub.WebAuthnApi({});
    for (const m of bound)
      expect(typeof (api as unknown as Record<string, unknown>)[m], m).toBe('function');
  });
});

describe('supabase-stubs (auth-js) : comportement', () => {
  it('se construisent sans effet et lèvent une erreur explicite à l’usage', () => {
    const admin = new GoTrueAdminApi({ url: 'x' }) as unknown as Record<string, () => unknown>;
    expect(() => admin['deleteUser']!()).toThrow(/Auth admin n'est pas inclus/);
    expect(webauthnStub.browserSupportsWebAuthn()).toBe(false);
    expect(() => new webauthnStub.WebAuthnApi({}).register()).toThrow(/WebAuthn/);
    expect(() => webauthnStub.webAuthnAbortService.createNewAbortSignal()).toThrow(/WebAuthn/);
    expect(() => web3Stub.getAddress('0x0')).toThrow(/Web3/);
  });
});
