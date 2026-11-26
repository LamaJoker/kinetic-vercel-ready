/**
 * tests/support/fake-indexeddb.ts
 *
 * IndexedDB en mémoire, fidèle sur les points dont dépend la synchro :
 *  - requêtes asynchrones (macrotâche), `onsuccess` / `onerror` ;
 *  - transactions : écritures visibles dans la transaction, validées (`oncomplete`)
 *    quand plus aucune requête n'est en cours et que la main revient à la boucle
 *    d'événements ; annulées (rollback complet) sur `abort()` ou sur une requête en
 *    erreur ; une requête placée sur une transaction inactive (après un `await`
 *    d'autre chose qu'une requête IDB) lève `TransactionInactiveError` ;
 *  - transactions `readwrite` sérialisées sur des stores qui se recouvrent ;
 *  - valeurs copiées par structured clone (un Proxy lève `DataCloneError`) ;
 *  - ouverture versionnée (`onupgradeneeded`, transaction `versionchange` annulable),
 *    `deleteDatabase` (avec `onversionchange` sur les connexions ouvertes), `databases()`.
 *
 * Injection de pannes : `failNext(predicate, name)` fait échouer la prochaine requête
 * correspondante (ex. QuotaExceededError sur un `put`), `breakConnections()` simule
 * WebKit « Connection to Indexed Database server lost ».
 *
 * Ce n'est PAS un mock du code testé : c'est un moteur de stockage substituable au
 * vrai `indexedDB` (aucune dépendance npm ajoutée au dépôt).
 */

type Key = string | number;
type Mode = 'readonly' | 'readwrite' | 'versionchange';

function domError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function validKey(key: unknown): key is Key {
  return (typeof key === 'string' || (typeof key === 'number' && !Number.isNaN(key))) as boolean;
}

function compareKeys(a: Key, b: Key): number {
  if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (err) {
    throw domError('DataCloneError', err instanceof Error ? err.message : String(err));
  }
}

/** Macrotâche (les microtâches en attente passent avant, comme entre deux événements IDB). */
const macrotask = (fn: () => void): void => {
  setImmediate(fn);
};

interface DbData {
  version: number;
  stores: Map<string, Map<Key, unknown>>;
}

interface FailRule {
  predicate: (op: FakeOp) => boolean;
  name: string;
  remaining: number;
}

export interface FakeOp {
  db: string;
  store: string;
  kind: 'get' | 'put' | 'delete' | 'clear' | 'getAll' | 'getAllKeys' | 'count' | 'open';
  key?: Key | undefined;
}

class FakeDOMStringList {
  constructor(private readonly names: () => string[]) {}
  contains(name: string): boolean {
    return this.names().includes(name);
  }
  get length(): number {
    return this.names().length;
  }
  item(i: number): string | null {
    return this.names()[i] ?? null;
  }
  [Symbol.iterator](): Iterator<string> {
    return this.names()[Symbol.iterator]();
  }
}

export class FakeRequest<T = unknown> {
  result: T | undefined = undefined;
  error: Error | null = null;
  readyState: 'pending' | 'done' = 'pending';
  onsuccess: ((ev: { target: FakeRequest<T> }) => void) | null = null;
  onerror: ((ev: { target: FakeRequest<T>; preventDefault(): void }) => void) | null = null;
  transaction: FakeTransaction | null = null;
  source: unknown = null;
}

export class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded:
    | ((ev: { target: FakeOpenRequest; oldVersion: number; newVersion: number }) => void)
    | null = null;
  onblocked: (() => void) | null = null;
}

export class FakeObjectStore {
  constructor(
    readonly name: string,
    readonly transaction: FakeTransaction,
  ) {}

  private data(): Map<Key, unknown> {
    const store = this.transaction.db._data.stores.get(this.name);
    if (!store) throw domError('InvalidStateError', `store ${this.name} supprimé`);
    return store;
  }

  get(key: Key): FakeRequest {
    return this.transaction._request(this, { kind: 'get', key }, () => {
      const v = this.data().get(key);
      return v === undefined ? undefined : clone(v);
    });
  }

  getAll(): FakeRequest<unknown[]> {
    return this.transaction._request(this, { kind: 'getAll' }, () =>
      [...this.data().entries()].sort((a, b) => compareKeys(a[0], b[0])).map(([, v]) => clone(v)),
    );
  }

  getAllKeys(): FakeRequest<Key[]> {
    return this.transaction._request(this, { kind: 'getAllKeys' }, () =>
      [...this.data().keys()].sort(compareKeys),
    );
  }

  count(): FakeRequest<number> {
    return this.transaction._request(this, { kind: 'count' }, () => this.data().size);
  }

