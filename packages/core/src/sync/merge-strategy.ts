/**
 * Résolution de conflit de synchronisation par domaine (docs/architecture/sync.md § 4.8).
 *
 * Le client de synchro (adapter-web) appelle `resolveSyncConflict` quand le serveur
 * refuse une écriture conditionnelle (`sync_push` → `conflict`), pendant la
 * réconciliation après migration, et pour la fusion invité → compte. Fonctions
 * PURES : aucune I/O, aucune horloge implicite (`now` est fourni).
 *
 * Invariant : aucune stratégie ne perd de donnée locale sans copie dans
 * `recovery` (sauf entrée `seed`, valeur par défaut jamais saisie par l'utilisateur).
 *
 * Ce module définit l'interface et la stratégie par défaut « dernière écriture
 * arrivée au serveur gagne » (`lww`). Les stratégies métier (keep-both, union-by-id,
 * set-union, map-merge, max, streak) s'enregistrent dans un registre construit avec
 * `createMergeRegistry`.
 */

/** État d'une clé : vivante (avec sa valeur, éventuellement `null`) ou supprimée. */
export type SyncKeyState =
  | { readonly deleted: false; readonly value: unknown }
  | { readonly deleted: true };

/** Écriture locale en attente au moment du conflit. */
export interface PendingWriteInfo {
  readonly op: 'set' | 'delete';
  /** Valeur par défaut écrite sans saisie utilisateur : en conflit, le serveur gagne. */
  readonly seed: boolean;
  /** `legacy` : entrée convertie depuis l'outbox de l'ancienne version (sans `base`). */
  readonly origin: 'app' | 'legacy' | 'reconcile' | 'guest';
}

export interface ConflictInput {
  readonly key: string;
  /** État local actuel (après toutes les écritures locales en attente). */
  readonly local: SyncKeyState;
  /** État serveur actuel (version qui a provoqué le conflit). */
  readonly server: SyncKeyState;
  /** Version serveur (`updated_at`) de `server`. */
  readonly serverVersion: string;
  readonly pending: PendingWriteInfo;
  /** Horodatage ISO de la résolution (fourni par l'appelant, pour les copies datées). */
  readonly now: string;
  /**
   * Ancêtre commun (fusion à trois voies) : état de la clé à la version `base`, c.-à-d. la
   * valeur de `kv` au moment où l'entrée d'outbox a été CRÉÉE (`{ deleted: true }` si
   * `base: null`). Absent = inconnu (entrée `legacy`) : les stratégies retombent alors sur
   * leur règle à deux voies + `itemTombstones`. Voir sync.md « Fusion par domaine ».
   */
  readonly ancestor?: SyncKeyState | undefined;
  /**
   * Suppressions d'éléments de la collection (`kinetic:deleted:<clé>`), local ∪ serveur
   * (`mergeItemTombstoneMaps`). Utilisées seulement quand `ancestor` est inconnu.
   */
  readonly itemTombstones?: Readonly<Record<string, string>> | null | undefined;
}

/** Copie mise de côté (object store `recovery`), jamais synchronisée. */
export interface RecoveryCopy {
  readonly value: unknown;
  readonly reason: 'conflict' | 'reconcile' | 'resync';
}

/** Écriture supplémentaire (ex. copie « (conflit) » d'une séance) : nouvelle clé poussée avec `base: null`. */
export interface ExtraWrite {
  readonly key: string;
  readonly value: unknown;
}

export interface ConflictResolution {
  /** État local final de la clé. */
  readonly result: SyncKeyState;
  /**
   * `true` : `result` doit être poussé (entrée d'outbox conservée, `base` = version serveur).
   * `false` : le serveur gagne ; `result` DOIT alors être égal à `server`.
   */
  readonly push: boolean;
  /** Copies mises de côté (valeur serveur écrasée, valeur locale remplacée…). */
  readonly recovery?: ReadonlyArray<RecoveryCopy>;
  /** Nouvelles clés à écrire localement et à pousser. */
  readonly extraWrites?: ReadonlyArray<ExtraWrite>;
  /** Message français facultatif pour l'utilisateur (ex. « suppression annulée »). */
  readonly notice?: string;
}

export interface MergeStrategy {
  readonly name: string;
  resolve(input: ConflictInput): ConflictResolution;
}

export interface MergeRule {
  /** Préfixe de clé (`kinetic:training:session:`), clé exacte, ou prédicat. */
  readonly match: string | RegExp | ((key: string) => boolean);
  readonly strategy: MergeStrategy;
}

export interface MergeRegistry {
  strategyFor(key: string): MergeStrategy;
}

/** Égalité JSON profonde (ordre des clés d'objet ignoré, comme `jsonb`). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => k in bo && jsonEqual(ao[k], bo[k]));
}

export function sameKeyState(a: SyncKeyState, b: SyncKeyState): boolean {
  if (a.deleted || b.deleted) return a.deleted === b.deleted;
  return jsonEqual(a.value, b.value);
}

/**
 * « Dernière écriture arrivée au serveur gagne » : l'écriture locale en attente est
 * repoussée par-dessus la version serveur, dont la valeur est copiée dans `recovery`.
 * Entrée `seed` : le serveur gagne, sans copie.
 */
export const lwwStrategy: MergeStrategy = {
  name: 'lww',
  resolve(input) {
    if (sameKeyState(input.local, input.server)) return { result: input.server, push: false };
    if (input.pending.seed) return { result: input.server, push: false };
    const recovery: RecoveryCopy[] = input.server.deleted
      ? []
      : [{ value: input.server.value, reason: 'conflict' }];
    return { result: input.local, push: true, recovery };
  },
};

export function createMergeRegistry(
  rules: readonly MergeRule[],
  fallback: MergeStrategy = lwwStrategy,
): MergeRegistry {
  const matches = (rule: MergeRule, key: string): boolean => {
    if (typeof rule.match === 'string') return key === rule.match || key.startsWith(rule.match);
    if (rule.match instanceof RegExp) return rule.match.test(key);
    return rule.match(key);
  };
  return {
    strategyFor(key) {
      return rules.find((r) => matches(r, key))?.strategy ?? fallback;
    },
  };
}

/**
 * Registre minimal : `lww` pour toutes les clés. Le registre MÉTIER à utiliser par le client
 * de synchro est `domainMergeRegistry` (sync/domain-merge.ts, sync.md « Fusion par domaine »).
 */
export const defaultMergeRegistry: MergeRegistry = createMergeRegistry([]);

/**
 * Résout un conflit avec la stratégie de la clé et vérifie l'invariant
 * « `push: false` ⇒ résultat = serveur » (sinon la donnée locale serait perdue
 * sans être poussée) : une résolution incohérente est convertie en `push: true`.
 */
export function resolveSyncConflict(
  registry: MergeRegistry,
  input: ConflictInput,
): ConflictResolution {
  const resolution = registry.strategyFor(input.key).resolve(input);
  if (!resolution.push && !sameKeyState(resolution.result, input.server)) {
    return { ...resolution, push: true };
  }
  return resolution;
}
