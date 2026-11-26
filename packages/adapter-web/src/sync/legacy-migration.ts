/**
 * Migration de l'ancienne base locale unique (`keyval-store` / store `keyval`,
 * idb-keyval par défaut) vers la base par compte (docs/architecture/sync.md § 4.1).
 *
 * Règle propriétaire : les données vont à la PREMIÈRE base qui la réclame (compte de la
 * session locale au premier lancement, sinon invité). Un marqueur
 * `kinetic:migrated-to = <base cible>` est posé dans l'ancienne base AVANT la copie :
 * une autre base (autre compte) ne la reprendra jamais ; la même base peut la reprendre
 * si la copie a échoué (réessai au lancement suivant).
 *
 * L'ancienne base n'est PAS supprimée (filet de sécurité, retour arrière vers une
 * ancienne version de l'app possible).
 */
import { STORAGE_KEYS, jsonEqual } from '@kinetic/core';
import {
  databaseExists,
  openDatabase,
  requestToPromise,
  runTransaction,
  txEntries,
} from './idb.js';
import {
  type LocalSyncDb,
  type OutboxEntry,
  type RecoveryRecord,
  META_LEGACY_CURSOR,
  META_MIGRATED_FROM,
  META_NEEDS_RECONCILE,
  S_KV,
  S_META,
  S_OUTBOX,
  S_RECOVERY,
} from './local-db.js';
import { isLocalOnlyKey } from './local-keys.js';
import { readJournal } from './fallback-storage.js';
import { newEntry, rearm, toPlain } from './shared.js';

export const LEGACY_DB_NAME = 'keyval-store';
export const LEGACY_STORE_NAME = 'keyval';

/** Clés de synchro de l'ancienne version : jamais copiées dans `kv`. */
const LEGACY_SYNC_KEYS: ReadonlySet<string> = new Set([
  STORAGE_KEYS.SYNC_OUTBOX,
  STORAGE_KEYS.SYNC_CURSOR,
  STORAGE_KEYS.SYNC_LAST_AT,
  STORAGE_KEYS.SYNC_INITIAL_DONE,
  STORAGE_KEYS.SYNC_MIGRATED_TO,
  STORAGE_KEYS.SYNC_FALLBACK_JOURNAL,
]);

export type LegacyMigrationResult =
  | { status: 'migrated'; keys: number; outbox: number; kept: number }
  | { status: 'already-done' }
  | { status: 'no-legacy' }
  | { status: 'claimed-by-other'; target: string };

interface LegacyOutboxItem {
  op?: unknown;
}

export interface LegacyMigrationOptions {
  factory: IDBFactory;
  /** Compte avec synchro : l'outbox est convertie et une réconciliation est demandée. */
  syncEnabled: boolean;
  now: () => number;
  legacyDbName?: string;
  legacyStoreName?: string;
}

