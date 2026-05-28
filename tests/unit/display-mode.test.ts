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
  (globalThis as { document?: unknown }).document = { documentElement: root };
}
if (typeof globalThis.window === 'undefined') {
  (globalThis as { window?: unknown }).window = { dispatchEvent: () => true };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('display-mode', () => {
  it("getDisplayDensity retourne 'simple' par défaut", async () => {
    const { getDisplayDensity } = await import('../../apps/web/src/lib/display-mode.js');
    expect(getDisplayDensity()).toBe('simple');
  });

  it("respecte la valeur persistée 'advanced'", async () => {
    localStorage.setItem('kinetic:display-density', 'advanced');
    const { getDisplayDensity } = await import('../../apps/web/src/lib/display-mode.js');
    expect(getDisplayDensity()).toBe('advanced');
  });

  it('applyDisplayDensity pose data-density sur <html>', async () => {
    const { applyDisplayDensity } = await import('../../apps/web/src/lib/display-mode.js');
    applyDisplayDensity('advanced');
    expect(document.documentElement.getAttribute('data-density')).toBe('advanced');
    applyDisplayDensity('simple');
    expect(document.documentElement.getAttribute('data-density')).toBe('simple');
  });

  it('setDisplayDensity persiste ET applique', async () => {
    const { setDisplayDensity, getDisplayDensity } =
      await import('../../apps/web/src/lib/display-mode.js');
    setDisplayDensity('advanced');
    expect(getDisplayDensity()).toBe('advanced');
    expect(document.documentElement.getAttribute('data-density')).toBe('advanced');
  });

  it('setDisplayDensity ignore une valeur invalide', async () => {
    localStorage.setItem('kinetic:display-density', 'simple');
    const { setDisplayDensity, getDisplayDensity } =
      await import('../../apps/web/src/lib/display-mode.js');
    setDisplayDensity('xx' as 'simple');
    expect(getDisplayDensity()).toBe('simple');
  });

  it('initDisplayDensity applique la préférence persistée', async () => {
    localStorage.setItem('kinetic:display-density', 'advanced');
    const { initDisplayDensity } = await import('../../apps/web/src/lib/display-mode.js');
    initDisplayDensity();
    expect(document.documentElement.getAttribute('data-density')).toBe('advanced');
  });
});
