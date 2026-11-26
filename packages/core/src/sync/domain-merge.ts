/**
 * Fusion PAR DOMAINE des clés synchronisées (docs/architecture/sync.md § « Fusion par domaine »).
 *
 * - `SYNC_MERGE_RULES` : registre clé / motif de clé → portée (synchronisée ou propre à
 *   l'appareil) + stratégie (`MergeSpec`) + justification.
 * - `domainMergeRegistry` : registre `MergeRegistry` (interface de merge-strategy.ts) à passer
 *   à `resolveSyncConflict` par le client de synchro.
 * - `planGuestMerge` : fusion des données invité dans le compte (liaison invité → compte).
 * - Suppressions d'éléments (`kinetic:deleted:<clé>`) : helpers pour l'app.
 *
 * Module pur : aucune I/O, aucune horloge implicite.
 */

import { STORAGE_KEYS } from '../constants/storage-keys.js';
import type { StorageWrite } from '../ports/storage.port.js';
import { isPlainObject, jsonEqual } from './json.js';
import {
  ABSENT_ANCESTOR,
  UNKNOWN_ANCESTOR,
  collectionItemId,
  knownAncestor,
  mergeValues,
  type MergeAncestor,
  type MergeSpec,
} from './merge-strategies.js';
import {
  createMergeRegistry,
  resolveSyncConflict,
  sameKeyState,
  type ConflictInput,
  type ConflictResolution,
  type ExtraWrite,
  type MergeRegistry,
  type MergeStrategy,
  type RecoveryCopy,
  type SyncKeyState,
} from './merge-strategy.js';

// ─── Registre ─────────────────────────────────────────────────────────────────

/** `synced` : poussée/tirée ; `device` : propre à l'appareil, ne DOIT jamais passer par l'outbox. */
export type SyncScope = 'synced' | 'device';

export interface SyncMergeRule {
  /** Clé exacte (`exact`) ou préfixe de clé (`prefix`). */
  readonly exact?: string;
  readonly prefix?: string;
  readonly scope: SyncScope;
  readonly spec: MergeSpec;
  /** Justification (affichée dans sync.md). */
  readonly why: string;
}

const K = STORAGE_KEYS;
const prefixOf = (f: (arg: string) => string): string => f('');

const LWW: MergeSpec = { kind: 'lww' };
const FIELDS: MergeSpec = { kind: 'fields' };
const SET: MergeSpec = { kind: 'set' };
const MAX: MergeSpec = { kind: 'max' };
const byId = (sortField?: string, dir: 'asc' | 'desc' = 'asc'): MergeSpec =>
  sortField
    ? { kind: 'collection', id: ['id'], sort: { field: sortField, dir } }
    : { kind: 'collection', id: ['id'] };

const device = (exact: string, why: string): SyncMergeRule => ({
  exact,
  scope: 'device',
  spec: LWW,
  why,
});
const exact = (key: string, spec: MergeSpec, why: string): SyncMergeRule => ({
  exact: key,
  scope: 'synced',
  spec,
  why,
});
const prefix = (p: string, spec: MergeSpec, why: string): SyncMergeRule => ({
  prefix: p,
  scope: 'synced',
  spec,
  why,
});

/**
 * Registre des clés IndexedDB (StoragePort). Première règle qui correspond = règle appliquée.
 * Toute clé non listée : `lww` (synchronisée). Les clés localStorage/sessionStorage de
 * STORAGE_KEYS ne passent pas par le StoragePort et ne sont pas concernées.
 */