export async function migrateLegacyStore(
  target: LocalSyncDb,
  opts: LegacyMigrationOptions,
): Promise<LegacyMigrationResult> {
  const legacyName = opts.legacyDbName ?? LEGACY_DB_NAME;
  const legacyStore = opts.legacyStoreName ?? LEGACY_STORE_NAME;

  const done = await target.tx([S_META], 'readonly', (tx) =>
    requestToPromise(tx.objectStore(S_META).get(META_MIGRATED_FROM)),
  );
  if (done !== undefined) return { status: 'already-done' };

  if (!(await databaseExists(opts.factory, legacyName))) {
    await markTarget(target, 'none');
    return { status: 'no-legacy' };
  }

  // Ouverture SANS montée de version : on ne modifie pas le schéma de l'ancienne base.
  const legacy = await openDatabase(opts.factory, legacyName, undefined, () => undefined);
  try {
    if (!legacy.objectStoreNames.contains(legacyStore)) {
      await markTarget(target, 'none');
      return { status: 'no-legacy' };
    }

    // 1. Réservation (marqueur posé avant la copie) + lecture, dans une transaction.
    const claim = await runTransaction(legacy, [legacyStore], 'readwrite', async (tx) => {
      const store = tx.objectStore(legacyStore);
      const marker = await requestToPromise(store.get(STORAGE_KEYS.SYNC_MIGRATED_TO));
      if (marker !== undefined && marker !== target.name) {
        return { claimedBy: String(marker), entries: [] as Array<[string, unknown]> };
      }
      if (marker === undefined) store.put(target.name, STORAGE_KEYS.SYNC_MIGRATED_TO);
      return { claimedBy: null, entries: await txEntries<unknown>(tx, legacyStore) };
    });
    if (claim.claimedBy !== null) {
      await markTarget(target, `none:${claim.claimedBy}`);
      return { status: 'claimed-by-other', target: claim.claimedBy };
    }

    // 2. Copie en UNE transaction sur la base cible.
    const legacyOutbox = claim.entries.find(([k]) => k === STORAGE_KEYS.SYNC_OUTBOX)?.[1];
    const legacyCursor = claim.entries.find(([k]) => k === STORAGE_KEYS.SYNC_CURSOR)?.[1];
    const data = claim.entries.filter(([k]) => !LEGACY_SYNC_KEYS.has(k));
    const nowMs = opts.now();
    const nowIso = new Date(nowMs).toISOString();

    const result = await target.tx(
      [S_KV, S_OUTBOX, S_META, S_RECOVERY],
      'readwrite',
      async (tx) => {
        const again = await requestToPromise(tx.objectStore(S_META).get(META_MIGRATED_FROM));
        if (again !== undefined) return { status: 'already-done' } as const;
        const kv = tx.objectStore(S_KV);
        let copied = 0;
        let kept = 0;
        const present = new Set<string>();
        for (const [key, value] of data) {
          const existing = await requestToPromise(kv.get(key));
          if (existing === undefined) {
            kv.put(value, key);
            copied++;
            present.add(key);
          } else {
            present.add(key);
            if (!jsonEqual(existing, value)) {
              // La base cible a déjà une valeur : elle est gardée, l'ancienne est mise de côté.
              const rec: RecoveryRecord = { key, value, reason: 'reconcile', at: nowIso };
              tx.objectStore(S_RECOVERY).put(rec, `reconcile:${nowIso}:${key}`);
              kept++;
            }
          }
        }

        let outboxCount = 0;
        if (opts.syncEnabled && Array.isArray(legacyOutbox)) {
          const outbox = tx.objectStore(S_OUTBOX);
          for (const item of legacyOutbox as unknown[]) {
            if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
            const key = item[0];
            const raw = item[1] as LegacyOutboxItem | undefined;
            if (isLocalOnlyKey(key) || LEGACY_SYNC_KEYS.has(key)) continue;
            if (raw?.op !== 'set' && raw?.op !== 'remove') continue;
            // L'état local fait foi : une clé présente est une écriture, absente une suppression.
            const op = present.has(key) ? 'set' : raw.op === 'remove' ? 'delete' : null;
            if (op === null) continue; // « set » sans valeur locale : rien à pousser
            const entry: OutboxEntry = {
              op,
              base: null,
              rev: 1,
              attempts: 0,
              nextTryAt: 0,
              state: 'pending',
              queuedAt: nowMs + outboxCount,
              origin: 'legacy',
            };
            outbox.put(entry, key);
            outboxCount++;
          }
        }

        const meta = tx.objectStore(S_META);
        meta.put(legacyName, META_MIGRATED_FROM);
        if (opts.syncEnabled) {
          meta.put(true, META_NEEDS_RECONCILE);
          // Dernier état serveur vu par l'ancien client : distingue, à la réconciliation,
          // une copie locale périmée d'une écriture locale faite hors outbox.
          // (Validé à l'usage par le moteur : une valeur illisible est ignorée.)
          if (typeof legacyCursor === 'string') meta.put(legacyCursor, META_LEGACY_CURSOR);
        }
        return { status: 'migrated', keys: copied, outbox: outboxCount, kept } as const;
      },
    );

    // 3. L'ancienne outbox vit désormais dans la base cible : elle est retirée de l'ancienne
    // base (seule modification de celle-ci avec le marqueur), sinon un retour arrière vers
    // l'ancienne version la rejouerait et écraserait dans le cloud les modifications faites
    // depuis. Idem pour le journal de repli de cette base (ses données viennent d'être
    // copiées). Les données de l'ancienne base restent intactes. Échec sans gravité.
    if (result.status === 'migrated') {
      try {
        await runTransaction(legacy, [legacyStore], 'readwrite', async (tx) => {
          const store = tx.objectStore(legacyStore);
          const marker = await requestToPromise(store.get(STORAGE_KEYS.SYNC_MIGRATED_TO));
          if (marker !== target.name) return;
          if (opts.syncEnabled && legacyOutbox !== undefined) {
            store.delete(STORAGE_KEYS.SYNC_OUTBOX);
          }
          await dropJournal(store, target.name, null);
        });
      } catch (err) {
        console.warn('[sync] ancienne outbox non retirée de l’ancienne base :', err);
      }
    }
    return result;
  } finally {
    legacy.close();
  }
}

async function markTarget(target: LocalSyncDb, value: string): Promise<void> {
  await target.tx([S_META], 'readwrite', (tx) => {
    tx.objectStore(S_META).put(value, META_MIGRATED_FROM);
  });
}

/** Retire du journal de repli les clés `done` de la base `target` (toutes si `null`). */
async function dropJournal(
  store: IDBObjectStore,
  target: string,
  done: ReadonlySet<string> | null,
): Promise<void> {
  const raw = await requestToPromise(store.get(STORAGE_KEYS.SYNC_FALLBACK_JOURNAL));
  if (raw === undefined) return;
  const journal = readJournal(raw);
  const left = done === null ? [] : (journal[target] ?? []).filter((k) => !done.has(k));
  const next = Object.fromEntries(Object.entries(journal).filter(([t]) => t !== target));
  if (left.length > 0) next[target] = left;
  if (Object.keys(next).length > 0) store.put(next, STORAGE_KEYS.SYNC_FALLBACK_JOURNAL);
  else store.delete(STORAGE_KEYS.SYNC_FALLBACK_JOURNAL);
}

