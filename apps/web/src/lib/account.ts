/**
 * Suppression définitive du compte (Edge Function `delete-account`).
 * Efface toutes les données serveur puis les données locales de l'appareil.
 */
import { STORAGE_KEYS } from '@kinetic/core';

type SessionClient = {
  auth: { getSession: () => Promise<{ data: { session: { access_token: string } | null } }> };
};

export interface DeleteAccountDeps {
  supabaseUrl: string;
  anonKey: string;
  client: SessionClient | null;
  fetchImpl?: typeof fetch;
}

export async function deleteAccount(deps: DeleteAccountDeps): Promise<void> {
  if (!deps.client || !deps.supabaseUrl) throw new Error('Aucun compte connecté.');
  const { data } = await deps.client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Session expirée : reconnecte-toi puis réessaie.');

  const resp = await (deps.fetchImpl ?? fetch)(
    `${deps.supabaseUrl.replace(/\/$/, '')}/functions/v1/delete-account`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: deps.anonKey,
      },
      body: JSON.stringify({ confirm: 'SUPPRIMER' }),
    },
  );
  if (!resp.ok) {
    throw new Error(
      resp.status === 401
        ? 'Session expirée : reconnecte-toi puis réessaie.'
        : `La suppression a échoué (HTTP ${resp.status}). Tes données sont intactes.`,
    );
  }
}

/** Clé utilisée pour afficher un message sur l'écran de connexion après suppression. */
export const ACCOUNT_DELETED_FLAG = STORAGE_KEYS.ACCOUNT_DELETED;
