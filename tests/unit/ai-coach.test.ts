/**
 * Tests pour la lib ai-coach (client de l'Edge Function).
 *
 * Stratégie : on stub `import.meta.env` au top-level + on évite
 * `vi.resetModules()` qui peut interférer avec les stubs en environnement
 * node (vi.resetModules vide aussi le cache import.meta).
 *
 * Pour les tests qui nécessitent une env DIFFÉRENTE (Supabase absent),
 * on ré-import via une fonction utilitaire qui force un reload.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

// ─── Polyfills minimaux pour env node-only ────────────────────────────────
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
  const listeners = new Map<string, Set<EventListener>>();
  const w = {
    addEventListener(name: string, cb: EventListener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(cb);
    },
    removeEventListener(name: string, cb: EventListener) {
      listeners.get(name)?.delete(cb);
    },
    dispatchEvent(ev: Event) {
      listeners.get(ev.type)?.forEach((cb) => cb(ev));
      return true;
    },
  };
  (globalThis as { window?: unknown }).window = w;
}
if (typeof navigator === 'undefined') {
  (globalThis as { navigator?: unknown }).navigator = { userAgent: 'test' };
}

vi.mock('@kinetic/adapters-web', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'user-token-123' } },
      })),
    },
  },
}));

beforeAll(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ai-coach (env configurée)', () => {
  it('isAiCoachAvailable retourne true', async () => {
    const { isAiCoachAvailable } = await import('../../apps/web/src/lib/ai-coach.js');
    expect(isAiCoachAvailable()).toBe(true);
  });

  it('askCoach POSTe à /functions/v1/ai-coach avec le JWT user', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ answer: 'Voici mon analyse...' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { askCoach } = await import('../../apps/web/src/lib/ai-coach.js');
    const result = await askCoach({
      question: 'Comment progresser au bench ?',
      recentSessions: [
        {
          id: 's1',
          name: 'Push A',
          startedAt: '2026-05-20T18:00:00Z',
          entries: [
            {
              exerciseId: 'bench',
              sets: [
                {
                  setIndex: 0,
                  reps: 8,
                  weightKg: 80,
                  rpe: 8,
                  performedAt: '2026-05-20T18:05:00Z',
                },
              ],
            },
          ],
          avgRpe: 8,
          durationMin: 45,
        },
      ],
    });

    expect(result.answer).toBe('Voici mon analyse...');
    expect(fetchMock).toHaveBeenCalled();
    const callArgs = fetchMock.mock.calls[0]!;
    const url = callArgs[0] as string;
    const init = callArgs[1] as RequestInit & { headers: Record<string, string> };
    expect(url).toBe('https://test.supabase.co/functions/v1/ai-coach');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toContain('Bearer ');
  });

  it('askCoach throw avec statut HTTP non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    const { askCoach } = await import('../../apps/web/src/lib/ai-coach.js');
    await expect(askCoach({ question: 'x', recentSessions: [] })).rejects.toThrow(
      /Coach IA indisponible \(HTTP 429\)/,
    );
  });

  it("askCoach throw quand la réponse contient un champ 'error'", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'quota_exceeded' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { askCoach } = await import('../../apps/web/src/lib/ai-coach.js');
    await expect(askCoach({ question: 'x', recentSessions: [] })).rejects.toThrow(/quota_exceeded/);
  });

  it('askCoach tronque à 50 sessions récentes', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ answer: 'ok' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sessions = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      name: `Workout ${i}`,
      startedAt: '2026-01-01T00:00:00Z',
      entries: [],
    }));
    const { askCoach } = await import('../../apps/web/src/lib/ai-coach.js');
    await askCoach({ question: 'x', recentSessions: sessions });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.context.sessions.length).toBe(50);
  });

  it('dispatchCoachError dispatch un CustomEvent kinetic:notify', async () => {
    const handler = vi.fn();
    window.addEventListener('kinetic:notify', handler);
    const { dispatchCoachError } = await import('../../apps/web/src/lib/ai-coach.js');
    dispatchCoachError('Boom');
    expect(handler).toHaveBeenCalled();
    const ev = handler.mock.calls[0]![0] as CustomEvent;
    expect(ev.detail).toMatchObject({ kind: 'error', message: 'Boom' });
    window.removeEventListener('kinetic:notify', handler);
  });
});
