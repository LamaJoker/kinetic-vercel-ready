/**
 * Edge Function `ai-coach` — analyse l'historique d'entraînement avec Claude.
 *
 * Pourquoi côté serveur : la clé Anthropic n'est JAMAIS exposée au client, et
 * les droits (plan Pro, quota) sont vérifiés ici, pas dans le navigateur.
 * La logique est dans `handler.ts` (testée sous Node) ; ce fichier ne fait que
 * brancher Deno et supabase-js.
 *
 * Déploiement :
 *   supabase functions deploy ai-coach
 *
 * Secrets (voir docs/architecture/security.md, section « Fonctions Edge ») :
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase secrets set ALLOWED_ORIGINS=https://kinetic.vercel.app,capacitor://localhost,https://localhost
 *   supabase secrets set ANTHROPIC_MODEL=claude-sonnet-5        (optionnel, liste blanche)
 *   supabase secrets set AI_COACH_REQUIRE_PRO=false             (optionnel ; vrai par défaut)
 *   supabase secrets set RATE_LIMIT_SECRET=<aléatoire>          (pseudonymes des journaux)
 *
 * Contrat :
 *   POST /functions/v1/ai-coach   Authorization: Bearer <JWT utilisateur>
 *   Content-Type: application/json, Content-Length ≤ 32 Ko
 *   { "question": "Pourquoi je stagne au bench ?", "context": { ... },
 *     "history": [{ "role": "user"|"assistant", "content": "..." }] (≤ 6, optionnel) }
 *
 * Réponses : 200 { answer, truncated } · 400 invalid_request|invalid_json ·
 *   401 unauthorized · 403 origin_not_allowed|pro_required · 411 length_required ·
 *   413 payload_too_large · 415 unsupported_media_type · 422 ai_refused ·
 *   429 rate_limit_exceeded · 502 ai_unavailable · 503 ai_busy|quota_check_failed|
 *   entitlement_check_failed|cors_not_configured · 504 ai_timeout
 * Prérequis : migrations 009 (entitlements, is_pro) et 011 (consume_ai_quota).
 */
import { adminClient, authPort, consoleSink, denoEnv, rpcPort } from '../_deno/adapters.ts';
import { createLogger } from '../_shared/redact.ts';
import { createAiCoachHandler, loadAiCoachConfig } from './handler.ts';

const admin = adminClient(denoEnv);

Deno.serve(
  createAiCoachHandler({
    config: loadAiCoachConfig(denoEnv),
    auth: authPort(admin),
    admin: rpcPort(admin),
    fetch: (input, init) => fetch(input, init),
    logger: createLogger('ai-coach', consoleSink),
  }),
);
