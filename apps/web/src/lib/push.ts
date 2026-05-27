/**
 * Push Web — abonnement Service Worker + persistance Supabase.
 *
 * Pipeline :
 *   1. `enablePush()` — récupère la clé publique VAPID, demande la permission,
 *      appelle `pushManager.subscribe()` sur l'enregistrement SW courant.
 *   2. La subscription (PushSubscriptionJSON) est stockée :
 *        - en cache local (STORAGE_KEYS.PUSH_SUBSCRIPTION) pour re-sync hors-ligne
 *        - dans Supabase (table `push_subscriptions`) pour permettre à l'Edge
 *          Function `send-push` d'envoyer des notifs depuis le backend.
 *   3. `disablePush()` — révoque la subscription et la supprime côté serveur.
 *
 * Dégrade gracieusement sur navigateurs sans Push (iOS standalone non-PWA, etc.).
 */

import { STORAGE_KEYS } from '@kinetic/core';

const VAPID_PUBLIC_KEY: string | undefined = (
  import.meta as ImportMeta & { env?: Record<string, string> }
).env?.VITE_VAPID_PUBLIC_KEY;

export interface PushStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
}

/** Status synchrone — utile pour afficher l'état dans l'UI sans `await`. */
export function getPushStatus(): PushStatus {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    typeof Notification === 'undefined'
  ) {
    return { supported: false, permission: 'unsupported', subscribed: false };
  }
  let cached = false;
  try {
    cached = !!localStorage.getItem(STORAGE_KEYS.PUSH_SUBSCRIPTION);
  } catch {
    /* localStorage indisponible (Safari privé) */
  }
  return {
    supported: true,
    permission: Notification.permission,
    subscribed: cached,
  };
}

/**
 * isPushAvailable — vrai si le navigateur supporte le push ET qu'une clé
 * VAPID publique est configurée côté build. Si la clé manque, le subscribe
 * crasherait — autant désactiver l'UI proprement.
 */
export function isPushAvailable(): boolean {
  return getPushStatus().supported && !!VAPID_PUBLIC_KEY;
}

/**
 * enablePush — demande la permission, s'abonne, persiste côté serveur.
 * Renvoie la subscription (au format JSON) ou null en cas d'échec.
 */
export async function enablePush(): Promise<PushSubscriptionJSON | null> {
  if (!isPushAvailable()) return null;
  try {
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') return null;
    } else if (Notification.permission !== 'granted') {
      return null;
    }

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // ArrayBuffer cast : pushManager.subscribe accepte BufferSource mais
        // TS lib.dom restreint à ArrayBuffer concret ; on copie pour assurer.
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!).buffer as ArrayBuffer,
      }));

    const json = subscription.toJSON();
    try {
      localStorage.setItem(STORAGE_KEYS.PUSH_SUBSCRIPTION, JSON.stringify(json));
    } catch {
      /* noop */
    }
    await persistSubscription(json);
    return json;
  } catch (err) {
    console.error('[push] enable failed:', err);
    return null;
  }
}

/**
 * disablePush — révoque la subscription locale et la supprime côté serveur.
 * On essaie la suppression serveur en best-effort : si elle échoue, la
 * subscription locale est de toute façon invalidée — l'orphan côté Supabase
 * sera ignoré par l'Edge Function (404 du push, on nettoie).
 */
export async function disablePush(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await deleteSubscription(endpoint).catch(() => null);
    }
    try {
      localStorage.removeItem(STORAGE_KEYS.PUSH_SUBSCRIPTION);
    } catch {
      /* noop */
    }
    return true;
  } catch (err) {
    console.error('[push] disable failed:', err);
    return false;
  }
}

// ─── Persistance Supabase ─────────────────────────────────────────────────

async function persistSubscription(sub: PushSubscriptionJSON): Promise<void> {
  try {
    const { supabase } = await import('@kinetic/adapters-web');
    if (!supabase) return;
    const sb = supabase as unknown as {
      auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
      from: (t: string) => {
        upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) => Promise<unknown>;
      };
    };
    const { data } = await sb.auth.getUser();
    if (!data.user) return; // user offline / anonyme → on garde uniquement le cache local
    await sb.from('push_subscriptions').upsert(
      {
        user_id: data.user.id,
        endpoint: sub.endpoint,
        p256dh: sub.keys?.p256dh ?? '',
        auth: sub.keys?.auth ?? '',
        user_agent:
          typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : 'unknown',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    );
  } catch (err) {
    console.warn('[push] persistSubscription failed (offline ok):', err);
  }
}

async function deleteSubscription(endpoint: string): Promise<void> {
  try {
    const { supabase } = await import('@kinetic/adapters-web');
    if (!supabase) return;
    const sb = supabase as unknown as {
      from: (t: string) => {
        delete: () => { eq: (col: string, val: string) => Promise<unknown> };
      };
    };
    await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
  } catch (err) {
    console.warn('[push] deleteSubscription failed (offline ok):', err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convertit la clé publique VAPID (base64url) en Uint8Array attendu par
 * `pushManager.subscribe()`.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
