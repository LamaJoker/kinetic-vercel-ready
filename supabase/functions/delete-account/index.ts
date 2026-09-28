/**
 * Edge Function `delete-account` — droit à l'effacement (RGPD, art. 17).
 *
 * Supprime l'utilisateur Auth appelant. Toutes les tables applicatives
 * référencent auth.users avec ON DELETE CASCADE (user_storage, entitlements,
 * ai_coach_usage, push_subscriptions, tables d'entraînement, profiles) : une
 * seule suppression efface toutes ses données serveur.
 *
 * Contrat : POST /functions/v1/delete-account, Authorization: Bearer <JWT>,
 * corps { "confirm": "SUPPRIMER" } (garde-fou contre un appel accidentel).
 * Réponses : 200 { deleted: true } · 400 confirmation_required · 401 unauthorized
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow =
    ALLOWED_ORIGINS.length === 0 ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    Vary: 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'content-type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer '))
    return json(req, { error: 'unauthorized' }, 401);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json(req, { error: 'server_misconfigured' }, 500);
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return json(req, { error: 'unauthorized' }, 401);

  let body: { confirm?: unknown } = {};
  try {
    body = (await req.json()) as { confirm?: unknown };
  } catch {
    /* corps absent */
  }
  if (body.confirm !== 'SUPPRIMER') return json(req, { error: 'confirmation_required' }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: delErr } = await admin.auth.admin.deleteUser(data.user.id);
  if (delErr) {
    console.error('[delete-account] failed:', delErr.message);
    return json(req, { error: 'delete_failed' }, 500);
  }
  return json(req, { deleted: true });
});