  put(value: unknown, key: Key): FakeRequest<Key> {
    this.transaction._assertWritable();
    if (!validKey(key)) throw domError('DataError', 'clé invalide');
    const copy = clone(value); // DataCloneError levée de façon synchrone, comme IDB
    return this.transaction._request(this, { kind: 'put', key }, () => {
      const data = this.data();
      this.transaction._recordUndo(this.name, key, data.has(key), data.get(key));
      data.set(key, copy);
      return key;
    });
  }

  delete(key: Key): FakeRequest<undefined> {
    this.transaction._assertWritable();
    if (!validKey(key)) throw domError('DataError', 'clé invalide');
    return this.transaction._request(this, { kind: 'delete', key }, () => {
      const data = this.data();
      if (data.has(key)) {
        this.transaction._recordUndo(this.name, key, true, data.get(key));
        data.delete(key);
      }
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    this.transaction._assertWritable();
    return this.transaction._request(this, { kind: 'clear' }, () => {
      const data = this.data();
      for (const [k, v] of data) this.transaction._recordUndo(this.name, k, true, v);
      data.clear();
      return undefined;
    });
  }
}

export class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  readonly objectStoreNames: FakeDOMStringList;

  /** @internal */ _state: 'waiting' | 'active' | 'inactive' | 'finished' = 'waiting';
  private pending = 0;
  private queue: Array<() => void> = [];
  private undo: Array<{ store: string; key: Key; had: boolean; value: unknown }> = [];
  private checkScheduled = false;
  /** Fin de la tâche de création : une transaction pas encore démarrée devient inactive. */
  private creationTaskEnded = false;

  constructor(
    readonly db: FakeDatabase,
    readonly storeNames: string[],
    readonly mode: Mode,
  ) {
    this.objectStoreNames = new FakeDOMStringList(() => [...storeNames]);
    macrotask(() => {
      this.creationTaskEnded = true;
    });
  }

  objectStore(name: string): FakeObjectStore {
    if (this._state === 'finished') throw domError('InvalidStateError', 'transaction terminée');
    if (!this.storeNames.includes(name)) throw domError('NotFoundError', `store ${name}`);
    return new FakeObjectStore(name, this);
  }

  abort(): void {
    if (this._state === 'finished') throw domError('InvalidStateError', 'transaction terminée');
    this._abort(domError('AbortError', 'transaction annulée'));
  }

  commit(): void {
    /* validation explicite : la validation automatique suffit ici */
  }

  /** @internal */ _assertWritable(): void {
    if (this.mode === 'readonly') throw domError('ReadOnlyError', 'transaction en lecture seule');
  }

  /** @internal */ _recordUndo(store: string, key: Key, had: boolean, value: unknown): void {
    this.undo.push({ store, key, had, value });
  }

  /** @internal */ _start(): void {
    this._state = 'active';
    this.scheduleDeactivate();
    const queued = this.queue;
    this.queue = [];
    for (const run of queued) run();
  }

  /** @internal */ _request<T>(
    store: FakeObjectStore,
    op: Omit<FakeOp, 'db' | 'store'>,
    exec: () => T,
  ): FakeRequest<T> {
    if (
      this._state === 'finished' ||
      this._state === 'inactive' ||
      (this._state === 'waiting' && this.creationTaskEnded)
    ) {
      throw domError('TransactionInactiveError', 'transaction inactive');
    }
    const req = new FakeRequest<T>();
    req.transaction = this;
    req.source = store;
    this.pending++;
    const fullOp: FakeOp = { db: this.db.name, store: store.name, ...op };
    const run = (): void => {
      macrotask(() => {
        if (this._state === 'finished') return;
        this._state = 'active';
        let failure: Error | null = this.db._factory._takeFailure(fullOp);
        let result: T | undefined;
        if (!failure && this.db._broken) failure = domError('UnknownError', 'Connection lost');
        if (!failure) {
          try {
            result = exec();
          } catch (err) {
            failure = err instanceof Error ? err : domError('UnknownError', String(err));
          }
        }
        req.readyState = 'done';
        this.pending--;
        if (failure) {
          req.error = failure;
          let prevented = false;
          req.onerror?.({
            target: req,
            preventDefault: () => {
              prevented = true;
            },
          });
          if (!prevented) {
            this._abort(failure);
            return;
          }
        } else {
          req.result = result;
          req.onsuccess?.({ target: req });
        }
        this.scheduleDeactivate();
      });
    };
    if (this._state === 'waiting') this.queue.push(run);
    else run();
    return req;
  }

  private scheduleDeactivate(): void {
    if (this.checkScheduled) return;
    this.checkScheduled = true;
    // Les microtâches (résolutions de promesses) passent avant : comme dans les
    // navigateurs, une requête placée après `await requete` garde la transaction active.
    macrotask(() => {
      this.checkScheduled = false;
      if (this._state === 'finished') return;
      if (this.pending === 0) {
        this.finish();
      } else {
        this._state = 'inactive';
      }
    });
  }

  private finish(): void {
    this._state = 'finished';
    this.undo = [];
    this.db._factory._transactionDone(this);
    this.oncomplete?.();
  }

  /** @internal */ _abort(error: Error): void {
    if (this._state === 'finished') return;
    // Rollback dans l'ordre inverse.
    for (let i = this.undo.length - 1; i >= 0; i--) {
      const u = this.undo[i]!;
      const store = this.db._data.stores.get(u.store);
      if (!store) continue;
      if (u.had) store.set(u.key, u.value);
      else store.delete(u.key);
    }
    this.undo = [];
    this._state = 'finished';
    this.error = error;
    this.db._factory._transactionDone(this);
    macrotask(() => {
      this.onerror?.();
      this.onabort?.();
    });
  }
}

export class FakeDatabase {
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  /** @internal */ _closed = false;
  /** @internal */ _broken = false;
  /** @internal */ _upgradeTx: FakeTransaction | null = null;
  readonly objectStoreNames: FakeDOMStringList;

