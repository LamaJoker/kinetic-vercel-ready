/**
 * tests/support/fake-sync-server.ts
 *
 * Faux serveur Supabase appliquant EXACTEMENT la sémantique de la migration 010
 * (supabase/migrations/010_sync_reliability.sql), sans Postgres :
 *  - `user_storage` (user_id, key, value, deleted, deleted_at, created_at, updated_at),
 *    version = horloge serveur en MICROSECONDES, strictement croissante par utilisateur
 *    (`max(clock, last_version + 1 µs, ancienne version + 1 µs)`), format de sortie
 *    `2026-11-25T10:00:00.123456+00:00` (zéros finaux retirés, comme Postgres) ;
 *  - RPC `sync_push` (ordre des contrôles, statuts, raisons, idempotence, lot ≤ 100
 *    éléments / 4 Mo, quota en octets de la forme texte jsonb, réponse ≤ 4 Mo),
 *    `sync_pull_v2` (keyset (updated_at, key), ≤ 1000 lignes / 4 Mo, resync
 *    `tombstones_purged` / `cursor_in_future`), `sync_delete_all`, `sync_usage`,
 *    `purge(olderThanMicros)` ;
 *  - chemins des ANCIENS clients : upsert direct (recrée une tombstone), DELETE
 *    transformé en tombstone, `select`, `sync_pull` (sans tombstones) ;
 *  - mode « serveur non migré » (`migrated = false`) : RPC 010 absentes (PGRST202),
 *    DELETE physique, comme avant 010.
 *
 * Le client de test (`server.client(userId)`) imite le sous-ensemble de
 * `SupabaseClient` utilisé par SupabaseSyncRemote et l'ancien SupabaseStorage, avec
 * RLS (`auth.uid()`), session expirable et pannes réseau injectables.
 */

export interface PgErr {
  code: string;
  message: string;
}

interface Row {
  value: unknown;
  deleted: boolean;
  deletedAt: bigint | null;
  createdAt: bigint;
  updatedAt: bigint;
}

interface Usage {
  keys: number;
  bytes: number;
  lastVersion: bigint | null;
}

type Reply<T> = { data: T | null; error: PgErr | null; status: number };

const KEY_RE = /^[a-zA-Z0-9:_-]{1,200}$/;
const MAX_ITEMS = 100;
const MAX_BATCH_BYTES = 4 * 1048576;
const MAX_REPLY_BYTES = 4 * 1048576;
const EPOCH_MICROS = 0n;

/** Erreur Postgres / PostgREST (code SQLSTATE ou PGRST…). */
class PgError extends Error implements PgErr {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function pgError(code: string, message: string, status?: number): PgError {
  return new PgError(code, message, status);
}

// ─── jsonb : forme texte, taille, égalité ────────────────────────────────────

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Ordre des clés d'un objet jsonb : longueur (octets) puis ordre binaire. */
function jsonbKeyOrder(a: string, b: string): number {
  const la = utf8Bytes(a);
  const lb = utf8Bytes(b);
  if (la !== lb) return la - lb;
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** `value::text` de Postgres pour un jsonb (espaces après `:` et `,`). */
export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => jsonbText(v)).join(', ')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(jsonbKeyOrder);
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText(obj[k])}`).join(', ')}}`;
}

export function jsonbSize(value: unknown): number {
  return utf8Bytes(jsonbText(value));
}

function jsonbEqual(a: unknown, b: unknown): boolean {
  return jsonbText(a) === jsonbText(b);
}

function cloneJson<T>(v: T): T {
  return v === undefined ? (null as T) : (JSON.parse(JSON.stringify(v)) as T);
}

// ─── timestamptz en microsecondes ────────────────────────────────────────────

export function formatTs(micros: bigint): string {
  const ms = Number(micros / 1000n);
  const frac = Number(micros % 1_000_000n);
  const iso = new Date(ms).toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  const f = frac === 0 ? '' : '.' + String(frac).padStart(6, '0').replace(/0+$/, '');
  return `${iso}${f}+00:00`;
}