export const SYNC_MERGE_RULES: readonly SyncMergeRule[] = [
  // ── Propres à l'appareil ──
  device(K.SYNC_OUTBOX, 'Outbox de synchro (ancien format).'),
  device(K.SYNC_CURSOR, 'Curseur de pull de cet appareil.'),
  device(K.SYNC_LAST_AT, 'Ancien curseur de cet appareil.'),
  device(K.SYNC_INITIAL_DONE, 'Indicateur de premier pull de cet appareil.'),
  device(K.SCHEMA_VERSION, 'Version du schéma local.'),
  device(K.SCHEMA_MIGRATION_LOCK, 'Verrou de migration local.'),
  device(K.SYNC_MIGRATED_TO, 'Marqueur de migration de l’ancienne base locale.'),
  device(K.SYNC_FALLBACK_JOURNAL, 'Écritures faites dans l’ancienne base pendant un repli.'),
  device(K.TRAINING_ACTIVE_SESSION, 'Brouillon de la séance en cours, écrit à chaque série.'),
  device(
    K.PENDING_TASK_MUTATION,
    'Journal de reprise après plantage (valeurs absolues) : rejoué sur un autre appareil, il écraserait XP et série.',
  ),

  // ── Séances : une clé par séance ──
  prefix(
    K.TRAINING_SESSION_PREFIX,
    { kind: 'keep-both' },
    'Donnée la plus précieuse : jamais de fusion partielle ; serveur + copie « (conflit) ».',
  ),

  // ── Suppressions d'éléments ──
  prefix(
    K.ITEM_TOMBSTONES_PREFIX,
    { kind: 'map', entry: MAX },
    "Carte id → date de suppression : union, date la plus récente (une suppression n'est jamais oubliée).",
  ),

  // ── Collections d'éléments identifiés ──
  exact(K.TRAINING_SESSIONS, byId(), 'Ancien tableau de séances (migration v2) : union par id.'),
  exact(K.TRAINING_TEMPLATES, byId(), 'Modèles (id) : union ; même id → updatedAt, sinon local.'),
  exact(K.TRAINING_EXERCISES, byId(), 'Catalogue (id) : union, jamais de perte d’exercice.'),
  exact(K.TRAINING_CUSTOM_EXERCISES, byId(), 'Exercices perso (id) : union par id.'),
  exact(K.TIMER_PRESETS, byId(), 'Préréglages de minuteur (id) : union par id.'),
  exact(
    K.BODYWEIGHT_ENTRIES,
    { kind: 'collection', id: ['date'], sort: { field: 'date', dir: 'asc' } },
    'Pesées : une par jour (id = date), triées par date.',
  ),
  exact(K.MEASUREMENTS_ENTRIES, byId('date'), 'Mensurations (id), triées par date.'),
  exact(K.MEASUREMENTS_PHOTOS, byId(), 'Métadonnées des photos de mensurations (id).'),
  prefix(
    prefixOf(K.MEASUREMENT_PHOTO_DATA),
    LWW,
    'Contenu d’une photo : immuable par id (les deux côtés sont identiques).',
  ),
  exact(K.PROGRESS_PHOTOS, byId(), 'Photos de progression (id).'),
  exact(K.STRENGTH_GOALS, byId(), 'Objectifs de force (id).'),
  prefix(prefixOf(K.NUTRITION_LOG), byId(), 'Repas du jour (id) : union par repas.'),
  exact(
    K.NUTRITION_CUSTOM_FOODS,
    { kind: 'collection', id: ['name', 'recipeId'] },
    'Aliments perso : identité = nom (+ recette).',
  ),
  exact(
    K.NUTRITION_FAVORITES,
    { kind: 'collection', id: ['name', 'recipeId'] },
    'Favoris : identité = nom (+ recette).',
  ),
  exact(
    K.NUTRITION_RECENTS,
    {
      kind: 'collection',
      id: ['food.name', 'food.recipeId'],
      stamp: 'usedAt',
      sort: { field: 'usedAt', dir: 'desc' },
    },
    'Récents : identité = aliment, usage le plus récent gagne, du plus récent au plus ancien.',
  ),
  exact(K.NUTRITION_RECIPES, byId(), 'Recettes (id, updatedAt déjà présent).'),
  exact(K.VITALITE_CUSTOM_TASKS, byId(), 'Tâches perso (id).'),
  exact(K.VITALITE_TASKS, byId(), 'Définition des tâches (id).'),
  exact(
    K.CHALLENGES,
    {
      kind: 'composite',
      parts: {
        accepted: byId(),
        completed: { kind: 'collection', id: ['id', 'periodKey'], stamp: 'completedAt' },
      },
    },
    'Défis : acceptés (id) et réussis (id + période) fusionnés séparément.',
  ),

  // ── Ensembles ──
  exact(K.VITALITE_HIDDEN_TASKS, SET, 'Tâches masquées : ensemble (réafficher = retrait).'),
  prefix(K.VITALITE_DONE_PREFIX, SET, 'Tâches cochées du jour : ensemble (annuler = retrait).'),
  exact(K.COMPLETED_KEYS, SET, 'Clés d’idempotence : ensemble.'),
  exact(K.AWARDED_IDS, SET, 'Bonus déjà accordés : ensemble.'),
  exact(K.ACHIEVEMENTS_UNLOCKED, SET, 'Badges : ensemble croissant.'),
  exact(K.REWARDS_UNLOCKED, SET, 'Récompenses : ensemble croissant.'),
  exact(K.DEMO_MANIFEST, SET, 'Clés écrites par la démo : ensemble.'),
  prefix(prefixOf(K.PROGRAM_COMPLETED_DAYS), SET, 'Jours de programme faits : ensemble.'),

  // ── Objets indexés ──
  exact(
    K.WELLNESS_CHECKINS,
    { kind: 'map', entry: { kind: 'newest', stamp: 'at' } },
    'Check-ins par jour : le plus récent (champ at) gagne pour un même jour.',
  ),
  exact(
    K.WELLNESS_WATER,
    { kind: 'map', entry: { kind: 'multiset' } },
    'Verres d’eau par jour : verres ajoutés des deux côtés conservés.',
  ),
  exact(
    K.VITALITE_INTERVAL_LAST_DONE,
    { kind: 'map', entry: MAX },
    'Dernière réalisation par tâche : date maximale.',
  ),
  exact(
    K.PLATEAU_DISMISSED,
    { kind: 'map', entry: MAX },
    'Alertes masquées : date de fin maximale.',
  ),
  prefix(prefixOf(K.PROGRAM_TODO_STATUS), FIELDS, 'Cases du jour : champ par champ.'),
  exact(K.PROGRAM_ONE_RMS, FIELDS, '1RM par exercice : champ par champ.'),

  // ── Compteurs et scalaires monotones ──
  exact(
    K.XP,
    { kind: 'counter', field: 'xp', fallback: 'max' },
    'XP : serveur + delta local (ancêtre connu), sinon max.',
  ),
  prefix(
    K.XP_EARNED_PREFIX,
    { kind: 'counter', field: 'xp', fallback: 'max' },
    'XP du jour : comme XP.',
  ),
  exact(
    K.PROGRAM_GENERATED_COUNT,
    { kind: 'counter', fallback: 'max' },
    'Compteur croissant : delta, sinon max.',
  ),
  exact(
    K.REWARDS_FREEZE_TOKENS,
    { kind: 'counter', fallback: 'lww' },
    'Jetons consommés et rechargés : delta, sinon lww (max permettrait de dépenser deux fois).',
  ),
  exact(K.REWARDS_FREEZE_WEEK, MAX, 'Semaine de recharge : la plus récente.'),
  exact(K.VITALITE_LAST_RESET, MAX, 'Date de remise à zéro : la plus récente.'),
  exact(K.TRAINING_CATALOG_VERSION, MAX, 'Version du catalogue : la plus récente.'),
  exact(K.STREAK, { kind: 'streak' }, 'Série : best = max, série courante la plus récente.'),

  // ── Réglages : champ par champ ──
  exact(K.USER_PROFILE, FIELDS, 'Profil : champ par champ.'),
  exact(K.PROFILE, FIELDS, 'Profil d’affichage : champ par champ.'),
  exact(K.STRENGTH_SCORE_PROFILE, FIELDS, 'Profil de force : champ par champ.'),
  exact(K.NUTRITION_PLAN, FIELDS, 'Plan nutritionnel : champ par champ.'),
  exact(K.NUTRITION_PREFS, FIELDS, 'Réglages nutrition : champ par champ.'),
  exact(K.WELLNESS_WATER_PREFS, FIELDS, 'Réglages eau : champ par champ.'),
  exact(K.PLATE_PREFS, FIELDS, 'Réglages du calculateur : champ par champ.'),
  exact(K.GOALS, FIELDS, 'Objectifs : champ par champ.'),
  exact(K.GOALS_WEEKLY, FIELDS, 'Objectifs de la semaine : champ par champ.'),

  // ── Valeurs cohérentes d'un bloc : lww ──
  exact(K.PROGRAM_ACTIVE, LWW, 'Programme actif : un tout cohérent.'),
  exact(K.ACTIVE_PROGRAM, LWW, 'Programme du catalogue : un tout cohérent.'),
  exact(K.PROGRAM_WEEK_PLAN, LWW, 'Semaine adaptée : un tout cohérent.'),
  exact(K.BODYWEIGHT_GOAL, LWW, 'Objectif de poids : scalaire.'),
  exact(K.REWARDS_THEME, LWW, 'Thème choisi : scalaire.'),
  exact(K.STATS, LWW, 'Cache recalculable.'),
];