  constructor(
    readonly name: string,
    /** @internal */ readonly _data: DbData,
    /** @internal */ readonly _factory: FakeIndexedDB,
  ) {
    this.objectStoreNames = new FakeDOMStringList(() => [..._data.stores.keys()].sort());
  }

  get version(): number {
    return this._data.version;
  }

  createObjectStore(name: string): FakeObjectStore {
    if (!this._upgradeTx) throw domError('InvalidStateError', 'hors versionchange');
    if (this._data.stores.has(name)) throw domError('ConstraintError', `store ${name} existe`);
    this._data.stores.set(name, new Map());
    this._upgradeTx.storeNames.push(name);
    return new FakeObjectStore(name, this._upgradeTx);
  }

  deleteObjectStore(name: string): void {
    if (!this._upgradeTx) throw domError('InvalidStateError', 'hors versionchange');
    this._data.stores.delete(name);
  }

  transaction(
    names: string | string[],
    mode: 'readonly' | 'readwrite' = 'readonly',
  ): FakeTransaction {
    if (this._closed) throw domError('InvalidStateError', 'connexion fermée');
    const list = (Array.isArray(names) ? names : [names]).slice();
    if (list.length === 0) throw domError('InvalidAccessError', 'aucun store');
    for (const n of list) {
      if (!this._data.stores.has(n)) throw domError('NotFoundError', `store ${n}`);
    }
    const tx = new FakeTransaction(this, list, mode);
    this._factory._schedule(tx);
    return tx;
  }

  close(): void {
    this._closed = true;
    this._factory._connectionClosed(this);
  }
}

export class FakeIndexedDB {
  private readonly dbs = new Map<string, DbData>();
  private readonly connections = new Set<FakeDatabase>();
  private readonly running: FakeTransaction[] = [];
  private readonly waiting: FakeTransaction[] = [];
  private failures: FailRule[] = [];
  /** Journal des opérations (diagnostic des tests). */
  readonly log: FakeOp[] = [];

  /** Fait échouer les `times` prochaines requêtes qui satisfont `predicate`. */
  failNext(predicate: (op: FakeOp) => boolean, name = 'UnknownError', times = 1): void {
    this.failures.push({ predicate, name, remaining: times });
  }

  /** Simule la perte de connexion WebKit : toute requête des connexions ouvertes échoue. */
  breakConnections(): void {
    for (const c of this.connections) {
      c._broken = true;
      c.onclose?.();
    }
  }

  /** Lecture directe (assertions de test), hors transaction. */
  dump(dbName: string, store: string): Map<Key, unknown> {
    const s = this.dbs.get(dbName)?.stores.get(store);
    return new Map([...(s ?? new Map<Key, unknown>()).entries()].map(([k, v]) => [k, clone(v)]));
  }

  hasDatabase(name: string): boolean {
    return this.dbs.has(name);
  }

  async databases(): Promise<Array<{ name: string; version: number }>> {
    return [...this.dbs.entries()].map(([name, d]) => ({ name, version: d.version }));
  }

  open(name: string, version?: number): FakeOpenRequest {
    const req = new FakeOpenRequest();
    macrotask(() => this.doOpen(req, name, version));
    return req;
  }

  deleteDatabase(name: string): FakeRequest<undefined> {
    const req = new FakeRequest<undefined>();
    macrotask(() => {
      const open = [...this.connections].filter((c) => c.name === name);
      for (const c of open) c.onversionchange?.();
      const finish = (): void => {
        this.dbs.delete(name);
        req.readyState = 'done';
        req.onsuccess?.({ target: req });
      };
      const waitClosed = (): void => {
        if ([...this.connections].some((c) => c.name === name)) macrotask(waitClosed);
        else finish();
      };
      waitClosed();
    });
    return req;
  }