/** Parse un timestamptz texte (ISO, fraction ≤ 6 chiffres, fuseau Z ou ±HH:MM). */
export function parseTs(s: string): bigint {
  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      s.trim(),
    );
  if (!m) throw new Error(`invalid input syntax for type timestamp with time zone: "${s}"`);
  const base = Date.parse(`${m[1]}T${m[2]}Z`);
  if (!Number.isFinite(base)) throw new Error(`invalid timestamp "${s}"`);
  let micros = BigInt(base) * 1000n + BigInt((m[3] ?? '').padEnd(6, '0') || '0');
  const tz = m[4];
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1n : 1n;
    const hh = BigInt(tz.slice(1, 3));
    const mm = BigInt(tz.slice(3).replace(':', '') || '0');
    micros -= sign * (hh * 3600n + mm * 60n) * 1_000_000n;
  }
  return micros;
}

// ─── Serveur ─────────────────────────────────────────────────────────────────

export interface FakeSyncServerOptions {
  /** Migration 010 appliquée (défaut : oui). */
  migrated?: boolean;
  /** Horloge initiale (ms). */
  startMs?: number;
  maxKeys?: number;
  maxBytes?: number;
  maxValueBytes?: number;
}

export class FakeSyncServer {
  migrated: boolean;
  maxKeys: number;
  maxBytes: number;
  maxValueBytes: number;
  /** Réseau coupé : tout appel échoue comme un `fetch` impossible (status 0). */
  networkDown = false;
  /** Horizon de purge des tombstones (`sync_meta.tombstone_horizon`). */
  horizon: bigint | null = null;
  /** Journal des appels (nom, utilisateur). */
  readonly calls: Array<{ name: string; user: string | null; payload?: unknown }> = [];

  private readonly users = new Map<string, Map<string, Row>>();
  private readonly usage = new Map<string, Usage>();
  private clock: bigint;
  private readonly faults: Array<{
    name: string;
    kind: 'drop-response' | 'error';
    error?: PgErr;
    status?: number;
  }> = [];
  /** Sessions valides par utilisateur (jeton non expiré). */
  private readonly expired = new Set<string>();
  /** Refus du rafraîchissement de session (reconnexion nécessaire). */
  refreshFails = false;

  constructor(opts: FakeSyncServerOptions = {}) {
    this.migrated = opts.migrated ?? true;
    this.clock = BigInt(opts.startMs ?? Date.parse('2026-11-25T10:00:00.000Z')) * 1000n;
    this.maxKeys = opts.maxKeys ?? 20000;
    this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    this.maxValueBytes = opts.maxValueBytes ?? 1048576;
  }

  // ── Horloge, pannes, inspection ──

  /** Avance l'horloge serveur (ms). */
  advance(ms: number): void {
    this.clock += BigInt(Math.round(ms * 1000));
  }

  nowText(): string {
    return formatTs(this.clock);
  }

  /** Prochain appel `name` : exécuté puis réponse perdue (erreur réseau côté client). */
  dropResponseOnce(name: string): void {
    this.faults.push({ name, kind: 'drop-response' });
  }

  /** Prochain appel `name` : échoue avec cette erreur, sans rien exécuter. */
  failOnce(name: string, error: PgErr, status = 400): void {
    this.faults.push({ name, kind: 'error', error, status });
  }

  expireSession(userId: string): void {
    this.expired.add(userId);
  }

