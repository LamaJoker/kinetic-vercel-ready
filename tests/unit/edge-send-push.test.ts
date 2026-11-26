/**
 * Fonction Edge send-push : anti-SSRF, appel réservé au serveur, délais.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createSendPushHandler,
  loadSendPushConfig,
  validatePushBody,
  type PushSubscriptionRow,
} from '../../supabase/functions/send-push/handler.ts';
import { checkPushEndpoint } from '../../supabase/functions/_shared/push-endpoint.ts';
import { envFromRecord } from '../../supabase/functions/_shared/env.ts';
import {
  BASE_ENV,
  USER_ID,
  VALID_JWT,
  allowQuota,
  fakeRpc,
  jsonRequest,
  memLogger,
} from '../helpers/edge.ts';

const URL_FN = 'https://x.supabase.co/functions/v1/send-push';
const ENV = {
  ...BASE_ENV,
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  PUSH_SHARED_SECRET: 's'.repeat(40),
};
const SERVICE = BASE_ENV.SUPABASE_SERVICE_ROLE_KEY;

function sub(endpoint: string): PushSubscriptionRow {
  return { endpoint, p256dh: 'p', auth: 'a' };
}

function setup(rows: PushSubscriptionRow[], env: Record<string, string | undefined> = ENV) {
  const sendNotification = vi.fn(async () => undefined);
  const deleteSubscriptions = vi.fn(async () => undefined);
  const listSubscriptions = vi.fn(async () => rows);
  const logger = memLogger();
  const handler = createSendPushHandler({
    config: loadSendPushConfig(envFromRecord(env)),
    admin: fakeRpc({ consume_rate_limit: allowQuota }),
    listSubscriptions,
    deleteSubscriptions,
    sendNotification,
    logger,
  });
  return { handler, sendNotification, deleteSubscriptions, listSubscriptions, logger };
}

const serverCall = (body: unknown, extra: Record<string, string> = {}) =>
  jsonRequest(URL_FN, body, { origin: null, jwt: SERVICE, headers: extra });

describe('send-push : anti-SSRF', () => {
  it('endpoint vers une IP interne → jamais contacté, ligne supprimée', async () => {
    const internal = [
      'http://169.254.169.254/latest/meta-data/',
      'https://169.254.169.254/latest/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://10.0.0.5/push',
      'https://0x7f000001/',
    ];
    const { handler, sendNotification, deleteSubscriptions } = setup(internal.map(sub));
    const res = await handler(serverCall({ user_id: USER_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(0);
    expect(json.rejected).toBe(internal.length);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(deleteSubscriptions).toHaveBeenCalledWith(USER_ID, internal);
  });

  it('seuls les endpoints valides sont contactés', async () => {
    const good = 'https://fcm.googleapis.com/fcm/send/abc';
    const { handler, sendNotification } = setup([sub(good), sub('https://evil.example/x')]);
    const json = await (await handler(serverCall({ user_id: USER_ID }))).json();
    expect(json).toMatchObject({ sent: 1, rejected: 1 });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect((sendNotification.mock.calls[0] as unknown as [PushSubscriptionRow])[0].endpoint).toBe(
      good,
    );
  });

  it.each([
    ['https://fcm.googleapis.com/fcm/send/x', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/x', true],
    ['https://web.push.apple.com/QOx', true],
    ['https://api.push.apple.com/3/device/x', true],
    ['https://db5p.notify.windows.com/w/?token=x', true],
    ['http://fcm.googleapis.com/fcm/send/x', false],
    ['https://fcm.googleapis.com:8443/fcm/send/x', false],
    ['https://user:pass@fcm.googleapis.com/x', false],
    ['https://fcm.googleapis.com.evil.example/x', false],
    ['https://evilpush.apple.com/x', false],
    ['https://push.apple.com/x', false],
    ['https://notify.windows.com/x', false],
    ['https://localhost/x', false],
    ['https://192.168.1.1/x', false],
    ['https://[fd00::1]/x', false],
    ['javascript:alert(1)', false],
    ['', false],
  ])('checkPushEndpoint(%s) → %s', (endpoint, expected) => {
    expect(checkPushEndpoint(endpoint).ok).toBe(expected);
  });
});

describe('send-push : appel réservé au serveur', () => {
  it('JWT utilisateur (même valide) → 401', async () => {
    const { handler, listSubscriptions } = setup([]);
    const res = await handler(
      jsonRequest(URL_FN, { user_id: USER_ID }, { origin: null, jwt: VALID_JWT }),
    );
    expect(res.status).toBe(401);
    expect(listSubscriptions).not.toHaveBeenCalled();
  });

  it('secret partagé correct → accepté ; incorrect → 401', async () => {
    const { handler } = setup([]);
    const ok = await handler(
      jsonRequest(
        URL_FN,
        { user_id: USER_ID },
        { origin: null, jwt: null, headers: { 'x-push-secret': 's'.repeat(40) } },
      ),
    );
    expect(ok.status).toBe(200);
    const ko = await handler(
      jsonRequest(
        URL_FN,
        { user_id: USER_ID },
        { origin: null, jwt: null, headers: { 'x-push-secret': 's'.repeat(39) } },
      ),
    );
    expect(ko.status).toBe(401);
  });

  it('secret partagé trop court dans la configuration → ignoré', async () => {
    const { handler } = setup([], { ...ENV, PUSH_SHARED_SECRET: 'court' });
    const res = await handler(
      jsonRequest(
        URL_FN,
        { user_id: USER_ID },
        { origin: null, jwt: null, headers: { 'x-push-secret': 'court' } },
      ),
    );
    expect(res.status).toBe(401);
  });

  it('appel depuis un navigateur (en-tête Origin) → 403 sans CORS', async () => {
    const { handler } = setup([]);
    const res = await handler(jsonRequest(URL_FN, { user_id: USER_ID }, { jwt: SERVICE }));
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('corps invalide (url externe, champ inconnu, user_id absent) → 400', async () => {
    const { handler } = setup([]);
    for (const body of [
      { user_id: USER_ID, url: 'https://evil.example' },
      { user_id: USER_ID, url: '//evil.example' },
      { user_id: USER_ID, extra: 1 },
      { title: 'x' },
    ]) {
      expect((await handler(serverCall(body))).status).toBe(400);
    }
  });
});

describe('send-push : envoi', () => {
  it('404/410 → abonnement supprimé ; autre erreur comptée sans journaliser l’endpoint', async () => {
    const gone = 'https://fcm.googleapis.com/fcm/send/expire';
    const broken = 'https://fcm.googleapis.com/fcm/send/panne';
    const { handler, sendNotification, deleteSubscriptions, logger } = setup([
      sub(gone),
      sub(broken),
    ]);
    sendNotification.mockImplementation(async (s: PushSubscriptionRow) => {
      throw Object.assign(new Error('x'), { statusCode: s.endpoint === gone ? 410 : 500 });
    });
    const json = await (await handler(serverCall({ user_id: USER_ID }))).json();
    expect(json).toMatchObject({ sent: 0, failed: 1, cleaned: 1 });
    expect(deleteSubscriptions).toHaveBeenCalledWith(USER_ID, [gone]);
    expect(logger.lines.join('\n')).not.toContain('fcm.googleapis.com');
    expect(logger.lines.join('\n')).not.toContain(USER_ID);
  });

  it('délai transmis à l’envoi et au plus 10 abonnements', async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      sub(`https://fcm.googleapis.com/fcm/send/${i}`),
    );
    const { handler, sendNotification, listSubscriptions } = setup(rows);
    await handler(serverCall({ user_id: USER_ID }));
    expect(listSubscriptions).toHaveBeenCalledWith(USER_ID, 10);
    expect(sendNotification).toHaveBeenCalledTimes(10);
    expect((sendNotification.mock.calls[0] as unknown as [unknown, unknown, number])[2]).toBe(
      10_000,
    );
  });

  it('validatePushBody applique les valeurs par défaut', () => {
    const r = validatePushBody({ user_id: USER_ID });
    expect(r).toEqual({
      ok: true,
      value: {
        userId: USER_ID,
        title: 'Kinetic',
        body: "Ta routine t'attend !",
        url: '/',
        tag: 'kinetic-reminder',
      },
    });
  });
});
