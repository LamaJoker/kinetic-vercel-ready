/**
 * Edge Function `report-error` — collecte légère d'erreurs runtime du client.
 *
 * Les erreurs sont journalisées (Functions → Logs) après masquage des données
 * personnelles, et éventuellement relayées vers un webhook HTTPS
 * (ERROR_WEBHOOK_URL, Discord/Slack). Pas de stockage en base. La logique
 * (taille, schéma, limite de débit, masquage) est dans `handler.ts`, testée
 * sous Node.
 *
 * Déploiement :
 *   supabase functions deploy report-error
 *
 * Variables : ALLOWED_ORIGINS (obligatoire en production), RATE_LIMIT_SECRET
 * (à défaut la clé service_role sert de clé HMAC), ERROR_WEBHOOK_URL (optionnel).
 * Conservation : journaux Supabase (durée du plan) ; aucune donnée personnelle
 * volontairement conservée.
 */
import { adminClient, authPort, consoleSink, denoEnv, rpcPort } from '../_deno/adapters.ts';
import { createLogger } from '../_shared/redact.ts';
import { createReportErrorHandler, loadReportErrorConfig } from './handler.ts';

const admin = adminClient(denoEnv);

Deno.serve(
  createReportErrorHandler({
    config: loadReportErrorConfig(denoEnv),
    auth: authPort(admin),
    admin: rpcPort(admin),
    fetch: (input, init) => fetch(input, init),
    logger: createLogger('report-error', consoleSink),
  }),
);
