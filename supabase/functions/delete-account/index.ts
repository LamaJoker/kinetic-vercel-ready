/**
 * Edge Function `delete-account` — droit à l'effacement (RGPD, art. 17).
 *
 * Supprime l'utilisateur Auth appelant. Toutes les tables applicatives
 * référencent auth.users avec ON DELETE CASCADE (user_storage, entitlements,
 * ai_coach_usage, push_subscriptions, tables d'entraînement, profiles) : une
 * seule suppression efface toutes ses données serveur.
 *
 * Contrat : POST /functions/v1/delete-account, Authorization: Bearer <JWT>,
 * corps exactement { "confirm": "SUPPRIMER" } (garde-fou contre un appel accidentel).
 * Réponses : 200 { deleted: true[, alreadyDeleted: true] } · 400 confirmation_required ·
 *   401 unauthorized · 403 origin_not_allowed · 405 · 429 rate_limit_exceeded ·
 *   500 delete_failed · 503 auth_unavailable|rate_limit_unavailable|cors_not_configured
 * Variables : ALLOWED_ORIGINS (obligatoire en production), RATE_LIMIT_SECRET.
 * La logique est dans `handler.ts` (testée sous Node).
 */
import { adminClient, authPort, consoleSink, denoEnv, rpcPort } from '../_deno/adapters.ts';
import { createLogger } from '../_shared/redact.ts';
import { createDeleteAccountHandler, loadDeleteAccountConfig } from './handler.ts';

const admin = adminClient(denoEnv);

Deno.serve(
  createDeleteAccountHandler({
    config: loadDeleteAccountConfig(denoEnv),
    auth: authPort(admin),
    admin: rpcPort(admin),
    async deleteUser(userId) {
      if (!admin) return 'failed';
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (!error) return 'deleted';
      const code = (error as { code?: string }).code;
      return code === 'user_not_found' || error.status === 404 ? 'not_found' : 'failed';
    },
    logger: createLogger('delete-account', consoleSink),
  }),
);
