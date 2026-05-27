/**
 * Edge Function `ai-coach` — analyse l'historique d'entraînement avec Claude.
 *
 * Pourquoi côté serveur : pour ne JAMAIS exposer la clé Anthropic au client.
 *
 * Déploiement :
 *   supabase functions deploy ai-coach
 *
 * Secrets requis :
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *
 * Appel :
 *   POST /functions/v1/ai-coach
 *   {
 *     "question": "Pourquoi je stagne au bench ?",
 *     "context": { "lifts": [...], "recentSessions": [...] }
 *   }
 *
 * Le contexte est borné à ~50 séances pour rester sous le rate-limit.
 */

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

interface CoachBody {
  question?: string;
  context?: Record<string, unknown>;
}

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const SYSTEM_PROMPT = `Tu es un coach de musculation francophone, scientifique mais accessible.
Réponds en 3-5 phrases max, en t'appuyant sur les données fournies.
Si tu donnes un conseil de charge, cite ton raisonnement (RPE, e1RM, fréquence).
Pas de blabla générique : analyse les chiffres réels de l'athlète.`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: 'api_key_missing' }, 500);

  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);

  // Valider l'utilisateur (auth requise pour éviter d'épuiser la clé API
  // sur des spammeurs anonymes)
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);

  let body: CoachBody = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const question = (body.question ?? '').toString().slice(0, 500).trim();
  if (!question) return json({ error: 'question_required' }, 400);

  const contextJson = JSON.stringify(body.context ?? {}).slice(0, 20_000);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Question : ${question}\n\nContexte (JSON) :\n${contextJson}`,
          },
        ],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error('[ai-coach] anthropic error:', resp.status, detail);
      return json({ error: 'upstream_error', status: resp.status }, 502);
    }
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text =
      data.content?.find((c) => c.type === 'text')?.text?.trim() ||
      "Je n'ai pas pu générer de réponse — réessaie dans un instant.";
    return json({ answer: text });
  } catch (err) {
    console.error('[ai-coach] fetch failed:', err);
    return json({ error: 'fetch_failed' }, 500);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