  /** Lignes vivantes d'un utilisateur (clé → valeur). */
  live(userId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, r] of this.table(userId)) if (!r.deleted) out[k] = cloneJson(r.value);
    return out;
  }

  row(
    userId: string,
    key: string,
  ): { value: unknown; deleted: boolean; updated_at: string } | null {
    const r = this.table(userId).get(key);
    return r
      ? { value: cloneJson(r.value), deleted: r.deleted, updated_at: formatTs(r.updatedAt) }
      : null;
  }

  usageOf(userId: string): { keys: number; bytes: number } {
    const u = this.usage.get(userId);
    return { keys: u?.keys ?? 0, bytes: u?.bytes ?? 0 };
  }

  /** Purge des tombstones plus anciennes que `olderThanMs` (horizon enregistré d'abord). */
  purge(olderThanMs: number): number {
    const h = this.clock - BigInt(Math.round(olderThanMs * 1000));
    this.horizon = this.horizon === null || h > this.horizon ? h : this.horizon;
    let n = 0;
    for (const t of this.users.values()) {
      for (const [k, r] of t) {
        if (r.deleted && r.updatedAt < this.horizon) {
          t.delete(k);
          n++;
        }
      }
    }
    return n;
  }

  /** Écriture « serveur » directe (autre appareil, données existantes). */
  seed(userId: string, key: string, value: unknown): string {
    const r = this.write(userId, key, cloneJson(value), false, 'upsert');
    return formatTs(r.updatedAt);
  }

  client(userId: string | null): FakeSupabaseClient {
    return new FakeSupabaseClient(this, userId);
  }

  // ── Interne ──

  private table(userId: string): Map<string, Row> {
    let t = this.users.get(userId);
    if (!t) this.users.set(userId, (t = new Map()));
    return t;
  }

  private usageRow(userId: string): Usage {
    let u = this.usage.get(userId);
    if (!u) this.usage.set(userId, (u = { keys: 0, bytes: 0, lastVersion: null }));
    return u;
  }

  /** @internal Prise d'une panne programmée pour `name`. */
  takeFault(name: string): (typeof this.faults)[number] | null {
    const i = this.faults.findIndex((f) => f.name === name);
    if (i < 0) return null;
    return this.faults.splice(i, 1)[0]!;
  }

  /** @internal Session valide ? */
  sessionValid(userId: string | null): boolean {
    return userId !== null && !this.expired.has(userId);
  }

  /** @internal Rafraîchissement de session. */
  refresh(userId: string | null): boolean {
    if (userId === null || this.refreshFails) return false;
    this.expired.delete(userId);
    return true;
  }

  private nextVersion(userId: string, old: Row | undefined): bigint {
    this.clock += 1000n; // le temps passe d'1 ms entre deux écritures
    const u = this.usageRow(userId);
    let v = this.clock;
    if (u.lastVersion !== null && v <= u.lastVersion) v = u.lastVersion + 1n;
    if (old && v <= old.updatedAt) v = old.updatedAt + 1n;
    u.lastVersion = v;
    return v;
  }

  /**
   * Écriture d'une ligne avec les triggers de 010 (version, tombstone, quota).
   * `via` : 'push' (sync_push, colonne deleted explicite) ou 'upsert' (ancien client).
   * Lève PgErr (P0001 / P0002) si le quota est dépassé (rien n'est écrit).
   */
  write(
    userId: string,
    key: string,
    value: unknown,
    deleted: boolean,
    via: 'push' | 'upsert',
  ): Row {
    const t = this.table(userId);
    const old = t.get(key);
    let newDeleted = deleted;
    if (via === 'upsert' && old && old.deleted) {
      // Ancien client réécrivant une tombstone avec une nouvelle valeur : recréation.
      newDeleted = !jsonbEqual(old.value, value) ? false : old.deleted;
    }
    if (!this.migrated) {
      newDeleted = false;
    }
    const v = this.migrated ? this.nextVersion(userId, old) : (this.clock += 1000n);
    const row: Row = {
      value: newDeleted ? null : value,
      deleted: newDeleted,
      deletedAt: newDeleted ? v : null,
      createdAt: old?.createdAt ?? v,
      updatedAt: v,
    };
    // Quota (AFTER) : seules les hausses sont contrôlées.
    const u = this.usageRow(userId);
    let dKeys = 0;
    let dBytes = 0;
    if (old && !old.deleted) {
      dKeys -= 1;
      dBytes -= jsonbSize(old.value);
    }
    if (!row.deleted) {
      dKeys += 1;
      dBytes += jsonbSize(row.value);
    }
    if (this.migrated) {
      if (dKeys > 0 && u.keys + dKeys > this.maxKeys) {
        throw pgError('P0001', `Quota dépassé : max ${this.maxKeys} clés`);
      }
      if (dBytes > 0 && u.bytes + dBytes > this.maxBytes) {
        throw pgError('P0002', 'Quota dépassé : max 50MB');
      }
    }
    u.keys = Math.max(0, u.keys + dKeys);
    u.bytes = Math.max(0, u.bytes + dBytes);
    t.set(key, row);
    return row;
  }

  /** @internal DELETE d'un client authentifié. */
  clientDelete(userId: string, key: string | null): void {
    const t = this.table(userId);
    const keys = key === null ? [...t.keys()] : [key];
    for (const k of keys) {
      const r = t.get(k);
      if (!r) continue;
      if (!this.migrated) {
        t.delete(k);
        const u = this.usageRow(userId);
        u.keys = Math.max(0, u.keys - 1);
        u.bytes = Math.max(0, u.bytes - jsonbSize(r.value));
        continue;
      }
      if (!r.deleted) this.write(userId, k, null, true, 'push');
    }
  }

  // ── RPC 010 ──

  /** @internal */
  syncPush(uid: string, items: unknown): unknown[] {
    if (!Array.isArray(items))
      throw pgError('22023', 'sync_push: p_items doit être un tableau JSON');
    const results: unknown[] = [];
    const seen = new Set<string>();
    let batchBytes = 0;
    let replyBytes = 0;
    items.forEach((raw, idx) => {
      const item = raw as Record<string, unknown>;
      const key =
        raw !== null &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        typeof item['key'] === 'string'
          ? (item['key'] as string)
          : null;
      const res: Record<string, unknown> = { key };
      const push = (extra: Record<string, unknown>): void => {
        results.push({ ...res, ...extra });
      };
      if (idx + 1 > MAX_ITEMS) {
        push({ status: 'deferred', reason: 'batch_limit', updated_at: null });
        return;
      }
      const t = (v: unknown): string =>
        v === null
          ? 'null'
          : Array.isArray(v)
            ? 'array'
            : typeof v === 'object'
              ? 'object'
              : typeof v;
      if (
        key === null ||
        ('deleted' in item && !['boolean', 'null'].includes(t(item['deleted']))) ||
        ('base' in item && !['string', 'null'].includes(t(item['base'])))
      ) {
        push({ status: 'rejected', reason: 'invalid_item', updated_at: null });
        return;
      }
      if (!KEY_RE.test(key)) {
        push({ status: 'rejected', reason: 'invalid_key', updated_at: null });
        return;
      }
      if (seen.has(key)) {
        push({ status: 'rejected', reason: 'duplicate_key', updated_at: null });
        return;
      }
      seen.add(key);
      const deleted = item['deleted'] === true;
      if (!deleted && !('value' in item)) {
        push({ status: 'rejected', reason: 'missing_value', updated_at: null });
        return;
      }
      const value = deleted ? null : cloneJson(item['value'] ?? null);
      let base: bigint | null = null;
      try {
        base = typeof item['base'] === 'string' ? parseTs(item['base']) : null;
      } catch {
        push({ status: 'rejected', reason: 'invalid_base', updated_at: null });
        return;
      }
      let size = jsonbSize(value);
      if (size > this.maxValueBytes) {
        push({ status: 'rejected', reason: 'value_too_large', updated_at: null });
        return;
      }
      if (batchBytes > 0 && batchBytes + size > MAX_BATCH_BYTES) {
        push({ status: 'deferred', reason: 'batch_limit', updated_at: null });
        return;
      }
      batchBytes += size;

      const cur = this.table(uid).get(key);
      try {
        if (cur && (base === null || cur.updatedAt > base)) {
          if (cur.deleted === deleted && (deleted || jsonbEqual(cur.value, value))) {
            push({ status: 'ok', updated_at: formatTs(cur.updatedAt), deleted: cur.deleted });
          } else {
            const out: Record<string, unknown> = {
              status: 'conflict',
              updated_at: formatTs(cur.updatedAt),
              server_deleted: cur.deleted,
            };
            if (!cur.deleted) {
              size = jsonbSize(cur.value);
              if (replyBytes + size <= MAX_REPLY_BYTES) {
                out['server_value'] = cloneJson(cur.value);
                replyBytes += size;
              } else {
                out['server_value_omitted'] = true;
              }
            }
            push(out);
          }
        } else {
          const row = this.write(uid, key, value, deleted, 'push');
          push({ status: 'ok', updated_at: formatTs(row.updatedAt), deleted });
        }
      } catch (e) {
        const err = e as PgErr;
        const reason =
          err.code === 'P0001'
            ? 'quota_keys'
            : err.code === 'P0002'
              ? 'quota_bytes'
              : `internal:${err.code}`;
        push({ status: 'rejected', reason, updated_at: null });
      }
    });
    return results;
  }

  /** @internal */
  syncPullV2(
    uid: string,
    since: string | null,
    afterKey: string | null,
    limit: number | null,
  ): unknown {
    const now = this.clock;
    let sinceMicros: bigint | null = null;
    if (since !== null) sinceMicros = parseTs(since);
    const full = sinceMicros === null || sinceMicros <= EPOCH_MICROS;
    const horizon = this.horizon === null ? null : formatTs(this.horizon);
    if (!full && this.horizon !== null && sinceMicros! < this.horizon) {
      return {
        changes: [],
        has_more: false,
        resync_required: true,
        reason: 'tombstones_purged',
        horizon,
        server_time: formatTs(now),
      };
    }
    if (!full && sinceMicros! > now + 60_000_000n) {
      return {
        changes: [],
        has_more: false,
        resync_required: true,
        reason: 'cursor_in_future',
        horizon,
        server_time: formatTs(now),
      };
    }
    const lim = Math.min(Math.max(limit ?? 500, 1), 1000);
    const after = afterKey ?? '';
    const rows = [...this.table(uid).entries()]
      .filter(([k, r]) =>
        full && sinceMicros === null
          ? true
          : r.updatedAt > (sinceMicros ?? -1n) || (r.updatedAt === sinceMicros && k > after),
      )
      .sort((a, b) =>
        a[1].updatedAt < b[1].updatedAt
          ? -1
          : a[1].updatedAt > b[1].updatedAt
            ? 1
            : a[0] < b[0]
              ? -1
              : a[0] > b[0]
                ? 1
                : 0,
      );
    const changes: unknown[] = [];
    let bytes = 0;
    let hasMore = false;
    for (const [k, r] of rows) {
      if (changes.length >= lim) {
        hasMore = true;
        break;
      }
      const size = jsonbSize(r.value);
      if (changes.length > 0 && bytes + size > MAX_REPLY_BYTES) {
        hasMore = true;
        break;
      }
      changes.push({
        key: k,
        value: cloneJson(r.value),
        deleted: r.deleted,
        updated_at: formatTs(r.updatedAt),
      });
      bytes += size;
    }
    return {
      changes,
      has_more: hasMore,
      resync_required: false,
      horizon,
      server_time: formatTs(now),
    };
  }

  /** @internal */
  syncDeleteAll(uid: string): unknown {
    let n = 0;
    for (const [k, r] of this.table(uid)) {
      if (!r.deleted) {
        this.write(uid, k, null, true, 'push');
        n++;
      }
    }
    let last: bigint | null = null;
    for (const r of this.table(uid).values())
      if (last === null || r.updatedAt > last) last = r.updatedAt;
    return { deleted_count: n, updated_at: last === null ? null : formatTs(last) };
  }

  /** @internal `sync_pull` (009) : sans tombstones. */
  syncPullLegacy(uid: string, since: string, afterKey: string, limit: number): unknown[] {
    const s = parseTs(since);
    const lim = Math.min(Math.max(limit, 1), 1000);
    return [...this.table(uid).entries()]
      .filter(([k, r]) => !r.deleted && (r.updatedAt > s || (r.updatedAt === s && k > afterKey)))
      .sort((a, b) =>
        a[1].updatedAt < b[1].updatedAt
          ? -1
          : a[1].updatedAt > b[1].updatedAt
            ? 1
            : a[0] < b[0]
              ? -1
              : 1,
      )
      .slice(0, lim)
      .map(([k, r]) => ({ key: k, value: cloneJson(r.value), updated_at: formatTs(r.updatedAt) }));
  }

  /** @internal Lignes visibles par RLS. */
  rowsOf(uid: string): Array<[string, Row]> {
    return [...this.table(uid).entries()];
  }
}

