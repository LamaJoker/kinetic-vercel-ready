/**
 * Edge Function `send-push` — envoie une notification Web Push à un user.
 *
 * Déploiement :
 *   supabase functions deploy send-push
 *
 * Secrets requis :
 *   supabase secrets set VAPID_PUBLIC_KEY=...
 *   supabase secrets set VAPID_PRIVATE_KEY=...
 *   supabase secrets set VAPID_SUBJECT=mailto:contact@example.com
 *
 * Génération des clés VAPID (une fois) :
 *   npx web-push generate-vapid-keys
 *
 * Appel (depuis un client authentifié) :
 *   POST /functions/v1/send-push
 *   { "title": "...", "body": "...", "url": "/", "user_id": "<uuid>" }
 *
 * Si `user_id` est omis, on envoie au user courant (déduit du JWT). Si
 * `user_id` est fourni ET différent du caller, on refuse (403) — l'envoi
 * cross-user nécessite la clé service_role et n'est pas exposé via cette fn.
 *
 * Stratégie de nettoyage : pour chaque subscription qui répond 404/410,
 * on supprime la row correspondante (subscription expirée chez le provider).
 */

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Deno runtime, pas de @types disponibles
import * as webpush from 'https://esm.sh/web-push@3.6.7?bundle';

interface SendPushBody {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  user_id?: string;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string;
}

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:noreply@kinetic.app';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  (webpush as { setVapidDetails: (s: string, pub: string, priv: string) => void }).setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  );
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return json({ error: 'vapid_not_configured' }, 500);
  }

  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);

  // Client SCOPE user (vérifie le JWT)
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const callerUserId = userData.user.id;

  let body: SendPushBody = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const targetUserId = body.user_id ?? callerUserId;
  if (targetUserId !== callerUserId) {
    return json({ error: 'forbidden_cross_user' }, 403);
  }

  // Client SERVICE_ROLE pour lecture/suppression (bypasse RLS uniquement
  // pour le scope précis user.id == caller, vérifié juste avant).
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: subs, error: subsErr } = await adminClient
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, user_id')
    .eq('user_id', targetUserId);
  if (subsErr) return json({ error: 'db_error', detail: subsErr.message }, 500);
  const rows = (subs ?? []) as SubscriptionRow[];
  if (rows.length === 0) return json({ sent: 0, message: 'no_subscriptions' });

  const payload = JSON.stringify({
    title: body.title?.slice(0, 80) || 'Kinetic',
    body: body.body?.slice(0, 200) || "Ta routine t'attend !",
    url: body.url || '/',
    tag: body.tag || 'kinetic-reminder',
  });

  const lib = webpush as {
    sendNotification: (
      sub: { endpoint: string; keys: { p256dh: string; auth: string } },
      payload: string,
    ) => Promise<unknown>;
  };

  let sent = 0;
  const expiredEndpoints: string[] = [];

  await Promise.all(
    rows.map(async (row) => {
      try {
        await lib.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 0;
        if (status === 404 || status === 410) expiredEndpoints.push(row.endpoint);
        else console.error('[send-push] error for', row.endpoint, err);
      }
    }),
  );

  if (expiredEndpoints.length > 0) {
    await adminClient.from('push_subscriptions').delete().in('endpoint', expiredEndpoints);
  }

  return json({
    sent,
    total: rows.length,
    cleaned: expiredEndpoints.length,
  });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
