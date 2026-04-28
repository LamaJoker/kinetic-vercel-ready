/**
 * tests/helpers/stubs.ts
 *
 * Implémentations de test pour tous les ports du core.
 * À importer dans les tests unitaires et d'intégration.
 *
 * Usage :
 *   import { makeTestDeps, FakeClock } from '../helpers/stubs';
 *   const deps = makeTestDeps({ clock: new FakeClock('2026-04-20') });
 */

import type {
  StoragePort,
  StorageKey,
  ClockPort,
  IdGeneratorPort,
  NotifierPort,
  NotificationPayload,
} from '@kinetic/core';

// ─── InMemoryStorage ─────────────────────────────────────────────────────────

/**
 * InMemoryStorage — StoragePort synchrone en mémoire.
 * Parfait pour les tests : rapide, sans I/O, inspectable.
 */
export class InMemoryStorage implements StoragePort {
  private readonly store = new Map<string, unknown>();

  async get<T>(key: StorageKey): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: StorageKey, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async remove(key: StorageKey): Promise<void> {
    this.store.delete(key);
  }

  async keys(): Promise<readonly StorageKey[]> {
    return [...this.store.keys()];
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  // Helpers d'inspection pour les tests
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.store);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  get size(): number {
    return this.store.size;
  }
}

// ─── FakeClock ────────────────────────────────────────────────────────────────

/**
 * FakeClock — ClockPort avec date contrôlée.
 * Permet de tester les streaks, resets journaliers, etc.
 */
export class FakeClock implements ClockPort {
  private _dateIso: string;
  private _nowMs:   number;

  constructor(dateIso = '2026-01-01', nowMs?: number) {
    this._dateIso = dateIso;
    this._nowMs   = nowMs ?? Date.now();
  }

  nowMs(): number {
    return this._nowMs;
  }

  todayIsoDate(): string {
    return this._dateIso;
  }

  /** Avancer d'un nombre de jours */
  advanceDays(n: number): void {
    const [y, m, d] = this._dateIso.split('-').map(Number);
    const date = new Date(y!, m! - 1, d!);
    date.setDate(date.getDate() + n);

    const yy  = date.getFullYear();
    const mm  = String(date.getMonth() + 1).padStart(2, '0');
    const dd  = String(date.getDate()).padStart(2, '0');
    this._dateIso = `${yy}-${mm}-${dd}`;
    this._nowMs  += n * 24 * 60 * 60 * 1000;
  }

  /** Définir une date précise */
  setDate(isoDate: string): void {
    this._dateIso = isoDate;
  }
}

// ─── SequentialIdGenerator ────────────────────────────────────────────────────

/**
 * SequentialIdGenerator — IDs déterministes pour les snapshots de test.
 */
export class SequentialIdGenerator implements IdGeneratorPort {
  private counter = 0;
  private readonly prefix: string;

  constructor(prefix = 'id') {
    this.prefix = prefix;
  }

  newId(): string {
    this.counter++;
    return `${this.prefix}-${String(this.counter).padStart(4, '0')}`;
  }

  reset(): void {
    this.counter = 0;
  }
}

// ─── SpyNotifier ─────────────────────────────────────────────────────────────

/**
 * SpyNotifier — enregistre toutes les notifications émises.
 * Permet d'asserter sur les messages sans afficher de toast.
 */
export class SpyNotifier implements NotifierPort {
  readonly calls: NotificationPayload[] = [];

  notify(payload: NotificationPayload): void {
    this.calls.push({ ...payload });
  }

  /** Dernière notification reçue */
  get last(): NotificationPayload | undefined {
    return this.calls.at(-1);
  }

  /** Nombre de notifications */
  get count(): number {
    return this.calls.length;
  }

  /** Vider l'historique */
  reset(): void {
    this.calls.length = 0;
  }

  /** True si au moins une notification de ce kind a été émise */
  hasKind(kind: NotificationPayload['kind']): boolean {
    return this.calls.some((c) => c.kind === kind);
  }
}

// ─── FailingStorage ───────────────────────────────────────────────────────────

/**
 * FailingStorage — simule un storage défaillant.
 * Utile pour tester la résilience (mode offline, quota dépassé…).
 */
export class FailingStorage implements StoragePort {
  constructor(private readonly error = new Error('Storage unavailable')) {}

  async get<T>(_key: StorageKey): Promise<T | null> { throw this.error; }
  async set<T>(_key: StorageKey, _value: T): Promise<void> { throw this.error; }
  async remove(_key: StorageKey): Promise<void> { throw this.error; }
  async keys(): Promise<readonly StorageKey[]> { throw this.error; }
  async clear(): Promise<void> { throw this.error; }
}

// ─── Factory makeTestDeps ─────────────────────────────────────────────────────

export interface TestDeps {
  storage:  InMemoryStorage;
  clock:    FakeClock;
  idGen:    SequentialIdGenerator;
  notifier: SpyNotifier;
}

/**
 * makeTestDeps — crée un jeu de dépendances de test avec overrides optionnels.
 *
 * @example
 * const deps = makeTestDeps({ clock: new FakeClock('2026-04-20') });
 * const deps2 = makeTestDeps(); // tout par défaut
 */
export function makeTestDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  return {
    storage:  overrides.storage  ?? new InMemoryStorage(),
    clock:    overrides.clock    ?? new FakeClock('2026-04-20'),
    idGen:    overrides.idGen    ?? new SequentialIdGenerator(),
    notifier: overrides.notifier ?? new SpyNotifier(),
  };
}
