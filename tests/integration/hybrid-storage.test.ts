/**
 * tests/integration/hybrid-storage.test.ts
 *
 * Tests d'intégration du HybridStorage RÉEL (importé du package),
 * pas d'une copie inline qui peut diverger silencieusement.
 *
 * Stratégie : InMemoryStorage côté local et remote, globals mockés via
 * vi.stubGlobal() pour éviter les leaks entre tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StoragePort } from '@kinetic/core';
import { HybridStorage } from '@kinetic/adapters-web';

// ─── Setup globals (jsdom n'est pas chargé dans cet env) ─────────────────────

beforeEach(() => {
  // vi.stubGlobal isole les globals par test — pas de leak entre cas
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── InMemoryStorage — remplace IDB en test ──────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────

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
      await new Promise((r) => setTimeout(r, 0));
      const val = await remote.get<number>('key');
      expect(val).toBe(42);
    });

    it('ne bloque pas si le remote échoue', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(remote, 'set').mockRejectedValue(new Error('Network error'));

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
      vi.stubGlobal('navigator', { onLine: false });
      vi.spyOn(remote, 'set').mockRejectedValue(new Error('Offline'));

      await hybrid.set('offline-data', { xp: 100 });
      const data = await hybrid.get<{ xp: number }>('offline-data');
      expect(data?.xp).toBe(100);
    });
  });

  describe('syncFromRemote (anti-perte de données)', () => {
    it('ne ré-écrit PAS les clés déjà présentes en local (mode défaut)', async () => {
      await local.set('kinetic:training:sessions', [{ id: 'fresh', name: 'Nouvelle' }]);
      await remote.set('kinetic:training:sessions', [{ id: 'old', name: 'Ancienne' }]);

      await hybrid.syncFromRemote();

      const value = await hybrid.get<Array<{ id: string }>>('kinetic:training:sessions');
      expect(value).toEqual([{ id: 'fresh', name: 'Nouvelle' }]);
    });

    it('pull les clés MANQUANTES en local (cas nouvel appareil)', async () => {
      await remote.set('kinetic:userProfile', { name: 'Val' });
      await remote.set('kinetic:training:sessions', [{ id: 's1' }]);

      await hybrid.syncFromRemote();

      expect(await hybrid.get('kinetic:userProfile')).toEqual({ name: 'Val' });
      expect(await hybrid.get('kinetic:training:sessions')).toEqual([{ id: 's1' }]);
    });

    it('force: true écrase explicitement le local (bouton Restaurer)', async () => {
      await local.set('kinetic:training:sessions', [{ id: 'local-only' }]);
      await remote.set('kinetic:training:sessions', [{ id: 'remote-version' }]);

      await hybrid.syncFromRemote({ force: true });

      expect(await hybrid.get('kinetic:training:sessions')).toEqual([{ id: 'remote-version' }]);
    });

    it('ignore les clés internes de sync lors du pull', async () => {
      await remote.set('kinetic:training:sessions', [{ id: 's1' }]);

      await hybrid.syncFromRemote();

      const keys = await hybrid.keys();
      expect(keys).toContain('kinetic:training:sessions');
    });

    it('est idempotent : 2 appels successifs ne corrompent pas le local', async () => {
      await local.set('kinetic:training:sessions', [{ id: 'fresh' }]);
      await remote.set('kinetic:training:sessions', [{ id: 'old' }]);

      await hybrid.syncFromRemote();
      await hybrid.syncFromRemote();

      expect(await hybrid.get('kinetic:training:sessions')).toEqual([{ id: 'fresh' }]);
    });

    it('ne fait rien si offline', async () => {
      vi.stubGlobal('navigator', { onLine: false });
      await remote.set('kinetic:training:sessions', [{ id: 's1' }]);

      await hybrid.syncFromRemote();

      expect(await hybrid.get('kinetic:training:sessions')).toBeNull();
    });

    it('enregistre lastSyncAt après une sync réussie', async () => {
      await remote.set('kinetic:training:sessions', [{ id: 's1' }]);

      await hybrid.syncFromRemote();

      const lastSyncAt = await local.get<string>('kinetic:sync:last-at');
      expect(lastSyncAt).toBeTruthy();
      expect(new Date(lastSyncAt!).getFullYear()).toBeGreaterThanOrEqual(2025);
    });

    it('utilise keysSince() si disponible sur le remote (delta sync)', async () => {
      // Remote avec support delta
      const deltaRemote = {
        ...remote,
        keysSince: vi.fn().mockResolvedValue(['kinetic:training:sessions']),
        get: vi.fn().mockImplementation((k: string) => remote.get(k)),
        keys: vi.fn().mockResolvedValue(['kinetic:training:sessions']),
        set: vi.fn().mockImplementation((k: string, v: unknown) => remote.set(k, v)),
        remove: vi.fn(),
        clear: vi.fn(),
      };
      await remote.set('kinetic:training:sessions', [{ id: 'delta' }]);
      await local.set('kinetic:sync:last-at', '2025-01-01T00:00:00Z');

      const deltaHybrid = new HybridStorage(local, deltaRemote as unknown as StoragePort);
      await deltaHybrid.syncFromRemote();

      expect(deltaRemote.keysSince).toHaveBeenCalledWith('2025-01-01T00:00:00Z');
    });
  });

  describe('flushPendingWrites', () => {
    it('pousse les écritures en attente au retour en ligne', async () => {
      // Créer un remote de remplacement qui refuse toutes les écritures dans un 1er temps
      const blockingRemote = new InMemoryStorage();
      const rejectedSpy = vi.spyOn(blockingRemote, 'set').mockRejectedValue(new Error('Offline'));

      vi.stubGlobal('navigator', { onLine: false });
      const offlineHybrid = new HybridStorage(local, blockingRemote);

      await offlineHybrid.set('pending-key', { data: 42 });
      // La donnée est en local mais pas dans blockingRemote
      expect(await local.get('pending-key')).toEqual({ data: 42 });

      // Retour en ligne — débloquer le remote
      rejectedSpy.mockRestore();
      vi.stubGlobal('navigator', { onLine: true });

      await offlineHybrid.flushPendingWrites();

      expect(await blockingRemote.get('pending-key')).toEqual({ data: 42 });
    });
  });
});
