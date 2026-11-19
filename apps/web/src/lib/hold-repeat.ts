/**
 * Appui maintenu = répétition accélérée — directive Alpine `x-hold`.
 *
 *   <button type="button" x-hold="bumpWeight(1)" aria-label="Augmenter la charge">+</button>
 *
 * - Toucher bref : UNE exécution, au relâcher (un défilement qui commence sur le
 *   bouton n'incrémente donc rien : le navigateur annule le pointeur).
 * - Appui maintenu : première exécution après HOLD_DELAY_MS, puis répétitions
 *   de plus en plus rapprochées (holdInterval), jusqu'au relâcher.
 * - Clavier (Entrée / Espace → click sans pointeur) : une exécution.
 * - La vibration reste à la charge de l'expression (bumpWeight, bumpReps… font
 *   déjà hapticLight ; l'anti-rafale de haptics.ts limite les répétitions).
 *
 * Chargé à la demande (stub dans lazy-directives.ts).
 */

export const HOLD_DELAY_MS = 380;
export const HOLD_FIRST_INTERVAL_MS = 170;
export const HOLD_MIN_INTERVAL_MS = 45;
export const HOLD_MOVE_CANCEL_PX = 12;
/** Garde-fou : jamais plus de N répétitions pour un même appui (≈ 10 s). */
export const HOLD_MAX_REPEATS = 220;

/** Intervalle avant la répétition n° `n` (0, 1, 2…) : accélère puis plafonne. */
export function holdInterval(n: number): number {
  return Math.max(HOLD_MIN_INTERVAL_MS, Math.round(HOLD_FIRST_INTERVAL_MS * Math.pow(0.86, n)));
}

/**
 * Branche l'appui maintenu sur `el` ; `step` exécute une fois l'expression.
 * Retourne la fonction de nettoyage.
 */
export function bindHoldRepeat(el: HTMLElement, step: () => void): () => void {
  let pointerId: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let repeats = 0;
  let startX = 0;
  let startY = 0;

  const stopTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  // Garde-fous : le relâcher peut se perdre (doigt levé hors du bouton sans
  // capture, bouton retiré ou désactivé par le rendu, app mise en arrière-plan).
  const abort = (): void => {
    stopTimer();
    pointerId = null;
    el.classList.remove('is-holding');
    unwatch();
  };
  const onWindowUp = (e: PointerEvent): void => {
    if (e.pointerId === pointerId) abort();
  };
  const onHidden = (): void => {
    if (doc && doc.visibilityState !== 'visible') abort();
  };
  const win = typeof window === 'undefined' ? null : window;
  const doc = typeof document === 'undefined' ? null : document;
  const watch = (): void => {
    win?.addEventListener('pointerup', onWindowUp, true);
    win?.addEventListener('pointercancel', onWindowUp, true);
    win?.addEventListener('blur', abort);
    doc?.addEventListener('visibilitychange', onHidden);
  };
  function unwatch(): void {
    win?.removeEventListener('pointerup', onWindowUp, true);
    win?.removeEventListener('pointercancel', onWindowUp, true);
    win?.removeEventListener('blur', abort);
    doc?.removeEventListener('visibilitychange', onHidden);
  }

  const tick = (): void => {
    if (
      el.isConnected === false ||
      (el as HTMLButtonElement).disabled ||
      repeats >= HOLD_MAX_REPEATS
    ) {
      abort();
      return;
    }
    step();
    timer = setTimeout(tick, holdInterval(repeats++));
  };

  const onDown = (e: PointerEvent): void => {
    if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if ((el as HTMLButtonElement).disabled) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    repeats = 0;
    el.classList.add('is-holding');
    timer = setTimeout(tick, HOLD_DELAY_MS);
    watch();
  };

  const finish = (e: PointerEvent, commit: boolean): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    // Toucher bref (la répétition n'avait pas commencé) : une exécution.
    const tap = timer !== null && repeats === 0;
    stopTimer();
    unwatch();
    el.classList.remove('is-holding');
    if (commit && tap) step();
  };

  const onUp = (e: PointerEvent): void => finish(e, true);
  const onCancel = (e: PointerEvent): void => finish(e, false);
  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    if (
      Math.abs(e.clientX - startX) > HOLD_MOVE_CANCEL_PX ||
      Math.abs(e.clientY - startY) > HOLD_MOVE_CANCEL_PX
    )
      finish(e, false);
  };
  // Le clic qui suit un pointeur est ignoré (déjà traité) ; clavier : detail = 0.
  const onClick = (e: MouseEvent): void => {
    if (e.detail === 0) step();
  };
  const onContextMenu = (e: Event): void => e.preventDefault(); // appui long iOS/Android

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('pointerleave', onCancel);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('click', onClick);
  el.addEventListener('contextmenu', onContextMenu);

  return () => {
    abort();
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('pointerleave', onCancel);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('click', onClick);
    el.removeEventListener('contextmenu', onContextMenu);
  };
}
