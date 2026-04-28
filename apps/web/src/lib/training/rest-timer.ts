/**
 * Rest Timer — compte à rebours entre les séries.
 *
 * Offert en bonus : vibration (Vibration API) et notification système
 * (Notification API) à la fin du décompte. Dégrade gracieusement si les
 * permissions ne sont pas accordées — le timer lui-même est toujours fiable.
 */

export interface RestTimerOptions {
  durationSec: number;
  onTick?:  (remainingSec: number) => void;
  onDone?:  () => void;
  vibrate?: boolean;          // défaut true
  notify?:  boolean;          // défaut true
  label?:   string;           // ex: "Prêt pour la prochaine série"
}

export interface RestTimerHandle {
  remaining: () => number;
  isRunning: () => boolean;
  pause:     () => void;
  resume:    () => void;
  stop:      () => void;          // annule, ne déclenche pas onDone
  skip:      () => void;          // termine, déclenche onDone
}

const VIBRATION_PATTERN = [200, 80, 200];

export function startRestTimer(opts: RestTimerOptions): RestTimerHandle {
  const total = Math.max(1, Math.floor(opts.durationSec));
  let remaining = total;
  let timerId: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  let stopped = false;

  const tick = () => {
    if (paused || stopped) return;
    remaining -= 1;
    opts.onTick?.(remaining);
    if (remaining <= 0) {
      cleanup();
      fireDone();
    }
  };

  const cleanup = () => {
    if (timerId) clearInterval(timerId);
    timerId = null;
  };

  const fireDone = () => {
    if (opts.vibrate !== false) tryVibrate();
    if (opts.notify !== false)  tryNotify(opts.label ?? 'Série suivante !');
    opts.onDone?.();
  };

  opts.onTick?.(remaining);
  timerId = setInterval(tick, 1000);

  return {
    remaining: () => remaining,
    isRunning: () => timerId !== null && !paused,
    pause() { paused = true; },
    resume() { paused = false; },
    stop() {
      stopped = true;
      cleanup();
    },
    skip() {
      stopped = true;
      cleanup();
      fireDone();
    },
  };
}

// ─── Permissions & effets optionnels ─────────────────────────────────────────

function tryVibrate(): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(VIBRATION_PATTERN);
    }
  } catch {
    /* noop */
  }
}

function tryNotify(body: string): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification('Kinetic — Repos terminé', { body, silent: false });
    }
  } catch {
    /* noop */
  }
}

/**
 * requestNotificationPermission — à appeler sur interaction utilisateur
 * (Safari/iOS exigent un geste direct).
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * suggestedRestSec — recommandation simple selon l'intensité RPE.
 *   force (RPE >= 9) : 3 min
 *   hypertrophie (7-8) : 90 s
 *   endurance (<= 6) : 60 s
 */
export function suggestedRestSec(rpe: number): number {
  if (rpe >= 9) return 180;
  if (rpe >= 7) return 90;
  return 60;
}
