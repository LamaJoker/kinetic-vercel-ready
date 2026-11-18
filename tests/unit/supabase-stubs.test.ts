import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { RealtimeClient } from '../../apps/web/src/lib/supabase-stubs/realtime';
import { StorageClient, StorageApiError } from '../../apps/web/src/lib/supabase-stubs/storage';
import * as functionsStub from '../../apps/web/src/lib/supabase-stubs/functions';
import * as storageStub from '../../apps/web/src/lib/supabase-stubs/storage';
import * as realtimeStub from '../../apps/web/src/lib/supabase-stubs/realtime';
import { SUPABASE_UNUSED_STUBS } from '../../apps/web/vite.config';

const require = createRequire(join(process.cwd(), 'apps/web/package.json'));

function supabaseJsSource(): string {
  const pkgDir = dirname(require.resolve('@supabase/supabase-js/package.json'));
  return readFileSync(join(pkgDir, 'dist/index.mjs'), 'utf8');
}

/** Noms importés par supabase-js depuis un sous-module donné. */
function importedNames(source: string, mod: string): string[] {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']@supabase/${mod}["']`);
  const match = source.match(re);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((s) =>
      s
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim(),
    )
    .filter(Boolean);
}

describe('supabase-stubs : alias de build', () => {
  it('pointe vers des fichiers existants', () => {
    expect(Object.keys(SUPABASE_UNUSED_STUBS).sort()).toEqual([
      '@supabase/functions-js',
      '@supabase/realtime-js',
      '@supabase/storage-js',
    ]);
    for (const file of Object.values(SUPABASE_UNUSED_STUBS)) expect(existsSync(file)).toBe(true);
  });
});

describe('supabase-stubs : contrat avec supabase-js', () => {
  const source = supabaseJsSource();

  it.each([
    ['functions-js', functionsStub],
    ['storage-js', storageStub],
    ['realtime-js', realtimeStub],
  ] as const)('exporte tout ce que supabase-js importe de %s', (mod, stub) => {
    const names = importedNames(source, mod);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(stub, name).toHaveProperty(name);
  });

  it('couvre toutes les méthodes appelées sur this.realtime', () => {
    const called = new Set([...source.matchAll(/this\.realtime\.(\w+)\(/g)].map((m) => m[1]!));
    expect(called.size).toBeGreaterThan(0);
    const proto = RealtimeClient.prototype as unknown as Record<string, unknown>;
    for (const method of called) expect(typeof proto[method], method).toBe('function');
  });
});

describe('supabase-stubs : comportement', () => {
  it('Realtime : setAuth est sans effet, channel lève une erreur explicite', async () => {
    const rt = new RealtimeClient();
    await expect(rt.setAuth('jwt')).resolves.toBeUndefined();
    await expect(rt.setAuth()).resolves.toBeUndefined();
    expect(rt.getChannels()).toEqual([]);
    await expect(rt.removeChannel()).resolves.toBe('ok');
    await expect(rt.removeAllChannels()).resolves.toEqual([]);
    expect(() => rt.channel('x')).toThrow(/Realtime n'est pas inclus/);
  });

  it('Storage et Functions lèvent une erreur explicite', () => {
    expect(() => new StorageClient().from('photos')).toThrow(/Storage n'est pas inclus/);
    expect(() => new functionsStub.FunctionsClient().invoke('f')).toThrow(/Functions/);
    expect(new StorageApiError('x')).toBeInstanceOf(Error);
    expect(new functionsStub.FunctionsHttpError('x')).toBeInstanceOf(functionsStub.FunctionsError);
  });
});

describe('supabase-stubs : client réel', () => {
  function makeClient(fetchImpl: typeof fetch) {
    return createClient('https://demo.supabase.co', 'anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetchImpl },
    });
  }

  it('se construit avec les coquilles vides', () => {
    const client = makeClient(vi.fn() as unknown as typeof fetch);
    expect(client.realtime).toBeInstanceOf(RealtimeClient);
    expect(client.storage).toBeInstanceOf(StorageClient);
    expect(() => client.channel('x')).toThrow(/Realtime/);
  });

  it('rpc (synchronisation) passe toujours par PostgREST', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ ok: true }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const { data, error } = await client.rpc('sync_pull', { since: null } as never);
    expect(error).toBeNull();
    expect(data).toEqual([{ ok: true }]);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toBe('https://demo.supabase.co/rest/v1/rpc/sync_pull');
  });

  it('la déconnexion (qui notifie Realtime) ne lève pas', async () => {
    const client = makeClient(vi.fn() as unknown as typeof fetch);
    const events: string[] = [];
    client.auth.onAuthStateChange((event) => {
      events.push(event);
    });
    const { error } = await client.auth.signOut({ scope: 'local' });
    expect(error).toBeNull();
    await vi.waitFor(() => expect(events).toContain('SIGNED_OUT'));
  });
});