export const DEFAULT_MERGE_RULE: SyncMergeRule = {
  scope: 'synced',
  spec: LWW,
  why: 'Clé non listée : la dernière écriture arrivée au serveur gagne, valeur écrasée mise de côté.',
};

/** Règle du registre pour une clé (première qui correspond, sinon `DEFAULT_MERGE_RULE`). */
export function mergeRuleForKey(key: string): SyncMergeRule {
  for (const rule of SYNC_MERGE_RULES) {
    if (rule.exact !== undefined && rule.exact === key) return rule;
    if (rule.prefix !== undefined && key.startsWith(rule.prefix)) return rule;
  }
  return DEFAULT_MERGE_RULE;
}

export function mergeSpecForKey(key: string): MergeSpec {
  return mergeRuleForKey(key).spec;
}

/** Clé propre à l'appareil : jamais poussée ni tirée (à exclure de l'outbox). */
export function isDeviceLocalKey(key: string): boolean {
  return mergeRuleForKey(key).scope === 'device';
}

// ─── Stratégies (interface MergeStrategy) ────────────────────────────────────

const ALIVE = (value: unknown): SyncKeyState => ({ deleted: false, value });
const DELETED: SyncKeyState = { deleted: true };

function toMergeAncestor(input: ConflictInput, guest: boolean): MergeAncestor {
  const anc = input.ancestor ?? (guest ? DELETED : undefined);
  if (anc === undefined) return UNKNOWN_ANCESTOR;
  return anc.deleted ? ABSENT_ANCESTOR : knownAncestor(anc.value);
}

