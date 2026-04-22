/**
 * tests/integration/hybrid-storage.test.ts
 *
 * Tests d'intégration du HybridStorage.
 * Stratégie : mock le remote Supabase, utilise un InMemoryStorage local.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StoragePort } from '@kinetic/core';

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

// ─── HybridStorage inline (copie de packages/adapters-web/src/supabase/HybridStorage.ts)
class HybridStorage implements StoragePort {
  constructor(
    private readonly local: StoragePort,
    private readonly remote: StoragePort,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    return this.local.get<T>(key);
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.local.set(key, value);
    // fire-and-forget
    this.remote.set(key, value).catch((err: unknown) => {
      console.warn('[HybridStorage] remote sync failed', err);
    });
  }

  async remove(key: string): Promise<void> {
    await this.local.remove(key);
    this.remote.remove(key).catch(() => {});
  }

  async keys(): Promise<readonly string[]> {
    return this.local.keys();
  }

  async clear(): Promise<void> {
    await this.local.clear();
    this.remote.clear().catch(() => {});
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
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[HybridStorage]'),
        expect.anything()
      );
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
      vi.spyOn(remote, 'set').mockRejectedValue(new Error('Offline'));

      await hybrid.set('offline-data', { xp: 100 });
      const data = await hybrid.get<{ xp: number }>('offline-data');
      expect(data?.xp).toBe(100);
    });
  });
});
