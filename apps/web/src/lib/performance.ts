/**
 * Utilitaires perf runtime.
 *
 * Les pages sont désormais bundlées par Vite (via import.meta.glob dans
 * router.ts), donc le chargement dynamique n'existe plus côté client —
 * le loader/prefetch est retiré. Restent les helpers UI utiles.
 */

import { STORAGE_KEYS } from '@kinetic/core';

// ─── Skeletons ───────────────────────────────────────────────

export type SkeletonType = 'task-list' | 'dashboard' | 'profile' | 'xp-bar';

const SKELETONS: Record<SkeletonType, string> = {
  'task-list': `
    <div class="animate-pulse space-y-3">
      ${Array(4)
        .fill(
          `
        <div class="flex items-center gap-4 p-4 bg-gray-800 rounded-2xl">
          <div class="w-12 h-12 bg-gray-700 rounded-xl flex-shrink-0"></div>
          <div class="flex-1 space-y-2">
            <div class="h-4 bg-gray-700 rounded w-3/4"></div>
            <div class="h-3 bg-gray-700 rounded w-1/4"></div>
          </div>
        </div>
      `,
        )
        .join('')}
    </div>`,
  dashboard: `
    <div class="animate-pulse space-y-4">
      <div class="flex justify-between items-center">
        <div class="space-y-2">
          <div class="h-6 bg-gray-700 rounded w-40"></div>
          <div class="h-4 bg-gray-700 rounded w-32"></div>
        </div>
        <div class="w-10 h-10 bg-gray-700 rounded-full"></div>
      </div>
      <div class="h-24 bg-gray-800 rounded-2xl"></div>
      <div class="h-32 bg-gray-800 rounded-2xl"></div>
      <div class="h-20 bg-gray-700 rounded-2xl"></div>
    </div>`,
  profile: `
    <div class="animate-pulse space-y-4">
      <div class="flex items-center gap-4">
        <div class="w-16 h-16 bg-gray-700 rounded-full"></div>
        <div class="space-y-2">
          <div class="h-5 bg-gray-700 rounded w-32"></div>
          <div class="h-4 bg-gray-700 rounded w-24"></div>
        </div>
      </div>
      <div class="h-4 bg-gray-700 rounded w-full"></div>
      <div class="h-4 bg-gray-700 rounded w-5/6"></div>
    </div>`,
  'xp-bar': `
    <div class="animate-pulse bg-gray-800 rounded-2xl p-4">
      <div class="flex justify-between mb-2">
        <div class="h-4 bg-gray-700 rounded w-24"></div>
        <div class="h-4 bg-gray-700 rounded w-16"></div>
      </div>
      <div class="h-2 bg-gray-700 rounded-full"></div>
      <div class="h-3 bg-gray-700 rounded w-32 mt-1"></div>
    </div>`,
};

export function getSkeletonHtml(type: SkeletonType): string {
  return SKELETONS[type];
}

export function showSkeleton(container: HTMLElement, type: SkeletonType): () => void {
  const node = document.createElement('div');
  node.setAttribute('data-skeleton', type);
  node.innerHTML = getSkeletonHtml(type);
  container.appendChild(node);
  return () => {
    node.style.transition = 'opacity 0.2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  };
}

// ─── Lazy images ─────────────────────────────────────────────

let _imageObserver: IntersectionObserver | null = null;

function getImageObserver(): IntersectionObserver {
  if (_imageObserver) return _imageObserver;
  _imageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target as HTMLImageElement;
        const src = img.dataset['lazySrc'];
        if (src) {
          img.src = src;
          img.removeAttribute('data-lazy-src');
          _imageObserver!.unobserve(img);
        }
      }
    },
    { rootMargin: '100px' },
  );
  return _imageObserver;
}

export function lazyLoadImage(img: HTMLImageElement): void {
  getImageObserver().observe(img);
}

export function initLazyImages(): void {
  document.querySelectorAll<HTMLImageElement>('img[data-lazy-src]').forEach(lazyLoadImage);
}

// ─── Debounce / Throttle ─────────────────────────────────────

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= ms) {
      lastCall = now;
      fn(...args);
    }
  };
}

// ─── requestIdleCallback polyfill (Safari) ──────────────────────

type IdleCb = (deadline: { didTimeout: boolean; timeRemaining(): number }) => void;

export const ric: (cb: IdleCb, opts?: { timeout?: number }) => number =
  (globalThis as { requestIdleCallback?: (cb: IdleCb, opts?: { timeout?: number }) => number })
    .requestIdleCallback ??
  ((cb, opts) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), opts?.timeout ?? 1));

// ─── Après le premier écran ──────────────────────────────────

/** Événement du routeur : une page vient d'être affichée. */
const ROUTE_CHANGED = STORAGE_KEYS.EVENT_ROUTE_CHANGED;
/** Filet : si aucune page n'est affichée (erreur), le travail part quand même. */
export const FIRST_RENDER_FALLBACK_MS = 5000;

let firstRenderDone = false;
let firstRenderWaiters: Array<() => void> = [];

function flushFirstRender(): void {
  if (firstRenderDone) return;
  firstRenderDone = true;
  const waiters = firstRenderWaiters;
  firstRenderWaiters = [];
  for (const run of waiters) run();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(ROUTE_CHANGED, flushFirstRender, { once: true });
  setTimeout(flushFirstRender, FIRST_RENDER_FALLBACK_MS);
}

/**
 * Lance `cb` une fois le premier écran affiché, pendant un temps mort
 * (requestIdleCallback, au plus `timeout` ms d'attente). Pour tout ce qui
 * n'est pas utile à la première image : synchro, rappels, défis, sauvegarde
 * automatique, préchargements, nettoyage du stockage.
 */
export function afterFirstRender(cb: () => void, timeout = 2000): void {
  const run = (): void => {
    ric(
      () => {
        try {
          cb();
        } catch (err) {
          console.warn('[perf] tâche différée en échec :', err);
        }
      },
      { timeout },
    );
  };
  if (firstRenderDone) run();
  else firstRenderWaiters.push(run);
}

/** Tests : remet l'attente du premier écran à zéro (ou la marque comme passée). */
export function _setFirstRenderDoneForTesting(done: boolean): void {
  firstRenderDone = done;
  if (!done) firstRenderWaiters = [];
}