function ancestorValue(input: ConflictInput): { alive: true; value: unknown } | { alive: false } {
  const anc = input.ancestor;
  return anc && !anc.deleted ? { alive: true, value: anc.value } : { alive: false };
}

/** Stratégie générique pilotée par une `MergeSpec` (toutes les clés sauf les séances). */
export function specMergeStrategy(spec: MergeSpec, name: string = spec.kind): MergeStrategy {
  return {
    name,
    resolve(input): ConflictResolution {
      const { local, server, pending } = input;
      const guest = pending.origin === 'guest';
      if (sameKeyState(local, server) || pending.seed) return { result: server, push: false };
      const anc = ancestorValue(input);

      if (local.deleted) {
        if (server.deleted) return { result: server, push: false };
        if (guest) return { result: server, push: false };
        // Le serveur n'a pas changé depuis l'ancêtre : la suppression locale s'applique.
        if (anc.alive && jsonEqual(server.value, anc.value)) return { result: DELETED, push: true };
        return {
          result: DELETED,
          push: true,
          recovery: [{ value: server.value, reason: 'conflict' }],
        };
      }
      if (server.deleted) {
        // Valeur locale inchangée depuis l'ancêtre : la suppression distante s'applique.
        if (anc.alive && jsonEqual(local.value, anc.value)) return { result: server, push: false };
        // Modifiée localement après : la modification l'emporte (rien n'est perdu).
        return { result: local, push: true };
      }

      const out = mergeValues(spec, local.value, server.value, toMergeAncestor(input, guest), {
        tiebreak: guest ? 'server' : 'local',
        tombstones: input.itemTombstones ?? null,
      });
      const push = !jsonEqual(out.value, server.value);
      const result = push ? ALIVE(out.value) : server;
      const recovery: RecoveryCopy[] = [];
      if (!guest && out.discardedServer) recovery.push({ value: server.value, reason: 'conflict' });
      if (!guest && out.discardedLocal) recovery.push({ value: local.value, reason: 'conflict' });
      return recovery.length > 0 ? { result, push, recovery } : { result, push };
    },
  };
}

