/**
 * Tests pour la lib theme (mode clair/foncé). Le module utilise
 * `localStorage`, `document.documentElement.setAttribute` et
 * `window.matchMedia` — qu'on stub minimal pour pouvoir tourner en jsdom-less.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Polyfills minimaux ───────────────────────────────────────────────────
type FakeMql = MediaQueryList & {
  addListener?: (cb: () => void) => void;
};

let mediaDarkMatches = false;
const mqlListeners: Array<(ev?: { matches: boolean }) => void> = [];

if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (_q: string): FakeMql =>
      ({
        matches: mediaDarkMatches,
        media: _q,
        onchange: null,
        addEventListener: (_evt: string, cb: () => void) => mqlListeners.push(cb),
        removeEventListener: () => undefined,
        addListener: (cb: () => void) => mqlListeners.push(cb),
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }) as unknown as FakeMql,
  });
}

if (typeof globalThis.window === 'undefined') {
  (globalThis as { window?: unknown }).window = globalThis;
}

if (typeof globalThis.document === 'undefined') {
  const root = {
    _attrs: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this._attrs[name] = value;
    },
    getAttribute(name: string): string | null {
      return this._attrs[name] ?? null;
    },
  };
  (globalThis as { document?: unknown }).document = {
    documentElement: root,
    querySelector: () => null,
  };
}

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

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
  mediaDarkMatches = true;
  mqlListeners.length = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('theme', () => {
  it('retourne "dark" par défaut si rien stocké', async () => {
    const { getThemeMode } = await import('../../apps/web/src/lib/theme.js');
    expect(getThemeMode()).toBe('dark');
  });

  it('respecte la valeur stockée (light)', async () => {
    localStorage.setItem('kinetic:theme-mode', 'light');
    const { getThemeMode } = await import('../../apps/web/src/lib/theme.js');
    expect(getThemeMode()).toBe('light');
  });

  it("résout 'system' selon matchMedia (dark)", async () => {
    mediaDarkMatches = true;
    const { resolveThemeMode } = await import('../../apps/web/src/lib/theme.js');
    expect(resolveThemeMode('system')).toBe('dark');
  });

  it("résout 'system' selon matchMedia (light)", async () => {
    mediaDarkMatches = false;
    const { resolveThemeMode } = await import('../../apps/web/src/lib/theme.js');
    expect(resolveThemeMode('system')).toBe('light');
  });

  it('applyThemeMode pose data-mode sur <html>', async () => {
    const { applyThemeMode } = await import('../../apps/web/src/lib/theme.js');
    applyThemeMode('light');
    expect(document.documentElement.getAttribute('data-mode')).toBe('light');
    applyThemeMode('dark');
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
  });

  it('setThemeMode persiste ET applique', async () => {
    const { setThemeMode, getThemeMode } = await import('../../apps/web/src/lib/theme.js');
    setThemeMode('light');
    expect(getThemeMode()).toBe('light');
    expect(document.documentElement.getAttribute('data-mode')).toBe('light');
  });

  it('setThemeMode ignore une valeur invalide', async () => {
    localStorage.setItem('kinetic:theme-mode', 'dark');
    const { setThemeMode, getThemeMode } = await import('../../apps/web/src/lib/theme.js');
    setThemeMode('xx' as 'dark');
    expect(getThemeMode()).toBe('dark');
  });

  it('initTheme applique la préférence persistée', async () => {
    localStorage.setItem('kinetic:theme-mode', 'light');
    const { initTheme } = await import('../../apps/web/src/lib/theme.js');
    initTheme();
    expect(document.documentElement.getAttribute('data-mode')).toBe('light');
  });

  it('applyThemeMode dispatch un EVENT_THEME_CHANGED', async () => {
    // Polyfill window.dispatchEvent + addEventListener si manquant
    let captured: CustomEvent | null = null;
    (globalThis as Record<string, unknown>).window = {
      ...((globalThis as Record<string, unknown>).window as object | undefined),
      dispatchEvent(ev: CustomEvent) {
        captured = ev;
        return true;
      },
    };
    const { applyThemeMode } = await import('../../apps/web/src/lib/theme.js');
    applyThemeMode('light');
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe('kinetic:theme-changed');
  });

  it("setThemeMode('system') installe le listener matchMedia", async () => {
    let listenerInstalled = false;
    const mqlMock = {
      matches: false,
      addEventListener: (_evt: string, _cb: () => void) => {
        listenerInstalled = true;
      },
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
      media: '',
      onchange: null,
    } as unknown as MediaQueryList;
    (globalThis as Record<string, unknown>).window = {
      ...((globalThis as Record<string, unknown>).window as object | undefined),
      matchMedia: () => mqlMock,
      dispatchEvent: () => true,
    };
    const { setThemeMode } = await import('../../apps/web/src/lib/theme.js');
    setThemeMode('system');
    expect(listenerInstalled).toBe(true);
  });

  it("resolveThemeMode retourne 'dark' si window.matchMedia indisponible", async () => {
    (globalThis as Record<string, unknown>).window = {
      ...((globalThis as Record<string, unknown>).window as object | undefined),
      matchMedia: undefined,
    };
    const { resolveThemeMode } = await import('../../apps/web/src/lib/theme.js');
    expect(resolveThemeMode('system')).toBe('dark');
  });
});
