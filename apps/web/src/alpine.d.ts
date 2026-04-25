/**
 * apps/web/src/alpine.d.ts
 *
 * Shim de types pour alpinejs — pas de @types/alpinejs disponible.
 * Couvre uniquement les APIs utilisées dans ce projet.
 */

declare module 'alpinejs' {
  export interface AlpineComponent {
    [key: string]: unknown;
  }

  export interface Alpine {
    store(name: string): unknown;
    store(name: string, value: unknown): void;
    data(name: string, callback: () => object): void;
    bind(el: HTMLElement, bindings: Record<string, unknown>): void;
    initTree(el: HTMLElement): void;
    start(): void;
  }

  const Alpine: Alpine;
  export default Alpine;
}

// Extend Window so `window.Alpine` doesn't error in router.ts
interface Window {
  Alpine?: import('alpinejs').Alpine;
  // Globals exposed for inline HTML page scripts (classic scripts that cannot
  // use module imports). Set once in main.ts before the router runs.
  __kinetic?: {
    getDeps: () => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exportAsJson: (...args: any[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exportAsCsv: (...args: any[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mealTimingPlan: (...args: any[]) => unknown[];
  };
}
