/**
 * Edge Function `report-error` — collecte légère d'erreurs runtime.
 *
 * Stratégie : on log en console Supabase (visible dans le dashboard
 * Functions → Logs). Pas de stockage en DB pour rester gratuit et sans
 * PII. Si tu veux brancher Sentry/Posthog/un webhook, ajoute l'envoi
 * dans la fonction `forward()` ci-dessous.
 *
 * Déploiement :
 *   supabase functions deploy report-error
 *
 * Optionnel — webhook externe (Discord, Slack, etc.) :
 *   supabase secrets set ERROR_WEBHOOK_URL=https://...
 */

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

interface ReportPayload {
  userAgent?: string;
  reports?: Array<{
    occurredAt: string;
    message: string;
    source: string;
  }>;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

const WEBHOOK_URL = Deno.env.get('ERROR_WEBHOOK_URL') ?? '';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: ReportPayload = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const reports = Array.isArray(body.reports) ? body.reports.slice(0, 50) : [];
  if (reports.length === 0) return json({ ok: true, forwarded: 0 });

  // Log côté Supabase (visible Functions → Logs)
  for (const r of reports) {
    console.log(`[kinetic-error] ${r.occurredAt} (${r.source}): ${r.message}`);
  }

  let forwarded = 0;
  if (WEBHOOK_URL) {
    forwarded = await forward(WEBHOOK_URL, reports, body.userAgent ?? 'unknown').catch(() => 0);
  }
  return json({ ok: true, received: reports.length, forwarded });
});

async function forward(
  url: string,
  reports: ReportPayload['reports'] = [],
  userAgent: string,
): Promise<number> {
  // Format Discord / Slack-friendly
  const text = reports.map((r) => `\`[${r.occurredAt}]\` *${r.source}* — ${r.message}`).join('\n');
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: `🚨 Kinetic — ${reports.length} erreur(s)\nUA: ${userAgent}\n${text}`,
    }),
  });
  return reports.length;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
