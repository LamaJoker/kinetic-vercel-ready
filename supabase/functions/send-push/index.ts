/**
 * Edge Function `send-push` — envoie une notification Web Push à un utilisateur.
 *
 * Fonction SERVEUR → client : appelée par un job ou une autre fonction avec la
 * clé service_role (ou le secret partagé PUSH_SHARED_SECRET), jamais par le
 * navigateur. La logique (anti-SSRF, validation, limites) est dans
 * `handler.ts`, testée sous Node.
 *
 * Déploiement :
 *   supabase functions deploy send-push
 *
 * Secrets requis :
 *   supabase secrets set VAPID_PUBLIC_KEY=...
 *   supabase secrets set VAPID_PRIVATE_KEY=...
 *   supabase secrets set VAPID_SUBJECT=mailto:contact@example.com
 *   supabase secrets set PUSH_SHARED_SECRET=<≥ 32 caractères aléatoires>   (optionnel)
 *
 * Appel :
 *   POST /functions/v1/send-push
 *   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>   (ou x-push-secret: <PUSH_SHARED_SECRET>)
 *   { "user_id": "<uuid>", "title": "...", "body": "...", "url": "/", "tag": "kinetic-reminder" }
 *
 * Nettoyage : un endpoint qui répond 404/410 (expiré) ou qui ne passe pas la
 * validation anti-SSRF est supprimé.
 */
import webpush from 'https://esm.sh/web-push@3.6.7?bundle';
import { adminClient, consoleSink, denoEnv, rpcPort } from '../_deno/adapters.ts';
import { createLogger } from '../_shared/redact.ts';
import { createSendPushHandler, loadSendPushConfig } from './handler.ts';

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:noreply@kinetic.app';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const admin = adminClient(denoEnv);

Deno.serve(
  createSendPushHandler({
    config: loadSendPushConfig(denoEnv),
    admin: rpcPort(admin),
    async listSubscriptions(userId, limit) {
      if (!admin) throw new Error('supabase_not_configured');
      const { data, error } = await admin
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth')
        .eq('user_id', userId)
        .limit(limit);
      if (error) throw new Error('db_error');
      return (data ?? []) as { endpoint: string; p256dh: string; auth: string }[];
    },
    async deleteSubscriptions(userId, endpoints) {
      if (!admin) return;
      await admin
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .in('endpoint', endpoints);
    },
    async sendNotification(sub, payload, timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('push_timeout')), timeoutMs);
      });
      try {
        await Promise.race([
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { timeout: timeoutMs, TTL: 3600 },
          ),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    logger: createLogger('send-push', consoleSink),
  }),
);
