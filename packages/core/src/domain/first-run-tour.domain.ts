/**
 * Visite de première utilisation : étapes, décision de lancement et placement
 * des bulles. Pur, zéro I/O (l'affichage est dans apps/web/src/lib/first-run-tour.ts).
 */

/** Petite animation qui mime le geste quand il n'y a rien à montrer à l'écran. */
export type TourGesture = 'hold' | 'swipe' | 'pull';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Sélecteurs CSS essayés dans l'ordre ; aucun trouvé → bulle centrée. */
  targets: readonly string[];
  gesture?: TourGesture;
  /** Texte quand l'élément n'est pas (encore) à l'écran. */
  fallbackBody?: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'today',
    title: 'Ta séance du jour',
    body: 'Ici, la séance prévue aujourd’hui. Un appui sur « Commencer la séance » et c’est parti.',
    targets: ['section[aria-label="Séance du jour"]'],
  },
  {
    id: 'quick-log',
    title: 'Saisie rapide',
    body: 'Pendant la séance, ajuste poids et répétitions d’un geste, puis « Même chose » recopie la série précédente.',
    targets: ['nav[aria-label="Navigation principale"] a[href="/seances"]'],
  },
  {
    id: 'hold',
    title: 'Appui long',
    body: 'Garde le doigt appuyé sur une ligne (exercice, aliment, record) pour ouvrir ses actions.',
    targets: [],
    gesture: 'hold',
  },
  {
    id: 'swipe',
    title: 'Glisser une ligne',
    body: 'Fais glisser une série ou une tâche vers la gauche pour la supprimer, vers la droite pour la valider.',
    targets: [],
    gesture: 'swipe',
  },
  {
    id: 'pull',
    title: 'Tirer pour rafraîchir',
    body: 'En haut d’une page, tire vers le bas pour tout mettre à jour.',
    targets: ['#app-outlet h1[data-large-title]', '#app-outlet h1'],
    gesture: 'pull',
  },
  {
    id: 'checkin',
    title: 'Check-in du matin',
    body: 'Sommeil, énergie, courbatures : trois touches chaque matin pour adapter tes séances.',
    targets: ['section[aria-labelledby="form-title"]'],
    fallbackBody:
      'Sommeil, énergie, courbatures : trois touches chaque matin (onglet Récup) pour adapter tes séances.',
  },
  {
    id: 'muscles',
    title: 'Carte des muscles',
    body: 'Vois d’un coup d’œil les muscles travaillés et ceux qui récupèrent encore.',
    targets: ['section[x-data="muscleMap"]'],
    fallbackBody:
      'Après ta première séance, la carte des muscles apparaît ici : muscles travaillés et récupération. Le détail est dans Progression.',
  },
];

/** État mémorisé : 'pending' à lancer, 'replay' relancée depuis le profil, 'done' vue. */
export type TourState = 'pending' | 'replay' | 'done' | null;

export function parseTourState(raw: unknown): TourState {
  return raw === 'pending' || raw === 'replay' || raw === 'done' ? raw : null;
}

/**
 * État à mémoriser à la fin de l'onboarding : la visite n'est proposée qu'une
 * fois (déjà vue → on n'y revient pas).
 */
export function tourStateAfterOnboarding(current: TourState): TourState {
  return current === 'done' ? 'done' : 'pending';
}

export interface TourStartContext {
  state: TourState;
  /** Build des tests de bout en bout (VITE_E2E). */
  e2eBuild: boolean;
  /** window.__kineticSkipOnboarding posé par un test. */
  skipFlag: boolean;
}

/** Lancement automatique : seulement en attente, jamais pendant les tests ; relance manuelle toujours. */
export function shouldStartTour(ctx: TourStartContext): boolean {
  if (ctx.state === 'replay') return !ctx.skipFlag;
  if (ctx.state !== 'pending') return false;
  return !ctx.e2eBuild && !ctx.skipFlag;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
  /** Zones réservées (encoche, barre d'onglets…). */
  safeTop?: number;
  safeBottom?: number;
}

