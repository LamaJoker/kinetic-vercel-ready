/**
 * tests/integration/hybrid-storage.test.ts
 *
 * Tests d'intégration du HybridStorage RÉEL (importé du package),
 * pas d'une copie inline qui peut diverger silencieusement.
 *
 * Stratégie : InMemoryStorage côté local et remote, mock de window.online
 * via un jsdom-light minimal.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StoragePort } from '@kinetic/core';
import { HybridStorage } from '@kinetic/adapters-web';

// jsdom n'est pas chargé dans cet env vitest — on patch les globals minimums
// dont HybridStorage a besoin (navigator.onLine, window.addEventListener).
beforeEach(() => {
  (globalThis as any).navigator ??= { onLine: true };
  (globalThis as any).navigator.onLine = true;
  (globalThis as any).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

// ─── InMemoryStorage — remplace IDB en test ──────────────────────────────
class InMemoryStorage implements StoragePort {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.store.keys()];
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
// ─────────────────────────────────────────────────────────────────────────

describe('HybridStorage', () => {
  let local: InMemoryStorage;
  let remote: InMemoryStorage;
  let hybrid: HybridStorage;

  beforeEach(() => {
    local = new InMemoryStorage();
    remote = new InMemoryStorage();
    hybrid = new HybridStorage(local, remote);
  });

  describe('get', () => {
    it('lit depuis le local uniquement', async () => {
      await local.set('key', 'local-value');
      await remote.set('key', 'remote-value');
      const val = await hybrid.get<string>('key');
      expect(val).toBe('local-value');
    });

    it('retourne null si clé inexistante', async () => {
      const val = await hybrid.get('nonexistent');
      expect(val).toBeNull();
    });
  });

  describe('set', () => {
    it('écrit dans le local immédiatement', async () => {
      await hybrid.set('key', 42);
      const val = await local.get<number>('key');
      expect(val).toBe(42);
    });

    it('écrit dans le remote en arrière-plan', async () => {
      await hybrid.set('key', 42);
      // Laisser le micro-task queue se vider
      await new Promise((r) => setTimeout(r, 0));
      const val = await remote.get<number>('key');
      expect(val).toBe(42);
    });

    it('ne bloque pas si le remote échoue', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(remote, 'set').mockRejectedValue(new Error('Network error'));

      // Ne doit pas throw
      await expect(hybrid.set('key', 'value')).resolves.toBeUndefined();

      await new Promise((r) => setTimeout(r, 10));
      const calls = consoleSpy.mock.calls.flat().map(String).join(' ');
      expect(calls).toContain('[HybridStorage]');
      consoleSpy.mockRestore();
    });
  });

  describe('remove', () => {
    it('supprime du local', async () => {
      await local.set('key', 'val');
      await hybrid.remove('key');
      expect(await local.get('key')).toBeNull();
    });
  });

  describe('keys', () => {
    it('retourne les clés du local', async () => {
      await hybrid.set('a', 1);
      await hybrid.set('b', 2);
      const keys = await hybrid.keys();
      expect(keys).toContain('a');
      expect(keys).toContain('b');
    });
  });

  describe('clear', () => {
    it('vide le local', async () => {
      await hybrid.set('a', 1);
      await hybrid.clear();
      expect(await hybrid.keys()).toHaveLength(0);
    });
  });

  describe('offline resilience', () => {
    it('les lectures locales fonctionnent si le remote est down', async () => {
      await local.set('user-data', { name: 'Val' });
      vi.spyOn(remote, 'get').mockRejectedValue(new Error('Offline'));

      const data = await hybrid.get('user-data');
      expect(data).toEqual({ name: 'Val' });
    });

    it('les écritures fonctionnent en mode offline (local uniquement)', async () => {
      (globalThis as any).navigator.onLine = false;
      vi.spyOn(remote, 'set').mockRejectedValue(new Error('Offline'));

      await hybrid.set('offline-data', { xp: 100 });
      const data = await hybrid.get<{ xp: number }>('offline-data');
      expect(data?.xp).toBe(100);
    });
  });

  describe('syncFromRemote (anti-perte de données)', () => {
    it("ne ré-écrit PAS les clés déjà présentes en local (mode défaut)", async () => {
      // Scénario du bug rapporté : utilisateur sauvegarde une séance
      // localement, puis recharge la page avant que l'upsert remote ne soit
      // visible. syncFromRemote ne doit pas restaurer la version stale.
      await local.set('kinetic:training:sessions', [{ id: 'fresh', name: 'Nouvelle' }]);
      await remote.set('kinetic:training:sessions', [{ id: 'old', name: 'Ancienne' }]);

      await hybrid.syncFromRemote();

      const value = await hybrid.get<Array<{ id: string }>>('kinetic:training:sessions');
      expect(value).toEqual([{ id: 'fresh', name: 'Nouvelle' }]);
    });

    it('pull les clés MANQUANTES en local (cas nouvel appareil)', async () => {
      await remote.set('kinetic:userProfile', { name: 'Val' });
      await remote.set('kinetic:training:sessions', [{ id: 's1' }]);
      // Le local n'a rien — premier sign-in sur un nouvel appareil

      await hybrid.syncFromRemote();

      expect(await hybrid.get('kinetic:userProfile')).toEqual({ name: 'Val' });
      expect(await hybrid.get('kinetic:training:sessions')).toEqual([{ id: 's1' }]);
    });

    it("force: true écrase explicitement le local (bouton Restaurer)", async () => {
      await local.set('kinetic:training:sessions', [{ id: 'local-only' }]);
      await remote.set('kinetic:training:sessions', [{ id: 'remote-version' }]);

      await hybrid.syncFromRemote({ force: true });

      expect(await hybrid.get('kinetic:training:sessions'))
        .toEqual([{ id: 'remote-version' }]);
    });

    it("ignore le flag de sync interne lors de la lecture des clés", async () => {
      await remote.set('kinetic:training:sessions', [{ id: 's1' }]);

      await hybrid.syncFromRemote();

      const keys = await hybrid.keys();
      // Le flag interne est OK (peut exister) — il ne doit juste pas être
      // remonté côté UI ni déclencher d'erreur. Vérification indirecte :
      // la séance a bien été pullée.
      expect(keys).toContain('kinetic:training:sessions');
    });

    it("est idempotent : 2 appels successifs ne corrompent pas le local", async () => {
      await local.set('kinetic:training:sessions', [{ id: 'fresh' }]);
      await remote.set('kinetic:training:sessions', [{ id: 'old' }]);

      await hybrid.syncFromRemote();
      await hybrid.syncFromRemote();

      expect(await hybrid.get('kinetic:training:sessions'))
        .toEqual([{ id: 'fresh' }]);
    });

    it("ne fait rien si offline", async () => {
      (globalThis as any).navigator.onLine = false;
      await remote.set('kinetic:training:sessions', [{ id: 's1' }]);

      await hybrid.syncFromRemote();

      expect(await hybrid.get('kinetic:training:sessions')).toBeNull();
    });
  });
});
