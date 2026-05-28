/**
 * Tests pour la lib i18n. On utilise `vi.resetModules()` pour isoler les
 * effets de bord de localStorage entre tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Polyfill minimal pour tests qui tournent en environnement node-only.
// IMPORTANT : Node 20 (utilisé en CI) n'expose PAS `navigator` global,
// contrairement à Node 21+. On le polyfill explicitement avant les tests
// qui font `Object.defineProperty(navigator, ...)`.
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
if (typeof globalThis.navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { language: 'fr-FR' },
  });
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

describe('i18n', () => {
  it('retombe en FR par défaut si rien dans localStorage et navigator.language inconnu', async () => {
    Object.defineProperty(navigator, 'language', { value: 'xx', configurable: true });
    const { getLocale, t } = await import('../../apps/web/src/lib/i18n.js');
    expect(getLocale()).toBe('fr');
    expect(t('login.title')).toBe('Connexion');
  });

  it('utilise EN si navigator.language commence par en', async () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    const { getLocale, t } = await import('../../apps/web/src/lib/i18n.js');
    expect(getLocale()).toBe('en');
    expect(t('login.title')).toBe('Sign in');
  });

  it('respecte la locale stockée dans localStorage (override navigator)', async () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    localStorage.setItem('kinetic:locale', 'fr');
    const { getLocale } = await import('../../apps/web/src/lib/i18n.js');
    expect(getLocale()).toBe('fr');
  });

  it('interpole les variables {var}', async () => {
    const { t } = await import('../../apps/web/src/lib/i18n.js');
    const result = t('dashboard.level', { level: 7 });
    expect(result).toContain('7');
  });

  it('retombe sur la clé brute si la traduction manque dans toutes les langues', async () => {
    const { t } = await import('../../apps/web/src/lib/i18n.js');
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('setLocale persiste et fait basculer la lecture', async () => {
    const mod = await import('../../apps/web/src/lib/i18n.js');
    mod.setLocale('en');
    expect(mod.getLocale()).toBe('en');
    expect(mod.t('common.save')).toBe('Save');
    mod.setLocale('fr');
    expect(mod.getLocale()).toBe('fr');
    expect(mod.t('common.save')).toBe('Enregistrer');
  });

  it('setLocale ignore une valeur invalide', async () => {
    const mod = await import('../../apps/web/src/lib/i18n.js');
    mod.setLocale('fr');
    mod.setLocale('xx' as 'fr');
    expect(mod.getLocale()).toBe('fr');
  });

  it('installAlpineI18nMagic enregistre $t et $locale', async () => {
    const calls: Array<[string, () => unknown]> = [];
    const fakeAlpine = {
      magic: (name: string, cb: () => unknown) => {
        calls.push([name, cb]);
      },
    };
    const { installAlpineI18nMagic } = await import('../../apps/web/src/lib/i18n.js');
    installAlpineI18nMagic(fakeAlpine);
    expect(calls.map((c) => c[0])).toEqual(['t', 'locale']);
    // Le $t magic appelle t() — on vérifie qu'il retourne une fonction valide
    const tFn = calls[0]![1]() as (key: string) => string;
    expect(typeof tFn).toBe('function');
    expect(tFn('common.save')).toBeTruthy();
  });

  it("installAlpineI18nMagic noop si Alpine n'a pas .magic", async () => {
    const { installAlpineI18nMagic } = await import('../../apps/web/src/lib/i18n.js');
    // Ne doit pas throw
    expect(() => installAlpineI18nMagic({})).not.toThrow();
  });

  it('setLocale dispatch un CustomEvent kinetic:locale-changed', async () => {
    let captured: CustomEvent | null = null;
    (globalThis as Record<string, unknown>).window = {
      ...((globalThis as Record<string, unknown>).window as object | undefined),
      dispatchEvent(ev: CustomEvent) {
        captured = ev;
        return true;
      },
    };
    (globalThis as Record<string, unknown>).document = {
      documentElement: { lang: '' },
    };
    const mod = await import('../../apps/web/src/lib/i18n.js');
    mod.setLocale('en');
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe('kinetic:locale-changed');
  });
});