  cmp(a: Key, b: Key): number {
    return compareKeys(a, b);
  }

  private doOpen(req: FakeOpenRequest, name: string, version?: number): void {
    const fail = this._takeFailure({ db: name, store: '', kind: 'open' });
    if (fail) {
      req.error = fail;
      req.readyState = 'done';
      req.onerror?.({ target: req, preventDefault: () => undefined });
      return;
    }
    const existing = this.dbs.get(name);
    const oldVersion = existing?.version ?? 0;
    const target = version ?? (oldVersion || 1);
    if (target < oldVersion) {
      req.error = domError('VersionError', `version ${target} < ${oldVersion}`);
      req.readyState = 'done';
      req.onerror?.({ target: req, preventDefault: () => undefined });
      return;
    }
    if (target === oldVersion && existing) {
      const db = new FakeDatabase(name, existing, this);
      this.connections.add(db);
      req.result = db;
      req.readyState = 'done';
      req.onsuccess?.({ target: req });
      return;
    }
    // Montée de version : copie de travail, publiée seulement si l'upgrade réussit.
    const working: DbData = {
      version: target,
      stores: new Map(
        [...(existing?.stores ?? new Map<string, Map<Key, unknown>>()).entries()].map(([k, v]) => [
          k,
          new Map(v),
        ]),
      ),
    };
    this.dbs.set(name, working);
    const db = new FakeDatabase(name, working, this);
    this.connections.add(db);
    const tx = new FakeTransaction(db, [...working.stores.keys()], 'versionchange');
    db._upgradeTx = tx;
    req.result = db;
    req.transaction = tx;
    tx._start();
    let aborted = false;
    tx.onabort = () => {
      aborted = true;
      if (existing) this.dbs.set(name, existing);
      else this.dbs.delete(name);
      this.connections.delete(db);
      db._closed = true;
      req.error = domError('AbortError', 'upgrade annulé');
      req.onerror?.({ target: req, preventDefault: () => undefined });
    };
    tx.oncomplete = () => {
      db._upgradeTx = null;
      if (aborted) return;
      req.readyState = 'done';
      req.onsuccess?.({ target: req });
    };
    try {
      req.onupgradeneeded?.({ target: req, oldVersion, newVersion: target });
    } catch (err) {
      tx._abort(err instanceof Error ? err : domError('AbortError'));
    }
  }

  /** @internal */ _takeFailure(op: FakeOp): Error | null {
    this.log.push(op);
    const rule = this.failures.find((f) => f.predicate(op));
    if (!rule) return null;
    rule.remaining--;
    if (rule.remaining <= 0) this.failures = this.failures.filter((f) => f !== rule);
    return domError(rule.name, `échec simulé (${op.kind} ${op.store} ${String(op.key ?? '')})`);
  }

  /** @internal */ _schedule(tx: FakeTransaction): void {
    this.waiting.push(tx);
    this.pump();
  }

  /** @internal */ _transactionDone(tx: FakeTransaction): void {
    const i = this.running.indexOf(tx);
    if (i >= 0) this.running.splice(i, 1);
    this.pump();
  }

  /** @internal */ _connectionClosed(db: FakeDatabase): void {
    this.connections.delete(db);
  }

  private conflicts(a: FakeTransaction, b: FakeTransaction): boolean {
    if (a.db._data !== b.db._data) return false;
    if (a.mode === 'readonly' && b.mode === 'readonly') return false;
    return a.storeNames.some((s) => b.storeNames.includes(s));
  }

  private pump(): void {
    // Ordre de création respecté : une transaction attend toutes celles, plus
    // anciennes, avec lesquelles elle est en conflit.
    const started: FakeTransaction[] = [];
    for (let i = 0; i < this.waiting.length; i++) {
      const tx = this.waiting[i]!;
      const blocked =
        this.running.some((r) => this.conflicts(r, tx)) ||
        this.waiting.slice(0, i).some((w) => !started.includes(w) && this.conflicts(w, tx));
      if (!blocked) started.push(tx);
    }
    for (const tx of started) {
      this.waiting.splice(this.waiting.indexOf(tx), 1);
      this.running.push(tx);
      tx._start();
    }
  }
}

/** Instance neuve, typée comme l'API du navigateur (pour le code de production). */
export function createFakeIndexedDB(): { factory: IDBFactory; fake: FakeIndexedDB } {
  const fake = new FakeIndexedDB();
  return { factory: fake as unknown as IDBFactory, fake };
}
