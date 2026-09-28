import { describe, it, expect, vi } from 'vitest';
import { deleteAccount } from '../../apps/web/src/lib/account.js';

const client = (token: string | null) => ({
  auth: {
    getSession: vi.fn(async () => ({ data: { session: token ? { access_token: token } : null } })),
  },
});

describe('deleteAccount', () => {
  it('appelle la fonction avec le JWT et la confirmation', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"deleted":true}', { status: 200 }));
    await deleteAccount({
      supabaseUrl: 'https://x.supabase.co/',
      anonKey: 'anon',
      client: client('jwt'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.supabase.co/functions/v1/delete-account');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt');
    expect(JSON.parse(String(init.body))).toEqual({ confirm: 'SUPPRIMER' });
  });

  it('refuse sans session et ne contacte pas le serveur', async () => {
    const fetchImpl = vi.fn();
    await expect(
      deleteAccount({ supabaseUrl: 'https://x', anonKey: 'a', client: client(null), fetchImpl }),
    ).rejects.toThrow(/reconnecte/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('signale un échec serveur sans prétendre avoir supprimé', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
    await expect(
      deleteAccount({
        supabaseUrl: 'https://x',
        anonKey: 'a',
        client: client('jwt'),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/intactes/);
  });
});
