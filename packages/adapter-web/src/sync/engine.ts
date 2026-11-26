/**
 * Moteur de synchronisation (push / pull / conflits / suppression totale / liaison
 * invité), chargé À LA DEMANDE par SyncedStorage après le premier rendu : hors du
 * bundle de démarrage. Contrat : docs/architecture/sync.md § 4.3, 4.4, 4.7, 4.8.
 */
import {
  STORAGE_KEYS,
  defaultMergeRegistry,
  jsonEqual,
  resolveSyncConflict,
  validateStorageKey,
  type ConflictResolution,
  type MergeRegistry,
  type StorageWrite,
  type SyncKeyState,
} from '@kinetic/core';
import { databaseExists, requestToPromise, txEntries, txKeys } from './idb.js';
import {
  DELETE_ALL_KEY,
  GUEST_OWNER,
  LocalSyncDb,
  META_CURSOR,
  META_GUEST_LINK,
  META_INITIAL_PULL_DONE,
  META_LAST_PULL_AT,
  META_LAST_PUSH_AT,
  META_LEGACY_CURSOR,
  META_NEEDS_RECONCILE,
  S_KV,
  S_META,
  S_OUTBOX,
  S_RECOVERY,
  S_VERSIONS,
  LocalResetError,
  dbNameForOwner,
  readEpoch,
  type OutboxEntry,
  type PullCursor,
  type RecoveryRecord,
  type VersionInfo,
} from './local-db.js';
import { isLocalOnlyKey } from './local-keys.js';
import {
  SyncCallError,
  type PullChange,
  type PushItem,
  type PushResult,
  type SyncRemote,
} from './remote.js';
import {
  META_PULL_MODE,
  backoffDelayMs,
  errorMessage,
  newEntry,
  rearm,
  stateOf,
  toPlain,
  type EngineHost,
  type PullMode,
} from './shared.js';

const FAILURE_NOTIFY_THRESHOLD = 3;
const CONFLICT_BACKOFF_THRESHOLD = 3;
/**
 * Version serveur (`timestamptz` texte : ISO ou format Postgres, fraction jusqu'à la
 * microseconde) en microsecondes depuis l'époque ; `null` si illisible.
 */
