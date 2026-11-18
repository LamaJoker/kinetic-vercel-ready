/**
 * lib/avatar.ts
 *
 * Texte affiché dans l'avatar (accueil, profil). Ordre de priorité :
 *   1. l'initiale du nom de profil local (Profil → « Ton prénom »), même sans compte ;
 *   2. les initiales du compte connecté (nom complet, sinon e-mail) ;
 *   3. rien : l'avatar affiche alors une silhouette (jamais « ? »).
 */

/** Utilisateur minimal (sous-ensemble de AuthUser). */
export interface AvatarUser {
  id: string;
  email: string | null;
  full_name: string | null;
}

/** Première lettre (graphème complet : accents, émojis) d'un nom, en majuscule. */
export function firstInitial(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  const first = Array.from(trimmed)[0] ?? '';
  return first.toLocaleUpperCase('fr-FR');
}

/** Initiales (2 au plus) d'un nom complet ou d'une adresse e-mail. */
export function accountInitials(user: AvatarUser | null | undefined): string {
  const source = user?.full_name?.trim() || user?.email?.trim() || '';
  return source
    .split(/\s+|@/)
    .filter(Boolean)
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toLocaleUpperCase('fr-FR')
    .slice(0, 2);
}

/**
 * Texte de l'avatar, ou '' pour afficher la silhouette.
 * Le compte invité (id 'guest', nom « Invité ») ne compte pas comme un nom.
 */
export function avatarText(
  profileName: string | null | undefined,
  user: AvatarUser | null | undefined,
): string {
  const local = firstInitial(profileName);
  if (local) return local;
  if (!user || user.id === 'guest') return '';
  return accountInitials(user);
}
