/**
 * Tests pour la lib i18n. On utilise `vi.resetModules()` pour isoler les
 * effets de bord de localStorage entre tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Polyfill minimal pour tests qui tournent en environnement node-only
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
});
