/**
 * Journal d'écritures (lib/write-journal.ts) : base du retour arrière des migrations
 * (audit stockage local F2) et de l'annulation d'une restauration (F5).
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  journalWrites,
  undoJournal,
  underlyingStorage,
} from '../../apps/web/src/lib/write-journal.js';

describe('journalWrites', () => {
  it('note la valeur d avant de chaque clé écrite, une seule fois, dans l ordre', async () => {
    const storage = new InMemoryStorage();
    await storage.set('a', 1);
    const j = journalWrites(storage);
    await j.storage.set('a', 2);
    await j.storage.set('a', 3);
    await j.storage.set('b', 'neuf');
    await j.storage.remove('a');
    expect(j.entries()).toEqual([
      { key: 'a', existed: true, value: 1 },
      { key: 'b', existed: false, value: null },
    ]);
  });

  it('undoJournal remet exactement l état d avant, sans toucher aux autres clés', async () => {
    const storage = new InMemoryStorage();
    await storage.set('a', 1);
    const j = journalWrites(storage);
    await j.storage.set('a', 2);
    await j.storage.set('b', 'neuf');
    await storage.set('c', 'écrite à côté'); // écriture de l'app, hors journal
    await undoJournal(storage, j.entries());
    expect(storage.snapshot()).toEqual({ a: 1, c: 'écrite à côté' });
  });

  it('valeur d avant illisible : l écriture n est pas faite (rien d irréversible)', async () => {
    const storage = new InMemoryStorage();
    await storage.set('a', 1);
    vi.spyOn(storage, 'get').mockRejectedValueOnce(new Error('Connection lost'));
    const set = vi.spyOn(storage, 'set');
    const j = journalWrites(storage);
    await expect(j.storage.set('a', 2)).rejects.toThrow('Connection lost');
    expect(set).not.toHaveBeenCalled();
    expect(j.entries()).toEqual([]);
  });

  it('setMany est journalisé, clear est refusé', async () => {
    const storage = new InMemoryStorage() as InMemoryStorage & {
      setMany: (
        w: ReadonlyArray<{ key: string; value?: unknown; remove?: boolean }>,
      ) => Promise<void>;
    };
    storage.setMany = async (writes) => {
      for (const w of writes) {
        if (w.remove) await storage.remove(w.key);
        else await storage.set(w.key, w.value);
      }
    };
    await storage.set('x', 1);
    const j = journalWrites(storage);
    await j.storage.setMany([
      { key: 'x', remove: true },
      { key: 'y', value: 2 },
    ]);
    expect(j.entries().map((e) => e.key)).toEqual(['x', 'y']);
    await expect(j.storage.clear()).rejects.toThrow();
    expect(underlyingStorage(j.storage)).toBe(storage);
    expect(underlyingStorage(journalWrites(j.storage).storage)).toBe(storage);
  });
});
