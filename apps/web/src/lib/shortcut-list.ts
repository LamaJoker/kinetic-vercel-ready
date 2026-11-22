/**
 * Raccourcis présentés dans Profil › Raccourcis (titres, liens à copier) et
 * texte de confirmation du verre d'eau. Chargé à la demande (hors démarrage).
 */
import { SHORTCUT_LINKS, shortcutUrl, type ShortcutAction } from './deep-link';

export interface ShortcutDef {
  /** Fin du lien : com.lamajoker.kinetic://open/<slug>. */
  slug: string;
  /** Page ouverte. */
  route: string;
  action: ShortcutAction | null;
  title: string;
  hint: string;
  url: string;
}

const TEXTS: ReadonlyArray<{ slug: string; title: string; hint: string }> = [
  { slug: 'seance-du-jour', title: 'Séance du jour', hint: 'Démarre la séance prévue aujourd’hui' },
  { slug: 'pesee', title: 'Pesée', hint: 'Ouvre la saisie du poids' },
  { slug: 'eau', title: 'Un verre d’eau', hint: 'Ajoute un verre et le confirme' },
  { slug: 'checkin', title: 'Check-in du matin', hint: 'Sommeil, énergie, courbatures' },
  { slug: 'minuteurs', title: 'Minuteurs', hint: 'EMOM, AMRAP, Tabata, intervalles' },
];

/** Raccourcis proposés, dans l'ordre d'affichage. */
export const SHORTCUTS: readonly ShortcutDef[] = TEXTS.filter((t) => t.slug in SHORTCUT_LINKS).map(
  (t) => ({ ...t, ...SHORTCUT_LINKS[t.slug]!, url: shortcutUrl(t.slug) }),
);

/** Message de confirmation après un verre ajouté par raccourci. */
export function waterShortcutMessage(
  glassLabel: string,
  totalLabel: string,
  goalLabel: string,
  reached: boolean,
): string {
  return reached
    ? `Verre ajouté (${glassLabel}) : objectif atteint, ${totalLabel} aujourd’hui.`
    : `Verre ajouté (${glassLabel}) : ${totalLabel} sur ${goalLabel} aujourd’hui.`;
}
