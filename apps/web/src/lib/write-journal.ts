/**
 * Journal d'écritures : enveloppe un StoragePort et note, pour chaque clé écrite ou
 * supprimée À TRAVERS cette enveloppe, sa valeur d'avant (à la première écriture).
 *
 * Sert à annuler exactement ce qu'une opération a modifié (migration locale en échec,
 * restauration d'une sauvegarde) sans toucher aux clés que le reste de l'app écrit en
 * parallèle : avant, la migration reprenait un cliché de TOUT le stockage et supprimait
 * les clés absentes du cliché, y compris une séance enregistrée pendant la migration
 * (audit stockage local F2).
 *
 * Une écriture dont la valeur d'avant ne peut pas être lue (lecture en échec) n'est pas
 * faite : l'erreur est levée, rien n'est modifié sans pouvoir être annulé.
 */
import type { StorageKey, StoragePort, StorageWrite } from '@kinetic/core';

/** Valeur d'une clé avant la première écriture du journal (`existed` faux = clé absente). */
export interface JournalEntry {
  key: StorageKey;
  existed: boolean;
  value: unknown;
}

export interface WriteJournal {
  /** Stockage à utiliser pour l'opération : chaque écriture y est notée. */
  readonly storage: StoragePort;
  /** Clés modifiées, dans l'ordre de leur première écriture, avec leur valeur d'avant. */
  entries(): JournalEntry[];
}

const bases = new WeakMap<StoragePort, StoragePort>();

/** Stockage réel derrière un journal (le stockage lui-même sinon). */
export function underlyingStorage(storage: StoragePort): StoragePort {
  return bases.get(storage) ?? storage;
}

export function journalWrites(storage: StoragePort): WriteJournal {
  const before = new Map<StorageKey, JournalEntry>();

  const note = async (key: StorageKey): Promise<void> => {
    if (before.has(key)) return;
    const value = await storage.get<unknown>(key);
    if (!before.has(key)) before.set(key, { key, existed: value !== null, value });
  };

  const journaled: StoragePort = {
    get: (key) => storage.get(key),
    keys: () => storage.keys(),
    async set(key, value) {
      await note(key);
      await storage.set(key, value);
    },
    async remove(key) {
      await note(key);
      await storage.remove(key);
    },
    async setMany(writes: readonly StorageWrite[]) {
      for (const w of writes) await note(w.key);
      await storage.setMany(writes);
    },
    clear() {
      return Promise.reject(new Error('[journal] clear() interdit dans une opération annulable'));
    },
  };

  bases.set(journaled, underlyingStorage(storage));
  return { storage: journaled, entries: () => [...before.values()] };
}

/**
 * Remet chaque clé du journal dans son état d'avant (valeur, ou absence), de la dernière
 * modifiée à la première. Les clés que le journal n'a pas vues ne sont jamais touchées.
 */
export async function undoJournal(
  storage: StoragePort,
  entries: readonly JournalEntry[],
): Promise<void> {
  for (const e of [...entries].reverse()) {
    if (e.existed) await storage.set(e.key, e.value);
    else await storage.remove(e.key);
  }
}
