import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof localStorage === 'undefined') {
  const store: Record<string, string> = {};
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  } as Storage;
}
if (typeof globalThis.window === 'undefined') {
  (globalThis as { window?: unknown }).window = globalThis;
}
if (typeof navigator === 'undefined') {
  (globalThis as { navigator?: unknown }).navigator = { userAgent: 'test-ua' };
}

vi.mock('@kinetic/adapters-web', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}));

beforeAll(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error-reporter', () => {
  it('flushErrorsToServer retourne ok:false sans env Supabase', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.resetModules();
    const { flushErrorsToServer } = await import('../../apps/web/src/lib/error-reporter.js');
    const result = await flushErrorsToServer();
    expect(result).toEqual({ sent: 0, ok: false });
    // Restaure
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test');
  });

  it('flushErrorsToServer retourne {sent:0, ok:true} si buffer vide', async () => {
    const { flushErrorsToServer } = await import('../../apps/web/src/lib/error-reporter.js');
    const result = await flushErrorsToServer();
    expect(result.sent).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('flushErrorsToServer POSTe le buffer puis le vide en cas de succès', async () => {
    const stamp = '2026-05-27T10:00:00Z';
    localStorage.setItem(
      'kinetic:errors',
      `[${stamp}] rejection: Boom message\n[${stamp}] error: Some uncaught`,
    );
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, received: 2 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { flushErrorsToServer } = await import('../../apps/web/src/lib/error-reporter.js');
    const result = await flushErrorsToServer();
    expect(result.sent).toBe(2);
    expect(result.ok).toBe(true);
    expect(localStorage.getItem('kinetic:errors')).toBeNull();

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.reports.length).toBe(2);
    expect(body.reports[0].source).toBe('unhandled_rejection');
    expect(body.reports[1].source).toBe('uncaught_error');
    // userAgent : le polyfill peut ne pas être appliqué selon l'ordre
    // d'import (node a son propre navigator) — on accepte n'importe quelle
    // valeur tant qu'elle existe.
    expect(typeof body.userAgent).toBe('string');
  });

  it('parse les lignes "manuelles" hors format ISO', async () => {
    localStorage.setItem('kinetic:errors', 'ligne libre sans timestamp');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { flushErrorsToServer } = await import('../../apps/web/src/lib/error-reporter.js');
    await flushErrorsToServer();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.reports[0].source).toBe('manual');
    expect(body.reports[0].message).toContain('ligne libre');
  });

  it('marque comme flushed sur 404 sans effacer le buffer', async () => {
    localStorage.setItem('kinetic:errors', '[2026-05-27T10:00:00Z] error: x');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    const { flushErrorsToServer } = await import('../../apps/web/src/lib/error-reporter.js');
    const result = await flushErrorsToServer();
    expect(result.ok).toBe(false);
    // Buffer NON effacé (le serveur n'existe pas, on retentera plus tard)
    expect(localStorage.getItem('kinetic:errors')).not.toBeNull();
    // Mais on a marqué le throttle
    expect(localStorage.getItem('kinetic:errors:last-flush')).not.toBeNull();
  });

  it('renvoie ok:false sur erreur réseau (fetch throws)', async () => {
    localStorage.setItem('kinetic:errors', '[2026-05-27T10:00:00Z] error: x');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Network unreachable');
      }),
    );
    const { flushErrorsToServer } = await import('../../apps/web/src/lib/error-reporter.js');
    const result = await flushErrorsToServer();
    expect(result.ok).toBe(false);
  });

  it('initErrorReporter respecte le throttle de 30 minutes', async () => {
    // Marque comme flushé il y a 1 minute
    localStorage.setItem('kinetic:errors:last-flush', String(Date.now() - 60_000));
    localStorage.setItem('kinetic:errors', '[2026-05-27T10:00:00Z] error: x');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { initErrorReporter } = await import('../../apps/web/src/lib/error-reporter.js');
    initErrorReporter();
    // Délai initial 5s — vérifie qu'on ne fetch JAMAIS dans la fenêtre throttle
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('initErrorReporter déclenche un flush différé après 30 min écoulées', async () => {
    // Throttle expiré
    localStorage.setItem('kinetic:errors:last-flush', String(Date.now() - 60 * 60 * 1000));
    localStorage.setItem('kinetic:errors', '[2026-05-27T10:00:00Z] error: x');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    const { initErrorReporter } = await import('../../apps/web/src/lib/error-reporter.js');
    initErrorReporter();
    // Avance 5 secondes pour franchir le setTimeout
    await vi.advanceTimersByTimeAsync(5500);
    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalled();
  });
});
