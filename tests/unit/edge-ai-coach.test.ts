/**
 * Fonction Edge ai-coach : scénarios de sécurité exécutés sur le vrai handler
 * (Request/Response standards), Supabase et Anthropic remplacés par des faux.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createAiCoachHandler,
  loadAiCoachConfig,
  validateCoachBody,
  MAX_BODY_BYTES,
} from '../../supabase/functions/ai-coach/handler.ts';
import { envFromRecord } from '../../supabase/functions/_shared/env.ts';
import {
  BASE_ENV,
  ORIGIN,
  USER_ID,
  allowQuota,
  fakeAuth,
  fakeRpc,
  hugeStreamRequest,
  jsonRequest,
  memLogger,
} from '../helpers/edge.ts';

const URL_FN = 'https://x.supabase.co/functions/v1/ai-coach';
const ENV = { ...BASE_ENV, ANTHROPIC_API_KEY: 'sk-ant-api03-cle-de-test-tres-secrete' };
const BODY = { question: 'Pourquoi je stagne au bench ?', context: { sessions: [{ e1rm: 100 }] } };

function anthropicOk(text = 'Augmente le volume.', stop = 'end_turn') {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stop }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function setup(
  opts: {
    env?: Record<string, string | undefined>;
    pro?: boolean | 'error';
    quota?: unknown;
    fetch?: ReturnType<typeof vi.fn>;
    timeoutMs?: number;
  } = {},
) {
  const admin = fakeRpc({
    is_pro: () =>
      opts.pro === 'error'
        ? { data: null, error: { code: 'XX000', message: 'boom' } }
        : { data: opts.pro ?? true, error: null },
    consume_ai_quota:
      opts.quota === undefined ? allowQuota : () => ({ data: opts.quota, error: null }),
  });
  const auth = fakeAuth();
  const fetchImpl = opts.fetch ?? anthropicOk();
  const logger = memLogger();
  const handler = createAiCoachHandler({
    config: {
      ...loadAiCoachConfig(envFromRecord(opts.env ?? ENV)),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    },
    auth,
    admin,
    fetch: fetchImpl as unknown as typeof fetch,
    logger,
  });
  return { handler, admin, auth, fetchImpl, logger };
}

describe('ai-coach : authentification', () => {
  it('sans jeton → 401 et ni Supabase ni Anthropic ne sont appelés', async () => {
    const { handler, admin, fetchImpl } = setup();
    const res = await handler(jsonRequest(URL_FN, BODY, { jwt: null }));
    expect(res.status).toBe(401);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('jeton refusé par Supabase Auth → 401', async () => {
    const { handler, auth, fetchImpl } = setup();
    const res = await handler(
      jsonRequest(URL_FN, BODY, { jwt: 'eyJfaux.eyJfaux.signature-fausse' }),
    );
    expect(res.status).toBe(401);
    expect(auth.getUser).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('service Auth indisponible → 503 (échec fermé)', async () => {
    const { handler, auth, fetchImpl } = setup();
    auth.getUser.mockRejectedValueOnce(new Error('réseau'));
    const res = await handler(jsonRequest(URL_FN, BODY));
    expect(res.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ai-coach : droit Pro vérifié côté serveur', () => {
  it('REQUIRE_PRO vrai par défaut : non-Pro → 403 pro_required', async () => {
    const { handler, fetchImpl, admin } = setup({ pro: false });
    const res = await handler(jsonRequest(URL_FN, BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('pro_required');
    expect(admin.calls[0]).toEqual({ fn: 'is_pro', args: { p_user: USER_ID } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('valeur inconnue de AI_COACH_REQUIRE_PRO → reste exigé', async () => {
    const { handler } = setup({ pro: false, env: { ...ENV, AI_COACH_REQUIRE_PRO: 'peut-etre' } });
    expect((await handler(jsonRequest(URL_FN, BODY))).status).toBe(403);
  });

  it('corps qui prétend être Pro → refusé (champ inconnu), jamais pris en compte', async () => {
    const { handler, fetchImpl } = setup({ pro: false });
    for (const forged of [{ isPro: true }, { tier: 'pro' }, { entitlements: { tier: 'pro' } }]) {
      const res = await handler(jsonRequest(URL_FN, { ...BODY, ...forged }));
      expect(res.status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('en-têtes forgés (x-kinetic-pro, x-user-tier) → ignorés, la base fait foi', async () => {
    const { handler, fetchImpl, admin } = setup({ pro: false });
    const res = await handler(
      jsonRequest(URL_FN, BODY, {
        headers: { 'x-kinetic-pro': 'true', 'x-user-tier': 'pro', 'x-user-id': 'autre' },
      }),
    );
    expect(res.status).toBe(403);
    expect(admin.calls.find((c) => c.fn === 'is_pro')?.args).toEqual({ p_user: USER_ID });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('erreur de lecture des droits → 503, pas d’accès par défaut', async () => {
    const { handler, fetchImpl } = setup({ pro: 'error' });
    expect((await handler(jsonRequest(URL_FN, BODY))).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('AI_COACH_REQUIRE_PRO=false explicite → is_pro non consulté', async () => {
    const { handler, admin } = setup({
      pro: false,
      env: { ...ENV, AI_COACH_REQUIRE_PRO: 'false' },
    });
    expect((await handler(jsonRequest(URL_FN, BODY))).status).toBe(200);
    expect(admin.calls.map((c) => c.fn)).toEqual(['consume_ai_quota']);
  });
});

describe('ai-coach : quotas', () => {
  it('quota journalier dépassé → 429 avec Retry-After et sans appel Anthropic', async () => {
    const { handler, fetchImpl } = setup({
      quota: { allowed: false, reason: 'user_daily', retry_after_seconds: 3600 },
    });
    const res = await handler(jsonRequest(URL_FN, BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    const json = await res.json();
    expect(json.reason).toBe('user_daily');
    expect(json.message).toMatch(/aujourd'hui/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('plafond global atteint → 429 global_daily', async () => {
    const { handler } = setup({ quota: { allowed: false, reason: 'global_daily' } });
    const res = await handler(jsonRequest(URL_FN, BODY));
    expect(res.status).toBe(429);
    expect((await res.json()).reason).toBe('global_daily');
  });

  it('réponse de quota inattendue → 503 (échec fermé)', async () => {
    const { handler, fetchImpl } = setup({ quota: true });
    expect((await handler(jsonRequest(URL_FN, BODY))).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('le quota est consommé avec l’identifiant vérifié et la taille du prompt', async () => {
    const { handler, admin } = setup();
    await handler(jsonRequest(URL_FN, BODY));
    const call = admin.calls.find((c) => c.fn === 'consume_ai_quota');
    expect(call?.args['p_user']).toBe(USER_ID);
    expect(call?.args['p_prompt_chars']).toBeGreaterThan(BODY.question.length);
  });
});

describe('ai-coach : requêtes malformées et volumineuses', () => {
  it.each([
    ['JSON invalide', '{"question": '],
    ['tableau', '[]'],
    ['question absente', JSON.stringify({ context: {} })],
    ['question non textuelle', JSON.stringify({ question: 42 })],
    ['question trop longue', JSON.stringify({ question: 'a'.repeat(501) })],
    ['question vide', JSON.stringify({ question: '   ' })],
    ['context non objet', JSON.stringify({ question: 'ok', context: 'texte' })],
    [
      'trop de messages',
      JSON.stringify({ question: 'ok', history: Array(7).fill({ role: 'user', content: 'x' }) }),
    ],
    [
      'rôle inconnu',
      JSON.stringify({ question: 'ok', history: [{ role: 'system', content: 'x' }] }),
    ],
    ['caractère de contrôle', JSON.stringify({ question: 'a\u0000b' })],
  ])('%s → 400 sans appel Anthropic', async (_label, raw) => {
    const { handler, fetchImpl } = setup();
    const res = await handler(jsonRequest(URL_FN, raw));
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Content-Type autre que JSON → 415', async () => {
    const { handler, auth } = setup();
    const res = await handler(jsonRequest(URL_FN, BODY, { contentType: 'text/plain' }));
    expect(res.status).toBe(415);
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it('Content-Length annoncé > 32 Ko → 413 sans lecture du corps ni authentification', async () => {
    const { handler, auth } = setup();
    const { req, pulled } = hugeStreamRequest(URL_FN, 10 * 1024 * 1024, {
      contentLength: 10 * 1024 * 1024,
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
    expect(pulled()).toBeLessThanOrEqual(64 * 1024);
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it('sans Content-Length → 411 sans lecture du corps', async () => {
    const { handler, auth } = setup();
    const { req, pulled } = hugeStreamRequest(URL_FN, 10 * 1024 * 1024);
    const res = await handler(req);
    expect(res.status).toBe(411);
    expect(pulled()).toBeLessThanOrEqual(64 * 1024);
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it('Content-Length mensonger (annonce 100 o, envoie 10 Mo) → 413, lecture arrêtée', async () => {
    const { handler, fetchImpl, admin } = setup();
    const { req, pulled } = hugeStreamRequest(URL_FN, 10 * 1024 * 1024, { contentLength: 100 });
    const res = await handler(req);
    expect(res.status).toBe(413);
    expect(pulled()).toBeLessThan(MAX_BODY_BYTES + 32 * 1024);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Content-Length non numérique → 400', async () => {
    const { handler } = setup();
    const res = await handler(
      jsonRequest(URL_FN, BODY, { contentLength: 'abc' as unknown as number }),
    );
    expect(res.status).toBe(400);
  });
});

describe('ai-coach : CORS strict', () => {
  it('origine non autorisée → 403 sans en-tête CORS permissif', async () => {
    const { handler, auth } = setup();
    const res = await handler(jsonRequest(URL_FN, BODY, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("origine 'null' (iframe sandbox, file:) → 403", async () => {
    const { handler } = setup();
    const res = await handler(jsonRequest(URL_FN, BODY, { origin: 'null' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('préliminaire OPTIONS depuis une origine autorisée → 204 et origine renvoyée telle quelle', async () => {
    const { handler } = setup();
    const res = await handler(
      jsonRequest(URL_FN, '', { method: 'OPTIONS', contentLength: 'none' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('ALLOWED_ORIGINS absent en production → 503 pour tous, jamais *', async () => {
    const { handler, auth } = setup({ env: { ...ENV, ALLOWED_ORIGINS: undefined } });
    for (const origin of [ORIGIN, null]) {
      const res = await handler(jsonRequest(URL_FN, BODY, { origin }));
      expect(res.status).toBe(503);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("ALLOWED_ORIGINS='*' est ignoré (équivaut à absent) → 503", async () => {
    const { handler } = setup({ env: { ...ENV, ALLOWED_ORIGINS: '*,null' } });
    expect((await handler(jsonRequest(URL_FN, BODY))).status).toBe(503);
  });

  it('méthode GET → 405', async () => {
    const { handler } = setup();
    const res = await handler(jsonRequest(URL_FN, '', { method: 'GET', contentLength: 'none' }));
    expect(res.status).toBe(405);
  });
});

describe('ai-coach : appel Anthropic', () => {
  it('succès : modèle et max_tokens bornés côté serveur, clé jamais renvoyée ni journalisée', async () => {
    const { handler, fetchImpl, logger } = setup({
      env: { ...ENV, ANTHROPIC_MODEL: 'modele-inconnu', AI_COACH_MAX_TOKENS: '999999' },
    });
    const res = await handler(jsonRequest(URL_FN, BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.answer).toBe('Augmente le volume.');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe('claude-sonnet-5');
    expect(sent.max_tokens).toBe(2048);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(json)).not.toContain('sk-ant');
    expect(logger.lines.join('\n')).not.toContain('sk-ant');
    expect(logger.lines.join('\n')).not.toContain(USER_ID);
  });

  it.each([
    [429, 503, 'ai_busy'],
    [529, 503, 'ai_busy'],
    [500, 502, 'ai_unavailable'],
    [401, 502, 'ai_unavailable'],
  ])('Anthropic %i → %i %s sans détail interne', async (upstream, expected, code) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'détail interne org-123 sk-ant-xxx' } }), {
          status: upstream,
        }),
    );
    const { handler } = setup({ fetch: fetchImpl });
    const res = await handler(jsonRequest(URL_FN, BODY));
    expect(res.status).toBe(expected);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe(code);
    expect(text).not.toContain('org-123');
    expect(text).not.toContain('sk-ant');
  });

  it('stop_reason refusal → 422 ai_refused en français', async () => {
    const { handler } = setup({ fetch: anthropicOk('', 'refusal') });
    const res = await handler(jsonRequest(URL_FN, BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).message).toMatch(/Reformule/);
  });

  it('délai dépassé → AbortController déclenché, 504 ai_timeout', async () => {
    let aborted = false;
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const { handler } = setup({ fetch: fetchImpl, timeoutMs: 30 });
    const res = await handler(jsonRequest(URL_FN, BODY));
    expect(aborted).toBe(true);
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe('ai_timeout');
  });

  it('délai par défaut borné (≤ 30 s)', () => {
    expect(loadAiCoachConfig(envFromRecord(ENV)).timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('clé Anthropic absente → 500 seulement après authentification', async () => {
    const { handler } = setup({ env: { ...ENV, ANTHROPIC_API_KEY: undefined } });
    expect((await handler(jsonRequest(URL_FN, BODY, { jwt: null }))).status).toBe(401);
    expect((await handler(jsonRequest(URL_FN, BODY))).status).toBe(500);
  });
});

describe('validateCoachBody', () => {
  it('accepte le contrat documenté', () => {
    const r = validateCoachBody({
      question: 'Combien de séries ?',
      context: { a: 1 },
      history: [{ role: 'assistant', content: 'Bonjour' }],
    });
    expect(r.ok).toBe(true);
  });

  it('refuse un contexte trop profond', () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i += 1) {
      const next = {};
      deep['n'] = next;
      deep = next;
    }
    expect(validateCoachBody({ question: 'ok', context: root }).ok).toBe(false);
  });
});