const CONFLICT_SUFFIX = ' (conflit)';
const GUEST_SUFFIX = ' (cet appareil)';

function sessionName(value: unknown): string {
  const name = isPlainObject(value) ? value['name'] : undefined;
  return typeof name === 'string' && name.trim() !== '' ? name : 'Séance';
}

/** Identifiant d'une copie de séance : `<id>-c<horodatage compact>` (ex. `abc-c20261125101530123`). */
export function conflictCopyId(sessionId: string, nowIso: string): string {
  const digits = nowIso.replace(/\D/g, '').slice(0, 17) || '0';
  return `${sessionId}-c${digits}`;
}

/** Copie d'une séance sous un nouvel id et un nom suffixé. */
export function sessionConflictCopy(
  key: string,
  value: unknown,
  nowIso: string,
  suffix: string = CONFLICT_SUFFIX,
): ExtraWrite {
  const id = key.slice(K.TRAINING_SESSION_PREFIX.length);
  const copyId = conflictCopyId(id, nowIso);
  const copyKey = K.TRAINING_SESSION(copyId);
  if (!isPlainObject(value)) return { key: copyKey, value };
  const base = sessionName(value);
  const name = base.endsWith(suffix) ? base : `${base}${suffix}`;
  return { key: copyKey, value: { ...value, id: copyId, name } };
}

/**
 * Séances (`keep-both`) : une séance ne disparaît jamais.
 * - modifiée des deux côtés → la version serveur est appliquée ET la version locale est
 *   enregistrée comme nouvelle séance « <nom> (conflit) » ;
 * - supprimée localement mais modifiée ailleurs → la suppression est annulée ;
 * - supprimée ailleurs mais modifiée ici → la version locale est recréée.
 */
export const sessionKeepBothStrategy: MergeStrategy = {
  name: 'keep-both',
  resolve(input): ConflictResolution {
    const { key, local, server, pending, now } = input;
    const guest = pending.origin === 'guest';
    if (sameKeyState(local, server) || pending.seed) return { result: server, push: false };
    const anc = ancestorValue(input);

    if (local.deleted) {
      if (server.deleted || guest) return { result: server, push: false };
      if (anc.alive && jsonEqual(server.value, anc.value)) return { result: DELETED, push: true };
      return {
        result: server,
        push: false,
        notice: `La séance « ${sessionName(server.value)} » a été modifiée sur un autre appareil : elle a été conservée.`,
      };
    }
    if (server.deleted) {
      if (anc.alive && jsonEqual(local.value, anc.value)) return { result: server, push: false };
      return {
        result: local,
        push: true,
        notice: `La séance « ${sessionName(local.value)} », supprimée sur un autre appareil, a été conservée car elle a été modifiée sur celui-ci.`,
      };
    }
    if (anc.alive) {
      if (jsonEqual(local.value, anc.value)) return { result: server, push: false };
      if (jsonEqual(server.value, anc.value)) return { result: local, push: true };
    }
    const copy = sessionConflictCopy(key, local.value, now, guest ? GUEST_SUFFIX : CONFLICT_SUFFIX);
    return {
      result: server,
      push: false,
      extraWrites: [copy],
      notice: guest
        ? `La séance « ${sessionName(local.value)} » de cet appareil a été ajoutée en copie.`
        : `La séance « ${sessionName(local.value)} » a été modifiée sur deux appareils : les deux versions ont été conservées.`,
    };
  },
};

const strategyCache = new Map<SyncMergeRule, MergeStrategy>();
function strategyForRule(rule: SyncMergeRule): MergeStrategy {
  let s = strategyCache.get(rule);
  if (!s) {
    s = rule.spec.kind === 'keep-both' ? sessionKeepBothStrategy : specMergeStrategy(rule.spec);
    strategyCache.set(rule, s);
  }
  return s;
}

