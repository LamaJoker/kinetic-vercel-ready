/**
 * Revue « attaquant » des fonctions Edge : scénarios d'abus démontrés puis
 * corrigés (voir docs/architecture/security.md, section « Revue attaquant »).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  clientIp,
  createReportErrorHandler,
  formatWebhookContent,
  loadReportErrorConfig,
} from '../../supabase/functions/report-error/handler.ts';
import { envFromRecord } from '../../supabase/functions/_shared/env.ts';
import {
  BASE_ENV,
  allowQuota,
  fakeAuth,
  fakeRpc,
  jsonRequest,
  memLogger,
} from '../helpers/edge.ts';

const URL_FN = 'https://x.supabase.co/functions/v1/report-error';
const REPORT = { occurredAt: '2026-11-26T09:00:00Z', source: 'uncaught_error', message: 'x' };

function setup(env: Record<string, string | undefined> = BASE_ENV) {
  const admin = fakeRpc({ consume_rate_limit: allowQuota });
  const webhook = vi.fn(async () => new Response(null, { status: 204 }));
  const handler = createReportErrorHandler({
    config: loadReportErrorConfig(envFromRecord(env)),
    auth: fakeAuth(),
    admin,
    fetch: webhook as unknown as typeof fetch,
    logger: memLogger(),
  });
  return { handler, admin, webhook };
}

/** Requête anonyme (clé anon) passée par la passerelle, X-Forwarded-For donné. */
function anonymous(xff: string, extra: Record<string, string> = {}): Request {
  return jsonRequest(
    URL_FN,
    { reports: [REPORT] },
    { jwt: BASE_ENV.SUPABASE_ANON_KEY, headers: { 'x-forwarded-for': xff, ...extra } },
  );
}

describe('report-error : X-Forwarded-For falsifié par le client', () => {
  // Le client peut envoyer son propre X-Forwarded-For : la passerelle AJOUTE
  // l'adresse réelle à la fin. Prendre la première entrée laissait l'attaquant
  // choisir son « IP » à chaque requête : limite par IP contournée, plafond
  // global (2 000/h) vidé en quelques minutes pour tous les utilisateurs, et
  // quota d'une victime épuisé en usurpant son adresse.
  const REAL = '198.51.100.23';

  it('une IP inventée par requête ne donne pas un nouveau compteur', async () => {
    const { handler, admin } = setup();
    for (let i = 1; i <= 5; i += 1) {
      const res = await handler(anonymous(`10.0.0.${i}, ${REAL}`));
      expect(res.status).toBe(200);
    }
    const subjects = new Set(
      admin.calls
        .filter((c) => c.args['p_scope'] === 'report_error_ip')
        .map((c) => c.args['p_subject']),
    );
    expect(subjects.size).toBe(1);
  });

  it('usurper l’adresse d’une victime ne consomme pas son quota', async () => {
    const { handler, admin } = setup();
    await handler(anonymous(`203.0.113.50, ${REAL}`)); // attaquant se faisant passer pour la victime
    await handler(anonymous('203.0.113.50')); // vraie requête de la victime
    const [attacker, victim] = admin.calls
      .filter((c) => c.args['p_scope'] === 'report_error_ip')
      .map((c) => c.args['p_subject']);
    expect(attacker).not.toBe(victim);
  });

  it('clientIp : dernière entrée (ajoutée par la passerelle), jamais la première', () => {
    const req = (h: Record<string, string>) => new Request(URL_FN, { method: 'POST', headers: h });
    expect(clientIp(req({ 'x-forwarded-for': `1.2.3.4, ${REAL}` }))).toBe(REAL);
    expect(clientIp(req({ 'x-forwarded-for': REAL }))).toBe(REAL);
    expect(clientIp(req({}))).toBe('inconnue');
    // cf-connecting-ip est falsifiable si la passerelle ne le réécrit pas : ignoré par défaut.
    expect(clientIp(req({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': REAL }))).toBe(REAL);
    // Plusieurs mandataires de confiance (TRUSTED_PROXY_HOPS = 2).
    expect(clientIp(req({ 'x-forwarded-for': `1.2.3.4, ${REAL}, 10.1.1.1` }), 2)).toBe(REAL);
    // Moins d'entrées que de mandataires annoncés : la plus ancienne entrée disponible
    // est ajoutée par un mandataire de confiance (pas par le client).
    expect(clientIp(req({ 'x-forwarded-for': REAL }), 2)).toBe(REAL);
  });

  it('TRUSTED_PROXY_HOPS est lu dans l’environnement et borné', async () => {
    const two = setup({ ...BASE_ENV, TRUSTED_PROXY_HOPS: '2' });
    await two.handler(anonymous(`10.9.9.9, ${REAL}, 10.1.1.1`));
    await two.handler(anonymous(`10.8.8.8, ${REAL}, 10.1.1.1`));
    const s2 = two.admin.calls.filter((c) => c.args['p_scope'] === 'report_error_ip');
    expect(s2[0]!.args['p_subject']).toBe(s2[1]!.args['p_subject']);
    expect(
      loadReportErrorConfig(envFromRecord({ ...BASE_ENV, TRUSTED_PROXY_HOPS: 'x' }))
        .trustedProxyHops,
    ).toBe(1);
    expect(
      loadReportErrorConfig(envFromRecord({ ...BASE_ENV, TRUSTED_PROXY_HOPS: '99' }))
        .trustedProxyHops,
    ).toBe(1);
  });
});

describe('report-error : injection de mise en forme dans le webhook de l’équipe', () => {
  // N'importe qui (clé anon publique) peut envoyer un « message d'erreur ».
  // Relayé tel quel, un lien masqué Markdown `[texte](url)` s'affichait comme un
  // lien cliquable dans le canal Discord/Slack de l'équipe : hameçonnage des
  // administrateurs depuis un canal de confiance.
  const PHISH = {
    ...REPORT,
    message:
      '[Session Supabase expirée : se reconnecter](https://evil.example/login) <https://evil.example|ici> ```x```',
  };

  it('contenu relayé dans un bloc de code, sans délimiteur échappable', () => {
    const text = formatWebhookContent({ userAgent: '`UA`', reports: [PHISH, PHISH] });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Kinetic — 2 erreur\(s\)$/);
    expect(lines[1]).toBe('```');
    expect(lines.at(-1)).toBe('```');
    // Un seul bloc : aucune autre séquence d'accent grave dans le contenu.
    expect(text.split('`').length - 1).toBe(6);
    expect(text).toContain('evil.example');
  });

  it('bloc refermé même quand le contenu est tronqué', () => {
    const text = formatWebhookContent({
      userAgent: 'UA',
      reports: Array(50).fill({ ...REPORT, message: '`'.repeat(1000) }),
    });
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text.endsWith('\n```')).toBe(true);
    expect(text.split('`').length - 1).toBe(6);
  });

  it('le handler envoie bien ce contenu au webhook', async () => {
    const { handler, webhook } = setup({
      ...BASE_ENV,
      ERROR_WEBHOOK_URL: 'https://discord.example/w',
    });
    await handler(jsonRequest(URL_FN, { reports: [PHISH] }));
    const [, init] = webhook.mock.calls[0] as unknown as [string, RequestInit];
    const content = String(JSON.parse(String(init.body)).content);
    expect(content.split('\n')[1]).toBe('```');
    expect(content.split('`').length - 1).toBe(6);
  });
});