export type FallbackImportResult =
  | { status: 'none' }
  | { status: 'imported'; written: number; setAside: number };

/**
 * Reprise des écritures faites dans l'ancienne base pendant un REPLI
 * (`LegacyFallbackStorage`), base du compte déjà migrée. Règles (aucune perte) :
 *  - séance (une clé par séance) : écriture locale ordinaire (donnée + outbox, `base`
 *    nulle : le serveur tranche, une séance n'est jamais perdue — copie « (conflit) » au
 *    besoin) ; une valeur en attente qu'elle remplace est mise de côté ;
 *  - clé propre à l'appareil (séance en cours…) : recopiée telle quelle ;
 *  - toute autre clé : la valeur du repli a été calculée à partir de l'ancienne base,
 *    peut-être périmée (valeurs par défaut, listes anciennes) : elle n'écrase rien et est
 *    mise de côté (« Restaurer » dans le profil).
 * Le journal n'est vidé qu'après la validation de la transaction de la base cible.
 */
export async function importFallbackWrites(
  target: LocalSyncDb,
  opts: Omit<LegacyMigrationOptions, 'now'> & { now: () => number },
): Promise<FallbackImportResult> {
  const legacyName = opts.legacyDbName ?? LEGACY_DB_NAME;
  const legacyStore = opts.legacyStoreName ?? LEGACY_STORE_NAME;
  if (!(await databaseExists(opts.factory, legacyName))) return { status: 'none' };
  const legacy = await openDatabase(opts.factory, legacyName, undefined, () => undefined);
  try {
    if (!legacy.objectStoreNames.contains(legacyStore)) return { status: 'none' };
    const pending = await runTransaction(legacy, [legacyStore], 'readonly', async (tx) => {
      const store = tx.objectStore(legacyStore);
      const journal = readJournal(
        await requestToPromise(store.get(STORAGE_KEYS.SYNC_FALLBACK_JOURNAL)),
      );
      const keys = journal[target.name] ?? [];
      const values = await Promise.all(keys.map((k) => requestToPromise(store.get(k))));
      return keys.map((k, i) => [k, values[i]] as [string, unknown]);
    });
    if (pending.length === 0) return { status: 'none' };

    const nowMs = opts.now();
    const nowIso = new Date(nowMs).toISOString();
    const res = await target.tx([S_KV, S_OUTBOX, S_RECOVERY], 'readwrite', async (tx) => {
      const kv = tx.objectStore(S_KV);
      const outbox = tx.objectStore(S_OUTBOX);
      let written = 0;
      let setAside = 0;
      let n = 0;
      const setAsideValue = (key: string, value: unknown): void => {
        const rec: RecoveryRecord = { key, value, reason: 'reconcile', at: nowIso };
        tx.objectStore(S_RECOVERY).put(rec, `reconcile:${nowIso}:${key}:fallback${n++}`);
        setAside++;
      };
      for (const [key, value] of pending) {
        if (LEGACY_SYNC_KEYS.has(key)) continue;
        const current = await requestToPromise(kv.get(key));
        const same = value === undefined ? current === undefined : jsonEqual(current, value);
        if (same) continue;
        if (isLocalOnlyKey(key)) {
          if (value === undefined) kv.delete(key);
          else kv.put(toPlain(value), key);
          continue;
        }
        if (!key.startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX)) {
          if (value !== undefined) setAsideValue(key, value);
          continue;
        }
        const entry = (await requestToPromise(outbox.get(key))) as OutboxEntry | undefined;
        // Valeur locale non encore envoyée (ou base invité) remplacée : mise de côté.
        if (current !== undefined && (entry !== undefined || !opts.syncEnabled)) {
          setAsideValue(key, current);
        }
        if (value === undefined) kv.delete(key);
        else kv.put(toPlain(value), key);
        written++;
        if (!opts.syncEnabled) continue;
        const op = value === undefined ? 'delete' : 'set';
        outbox.put(
          entry && entry.op !== 'delete_all'
            ? rearm(entry, { op, rev: entry.rev + 1, attempts: 0, nextTryAt: 0 })
            : newEntry(op, null, nowMs, { origin: 'legacy' }),
          key,
        );
      }
      return { written, setAside };
    });

    try {
      const done = new Set(pending.map(([k]) => k));
      await runTransaction(legacy, [legacyStore], 'readwrite', (tx) =>
        dropJournal(tx.objectStore(legacyStore), target.name, done),
      );
    } catch (err) {
      // Réimport sans effet au prochain lancement (valeurs identiques ignorées).
      console.warn('[sync] journal de repli non vidé :', err);
    }
    return { status: 'imported', ...res };
  } finally {
    legacy.close();
  }
}
