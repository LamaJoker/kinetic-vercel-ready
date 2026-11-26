/**
 * navigator.storage.persist() demandé après la première séance, une seule fois, avec
 * repli silencieux (iOS/Safari : éviction d'IndexedDB).
 */
import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { requestPersistentStorage } from '../../apps/web/src/lib/persistent-storage.js';

function memory(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('requestPersistentStorage', () => {
  it('demande la persistance une fois, puis ne redemande plus', async () => {
    const persist = vi.fn(async () => true);
    const storage = { persist, persisted: vi.fn(async () => false) };
    const mem = memory();
    expect(await requestPersistentStorage({ storage, memory: mem })).toBe('granted');
    expect(mem.data.get(STORAGE_KEYS.PERSIST_ASKED)).toBe('1');
    expect(await requestPersistentStorage({ storage, memory: mem })).toBe('asked-before');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('déjà persistant : aucune demande', async () => {
    const persist = vi.fn(async () => true);
    const out = await requestPersistentStorage({
      storage: { persist, persisted: async () => true },
      memory: memory(),
    });
    expect(out).toBe('already');
    expect(persist).not.toHaveBeenCalled();
  });

  it('refus, API absente ou en erreur : repli silencieux, jamais d exception', async () => {
    expect(
      await requestPersistentStorage({
        storage: { persist: async () => false, persisted: async () => false },
        memory: memory(),
      }),
    ).toBe('denied');
    expect(await requestPersistentStorage({ storage: undefined, memory: memory() })).toBe(
      'unsupported',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      await requestPersistentStorage({
        storage: {
          persist: async () => true,
          persisted: async () => {
            throw new Error('SecurityError');
          },
        },
        memory: memory(),
      }),
    ).toBe('unsupported');
    warn.mockRestore();
  });

  it('main.ts : demandé sur EVENT_SESSION_SAVED, plus au premier rendu', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const main = readFileSync(resolve(__dirname, '../../apps/web/src/main.ts'), 'utf8');
    expect(main).toMatch(
      /addEventListener\(STORAGE_KEYS\.EVENT_SESSION_SAVED, \(\) => \{\s*void import\('\.\/lib\/persistent-storage'\)/,
    );
    expect(main).not.toMatch(/afterFirstRender\(requestPersistentStorage\)/);
  });
});
