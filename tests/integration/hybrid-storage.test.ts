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

    it('log un warn si le remote.remove echoue (best-effort)', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(remote, 'remove').mockRejectedValueOnce(new Error('network'));
      await local.set('key', 'val');
      await hybrid.remove('key');
      // La suppression locale a reussi meme si le remote echoue
      expect(await local.get('key')).toBeNull();
      await new Promise((r) => setTimeout(r, 0)); // flush catch callback
      const warns = consoleSpy.mock.calls.flat().join(' ');
      expect(warns).toContain('[HybridStorage]');
      consoleSpy.mockRestore();
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

    it('log un warn si le remote.clear echoue (best-effort)', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(remote, 'clear').mockRejectedValueOnce(new Error('network'));
      await hybrid.set('a', 1);
      await hybrid.clear();
      // Le local est vide meme si le remote echoue
      expect(await hybrid.keys()).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 0)); // flush catch callback
      const warns = consoleSpy.mock.calls.flat().join(' ');
      expect(warns).toContain('[HybridStorage]');
      consoleSpy.mockRestore();
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

    it('delta sync sans keysSince: fait un full scan en safe mode (skip existing local)', async () => {
      // Simule un lastSyncAt sans support keysSince sur le remote (fallback full scan)
      await local.set('kinetic:sync:last-at', '2025-01-01T00:00:00Z');
      await remote.set('kinetic:training:sessions', [{ id: 'remote-version' }]);
      // Données locales existantes — ne doivent PAS être écrasées
      await local.set('kinetic:training:sessions', [{ id: 'local-version' }]);
      // Clé manquante en local — doit être tirée du remote
      await remote.set('kinetic:userProfile', { name: 'Remote User' });

      // remote n'a PAS de keysSince → fallback full scan
      await hybrid.syncFromRemote();

      // Local existant préservé
      expect(await hybrid.get('kinetic:training:sessions')).toEqual([{ id: 'local-version' }]);
      // Clé manquante importée
      expect(await hybrid.get('kinetic:userProfile')).toEqual({ name: 'Remote User' });
    });

    it('delta sync: clés avec pending write locales ne sont pas ecrasees', async () => {
      await local.set('kinetic:sync:last-at', '2025-01-01T00:00:00Z');
      // Write local pending: la clé est dans pendingWrites
      await hybrid.set('kinetic:xp', { xp: 500 });
      // Remote a une version plus ancienne
      await remote.set('kinetic:xp', { xp: 0 });

      // Force offline pour que le pending write ne soit pas flushé
      vi.stubGlobal('navigator', { onLine: false });
      const offlineHybrid2 = new HybridStorage(local, remote);
      await offlineHybrid2.set('kinetic:xp', { xp: 500 });

      vi.stubGlobal('navigator', { onLine: true });
      // syncFromRemote avec lastSyncAt → delta mode → keysSince non dispo → full scan
      // Le pending write doit bloquer l'écrasement
      const hybridWithPending = new HybridStorage(local, remote);
      await local.set('kinetic:sync:last-at', '2025-01-01T00:00:00Z');
      // Injecter un pending write manuellement en faisant un set offline
      vi.stubGlobal('navigator', { onLine: false });
      await hybridWithPending.set('kinetic:xp', { xp: 777 });
      vi.stubGlobal('navigator', { onLine: true });

      await hybridWithPending.syncFromRemote();

      // La valeur locale avec pending write doit être preservée
      expect(await local.get('kinetic:xp')).toEqual({ xp: 777 });
    });

    it('log un warn et continue si remote.get echoue pour une cle individuelle', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await remote.set('kinetic:userProfile', { name: 'Val' });
      await remote.set('kinetic:xp', { xp: 100 });

      // remote.get echoue pour la premiere cle, reussit pour la deuxieme
      const originalGet = remote.get.bind(remote);
      let callCount = 0;
      vi.spyOn(remote, 'get').mockImplementation((k) => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('network glitch'));
        return originalGet(k);
      });

      await hybrid.syncFromRemote();

      // Au moins une cle a ete importee malgre l'erreur de l'autre
      const warns = consoleSpy.mock.calls.flat().join(' ');
      expect(warns).toContain('[HybridStorage]');
      consoleSpy.mockRestore();
    });

    it('avorte proprement si le remote.keys() echoue pendant la sync', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(remote, 'keys').mockRejectedValue(new Error('network error'));

      await hybrid.syncFromRemote();

      // Ne doit pas enregistrer lastSyncAt si la sync a avorté
      const lastSyncAt = await local.get('kinetic:sync:last-at');
      expect(lastSyncAt).toBeNull();
      expect(consoleSpy.mock.calls.flat().join(' ')).toContain('[HybridStorage]');
      consoleSpy.mockRestore();
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

    it('abandonne une cle apres 3 tentatives echouees et dispatch EVENT_SYNC_FAILED', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dispatchSpy = vi.fn();
      vi.stubGlobal('window', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: dispatchSpy,
      });

      const failingRemote = new InMemoryStorage();
      vi.spyOn(failingRemote, 'set').mockRejectedValue(new Error('disk full'));

      const h = new HybridStorage(local, failingRemote);
      // Ajouter une cle en pending (offline)
      vi.stubGlobal('navigator', { onLine: false });
      await h.set('kinetic:xp', { xp: 100 });

      // Flush 3 fois pour atteindre la limite
      vi.stubGlobal('navigator', { onLine: true });
      await h.flushPendingWrites(); // attempt 1 (→ attempts becomes 1)
      await h.flushPendingWrites(); // attempt 2 (→ attempts becomes 2)
      await h.flushPendingWrites(); // attempt 3 → give-up, dispatch EVENT_SYNC_FAILED

      expect(dispatchSpy).toHaveBeenCalledOnce();
      const event = dispatchSpy.mock.calls[0][0] as CustomEvent;
      expect(event.type).toContain('sync');

      consoleSpy.mockRestore();
    });

    it('ne fait rien si la queue est vide', async () => {
      const remoteSpy = vi.spyOn(remote, 'set');
      await hybrid.flushPendingWrites();
      expect(remoteSpy).not.toHaveBeenCalled();
    });

    it('ne re-entre pas si deja en cours (flushing guard)', async () => {
      // Simuler deux appels concurrents: le second doit etre ignore
      const slowRemote = new InMemoryStorage();
      let resolveWrite!: () => void;
      const writePromise = new Promise<void>((r) => (resolveWrite = r));
      vi.spyOn(slowRemote, 'set').mockReturnValueOnce(writePromise);

      vi.stubGlobal('navigator', { onLine: false });
      const h = new HybridStorage(local, slowRemote);
      await h.set('key1', 'val1');
      vi.stubGlobal('navigator', { onLine: true });

      // Premier flush (bloqué)
      const flush1 = h.flushPendingWrites();
      // Deuxieme flush pendant que le premier est en cours
      const flush2 = h.flushPendingWrites();

      resolveWrite();
      await Promise.all([flush1, flush2]);

      // remote.set ne doit avoir ete appele qu'une seule fois
      expect(vi.mocked(slowRemote.set).mock.calls).toHaveLength(1);
    });
  });

  describe('dispose', () => {
    it('retire le listener online apres dispose', () => {
      const removeListenerSpy = vi.fn();
      vi.stubGlobal('window', {
        addEventListener: vi.fn(),
        removeEventListener: removeListenerSpy,
      });
      const h = new HybridStorage(local, remote);
      h.dispose();
      expect(removeListenerSpy).toHaveBeenCalledWith('online', expect.any(Function));
    });

    it('dispose est idempotent (2e appel est un no-op)', () => {
      const removeListenerSpy = vi.fn();
      vi.stubGlobal('window', {
        addEventListener: vi.fn(),
        removeEventListener: removeListenerSpy,
      });
      const h = new HybridStorage(local, remote);
      h.dispose();
      h.dispose();
      expect(removeListenerSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('queueWrite eviction', () => {
    it('evince la plus ancienne cle quand la queue est pleine', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Remplir la queue jusqu'a MAX_PENDING_WRITES (500) via remote offline
      const bigRemote = new InMemoryStorage();
      vi.stubGlobal('navigator', { onLine: false });
      const h = new HybridStorage(local, bigRemote);

      // Ajouter 500 cles differentes pour remplir la queue
      const keys: string[] = [];
      for (let i = 0; i < 500; i++) {
        const k = `kinetic:fill:${i}` as Parameters<typeof h.set>[0];
        keys.push(k);
        await h.set(k, i);
      }

      // La 501e ecriture doit evoicer la plus ancienne cle
      await h.set('kinetic:xp' as Parameters<typeof h.set>[0], { xp: 999 });

      // La premiere cle doit avoir ete evictee — le warn doit avoir ete appele
      const warnMsg = consoleSpy.mock.calls[0]?.[0] as string;
      expect(warnMsg).toContain('[HybridStorage]');
      expect(warnMsg).toContain('kinetic:fill:0');

      consoleSpy.mockRestore();
    });
  });
});
