/**
 * Fonction Edge report-error : taille, schéma, CORS, limite de débit,
 * masquage des données personnelles, webhook sans mentions.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createReportErrorHandler,
  formatWebhookContent,
  loadReportErrorConfig,
} from '../../supabase/functions/report-error/handler.ts';
import { envFromRecord } from '../../supabase/functions/_shared/env.ts';
import {
  BASE_ENV,
  USER_ID,
  allowQuota,
  fakeAuth,
  fakeRpc,
  hugeStreamRequest,
  jsonRequest,
  memLogger,
} from '../helpers/edge.ts';

const URL_FN = 'https://x.supabase.co/functions/v1/report-error';
const REPORT = {
  occurredAt: '2026-11-26T09:00:00Z',
  source: 'uncaught_error',
  message: 'TypeError',
};

function setup(
  opts: {
    env?: Record<string, string | undefined>;
    rate?: (args: Readonly<Record<string, unknown>>) => unknown;
  } = {},
) {
  const admin = fakeRpc({
    consume_rate_limit: opts.rate
      ? (args) => ({ data: opts.rate!(args), error: null })
      : allowQuota,
  });
  const webhook = vi.fn(async () => new Response(null, { status: 204 }));
  const logger = memLogger();
  const handler = createReportErrorHandler({
    config: loadReportErrorConfig(envFromRecord(opts.env ?? BASE_ENV)),
    auth: fakeAuth(),
    admin,
    fetch: webhook as unknown as typeof fetch,
    logger,
  });
  return { handler, admin, webhook, logger };
}

describe('report-error : entrée', () => {
  it('rapport valide (format du client actuel) → 200', async () => {
    const { handler } = setup();
    const res = await handler(jsonRequest(URL_FN, { userAgent: 'Mozilla', reports: [REPORT] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, received: 1 });
  });

  it('corps trop volumineux sans Content-Length → 413, lecture arrêtée', async () => {
    const { handler, admin } = setup();
    const { req, pulled } = hugeStreamRequest(URL_FN, 20 * 1024 * 1024);
    const res = await handler(req);
    expect(res.status).toBe(413);
    expect(pulled()).toBeLessThan(128 * 1024);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('Content-Length annoncé trop grand → 413', async () => {
    const { handler } = setup();
    const { req } = hugeStreamRequest(URL_FN, 1024, { contentLength: 10_000_000 });
    expect((await handler(req)).status).toBe(413);
  });

  it.each([
    ['champ inconnu', { reports: [REPORT], extra: 1 }],
    ['source inconnue', { reports: [{ ...REPORT, source: 'x' }] }],
    ['message trop long', { reports: [{ ...REPORT, message: 'a'.repeat(1001) }] }],
    ['trop de rapports', { reports: Array(201).fill(REPORT) }],
    ['reports non tableau', { reports: 'x' }],
  ])('%s → 400', async (_l, body) => {
    const { handler } = setup();
    expect((await handler(jsonRequest(URL_FN, body))).status).toBe(400);
  });

  it('au plus 50 rapports traités par appel', async () => {
    const { handler } = setup();
    const res = await handler(jsonRequest(URL_FN, { reports: Array(120).fill(REPORT) }));
    expect((await res.json()).received).toBe(50);
  });

  it('origine non autorisée → 403 sans CORS ; autorisée → origine exacte', async () => {
    const { handler } = setup();
    const bad = await handler(
      jsonRequest(URL_FN, { reports: [REPORT] }, { origin: 'https://x.example' }),
    );
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const good = await handler(
      jsonRequest(URL_FN, { reports: [REPORT] }, { origin: 'capacitor://localhost' }),
    );
    expect(good.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
  });
});

describe('report-error : limite de débit', () => {
  it('invité : limite par IP pseudonymisée (HMAC), jamais l’IP brute', async () => {
    const { handler, admin } = setup();
    await handler(
      jsonRequest(
        URL_FN,
        { reports: [REPORT] },
        {
          jwt: BASE_ENV.SUPABASE_ANON_KEY + 'xxxxxxxx',
          headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
        },
      ),
    );
    const call = admin.calls[0]!;
    expect(call.args['p_scope']).toBe('report_error_ip');
    expect(String(call.args['p_subject'])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(admin.calls)).not.toContain('203.0.113.7');
  });

  it('utilisateur connecté : limite par utilisateur puis plafond global', async () => {
    const { handler, admin } = setup();
    await handler(jsonRequest(URL_FN, { reports: [REPORT] }));
    expect(admin.calls.map((c) => [c.args['p_scope'], c.args['p_subject']])).toEqual([
      ['report_error_user', USER_ID],
      ['report_error_global', 'global'],
    ]);
  });

  it('limite dépassée → 429 sans journalisation ni webhook', async () => {
    const { handler, webhook, logger } = setup({
      env: { ...BASE_ENV, ERROR_WEBHOOK_URL: 'https://discord.example/webhook' },
      rate: () => ({ allowed: false, retry_after_seconds: 900 }),
    });
    const res = await handler(jsonRequest(URL_FN, { reports: [REPORT] }));
    expect(res.status).toBe(429);
    expect(webhook).not.toHaveBeenCalled();
    expect(logger.lines.some((l) => l.includes('client_error'))).toBe(false);
  });

  it('limiteur indisponible → 503 (échec fermé)', async () => {
    const { handler } = setup({ rate: () => null });
    expect((await handler(jsonRequest(URL_FN, { reports: [REPORT] }))).status).toBe(503);
  });
});

describe('report-error : données personnelles et webhook', () => {
  const sensitive = {
    ...REPORT,
    message:
      'Échec pour jean.dupont@example.com token=abc123 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl @everyone',
  };

  it('journal masqué', async () => {
    const { handler, logger } = setup();
    await handler(jsonRequest(URL_FN, { reports: [sensitive] }));
    const log = logger.lines.join('\n');
    expect(log).toContain('client_error');
    expect(log).not.toContain('jean.dupont');
    expect(log).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(log).not.toContain('abc123');
  });

  it('webhook : masqué, mentions neutralisées, allowed_mentions vide', async () => {
    const { handler, webhook } = setup({
      env: { ...BASE_ENV, ERROR_WEBHOOK_URL: 'https://discord.example/webhook' },
    });
    const res = await handler(jsonRequest(URL_FN, { reports: [sensitive] }));
    expect((await res.json()).forwarded).toBe(1);
    const [, init] = webhook.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content).not.toContain('@everyone');
    expect(payload.content).not.toContain('jean.dupont');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('webhook non HTTPS ignoré', async () => {
    const { handler, webhook } = setup({
      env: { ...BASE_ENV, ERROR_WEBHOOK_URL: 'http://169.254.169.254/' },
    });
    await handler(jsonRequest(URL_FN, { reports: [REPORT] }));
    expect(webhook).not.toHaveBeenCalled();
  });

  it('formatWebhookContent borne la taille', () => {
    const text = formatWebhookContent({
      userAgent: 'UA',
      reports: Array(50).fill({ ...REPORT, message: 'x'.repeat(1000) }),
    });
    expect(text.length).toBeLessThanOrEqual(1900);
  });
});
