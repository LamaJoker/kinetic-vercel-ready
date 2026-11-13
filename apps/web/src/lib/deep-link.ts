const DEEP_LINK_PREFIX = 'com.lamajoker.kinetic://open/';

/**
 * Route interne visée par un lien `com.lamajoker.kinetic://open/<page>` (widget,
 * notification). `null` pour tout autre lien, dont le retour de connexion.
 */
export function deepLinkRoute(url: string): string | null {
  if (!url.startsWith(DEEP_LINK_PREFIX)) return null;
  const page = url.slice(DEEP_LINK_PREFIX.length).split(/[?#]/)[0] ?? '';
  return /^[a-z][a-z-]*$/.test(page) ? `/${page}` : '/';
}