/** Registre métier à passer à `resolveSyncConflict(domainMergeRegistry, input)`. */
export const domainMergeRegistry: MergeRegistry = createMergeRegistry(
  SYNC_MERGE_RULES.map((rule) => ({
    // Prédicat (et non chaîne) : une clé exacte ne doit pas capturer ses « sous-clés »
    // (`kinetic:xp` ≠ `kinetic:xp:earned:…`).
    match: (key: string) => mergeRuleForKey(key) === rule,
    strategy: strategyForRule(rule),
  })),
  strategyForRule(DEFAULT_MERGE_RULE),
);

function strategyFor(key: string): MergeStrategy {
  return strategyForRule(mergeRuleForKey(key));
}

/** Nom de la stratégie appliquée à une clé (diagnostic, tests, documentation). */
export function strategyNameForKey(key: string): string {
  return strategyFor(key).name;
}

// ─── Liaison invité → compte ─────────────────────────────────────────────────

export interface GuestMergeWrite {
  readonly key: string;
  /** Valeur à écrire dans la base du compte (entrée d'outbox avec la `base` serveur). */
  readonly value: unknown;
}

export interface GuestMergePlan {
  /** Clés du compte à (ré)écrire avec la valeur fusionnée. */
  readonly writes: readonly GuestMergeWrite[];
  /** Nouvelles clés (copies de séances) à écrire avec `base: null`. */
  readonly extraWrites: readonly ExtraWrite[];
  /** Clés invité non reprises (propres à l'appareil, données de démo, identiques au compte). */
  readonly skipped: readonly string[];
  readonly notices: readonly string[];
}

/**
 * Fusionne les données de la base invité dans le compte, APRÈS le pull complet du compte.
 * Règles : ancêtre = « absent » (les deux historiques sont indépendants) ; collections,
 * ensembles, cartes : union ; compteurs (XP…) : somme ; série : règle `streak` ; réglages
 * et valeurs d'un bloc : le COMPTE gagne (la base invité est conservée intacte) ; séance de
 * même id et contenu différent : copie « (cet appareil) ». Données de démo exclues.
 *
 * @param guestEntries toutes les paires clé/valeur de la base invité (`kv`)
 * @param account valeurs vivantes du compte pour ces clés (absente = clé absente ou supprimée)
 */
export function planGuestMerge(
  guestEntries: Iterable<readonly [string, unknown]>,
  account: ReadonlyMap<string, unknown>,
  nowIso: string,
): GuestMergePlan {
  const entries = [...guestEntries];
  const manifest = entries.find(([k]) => k === K.DEMO_MANIFEST)?.[1];
  const demoKeys = new Set(
    Array.isArray(manifest) ? manifest.filter((k): k is string => typeof k === 'string') : [],
  );
  const writes: GuestMergeWrite[] = [];
  const extraWrites: ExtraWrite[] = [];
  const skipped: string[] = [];
  const notices: string[] = [];
  for (const [key, guestValue] of entries) {
    if (isDeviceLocalKey(key) || key === K.DEMO_MANIFEST || demoKeys.has(key)) {
      skipped.push(key);
      continue;
    }
    const server: SyncKeyState = account.has(key) ? ALIVE(account.get(key)) : DELETED;
    const r = resolveSyncConflict(domainMergeRegistry, {
      key,
      local: ALIVE(guestValue),
      server,
      serverVersion: '',
      pending: { op: 'set', seed: false, origin: 'guest' },
      now: nowIso,
      ancestor: DELETED,
    });
    if (r.push && !r.result.deleted) writes.push({ key, value: r.result.value });
    if (r.extraWrites) extraWrites.push(...r.extraWrites);
    if (r.notice) notices.push(r.notice);
    if (!r.push && !r.extraWrites?.length) skipped.push(key);
  }
  return { writes, extraWrites, skipped, notices };
}

// ─── Suppressions d'éléments (clé sœur `kinetic:deleted:<clé>`) ──────────────

/** Durée de conservation conseillée d'une suppression d'élément (alignée sur la purge serveur). */
export const ITEM_TOMBSTONE_TTL_DAYS = 180;

export function itemTombstoneKey(collectionKey: string): string {
  return K.ITEM_TOMBSTONES(collectionKey);
}

