/**
 * Tests pour la lib pwa-install — bannière d'installation PWA.
 *
 * On stub :
 *   - `window.addEventListener` pour capter `beforeinstallprompt`
 *   - `window.matchMedia` pour le test standalone
 *   - `navigator.userAgent` pour la détection iOS
 *   - `localStorage` pour le dismiss persistant
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof localStorage === 'undefined') {
  const store: Record<string, string> = {};
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  } as Storage;
}

// Stub window avec event listener et matchMedia
type Listener = (ev: Event) => void;
const windowListeners = new Map<string, Set<Listener>>();
let mqStandaloneMatches = false;

function installWindow(): void {
  (globalThis as Record<string, unknown>).window = {
    addEventListener(name: string, cb: Listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, new Set());
      windowListeners.get(name)!.add(cb);
    },
    removeEventListener(name: string, cb: Listener) {
      windowListeners.get(name)?.delete(cb);
    },
    matchMedia(_q: string) {
      return { matches: mqStandaloneMatches } as MediaQueryList;
    },
    MSStream: undefined,
  };
}

function installNavigator(opts: { ua: string; standalone?: boolean }): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { userAgent: opts.ua, standalone: opts.standalone ?? false },
  });
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
  windowListeners.clear();
  mqStandaloneMatches = false;
  installWindow();
  installNavigator({ ua: 'Mozilla/5.0 (Chrome) Chrome/120' });
  vi.resetModules();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  windowListeners.clear();
});

describe('pwa-install', () => {
  it('initPwaInstallPrompt enregistre un listener beforeinstallprompt', async () => {
    const { initPwaInstallPrompt } = await import('../../apps/web/src/lib/pwa-install.js');
    initPwaInstallPrompt();
    expect(windowListeners.get('beforeinstallprompt')?.size).toBe(1);
  });

  it("pwaInstallPrompt n'affiche pas la bannière si déjà installé en standalone", async () => {
    mqStandaloneMatches = true;
    const { pwaInstallPrompt } = await import('../../apps/web/src/lib/pwa-install.js');
    const inst = pwaInstallPrompt();
    inst.init();
    vi.useFakeTimers();
    vi.advanceTimersByTime(5000);
    expect(inst.visible).toBe(false);
  });

  it("pwaInstallPrompt n'affiche pas la bannière si dismissé récemment", async () => {
    localStorage.setItem('kinetic:pwa:install-dismissed', String(Date.now() - 60_000));
    const { initPwaInstallPrompt, pwaInstallPrompt } =
      await import('../../apps/web/src/lib/pwa-install.js');
    initPwaInstallPrompt();
    // Simule l'événement beforeinstallprompt pour avoir deferredPrompt
    const fakeEvt = {
      preventDefault: vi.fn(),
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    } as unknown as Event;
    windowListeners.get('beforeinstallprompt')?.forEach((cb) => cb(fakeEvt));

    const inst = pwaInstallPrompt();
    inst.init();
    vi.useFakeTimers();
    vi.advanceTimersByTime(5000);
    expect(inst.visible).toBe(false);
  });

  it('pwaInstallPrompt affiche la bannière sur iOS Safari (sans beforeinstallprompt)', async () => {
    installNavigator({
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari',
    });
    const { pwaInstallPrompt } = await import('../../apps/web/src/lib/pwa-install.js');
    const inst = pwaInstallPrompt();
    vi.useFakeTimers();
    inst.init();
    vi.advanceTimersByTime(5000);
    expect(inst.isIos).toBe(true);
    expect(inst.visible).toBe(true);
  });

  it('pwaInstallPrompt affiche la bannière quand beforeinstallprompt a été émis', async () => {
    const { initPwaInstallPrompt, pwaInstallPrompt } =
      await import('../../apps/web/src/lib/pwa-install.js');
    initPwaInstallPrompt();
    const fakeEvt = {
      preventDefault: vi.fn(),
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    } as unknown as Event;
    windowListeners.get('beforeinstallprompt')?.forEach((cb) => cb(fakeEvt));

    const inst = pwaInstallPrompt();
    vi.useFakeTimers();
    inst.init();
    vi.advanceTimersByTime(5000);
    expect(inst.visible).toBe(true);
  });

  it('install() appelle prompt() et masque la bannière sur acceptation', async () => {
    const { initPwaInstallPrompt, pwaInstallPrompt } =
      await import('../../apps/web/src/lib/pwa-install.js');
    initPwaInstallPrompt();
    const prompt = vi.fn(async () => undefined);
    const fakeEvt = {
      preventDefault: vi.fn(),
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    } as unknown as Event;
    windowListeners.get('beforeinstallprompt')?.forEach((cb) => cb(fakeEvt));

    const inst = pwaInstallPrompt();
    vi.useFakeTimers();
    inst.init();
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
    expect(inst.visible).toBe(true);

    await inst.install();
    expect(prompt).toHaveBeenCalled();
    expect(inst.visible).toBe(false);
  });

  it("install() marque dismissed quand l'utilisateur refuse le prompt natif", async () => {
    const { initPwaInstallPrompt, pwaInstallPrompt } =
      await import('../../apps/web/src/lib/pwa-install.js');
    initPwaInstallPrompt();
    const fakeEvt = {
      preventDefault: vi.fn(),
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    } as unknown as Event;
    windowListeners.get('beforeinstallprompt')?.forEach((cb) => cb(fakeEvt));

    const inst = pwaInstallPrompt();
    vi.useFakeTimers();
    inst.init();
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
    await inst.install();
    expect(localStorage.getItem('kinetic:pwa:install-dismissed')).not.toBeNull();
    expect(inst.visible).toBe(false);
  });

  it('dismiss() pose le timestamp et masque', async () => {
    installNavigator({
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari',
    });
    const { pwaInstallPrompt } = await import('../../apps/web/src/lib/pwa-install.js');
    const inst = pwaInstallPrompt();
    vi.useFakeTimers();
    inst.init();
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
    inst.dismiss();
    expect(localStorage.getItem('kinetic:pwa:install-dismissed')).not.toBeNull();
    expect(inst.visible).toBe(false);
  });

  it('install() no-op si aucune subscription en attente (iOS pur)', async () => {
    installNavigator({
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari',
    });
    const { pwaInstallPrompt } = await import('../../apps/web/src/lib/pwa-install.js');
    const inst = pwaInstallPrompt();
    vi.useFakeTimers();
    inst.init();
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
    await inst.install();
    // Aucun deferredPrompt → on ne masque pas, l'instruction iOS reste affichée
    expect(inst.visible).toBe(true);
  });
});