export function serverVersionMicros(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      text.trim(),
    );
  if (!m) return null;
  const tz = m[4];
  let offset = 'Z';
  if (tz && tz !== 'Z') {
    const digits = tz.slice(1).replace(':', '').padEnd(4, '0');
    offset = `${tz[0]}${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  }
  const ms = Date.parse(`${m[1]}T${m[2]}${offset}`);
  if (!Number.isFinite(ms)) return null;
  return ms * 1000 + Number((m[3] ?? '').padEnd(6, '0').slice(0, 6));
}

/** Avance maximale tolérée du curseur de l'ancien client sur l'horloge de l'appareil. */
const LEGACY_CURSOR_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
const MAX_VALUE_BYTES = 1_048_576;

interface BatchItem {
  key: string;
  rev: number;
  item: PushItem;
}

export interface GuestDataSummary {
  /** Nombre de clés de données dans la base invité. */
  count: number;
  /** Décision déjà prise pour ce compte (`linked`, `declined`) ou `null`. */
  decision: 'linked' | 'declined' | null;
}

function sameState(a: SyncKeyState, b: SyncKeyState): boolean {
  if (a.deleted || b.deleted) return a.deleted === b.deleted;
  return jsonEqual(a.value, b.value);
}

/** Entrée sans l'état « envoyé sans réponse » (la version serveur est désormais connue). */
function withoutSent(entry: OutboxEntry): OutboxEntry {
  const next: OutboxEntry = { ...entry };
  delete next.sent;
  delete next.sentEarlier;
  return next;
}

export class SyncEngine {
  constructor(private readonly h: EngineHost) {}

  async flushLocked(remote: SyncRemote, ignoreBackoff: boolean): Promise<void> {
    if (!this.h.isOnline()) return;
    this.h.state.busy++;
    this.h.scheduleStatus();
    try {
      for (let round = 0; round < 10_000 && !this.h.isDisposed(); round++) {
        const now = this.h.now();
        const entries = await this.h.db.tx([S_OUTBOX], 'readonly', (tx) =>
          txEntries<OutboxEntry>(tx, S_OUTBOX),
        );
        const deleteAll = entries.find(([k]) => k === DELETE_ALL_KEY)?.[1];
        if (deleteAll) {
          // « Supprimer toutes mes données cloud » passe avant tout le reste.
          if (deleteAll.state !== 'pending') return;
          if (!ignoreBackoff && deleteAll.nextTryAt > now) return;
          if (!(await this.runDeleteAll(remote))) return;
          continue;
        }
        const eligible = entries
          .filter(([, e]) => e.state === 'pending' && (ignoreBackoff || e.nextTryAt <= now))
          .sort((a, b) => a[1].queuedAt - b[1].queuedAt);
        if (eligible.length === 0) return;

        const { batch, epoch } = await this.buildBatch(eligible);
        if (batch.length === 0) continue;

        let results: PushResult[];
        try {
          results = await this.withAuth(remote, () => remote.push(batch.map((b) => b.item)));
          if (
            !Array.isArray(results) ||
            results.length !== batch.length ||
            results.some((r, i) => !r || (r.key !== null && r.key !== batch[i]!.key))
          ) {
            throw new SyncCallError('fatal', 'réponse sync_push incohérente', 'bad_reply');
          }
        } catch (err) {
          await this.onCallFailure(
            batch.map((b) => b.key),
            err,
            batch,
          );
          return;
        }
        this.h.state.pushError = null;
        this.h.state.authRequired = false;
        await this.applyPushResults(remote, batch, results, epoch);
      }
    } finally {
      this.h.state.busy--;
    }
  }

  /** Forme un lot (≤ batchMaxItems, ≤ batchMaxBytes) ; valeurs lues dans `kv` maintenant. */
  private async buildBatch(
    eligible: Array<[string, OutboxEntry]>,
  ): Promise<{ batch: BatchItem[]; epoch: number }> {
    const tooLarge: string[] = [];
    const dropped: Array<[string, number]> = [];
    let epoch = 0;
    const batch = await this.h.db.tx([S_KV, S_OUTBOX, S_META], 'readonly', async (tx) => {
      epoch = await readEpoch(tx);
      const out: BatchItem[] = [];
      let bytes = 0;
      for (const [key, snap] of eligible) {
        if (out.length >= this.h.batchMaxItems) break;
        const entry = (await requestToPromise(tx.objectStore(S_OUTBOX).get(key))) as
          | OutboxEntry
          | undefined;
        if (!entry || entry.state !== 'pending' || entry.rev !== snap.rev) continue;
        if (entry.op === 'delete') {
          out.push({ key, rev: entry.rev, item: { key, deleted: true, base: entry.base } });
          continue;
        }
        const value = await requestToPromise(tx.objectStore(S_KV).get(key));
        if (value === undefined) {
          // Entrée « set » sans valeur locale (ancienne outbox) : rien à envoyer.
          dropped.push([key, entry.rev]);
          continue;
        }
        const size = JSON.stringify(value).length;
        if (size * 1.1 > MAX_VALUE_BYTES) {
          tooLarge.push(key);
          continue;
        }
        if (out.length > 0 && bytes + size > this.h.batchMaxBytes) break;
        bytes += size;
        out.push({ key, rev: entry.rev, item: { key, value, base: entry.base } });
      }
      return out;
    });
    if (tooLarge.length > 0 || dropped.length > 0) {
      await this.h.db.tx([S_OUTBOX], 'readwrite', async (tx) => {
        const outbox = tx.objectStore(S_OUTBOX);
        for (const key of tooLarge) {
          const e = (await requestToPromise(outbox.get(key))) as OutboxEntry | undefined;
          if (e) outbox.put({ ...e, state: 'blocked', reason: 'value_too_large' }, key);
        }
        for (const [key, rev] of dropped) {
          const e = (await requestToPromise(outbox.get(key))) as OutboxEntry | undefined;
          if (e && e.rev === rev) outbox.delete(key);
        }
      });
    }
    return { batch, epoch };
  }

  private async withAuth<T>(remote: SyncRemote, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof SyncCallError) || err.kind !== 'auth') throw err;
      if (!(await remote.refreshSession().catch(() => false))) throw err;
      return call();
    }
  }

  /** L'appel entier a échoué : backoff (réseau, auth) ou blocage (erreur fatale). */
  private async onCallFailure(
    keys: readonly string[],
    err: unknown,
    sentBatch: readonly BatchItem[] = [],
  ): Promise<void> {
    const kind = err instanceof SyncCallError ? err.kind : 'network';
    const code = err instanceof SyncCallError ? err.code : null;
    if (kind === 'auth') {
      this.h.state.authRequired = true;
      this.h.state.pushError = 'Reconnectez-vous pour synchroniser';
    } else if (kind === 'network') {
      this.h.state.pushError = 'Serveur injoignable, nouvel essai automatique';
    } else {
      this.h.state.pushError = errorMessage(err);
    }
    const now = this.h.now();
    const notify: Array<[string, number]> = [];
    await this.h.db.tx([S_OUTBOX], 'readwrite', async (tx) => {
      const outbox = tx.objectStore(S_OUTBOX);
      for (const key of keys) {
        const e = (await requestToPromise(outbox.get(key))) as OutboxEntry | undefined;
        if (!e) continue;
        if (kind === 'fatal') {
          outbox.put({ ...e, state: 'blocked', reason: `internal:${code ?? 'call'}` }, key);
          continue;
        }
        const attempts = e.attempts + 1;
        const next: OutboxEntry = { ...e, attempts, nextTryAt: now + backoffDelayMs(attempts) };
        // Réseau : la requête a pu être appliquée sans que la réponse arrive. L'état envoyé
        // est noté pour reconnaître notre propre écriture au prochain conflit.
        const item = kind === 'network' ? sentBatch.find((b) => b.key === key)?.item : undefined;
        if (item) {
          const state: SyncKeyState = item.deleted
            ? { deleted: true }
            : { deleted: false, value: item.value };
          if (e.sent !== undefined && !sameState(e.sent, state)) {
            next.sentEarlier = [...(e.sentEarlier ?? []), e.sent].slice(-4);
          }
          next.sent = state;
        }
        outbox.put(next, key);
        if (attempts === FAILURE_NOTIFY_THRESHOLD) notify.push([key, attempts]);
      }
    });
    for (const [key, attempts] of notify) {
      this.h.emit(STORAGE_KEYS.EVENT_SYNC_FAILED, { key, attempts });
    }
    console.warn('[sync] envoi échoué :', err);
  }

  private async applyPushResults(
    remote: SyncRemote,
    batch: readonly BatchItem[],
    results: readonly PushResult[],
    epoch: number,
  ): Promise<void> {
    // Règles de fusion chargées AVANT la transaction (aucune attente hors IDB dedans).
    const registry = results.some((r) => r.status === 'conflict')
      ? await this.h.getRegistry()
      : defaultMergeRegistry;
    // Conflits dont la valeur serveur a été omise (réponse > 4 Mo) : relue avant la transaction.
    const fetched = new Map<string, PushResult>();
    for (let i = 0; i < batch.length; i++) {
      const r = results[i]!;
      if (r.status !== 'conflict' || !r.server_value_omitted) continue;
      try {
        const state = await this.withAuth(remote, () => remote.fetchKey(batch[i]!.key));
        fetched.set(
          batch[i]!.key,
          state
            ? {
                ...r,
                updated_at: state.updated_at,
                server_deleted: state.deleted,
                server_value: state.value,
              }
            : { ...r, server_deleted: true },
        );
      } catch {
        /* traité comme un report : nouvel essai plus tard */
      }
    }

    const nowMs = this.h.now();
    const nowIso = new Date(nowMs).toISOString();
    const changed: string[] = [];
    const notices: string[] = [];
    const failedNotify: Array<[string, number]> = [];
    await this.h.db.tx(
      [S_KV, S_OUTBOX, S_VERSIONS, S_META, S_RECOVERY],
      'readwrite',
      async (tx) => {
        const outbox = tx.objectStore(S_OUTBOX);
        const versions = tx.objectStore(S_VERSIONS);
        // Remise à zéro locale pendant l'appel : une entrée présente a été écrite APRÈS
        // (même `rev` possible, elle repart de 1) ; ce n'est jamais celle qui a été envoyée.
        const reset = (await readEpoch(tx)) !== epoch;
        let anyOk = false;
        for (let i = 0; i < batch.length; i++) {
          const b = batch[i]!;
          let r = results[i]!;
          const entry = (await requestToPromise(outbox.get(b.key))) as OutboxEntry | undefined;
          if (r.status === 'conflict' && r.server_value_omitted) {
            const f = fetched.get(b.key);
            if (!f) r = { ...r, status: 'deferred', reason: 'transient:fetch' };
            else r = f;
          }
          switch (r.status) {
            case 'ok': {
              anyOk = true;
              const deleted = r.deleted ?? b.item.deleted === true;
              // Base vidée depuis l'envoi et clé non réécrite : rien à noter.
              if (reset && !entry) break;
              if (typeof r.updated_at === 'string') {
                versions.put({ updated_at: r.updated_at, deleted } satisfies VersionInfo, b.key);
              }
              if (!entry) break;
              if (entry.rev === b.rev && !reset) outbox.delete(b.key);
              else {
                // Écriture locale arrivée pendant l'envoi : elle repart sur la nouvelle version.
                outbox.put(
                  rearm(withoutSent(entry), {
                    base: r.updated_at,
                    ancestor: b.item.deleted
                      ? { deleted: true }
                      : { deleted: false, value: b.item.value },
                    attempts: 0,
                    nextTryAt: 0,
                    conflicts: 0,
                  }),
                  b.key,
                );
              }
              break;
            }
            case 'conflict': {
              if (!entry || typeof r.updated_at !== 'string') break;
              const server: SyncKeyState = r.server_deleted
                ? { deleted: true }
                : { deleted: false, value: r.server_value ?? null };
              const res = await this.resolveInTx(
                registry,
                tx,
                b.key,
                entry,
                server,
                r.updated_at,
                nowIso,
              );
              await this.applyResolution(
                tx,
                b.key,
                entry,
                { server, serverVersion: r.updated_at, res },
                nowMs,
                nowIso,
              );
              changed.push(b.key, ...(res.extraWrites ?? []).map((w) => w.key));
              if (res.notice) notices.push(res.notice);
              break;
            }
            case 'rejected': {
              // Le refus visait l'ancien contenu, pas l'entrée écrite après la remise à zéro.
              if (!entry || reset) break;
              if (r.reason === 'duplicate_key') {
                outbox.put({ ...entry, nextTryAt: 0 }, b.key);
                break;
              }
              outbox.put({ ...entry, state: 'blocked', reason: r.reason ?? 'rejected' }, b.key);
              break;
            }
            default: {
              if (!entry || reset) break;
              if (r.reason === 'batch_limit') {
                outbox.put({ ...entry, nextTryAt: 0 }, b.key);
              } else {
                const attempts = entry.attempts + 1;
                outbox.put(
                  { ...entry, attempts, nextTryAt: nowMs + backoffDelayMs(attempts) },
                  b.key,
                );
                if (attempts === FAILURE_NOTIFY_THRESHOLD) failedNotify.push([b.key, attempts]);
              }
            }
          }
        }
        if (anyOk) tx.objectStore(S_META).put(nowIso, META_LAST_PUSH_AT);
      },
    );
    for (const [key, attempts] of failedNotify) {
      this.h.emit(STORAGE_KEYS.EVENT_SYNC_FAILED, { key, attempts });
    }
    this.afterRemoteApply(changed, notices);
  }

  /** Lit l'état local de la clé (et ses suppressions d'éléments) puis applique la stratégie. */
  private async resolveInTx(
    registry: MergeRegistry,
    tx: IDBTransaction,
    key: string,
    entry: OutboxEntry,
    server: SyncKeyState,
    serverVersion: string,
    nowIso: string,
  ): Promise<ConflictResolution> {
    const kv = tx.objectStore(S_KV);
    const local = stateOf(await requestToPromise(kv.get(key)));
    // Notre envoi précédent (réponse perdue) a été appliqué : le serveur n'a pas changé
    // depuis, l'écriture locale suivante s'applique telle quelle (avance rapide).
    const sentStates = entry.sent ? [entry.sent, ...(entry.sentEarlier ?? [])] : [];
    if (sentStates.some((sent) => sameState(sent, server))) {
      return sameState(local, server)
        ? { result: server, push: false }
        : { result: local, push: true };
    }
    // Marques de suppression d'éléments : utiles quand l'appareil ne connaît pas l'histoire
    // commune de la clé (ancêtre inconnu, ou clé jamais vue du serveur : `base` nulle).
    const tombstones =
      entry.ancestor === undefined || entry.ancestor.deleted
        ? ((await requestToPromise(kv.get(STORAGE_KEYS.ITEM_TOMBSTONES(key)))) ?? null)
        : null;
    return resolveSyncConflict(registry, {
      key,
      local,
      server,
      serverVersion,
      pending: {
        op: entry.op === 'delete' ? 'delete' : 'set',
        seed: entry.seed === true,
        origin: entry.origin ?? 'app',
      },
      now: nowIso,
      ancestor: entry.ancestor,
      itemTombstones: tombstones as Readonly<Record<string, string>> | null,
    });
  }

  /** Applique une résolution : valeur locale, version serveur, outbox, copies, clés en plus. */
  private async applyResolution(
    tx: IDBTransaction,
    key: string,
    entry: OutboxEntry | null,
    conflict: { server: SyncKeyState; serverVersion: string; res: ConflictResolution },
    nowMs: number,
    nowIso: string,
  ): Promise<void> {
    const { server, serverVersion, res } = conflict;
    const kv = tx.objectStore(S_KV);
    const outbox = tx.objectStore(S_OUTBOX);
    await this.noteRemoteChange(tx, key, res.result);
    if (res.result.deleted) kv.delete(key);
    else kv.put(toPlain(res.result.value), key);
    tx.objectStore(S_VERSIONS).put(
      { updated_at: serverVersion, deleted: server.deleted } satisfies VersionInfo,
      key,
    );
    if (res.push) {
      const conflicts = (entry?.conflicts ?? 0) + 1;
      const base: OutboxEntry = entry ? withoutSent(entry) : newEntry('set', serverVersion, nowMs);
      outbox.put(
        rearm(base, {
          op: res.result.deleted ? 'delete' : 'set',
          base: serverVersion,
          ancestor: server,
          rev: base.rev + 1,
          attempts: 0,
          conflicts,
          seed: false,
          nextTryAt: conflicts > CONFLICT_BACKOFF_THRESHOLD ? nowMs + backoffDelayMs(conflicts) : 0,
        }),
        key,
      );
    } else if (entry) {
      outbox.delete(key);
    }
    let n = 0;
    for (const copy of res.recovery ?? []) {
      const rec: RecoveryRecord = { key, value: copy.value, reason: copy.reason, at: nowIso };
      tx.objectStore(S_RECOVERY).put(rec, `${copy.reason}:${nowIso}:${key}:${n++}`);
    }
    for (const extra of res.extraWrites ?? []) {
      if (!validateStorageKey(extra.key)) continue;
      await this.noteRemoteChange(tx, extra.key, { deleted: false, value: extra.value });
      kv.put(toPlain(extra.value), extra.key);
      const existing = (await requestToPromise(outbox.get(extra.key))) as OutboxEntry | undefined;
      outbox.put(
        existing
          ? rearm(existing, { op: 'set', rev: existing.rev + 1, attempts: 0, nextTryAt: 0 })
          : newEntry('set', null, nowMs, { ancestor: { deleted: true } }),
        extra.key,
      );
    }
  }

  /** La synchro va modifier `key` dans `kv` : l'état que l'app avait vu est mémorisé. */
  private async noteRemoteChange(
    tx: IDBTransaction,
    key: string,
    after: SyncKeyState = { deleted: true },
  ): Promise<void> {
    if (!this.h.observes(key)) return;
    const before = stateOf(await requestToPromise(tx.objectStore(S_KV).get(key)));
    if (!sameState(before, after)) this.h.remoteTouched(key, before);
  }

  /**
   * Écriture de l'app fondée sur un état PÉRIMÉ (lu avant qu'un pull, un conflit ou une
   * suppression totale ne modifie la clé) : fusion à trois voies par domaine, dans la
   * transaction d'écriture, entre ce que l'app avait vu (`seen`), ce qu'elle écrit
   * (`local`) et la valeur actuelle de `kv`. Sans elle, l'écriture repartait avec la
   * version la plus récente comme `base` et écrasait la modification de l'autre appareil
   * sans conflit ni copie. Renvoie l'état à écrire ; les copies (récupération, séance
   * « (conflit) ») sont écrites ici.
   */
  async rebaseStaleWrite(
    registry: MergeRegistry,
    tx: IDBTransaction,
    key: string,
    local: SyncKeyState,
    seen: SyncKeyState | undefined,
    nowMs: number,
  ): Promise<{ result: SyncKeyState; extraKeys: string[]; notice?: string }> {
    const kv = tx.objectStore(S_KV);
    const current = stateOf(await requestToPromise(kv.get(key)));
    const nowIso = new Date(nowMs).toISOString();
    const version = (await requestToPromise(tx.objectStore(S_VERSIONS).get(key))) as
      | VersionInfo
      | undefined;
    const tombstones =
      seen === undefined || seen.deleted
        ? ((await requestToPromise(kv.get(STORAGE_KEYS.ITEM_TOMBSTONES(key)))) ?? null)
        : null;
    const res = resolveSyncConflict(registry, {
      key,
      local,
      server: current,
      serverVersion: version?.updated_at ?? '',
      pending: { op: local.deleted ? 'delete' : 'set', seed: false, origin: 'app' },
      now: nowIso,
      ancestor: seen,
      itemTombstones: tombstones as Readonly<Record<string, string>> | null,
    });
    let n = 0;
    for (const copy of res.recovery ?? []) {
      const rec: RecoveryRecord = { key, value: copy.value, reason: copy.reason, at: nowIso };
      tx.objectStore(S_RECOVERY).put(rec, `${copy.reason}:${nowIso}:${key}:stale${n++}`);
    }
    const extraKeys: string[] = [];
    for (const extra of res.extraWrites ?? []) {
      if (!validateStorageKey(extra.key)) continue;
      kv.put(toPlain(extra.value), extra.key);
      extraKeys.push(extra.key);
      const outbox = tx.objectStore(S_OUTBOX);
      const existing = (await requestToPromise(outbox.get(extra.key))) as OutboxEntry | undefined;
      outbox.put(
        existing
          ? rearm(existing, { op: 'set', rev: existing.rev + 1, attempts: 0, nextTryAt: 0 })
          : newEntry('set', null, nowMs, { ancestor: { deleted: true } }),
        extra.key,
      );
    }
    return res.notice !== undefined
      ? { result: res.result, extraKeys, notice: res.notice }
      : { result: res.result, extraKeys };
  }

  private async runDeleteAll(remote: SyncRemote): Promise<boolean> {
    const epoch = await this.h.db.tx([S_META], 'readonly', (tx) => readEpoch(tx));
    let res: { deleted_count: number; updated_at: string | null };
    try {
      res = await this.withAuth(remote, () => remote.deleteAll());
    } catch (err) {
      await this.onCallFailure([DELETE_ALL_KEY], err);
      return false;
    }
    const nowIso = new Date(this.h.now()).toISOString();
    const changed = await this.h.db.tx(
      [S_KV, S_OUTBOX, S_VERSIONS, S_META],
      'readwrite',
      async (tx) => {
        // Nouvelle demande (ou effacement local) pendant l'appel : l'outbox actuelle n'est
        // pas celle de la demande traitée. Rien n'est touché ; une demande en attente est
        // rejouée (idempotente) au tour suivant.
        if ((await readEpoch(tx)) !== epoch) return [];
        const outbox = tx.objectStore(S_OUTBOX);
        const entries = await txEntries<OutboxEntry>(tx, S_OUTBOX);
        // Entrées écrites APRÈS la demande : conservées, rebasées sur les tombstones.
        const kept = new Set<string>();
        for (const [k, e] of entries) {
          if (k === DELETE_ALL_KEY) continue;
          kept.add(k);
          outbox.put(rearm(e, { base: res.updated_at, ancestor: { deleted: true } }), k);
        }
        outbox.delete(DELETE_ALL_KEY);
        const keys = await txKeys(tx, S_KV);
        const removed: string[] = [];
        for (const k of keys) {
          if (isLocalOnlyKey(k) || kept.has(k)) continue;
          await this.noteRemoteChange(tx, k);
          tx.objectStore(S_KV).delete(k);
          removed.push(k);
        }
        tx.objectStore(S_VERSIONS).clear();
        tx.objectStore(S_META).put(nowIso, META_LAST_PUSH_AT);
        return removed;
      },
    );
    this.h.state.pushError = null;
    this.afterRemoteApply(changed, []);
    return true;
  }

  async pullLocked(remote: SyncRemote, forceResync: boolean): Promise<void> {
    if (!this.h.isOnline()) return;
    this.h.state.busy++;
    this.h.scheduleStatus();
    try {
      const meta = await this.h.db.tx([S_META], 'readonly', async (tx) => {
        const m = tx.objectStore(S_META);
        const [cursor, reconcile, pending, epoch] = await Promise.all([
          requestToPromise(m.get(META_CURSOR)),
          requestToPromise(m.get(META_NEEDS_RECONCILE)),
          requestToPromise(m.get(META_PULL_MODE)),
          readEpoch(tx),
        ]);
        return {
          epoch,
          cursor: (cursor as PullCursor | undefined) ?? null,
          reconcile: reconcile === true,
          pending: (pending as PullMode | undefined) ?? null,
        };
      });
      // Réconciliation après migration prioritaire (elle pousse les données d'avant
      // migration au lieu de les mettre de côté) ; puis passe interrompue reprise de zéro.
      let mode: PullMode = meta.reconcile
        ? 'reconcile'
        : forceResync
          ? 'resync'
          : (meta.pending ?? (meta.cursor ? 'delta' : 'full'));
      let restarted = false;
      for (;;) {
        const outcome = await this.pullPass(remote, mode, meta.cursor, meta.epoch);
        if (outcome === 'resync' && !restarted && mode === 'delta') {
          restarted = true;
          mode = 'resync';
          continue;
        }
        break;
      }
      this.h.state.pullError = null;
      this.h.state.authRequired = false;
    } catch (err) {
      // Base remise à zéro pendant le pull : rien n'a été appliqué, le prochain repart d'elle.
      if (err instanceof LocalResetError) return;
      if (err instanceof SyncCallError && err.kind === 'auth') {
        this.h.state.authRequired = true;
        this.h.state.pullError = 'Reconnectez-vous pour synchroniser';
      } else {
        this.h.state.pullError =
          err instanceof SyncCallError && err.kind === 'network'
            ? 'Serveur injoignable, nouvel essai automatique'
            : errorMessage(err);
      }
      console.warn('[sync] pull interrompu :', err);
    } finally {
      this.h.state.busy--;
    }
  }

  /** Une passe de pull. Renvoie 'resync' si le serveur l'exige (curseur trop ancien / futur). */
  private async pullPass(
    remote: SyncRemote,
    mode: PullMode,
    cursor: PullCursor | null,
    epoch: number,
  ): Promise<'done' | 'resync'> {
    const full = mode !== 'delta';
    let since: string | null = full ? null : (cursor?.since ?? null);
    let afterKey = full ? '' : (cursor?.afterKey ?? '');
    if (full) {
      await this.h.db.tx([S_META], 'readwrite', async (tx) => {
        await this.assertEpoch(tx, epoch);
        tx.objectStore(S_META).put(mode, META_PULL_MODE);
      });
    }
    const registry = mode === 'reconcile' ? await this.h.getRegistry() : defaultMergeRegistry;
    let legacySeen =
      mode === 'reconcile'
        ? serverVersionMicros(
            await this.h.db.tx([S_META], 'readonly', (tx) =>
              requestToPromise(tx.objectStore(S_META).get(META_LEGACY_CURSOR)),
            ),
          )
        : null;
    // Curseur dans le futur (anciennes versions serveur fixées par le client, ramenées à
    // l'heure par la migration 010) : inutilisable, réconciliation sans lui.
    if (legacySeen !== null && legacySeen > (this.h.now() + LEGACY_CURSOR_MAX_AHEAD_MS) * 1000) {
      legacySeen = null;
    }
    const stale = { kept: 0 };
    const serverKeys = new Set<string>();
    let last: PullChange | null = null;
    const changedAll: string[] = [];
    for (let page = 0; page < 1_000_000; page++) {
      const res = await this.withAuth(remote, () => remote.pull(since, afterKey, this.h.pageSize));
      if (res.resync_required) {
        if (full)
          throw new Error(`[sync] resync demandé pendant un pull complet (${res.reason ?? '?'})`);
        return 'resync';
      }
      const changes = Array.isArray(res.changes) ? res.changes : [];
      for (const c of changes) serverKeys.add(c.key);
      const pageLast = changes.length > 0 ? changes[changes.length - 1]! : null;
      if (changes.length > 0) {
        const changed = await this.applyPullPage(
          registry,
          changes,
          mode,
          full ? null : pageLast,
          { legacySeen, stale },
          epoch,
        );
        changedAll.push(...changed);
        last = pageLast;
      }
      if (!res.has_more || !pageLast) break;
      since = pageLast.updated_at;
      afterKey = pageLast.key;
    }
    const nowIso = new Date(this.h.now()).toISOString();
    const orphans = await this.finishPull(mode, serverKeys, full ? last : null, nowIso, epoch);
    changedAll.push(...orphans.changed);
    const notices: string[] = [];
    if (stale.kept > 0) {
      notices.push(
        stale.kept > 1
          ? `${stale.kept} anciennes valeurs de cet appareil, modifiées depuis sur un autre appareil, ont été mises de côté`
          : '1 ancienne valeur de cet appareil, modifiée depuis sur un autre appareil, a été mise de côté',
      );
    }
    if (orphans.recovered > 0) {
      notices.push(
        `${orphans.recovered} élément${orphans.recovered > 1 ? 's' : ''} de cet appareil absent${orphans.recovered > 1 ? 's' : ''} du cloud ${orphans.recovered > 1 ? 'ont été mis' : 'a été mis'} de côté`,
      );
    }
    this.afterRemoteApply(changedAll, notices);
    return 'done';
  }

  /** Applique une page dans UNE transaction (curseur compris en mode delta). */
  private async applyPullPage(
    registry: MergeRegistry,
    changes: readonly PullChange[],
    mode: PullMode,
    cursorTo: PullChange | null,
    legacy: { legacySeen: number | null; stale: { kept: number } },
    epoch: number,
  ): Promise<string[]> {
    const nowMs = this.h.now();
    const nowIso = new Date(nowMs).toISOString();
    return this.h.db.tx(
      [S_KV, S_OUTBOX, S_VERSIONS, S_META, S_RECOVERY],
      'readwrite',
      async (tx) => {
        await this.assertEpoch(tx, epoch);
        const kv = tx.objectStore(S_KV);
        const versions = tx.objectStore(S_VERSIONS);
        const changed: string[] = [];
        for (const c of changes) {
          if (isLocalOnlyKey(c.key) || !validateStorageKey(c.key)) continue;
          // Écriture locale en attente : jamais écrasée (le conflit sera traité au push).
          const entry = (await requestToPromise(tx.objectStore(S_OUTBOX).get(c.key))) as
            | OutboxEntry
            | undefined;
          if (entry !== undefined) {
            this.adoptLegacyAncestor(tx, c, entry, mode, legacy.legacySeen);
            continue;
          }
          const current = await requestToPromise(kv.get(c.key));
          if (c.deleted) {
            if (current !== undefined) {
              this.h.remoteTouched(c.key, stateOf(current));
              if (mode === 'reconcile') {
                const rec: RecoveryRecord = {
                  key: c.key,
                  value: current,
                  reason: 'reconcile',
                  at: nowIso,
                };
                tx.objectStore(S_RECOVERY).put(rec, `reconcile:${nowIso}:${c.key}`);
              }
              kv.delete(c.key);
              changed.push(c.key);
            }
            versions.put({ updated_at: c.updated_at, deleted: true } satisfies VersionInfo, c.key);
            continue;
          }
          if (mode === 'reconcile' && current !== undefined && !jsonEqual(current, c.value)) {
            const version = serverVersionMicros(c.updated_at);
            if (legacy.legacySeen !== null && version !== null && version > legacy.legacySeen) {
              // Modifiée sur le serveur APRÈS le dernier pull de l'ancien client : la copie
              // locale est l'état périmé d'avant (sinon elle serait dans l'ancienne outbox).
              // Le cloud gagne ; la valeur locale est mise de côté, jamais perdue.
              const rec: RecoveryRecord = {
                key: c.key,
                value: current,
                reason: 'reconcile',
                at: nowIso,
              };
              tx.objectStore(S_RECOVERY).put(rec, `reconcile:${nowIso}:${c.key}`);
              kv.put(c.value, c.key);
              versions.put(
                { updated_at: c.updated_at, deleted: false } satisfies VersionInfo,
                c.key,
              );
              changed.push(c.key);
              legacy.stale.kept++;
              continue;
            }
            // Donnée d'avant migration différente du cloud : fusion par domaine.
            const server: SyncKeyState = { deleted: false, value: c.value };
            const pseudo = newEntry('set', null, nowMs, { origin: 'reconcile' });
            const res = await this.resolveInTx(
              registry,
              tx,
              c.key,
              pseudo,
              server,
              c.updated_at,
              nowIso,
            );
            await this.applyResolution(
              tx,
              c.key,
              res.push ? pseudo : null,
              { server, serverVersion: c.updated_at, res },
              nowMs,
              nowIso,
            );
            changed.push(c.key, ...(res.extraWrites ?? []).map((w) => w.key));
            continue;
          }
          if (current === undefined || !jsonEqual(current, c.value)) {
            this.h.remoteTouched(c.key, stateOf(current));
            kv.put(c.value, c.key);
            changed.push(c.key);
          }
          versions.put({ updated_at: c.updated_at, deleted: false } satisfies VersionInfo, c.key);
        }
        if (cursorTo) {
          tx.objectStore(S_META).put(
            { since: cursorTo.updated_at, afterKey: cursorTo.key } satisfies PullCursor,
            META_CURSOR,
          );
        }
        return changed;
      },
    );
  }

  /**
   * Entrée de l'ANCIENNE outbox (aucune version connue) sur une clé que le serveur n'a pas
   * modifiée depuis le dernier pull de l'ancien client : l'état serveur est celui que
   * l'appareil avait sous les yeux quand il a écrit, c'est donc l'ancêtre. L'entrée est
   * rebasée dessus : la modification (ou la suppression) locale s'applique sans faux
   * conflit, au lieu d'une copie « (conflit) » ou d'une suppression annulée.
   */
  private adoptLegacyAncestor(
    tx: IDBTransaction,
    c: PullChange,
    entry: OutboxEntry,
    mode: PullMode,
    legacySeen: number | null,
  ): void {
    if (mode !== 'reconcile' || legacySeen === null) return;
    if (entry.origin !== 'legacy' || entry.base !== null || entry.ancestor !== undefined) return;
    if (entry.sent !== undefined || entry.state !== 'pending') return;
    const version = serverVersionMicros(c.updated_at);
    if (version === null || version > legacySeen) return;
    const ancestor: SyncKeyState = c.deleted
      ? { deleted: true }
      : { deleted: false, value: c.value };
    tx.objectStore(S_OUTBOX).put({ ...entry, base: c.updated_at, ancestor }, c.key);
    tx.objectStore(S_VERSIONS).put(
      { updated_at: c.updated_at, deleted: c.deleted } satisfies VersionInfo,
      c.key,
    );
  }

  /** Fin de pull : clés locales absentes du serveur (réconciliation / resync), drapeaux. */
  private async finishPull(
    mode: PullMode,
    serverKeys: ReadonlySet<string>,
    cursorTo: PullChange | null,
    nowIso: string,
    epoch: number,
  ): Promise<{ recovered: number; changed: string[] }> {
    const nowMs = this.h.now();
    return this.h.db.tx(
      [S_KV, S_OUTBOX, S_VERSIONS, S_META, S_RECOVERY],
      'readwrite',
      async (tx) => {
        await this.assertEpoch(tx, epoch);
        const changed: string[] = [];
        let recovered = 0;
        if (mode === 'reconcile' || mode === 'resync') {
          const pending = new Set(await txKeys(tx, S_OUTBOX));
          const localKeys = await txKeys(tx, S_KV);
          for (const key of localKeys) {
            if (isLocalOnlyKey(key) || serverKeys.has(key) || pending.has(key)) continue;
            if (mode === 'reconcile') {
              // Écrite hors outbox (ancienne version) et absente du cloud : à pousser.
              tx.objectStore(S_OUTBOX).put(
                newEntry('set', null, nowMs, { origin: 'reconcile', ancestor: { deleted: true } }),
                key,
              );
            } else {
              const value = await requestToPromise(tx.objectStore(S_KV).get(key));
              this.h.remoteTouched(key, stateOf(value));
              const rec: RecoveryRecord = { key, value, reason: 'resync', at: nowIso };
              tx.objectStore(S_RECOVERY).put(rec, `resync:${nowIso}:${key}`);
              tx.objectStore(S_KV).delete(key);
              tx.objectStore(S_VERSIONS).delete(key);
              changed.push(key);
              recovered++;
            }
          }
        }
        const meta = tx.objectStore(S_META);
        if (cursorTo) {
          meta.put(
            { since: cursorTo.updated_at, afterKey: cursorTo.key } satisfies PullCursor,
            META_CURSOR,
          );
        } else if (mode === 'resync') {
          meta.delete(META_CURSOR);
        }
        meta.delete(META_PULL_MODE);
        meta.put(true, META_INITIAL_PULL_DONE);
        meta.put(nowIso, META_LAST_PULL_AT);
        if (mode === 'reconcile' || mode === 'resync') {
          meta.delete(META_NEEDS_RECONCILE);
          meta.delete(META_LEGACY_CURSOR);
        }
        return { recovered, changed };
      },
    );
  }

  /** Pull commencé sur une génération locale antérieure : transaction annulée. */
  private async assertEpoch(tx: IDBTransaction, epoch: number): Promise<void> {
    if ((await readEpoch(tx)) !== epoch) throw new LocalResetError();
  }

  private afterRemoteApply(changed: string[], notices: string[]): void {
    const keys = [...new Set(changed)];
    if (keys.length > 0) {
      this.h.emit(STORAGE_KEYS.EVENT_SYNC_APPLIED, { keys, source: 'sync' });
      this.h.broadcast(keys, 'pull');
    }
    for (const message of notices) {
      this.h.emit(STORAGE_KEYS.EVENT_NOTIFY, { kind: 'info', message });
    }
    this.h.scheduleStatus();
  }

  /** Données présentes dans la base invité de cet appareil (sans la créer). */
  async guestDataSummary(): Promise<GuestDataSummary> {
    const guest = await this.openGuestIfExists();
    if (!guest) return { count: 0, decision: null };
    try {
      return await guest.tx([S_KV, S_META], 'readonly', async (tx) => {
        const keys = (await txKeys(tx, S_KV)).filter((k) => !isLocalOnlyKey(k));
        const link = await requestToPromise(tx.objectStore(S_META).get(META_GUEST_LINK));
        const decision =
          link === `linked:${this.h.owner}`
            ? 'linked'
            : link === `declined:${this.h.owner}`
              ? 'declined'
              : null;
        return { count: keys.length, decision };
      });
    } finally {
      guest.close();
    }
  }

  /**
   * « Ajouter les données de cet appareil à votre compte » : fusion par domaine
   * (`planGuestMerge`), chaque clé fusionnée passe par l'outbox avec la `base` serveur.
   * Exige le pull complet du compte. La base invité est conservée intacte.
   */
  async importGuestData(): Promise<{ written: number }> {
    if (!this.h.remote) throw new Error('Synchronisation cloud inactive');
    if (!(await this.h.isInitialPullDone())) {
      throw new Error('Synchronisation initiale du compte pas encore terminée');
    }
    const guest = await this.openGuestIfExists();
    if (!guest) return { written: 0 };
    try {
      const entries = await guest.tx([S_KV], 'readonly', (tx) => txEntries<unknown>(tx, S_KV));
      const keys = entries.map(([k]) => k);
      const account = await this.h.db.tx([S_KV], 'readonly', async (tx) => {
        const map = new Map<string, unknown>();
        for (const k of keys) {
          const v = await requestToPromise(tx.objectStore(S_KV).get(k));
          if (v !== undefined) map.set(k, v);
        }
        return map;
      });
      const merge = await this.h.getMergeModule();
      if (!merge) throw new Error('Fusion des données invité indisponible');
      const plan = merge.planGuestMerge(entries, account, new Date(this.h.now()).toISOString());
      const writes: StorageWrite[] = [
        ...plan.writes.map((w) => ({ key: w.key, value: w.value })),
        ...plan.extraWrites.map((w) => ({ key: w.key, value: w.value })),
      ].filter((w) => validateStorageKey(w.key));
      if (writes.length > 0) await this.setManyWithOrigin(writes, 'guest');
      await guest.tx([S_META], 'readwrite', (tx) => {
        tx.objectStore(S_META).put(`linked:${this.h.owner}`, META_GUEST_LINK);
      });
      for (const message of plan.notices)
        this.h.emit(STORAGE_KEYS.EVENT_NOTIFY, { kind: 'info', message });
      return { written: writes.length };
    } finally {
      guest.close();
    }
  }

  /** « Ne pas les ajouter » : la base invité reste intacte, récupérable depuis le profil. */
  async declineGuestData(): Promise<void> {
    const guest = await this.openGuestIfExists();
    if (!guest) return;
    try {
      await guest.tx([S_META], 'readwrite', (tx) => {
        tx.objectStore(S_META).put(`declined:${this.h.owner}`, META_GUEST_LINK);
      });
    } finally {
      guest.close();
    }
  }

  private async setManyWithOrigin(
    writes: readonly StorageWrite[],
    origin: OutboxEntry['origin'],
  ): Promise<void> {
    await this.h.setMany(writes);
    const keys = new Set(writes.map((w) => w.key));
    await this.h.db.tx([S_OUTBOX], 'readwrite', async (tx) => {
      const outbox = tx.objectStore(S_OUTBOX);
      for (const key of keys) {
        const e = (await requestToPromise(outbox.get(key))) as OutboxEntry | undefined;
        if (e && e.origin !== origin) outbox.put({ ...e, origin }, key);
      }
    });
  }

  private async openGuestIfExists(): Promise<LocalSyncDb | null> {
    if (this.h.owner === GUEST_OWNER) return null;
    if (!(await databaseExists(this.h.db.factory, dbNameForOwner(GUEST_OWNER)))) return null;
    return LocalSyncDb.open(this.h.db.factory, GUEST_OWNER);
  }
}