export function isItemTombstoneKey(key: string): boolean {
  return key.startsWith(K.ITEM_TOMBSTONES_PREFIX);
}

/** Clé de la collection dont `tombstoneKey` porte les suppressions (`null` si ce n'en est pas une). */
export function collectionKeyOfTombstoneKey(tombstoneKey: string): string | null {
  return isItemTombstoneKey(tombstoneKey)
    ? tombstoneKey.slice(K.ITEM_TOMBSTONES_PREFIX.length)
    : null;
}

/** Normalise une valeur lue (forme inattendue → carte vide). */
export function asItemTombstones(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(value)) if (typeof at === 'string') out[id] = at;
  return out;
}

/** Union de deux cartes de suppressions (date la plus récente par id). */
export function mergeItemTombstoneMaps(a: unknown, b: unknown): Record<string, string> {
  const out = asItemTombstones(a);
  for (const [id, at] of Object.entries(asItemTombstones(b))) {
    const cur = out[id];
    if (cur === undefined || at > cur) out[id] = at;
  }
  return out;
}

/**
 * Identifiant d'un élément tel que l'utilise la fusion pour `collectionKey` : `id`, `date`
 * (pesées), `nom|recette` (favoris)… ; pour un ensemble, la valeur elle-même ; pour un objet
 * indexé, la clé de l'entrée. `part` : sous-collection d'une clé composite (`accepted`).
 */
export function itemIdFor(collectionKey: string, item: unknown, part?: string): string {
  const spec = mergeSpecForKey(collectionKey);
  if (spec.kind === 'composite' && part !== undefined) {
    const sub = spec.parts[part];
    return sub ? `${part}:${itemIdForSpec(sub, item)}` : String(item);
  }
  return itemIdForSpec(spec, item);
}

function itemIdForSpec(spec: MergeSpec, item: unknown): string {
  return spec.kind === 'collection' ? collectionItemId(item, spec.id) : String(item);
}

/** Ajoute des suppressions (date la plus récente conservée). */
export function withItemDeletions(
  tombstones: unknown,
  ids: Iterable<string>,
  deletedAtIso: string,
): Record<string, string> {
  const add: Record<string, string> = {};
  for (const id of ids) add[id] = deletedAtIso;
  return mergeItemTombstoneMaps(tombstones, add);
}

/** Retire les suppressions plus anciennes que `maxAgeDays` (défaut 180 j). */
export function pruneItemTombstones(
  tombstones: unknown,
  nowIso: string,
  maxAgeDays: number = ITEM_TOMBSTONE_TTL_DAYS,
): Record<string, string> {
  const cutoff = Date.parse(nowIso) - maxAgeDays * 86_400_000;
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(asItemTombstones(tombstones))) {
    const ms = Date.parse(at);
    if (!Number.isFinite(cutoff) || !Number.isFinite(ms) || ms >= cutoff) out[id] = at;
  }
  return out;
}

/** Marque un élément comme modifié maintenant (champ `updatedAt`, utilisé par la fusion). */
export function stampUpdatedAt<T extends object>(
  item: T,
  atIso: string,
): T & { updatedAt: string } {
  return { ...item, updatedAt: atIso };
}

/**
 * Supprime des éléments d'une collection ET enregistre leurs suppressions : renvoie les deux
 * écritures à passer ENSEMBLE à `storage.setMany(...)` (une seule transaction locale).
 */
export function deleteCollectionItems<T>(
  collectionKey: string,
  items: readonly T[],
  idsToDelete: Iterable<string>,
  currentTombstones: unknown,
  nowIso: string,
): { items: T[]; tombstones: Record<string, string>; writes: StorageWrite[] } {
  const ids = new Set(idsToDelete);
  const kept = items.filter((it) => !ids.has(itemIdFor(collectionKey, it)));
  const tombstones = pruneItemTombstones(withItemDeletions(currentTombstones, ids, nowIso), nowIso);
  return {
    items: kept,
    tombstones,
    writes: [
      { key: collectionKey, value: kept },
      { key: itemTombstoneKey(collectionKey), value: tombstones },
    ],
  };
}