/** Découpe lumineuse autour de la cible : marge, puis restreinte à l'écran. */
export function spotlightRect(target: Rect, viewport: Viewport, pad = 8): Rect {
  const top = Math.max(0, target.top - pad);
  const left = Math.max(0, target.left - pad);
  const bottom = Math.min(viewport.height, target.top + target.height + pad);
  const right = Math.min(viewport.width, target.left + target.width + pad);
  return {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Cible trop haute pour laisser la bulle au-dessus ou en dessous : on n'éclaire
 * que sa partie haute (titre et début du contenu).
 */
export function cropSpotForBubble(
  spot: Rect,
  bubbleHeight: number,
  viewport: Viewport,
  gap = 14,
  margin = 16,
): Rect {
  const room = Math.floor(
    viewport.height - (viewport.safeBottom ?? 0) - margin - gap - bubbleHeight - spot.top,
  );
  const minVisible = 56;
  if (spot.height <= room) return spot;
  // La bulle tient au-dessus de la cible : rien à rogner.
  if (spot.top - gap - bubbleHeight >= (viewport.safeTop ?? 0) + margin) return spot;
  return { ...spot, height: Math.max(minVisible, Math.round(room)) };
}

/**
 * Défilement (en px, positif vers le bas) pour poser la cible sous l'en-tête
 * compact en gardant la place de la bulle en dessous ; 0 si elle est déjà bien placée.
 */
export function scrollDeltaForTarget(
  target: Rect,
  viewport: Viewport,
  bubbleHeight: number,
  headerHeight = 76,
  gap = 14,
  margin = 16,
): number {
  const free = viewport.height - headerHeight - (viewport.safeBottom ?? 0) - margin;
  const block = target.height + gap + bubbleHeight;
  const desiredTop =
    block <= free ? headerHeight + Math.round((free - block) / 2) : headerHeight + 8;
  const delta = Math.round(target.top - desiredTop);
  // Bloc (cible + bulle) déjà entièrement visible sous l'en-tête, ou presque à sa place.
  const fitsNow =
    block <= free &&
    target.top >= headerHeight &&
    target.top + block <= viewport.height - (viewport.safeBottom ?? 0) - margin;
  return fitsNow || Math.abs(delta) < 24 ? 0 : delta;
}

export interface BubblePlacement {
  placement: 'above' | 'below' | 'center';
  top: number;
  left: number;
  /** Position horizontale de la flèche dans la bulle (px depuis son bord gauche). */
  arrowX: number;
}

/**
 * Place la bulle sous la découpe s'il y a la place, sinon au-dessus, sinon au
 * centre ; centrée horizontalement sur la cible, sans sortir de l'écran.
 */
export function placeBubble(
  spot: Rect | null,
  bubble: { width: number; height: number },
  viewport: Viewport,
  gap = 14,
  margin = 16,
): BubblePlacement {
  const safeTop = viewport.safeTop ?? 0;
  const safeBottom = viewport.safeBottom ?? 0;
  const width = Math.min(bubble.width, viewport.width - margin * 2);
  const centerLeft = Math.round((viewport.width - width) / 2);
  if (!spot) {
    return {
      placement: 'center',
      top: Math.max(safeTop + margin, Math.round((viewport.height - bubble.height) / 2)),
      left: centerLeft,
      arrowX: width / 2,
    };
  }
  const targetCenter = spot.left + spot.width / 2;
  const left = Math.round(
    Math.min(viewport.width - margin - width, Math.max(margin, targetCenter - width / 2)),
  );
  const arrowX = Math.min(width - 22, Math.max(22, targetCenter - left));
  const below = spot.top + spot.height + gap;
  if (below + bubble.height <= viewport.height - safeBottom - margin + 1) {
    return { placement: 'below', top: Math.round(below), left, arrowX };
  }
  const above = spot.top - gap - bubble.height;
  if (above >= safeTop + margin) {
    return { placement: 'above', top: Math.round(above), left, arrowX };
  }
  return {
    placement: 'center',
    top: Math.max(safeTop + margin, Math.round((viewport.height - bubble.height) / 2)),
    left: centerLeft,
    arrowX: width / 2,
  };
}

/** « 3 / 7 » */
export function tourProgressLabel(index: number, total: number): string {
  return `${index + 1} / ${total}`;
}
