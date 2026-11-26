/**
 * Fonction Edge delete-account : confirmation explicite, POST seulement, CORS
 * strict, idempotence, journaux sans donnée personnelle.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createDeleteAccountHandler,
  loadDeleteAccountConfig,
  type DeleteUserResult,
} from '../../supabase/functions/delete-account/handler.ts';
import { envFromRecord } from '../../supabase/functions/_shared/env.ts';
import { deleteAccount } from '../../apps/web/src/lib/account.js';
import {
  BASE_ENV,
  ORIGIN,
  USER_ID,
  VALID_JWT,
  allowQuota,
  fakeAuth,
  fakeRpc,
  jsonRequest,
  memLogger,
} from '../helpers/edge.ts';

const URL_FN = 'https://x.supabase.co/functions/v1/delete-account';
const CONFIRM = { confirm: 'SUPPRIMER' };

function setup(
  opts: {
    outcome?: DeleteUserResult;
    rate?: unknown;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const admin = fakeRpc({
    consume_rate_limit:
      opts.rate === undefined ? allowQuota : () => ({ data: opts.rate, error: null }),
  });
  const auth = fakeAuth({ 'jeton.utilisateur.supprime': { status: 'not_found' } });
  const deleteUser = vi.fn(async () => opts.outcome ?? 'deleted');
  const logger = memLogger();
  const handler = createDeleteAccountHandler({
    config: loadDeleteAccountConfig(envFromRecord(opts.env ?? BASE_ENV)),
    auth,
    admin,
    deleteUser,
    logger,
  });
  return { handler, deleteUser, logger, admin };
}

describe('delete-account', () => {
  it('sans confirmation → 400 et aucune suppression', async () => {
    const { handler, deleteUser } = setup();
    for (const body of [{}, { confirm: 'oui' }, { confirm: 'supprimer' }, { confirm: true }]) {
      const res = await handler(jsonRequest(URL_FN, body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('confirmation_required');
    }
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('corps absent ou non JSON → 400 confirmation_required', async () => {
    const { handler, deleteUser } = setup();
    expect((await handler(jsonRequest(URL_FN, ''))).status).toBe(400);
    expect((await handler(jsonRequest(URL_FN, 'SUPPRIMER'))).status).toBe(400);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('champ supplémentaire (ex. user_id d’un autre compte) → 400', async () => {
    const { handler, deleteUser } = setup();
    const res = await handler(jsonRequest(URL_FN, { ...CONFIRM, user_id: 'autre' }));
    expect(res.status).toBe(400);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('confirmation exacte → supprime l’utilisateur du JWT uniquement', async () => {
    const { handler, deleteUser } = setup();
    const res = await handler(jsonRequest(URL_FN, CONFIRM));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(deleteUser).toHaveBeenCalledWith(USER_ID);
  });

  it('sans authentification → 401', async () => {
    const { handler, deleteUser } = setup();
    expect((await handler(jsonRequest(URL_FN, CONFIRM, { jwt: null }))).status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('méthodes autres que POST → 405', async () => {
    const { handler } = setup();
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await handler(jsonRequest(URL_FN, method === 'GET' ? '' : CONFIRM, { method }));
      expect(res.status).toBe(405);
    }
  });

  it('origine non autorisée → 403 sans en-tête CORS', async () => {
    const { handler, deleteUser } = setup();
    const res = await handler(jsonRequest(URL_FN, CONFIRM, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('idempotent : compte déjà supprimé (jeton encore valide) → 200', async () => {
    const { handler, deleteUser } = setup();
    const res = await handler(jsonRequest(URL_FN, CONFIRM, { jwt: 'jeton.utilisateur.supprime' }));
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('idempotent : Auth répond « introuvable » à la suppression → 200', async () => {
    const { handler } = setup({ outcome: 'not_found' });
    const res = await handler(jsonRequest(URL_FN, CONFIRM));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, alreadyDeleted: true });
  });

  it('échec de suppression → 500 sans détail', async () => {
    const { handler } = setup({ outcome: 'failed' });
    const res = await handler(jsonRequest(URL_FN, CONFIRM));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('delete_failed');
  });

  it('trop de tentatives → 429 ; limiteur indisponible → 503 (échec fermé)', async () => {
    const denied = setup({ rate: { allowed: false, retry_after_seconds: 120 } });
    const res = await denied.handler(jsonRequest(URL_FN, CONFIRM));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(denied.deleteUser).not.toHaveBeenCalled();
    const broken = setup({ rate: 'pas un objet' });
    expect((await broken.handler(jsonRequest(URL_FN, CONFIRM))).status).toBe(503);
    expect(broken.deleteUser).not.toHaveBeenCalled();
  });

  it('journal sans identifiant brut', async () => {
    const { handler, logger } = setup();
    await handler(jsonRequest(URL_FN, CONFIRM));
    const log = logger.lines.join('\n');
    expect(log).toContain('account_deleted');
    expect(log).not.toContain(USER_ID);
  });

  it('contrat client ↔ serveur : le client web envoie la confirmation attendue', async () => {
    const { handler, deleteUser } = setup();
    // Le vrai client (apps/web/src/lib/account.ts) appelle le vrai handler.
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set('origin', ORIGIN);
      return handler(new Request(url, { ...init, headers }));
    }) as unknown as typeof fetch;
    await deleteAccount({
      supabaseUrl: 'https://x.supabase.co',
      anonKey: 'anon',
      client: {
        auth: { getSession: async () => ({ data: { session: { access_token: VALID_JWT } } }) },
      },
      fetchImpl,
    });
    expect(deleteUser).toHaveBeenCalledWith(USER_ID);
  });
});