// ─── Client Supabase de test ─────────────────────────────────────────────────

const NETWORK_ERROR: PgErr = { code: '', message: 'TypeError: fetch failed' };

type Filter = { col: string; op: 'eq' | 'gte'; val: unknown };

class FakeQuery implements PromiseLike<Reply<unknown>> {
  private action: 'select' | 'upsert' | 'delete' = 'select';
  private cols = '*';
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private single: 'maybe' | 'one' | null = null;
  private returning = false;
  private payload: Record<string, unknown> | null = null;

  constructor(
    private readonly client: FakeSupabaseClient,
    private readonly table: string,
  ) {}

  select(cols = '*'): this {
    if (this.action === 'select') this.cols = cols;
    else this.returning = true;
    this.cols = cols;
    return this;
  }
  upsert(row: Record<string, unknown>, _opts?: unknown): this {
    this.action = 'upsert';
    this.payload = row;
    return this;
  }
  delete(): this {
    this.action = 'delete';
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }
  gte(col: string, val: unknown): this {
    this.filters.push({ col, op: 'gte', val });
    return this;
  }
  order(col: string, _opts?: unknown): this {
    this.orderCol = col;
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  maybeSingle(): this {
    this.single = 'maybe';
    return this;
  }
  singleRow(): this {
    this.single = 'one';
    return this;
  }

  then<A = Reply<unknown>, B = never>(
    onfulfilled?: ((value: Reply<unknown>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.client.exec(`table:${this.action}`, () => this.run()))
      .then(onfulfilled, onrejected);
  }

  private run(): unknown {
    if (this.table !== 'user_storage') throw pgError('42P01', 'relation inconnue');
    const server = this.client.server;
    const uid = this.client.requireUid();
    const userFilter = this.filters.find((f) => f.col === 'user_id');
    // RLS : un autre user_id ne voit / ne modifie rien.
    if (userFilter && userFilter.val !== uid) {
      if (this.action === 'upsert')
        throw pgError('42501', 'new row violates row-level security policy');
      return this.single ? null : [];
    }
    const keyFilter = this.filters.find((f) => f.col === 'key' && f.op === 'eq');
    if (this.action === 'upsert') {
      const p = this.payload!;
      if (p['user_id'] !== uid)
        throw pgError('42501', 'new row violates row-level security policy');
      const key = String(p['key']);
      if (!KEY_RE.test(key)) throw pgError('23514', 'violates check constraint "key_format"');
      const value = cloneJson(p['value'] ?? null);
      if (jsonbSize(value) > server.maxValueBytes) throw pgError('23514', 'value_size');
      const row = server.write(uid, key, value, false, 'upsert');
      const out = { updated_at: formatTs(row.updatedAt) };
      return this.returning ? (this.single ? out : [out]) : null;
    }
    if (this.action === 'delete') {
      server.clientDelete(uid, keyFilter ? String(keyFilter.val) : null);
      return null;
    }
    // select
    let rows = server.rowsOf(uid);
    if (keyFilter) rows = rows.filter(([k]) => k === keyFilter.val);
    const gte = this.filters.find((f) => f.op === 'gte' && f.col === 'updated_at');
    if (gte) rows = rows.filter(([, r]) => r.updatedAt >= parseTs(String(gte.val)));
    if (this.orderCol === 'key') rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (this.rangeFrom !== null)
      rows = rows.slice(this.rangeFrom, (this.rangeTo ?? rows.length) + 1);
    const cols = this.cols.split(',').map((c) => c.trim());
    if (!server.migrated && cols.includes('deleted')) {
      throw pgError('42703', 'column user_storage.deleted does not exist');
    }
    const shaped = rows.map(([k, r]) => {
      const o: Record<string, unknown> = {};
      for (const c of cols) {
        if (c === 'key') o['key'] = k;
        else if (c === 'value') o['value'] = cloneJson(r.value);
        else if (c === 'deleted') o['deleted'] = r.deleted;
        else if (c === 'updated_at') o['updated_at'] = formatTs(r.updatedAt);
      }
      return o;
    });
    if (this.single) {
      if (shaped.length > 1) throw pgError('PGRST116', 'plusieurs lignes');
      return shaped[0] ?? null;
    }
    return shaped;
  }
}

export class FakeSupabaseClient {
  constructor(
    readonly server: FakeSyncServer,
    public uid: string | null,
  ) {}

  readonly auth = {
    refreshSession: async (): Promise<{
      data: { session: { user: { id: string } } | null };
      error: PgErr | null;
    }> => {
      if (this.server.networkDown) return { data: { session: null }, error: NETWORK_ERROR };
      const ok = this.server.refresh(this.uid);
      return ok && this.uid
        ? { data: { session: { user: { id: this.uid } } }, error: null }
        : {
            data: { session: null },
            error: { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' },
          };
    },
  };

  /** @internal */
  requireUid(): string {
    if (!this.server.sessionValid(this.uid)) throw pgError('42501', 'non authentifié');
    return this.uid!;
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  async rpc(name: string, params: Record<string, unknown> = {}): Promise<Reply<unknown>> {
    return this.exec(name, () => {
      const s = this.server;
      const v010 = ['sync_push', 'sync_pull_v2', 'sync_delete_all', 'sync_usage'];
      if (v010.includes(name) && !s.migrated) {
        throw pgError('PGRST202', `Could not find the function public.${name}`);
      }
      if (!s.sessionValid(this.uid)) {
        // Jeton expiré : PostgREST refuse la requête (JWT expired).
        throw pgError('PGRST301', 'JWT expired', 401);
      }
      const uid = this.uid!;
      switch (name) {
        case 'sync_push':
          return s.syncPush(uid, params['p_items']);
        case 'sync_pull_v2':
          return s.syncPullV2(
            uid,
            (params['p_since'] as string | null | undefined) ?? null,
            (params['p_after_key'] as string | undefined) ?? '',
            (params['p_limit'] as number | undefined) ?? 500,
          );
        case 'sync_delete_all':
          return s.syncDeleteAll(uid);
        case 'sync_usage':
          return {
            ...s.usageOf(uid),
            max_keys: s.maxKeys,
            max_bytes: s.maxBytes,
            max_value_bytes: s.maxValueBytes,
          };
        case 'sync_pull':
          return s.syncPullLegacy(
            uid,
            String(params['p_since']),
            String(params['p_after_key'] ?? ''),
            Number(params['p_limit'] ?? 1000),
          );
        default:
          throw pgError('PGRST202', `Could not find the function public.${name}`);
      }
    });
  }

  /** @internal Exécution avec pannes injectées et mise en forme `{ data, error, status }`. */
  exec(name: string, run: () => unknown): Reply<unknown> {
    const s = this.server;
    s.calls.push({ name, user: this.uid });
    if (s.networkDown) return { data: null, error: NETWORK_ERROR, status: 0 };
    const fault = s.takeFault(name);
    if (fault?.kind === 'error')
      return { data: null, error: fault.error!, status: fault.status ?? 400 };
    try {
      const data = run();
      if (fault?.kind === 'drop-response') return { data: null, error: NETWORK_ERROR, status: 0 };
      return { data: (data ?? null) as unknown, error: null, status: 200 };
    } catch (e) {
      const err = e as PgErr & { status?: number };
      if (typeof err?.code !== 'string') throw e;
      const status =
        err.status ?? (err.code === '42501' ? 401 : err.code === 'PGRST202' ? 404 : 400);
      return { data: null, error: { code: err.code, message: err.message }, status };
    }
  }
}
