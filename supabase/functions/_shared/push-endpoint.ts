/**
 * Validation des endpoints Web Push (anti-SSRF).
 *
 * Un endpoint est accepté seulement s'il pointe, en HTTPS sur le port par
 * défaut, vers un service de push connu. Les adresses IP littérales, ports
 * explicites, identifiants dans l'URL et hôtes inconnus sont refusés : la
 * fonction `send-push` ne peut donc pas servir à atteindre le réseau interne
 * (métadonnées cloud 169.254.169.254, localhost, 10.0.0.0/8…) ni un tiers.
 *
 * Liste alignée sur la contrainte SQL de `push_subscriptions`
 * (migration 011, voir docs/architecture/security.md).
 */

/** Hôtes exacts autorisés. */
export const PUSH_EXACT_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];

/** Suffixes autorisés (sous-domaines uniquement, au moins un label avant). */
export const PUSH_HOST_SUFFIXES: readonly string[] = [
  '.push.apple.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
];

export const MAX_ENDPOINT_LENGTH = 1000;

export type EndpointCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isAllowedPushHost(host: string): boolean {
  if (PUSH_EXACT_HOSTS.includes(host)) return true;
  return PUSH_HOST_SUFFIXES.some((suffix) => {
    if (!host.endsWith(suffix)) return false;
    const prefix = host.slice(0, -suffix.length);
    return prefix.length > 0 && prefix.split('.').every((label) => LABEL.test(label));
  });
}

export function checkPushEndpoint(raw: unknown): EndpointCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'vide' };
  if (raw.length > MAX_ENDPOINT_LENGTH) return { ok: false, reason: 'trop_long' };
  // Avant tout parse : schéma https littéral (l'analyseur d'URL tolère des
  // variantes comme « HTTPS:/\ » qu'on ne veut pas accepter).
  if (!raw.startsWith('https://')) return { ok: false, reason: 'https_requis' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'url_invalide' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'https_requis' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'identifiants' };
  // Le port explicite 443 est normalisé en '' par URL ; tout autre est refusé.
  if (url.port !== '') return { ok: false, reason: 'port_interdit' };
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    return { ok: false, reason: 'ip_litterale' };
  }
  if (!isAllowedPushHost(host)) return { ok: false, reason: 'hote_non_autorise' };
  return { ok: true, url: url.toString() };
}
