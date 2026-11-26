/**
 * Stratégies de fusion pures (aucune I/O) utilisées pour résoudre un conflit de
 * synchronisation (sync_push → `conflict`) et pour la liaison invité → compte.
 *
 * Toutes les stratégies sont des fusions « à trois voies » quand l'ancêtre est connu
 * (valeur de la clé à la version `base` de l'entrée d'outbox), et retombent sur une
 * règle « à deux voies » documentée sinon. Principe directeur : **aucune donnée
 * n'est perdue sans être signalée** (`discardedServer` / `discardedLocal`, que la
 * couche de résolution transforme en copie de récupération).
 *
 * Référence : docs/architecture/sync.md, section « Fusion par domaine ».
 */

import { isPlainObject, jsonEqual, readPath, stableStringify, type JsonObject } from './json.js';

// ─── Types publics ────────────────────────────────────────────────────────────

/** Ancêtre commun : valeur de la clé à la version `base`. `value: undefined` = clé absente. */
export type MergeAncestor =
  | { readonly known: false }
  | { readonly known: true; readonly value: unknown };

export const UNKNOWN_ANCESTOR: MergeAncestor = /* @__PURE__ */ Object.freeze({ known: false });
export const ABSENT_ANCESTOR: MergeAncestor = /* @__PURE__ */ Object.freeze({
  known: true,
  value: undefined,
});

export function knownAncestor(value: unknown): MergeAncestor {
  return { known: true, value };
}

/**
 * Suppressions d'éléments d'une collection : identifiant d'élément → date ISO de
 * suppression (valeur de la clé sœur `kinetic:deleted:<clé>`).
 */
export type ItemTombstones = Readonly<Record<string, string>>;

/** Tri du résultat d'une collection (ordre du domaine). */
export interface CollectionSort {
  readonly field: string;
  readonly dir: 'asc' | 'desc';
}

export type MergeSpec =
  /** La dernière écriture arrivée au serveur gagne (en conflit : `tiebreak`). */
  | { readonly kind: 'lww' }
  /** Scalaire monotone (nombre, ou chaîne ISO comparée lexicalement) : maximum. */
  | { readonly kind: 'max' }
  /**
   * Compteur (nombre, ou objet `{ [field]: nombre }`). Ancêtre connu : serveur + delta local
   * (les incréments concurrents s'additionnent, une annulation locale est conservée).
   * Ancêtre inconnu : `fallback`.
   */
  | { readonly kind: 'counter'; readonly field?: string; readonly fallback: 'max' | 'lww' }
  /** Ensemble de primitives (tableau sans doublon). */
  | { readonly kind: 'set' }
  /** Liste de primitives sans identité (verres d'eau du jour) : fusion de multiensembles. */
  | { readonly kind: 'multiset' }
  /** Objet daté : le plus récent selon `stamp` gagne. */
  | { readonly kind: 'newest'; readonly stamp: string }
  /** Série : `best` = max ; `count`/`lastActiveDate` de la valeur la plus récente. */
  | { readonly kind: 'streak' }
  /** Tableau d'éléments identifiés (`id` = chemins des champs qui forment l'identifiant). */
  | {
      readonly kind: 'collection';
      readonly id: readonly string[];
      /** Champ de date de modification (défaut `updatedAt`). */
      readonly stamp?: string;
      readonly sort?: CollectionSort;
    }
  /** Objet indexé (date → valeur, id → valeur) : fusion par entrée avec `entry`. */
  | { readonly kind: 'map'; readonly entry: MergeSpec }
  /** Objet de réglages : fusion champ par champ (`lww` par champ). */
  | { readonly kind: 'fields' }
  /** Objet dont certains champs ont leur propre stratégie (le reste : `fields`). */
  | { readonly kind: 'composite'; readonly parts: Readonly<Record<string, MergeSpec>> }
  /** Séance : serveur conservé + copie locale « (conflit) » (géré par la résolution). */
  | { readonly kind: 'keep-both' };

export type MergeKind = MergeSpec['kind'];

export interface MergeContext {
  /** Côté retenu quand rien ne permet de départager (dates égales ou absentes). */
  readonly tiebreak: 'local' | 'server';
  /** Suppressions d'éléments (utilisées seulement si l'ancêtre est inconnu). */
  readonly tombstones: ItemTombstones | null;
}

export interface MergeOutcome {
  readonly value: unknown;
  /** Une information présente côté serveur a été écartée (→ copie de récupération). */
  readonly discardedServer: boolean;
  /** Une information présente côté local a été écartée. */
  readonly discardedLocal: boolean;
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

const keep = (value: unknown): MergeOutcome => ({
  value,
  discardedServer: false,
  discardedLocal: false,
});

function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function stampOf(item: unknown, field: string): number | null {
  return toMs(readPath(item, field));
}

function isTombstoned(
  id: string,
  item: unknown,
  stampField: string | null,
  tombstones: ItemTombstones | null,
): boolean {
  if (!tombstones || !Object.prototype.hasOwnProperty.call(tombstones, id)) return false;
  const deletedAt = toMs(tombstones[id]);
  const stamp = stampField ? stampOf(item, stampField) : null;
  // Élément sans date de modification : considéré plus ancien que la suppression.
  if (stamp === null) return true;
  return deletedAt === null || stamp <= deletedAt;
}

function childAncestor(anc: Readonly<Record<string, unknown>> | null, k: string): MergeAncestor {
  return anc ? { known: true, value: anc[k] } : UNKNOWN_ANCESTOR;
}

function combine(value: unknown, parts: readonly MergeOutcome[]): MergeOutcome {
  return {
    value,
    discardedServer: parts.some((p) => p.discardedServer),
    discardedLocal: parts.some((p) => p.discardedLocal),
  };
}

function tiebreak(local: unknown, server: unknown, ctx: MergeContext): MergeOutcome {
  return ctx.tiebreak === 'local'
    ? { value: local, discardedServer: true, discardedLocal: false }
    : { value: server, discardedServer: false, discardedLocal: true };
}

/** Règle commune : égalité, puis ancêtre (seul un côté a changé), sinon `undefined`. */
function threeWayShortcut(
  local: unknown,
  server: unknown,
  anc: MergeAncestor,
): MergeOutcome | undefined {
  if (jsonEqual(local, server)) return keep(local);
  if (anc.known && anc.value !== undefined) {
    if (jsonEqual(local, anc.value)) return keep(server);
    if (jsonEqual(server, anc.value)) return keep(local);
  }
  return undefined;
}

// ─── Stratégies ───────────────────────────────────────────────────────────────

function mergeLww(local: unknown, server: unknown, anc: MergeAncestor, ctx: MergeContext) {
  return threeWayShortcut(local, server, anc) ?? tiebreak(local, server, ctx);
}

function mergeMax(local: unknown, server: unknown, anc: MergeAncestor, ctx: MergeContext) {
  if (typeof local === 'number' && typeof server === 'number') {
    return keep(Math.max(local, server));
  }
  if (typeof local === 'string' && typeof server === 'string') {
    return keep(local >= server ? local : server);
  }
  return mergeLww(local, server, anc, ctx);
}

function counterOf(v: unknown, field: string | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (field && isPlainObject(v)) {
    const n = v[field];
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

function mergeCounter(
  spec: Extract<MergeSpec, { kind: 'counter' }>,
  local: unknown,
  server: unknown,
  anc: MergeAncestor,
  ctx: MergeContext,
): MergeOutcome {
  const l = counterOf(local, spec.field);
  const s = counterOf(server, spec.field);
  if (l === null || s === null) return mergeLww(local, server, anc, ctx);
  if (jsonEqual(local, server)) return keep(local);
  let n: number;
  const a = anc.known ? (anc.value === undefined ? 0 : counterOf(anc.value, spec.field)) : null;
  if (a !== null) {
    n = Math.max(0, s + (l - a));
  } else if (spec.fallback === 'max') {
    n = Math.max(l, s);
  } else {
    return mergeLww(local, server, anc, ctx);
  }
  if (spec.field && (isPlainObject(local) || isPlainObject(server))) {
    const base: JsonObject = {
      ...(isPlainObject(server) ? server : {}),
      ...(isPlainObject(local) ? local : {}),
    };
    return keep({ ...base, [spec.field]: n });
  }
  return keep(n);
}

type Primitive = string | number | boolean;
const isPrimitive = (v: unknown): v is Primitive =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const primKey = (v: Primitive): string => `${typeof v}:${String(v)}`;

function mergeSet(local: unknown, server: unknown, anc: MergeAncestor, ctx: MergeContext) {
  if (
    !Array.isArray(local) ||
    !Array.isArray(server) ||
    !local.every(isPrimitive) ||
    !server.every(isPrimitive)
  ) {
    return mergeLww(local, server, anc, ctx);
  }
  // Idempotence : deux valeurs identiques sont rendues telles quelles (doublons compris).
  if (jsonEqual(local, server)) return keep(local);
  const l = local as Primitive[];
  const s = server as Primitive[];
  const inL = new Set(l.map(primKey));
  const inS = new Set(s.map(primKey));
  const ancArr = anc.known ? (Array.isArray(anc.value) ? anc.value.filter(isPrimitive) : []) : null;
  const inA = ancArr ? new Set(ancArr.map(primKey)) : null;

  const out: Primitive[] = [];
  const seen = new Set<string>();
  const push = (v: Primitive) => {
    const k = primKey(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  };
  for (const v of s) {
    const k = primKey(v);
    if (inA) {
      // Retiré localement depuis l'ancêtre : la suppression est respectée.
      if (inA.has(k) && !inL.has(k)) continue;
    } else if (!inL.has(k) && isTombstoned(String(v), v, null, ctx.tombstones)) {
      continue;
    }
    push(v);
  }
  for (const v of l) {
    const k = primKey(v);
    if (inS.has(k)) continue;
    if (inA) {
      // Retiré côté serveur depuis l'ancêtre : la suppression est respectée.
      if (inA.has(k)) continue;
    } else if (isTombstoned(String(v), v, null, ctx.tombstones)) {
      continue;
    }
    push(v);
  }
  return keep(out);
}

function isPrefix(short: readonly unknown[], long: readonly unknown[]): boolean {
  return short.length <= long.length && short.every((v, i) => jsonEqual(v, long[i]));
}

function mergeMultiset(local: unknown, server: unknown, anc: MergeAncestor, ctx: MergeContext) {
  if (!Array.isArray(local) || !Array.isArray(server)) return mergeLww(local, server, anc, ctx);
  if (jsonEqual(local, server)) return keep(local);
  if (anc.known) {
    const a = Array.isArray(anc.value) ? anc.value : [];
    const count = new Map<string, number>();
    for (const v of a) count.set(stableStringify(v), (count.get(stableStringify(v)) ?? 0) + 1);
    const added: unknown[] = [];
    for (const v of local) {
      const k = stableStringify(v);
      const c = count.get(k) ?? 0;
      if (c > 0) count.set(k, c - 1);
      else added.push(v);
    }
    // Ce qui reste dans `count` a été retiré localement depuis l'ancêtre.
    const out = [...server];
    for (const [k, c] of count) {
      for (let i = 0; i < c; i++) {
        const idx = out.map(stableStringify).lastIndexOf(k);
        if (idx >= 0) out.splice(idx, 1);
      }
    }
    return keep([...out, ...added]);
  }
  if (isPrefix(local, server)) return keep(server);
  if (isPrefix(server, local)) return keep(local);
  if (local.length > server.length)
    return { value: local, discardedServer: true, discardedLocal: false };
  if (server.length > local.length)
    return { value: server, discardedServer: false, discardedLocal: true };
  return tiebreak(local, server, ctx);
}

function mergeNewest(
  spec: Extract<MergeSpec, { kind: 'newest' }>,
  local: unknown,
  server: unknown,
  anc: MergeAncestor,
  ctx: MergeContext,
): MergeOutcome {
  const short = threeWayShortcut(local, server, anc);
  if (short) return short;
  const ls = stampOf(local, spec.stamp);
  const ss = stampOf(server, spec.stamp);
  if (ls !== null || ss !== null) {
    const l = ls ?? Number.NEGATIVE_INFINITY;
    const s = ss ?? Number.NEGATIVE_INFINITY;
    if (l > s) return keep(local);
    if (s > l) return keep(server);
  }
  return tiebreak(local, server, ctx);
}

interface StreakLike {
  count: number;
  best: number;
  lastActiveDate: string | null;
}
function asStreak(v: unknown): StreakLike | null {
  if (!isPlainObject(v)) return null;
  const { count, best, lastActiveDate } = v;
  if (typeof count !== 'number' || typeof best !== 'number') return null;
  if (lastActiveDate !== null && typeof lastActiveDate !== 'string') return null;
  return { count, best, lastActiveDate };
}

function mergeStreak(local: unknown, server: unknown, anc: MergeAncestor, ctx: MergeContext) {
  const l = asStreak(local);
  const s = asStreak(server);
  if (!l || !s) return mergeLww(local, server, anc, ctx);
  if (jsonEqual(local, server)) return keep(local);
  const ld = l.lastActiveDate ?? '';
  const sd = s.lastActiveDate ?? '';
  let pickLocal: boolean;
  if (ld !== sd) pickLocal = ld > sd;
  else pickLocal = l.count >= s.count;
  const pick = pickLocal ? (local as JsonObject) : (server as JsonObject);
  const pickedCount = pickLocal ? l.count : s.count;
  return keep({ ...pick, best: Math.max(l.best, s.best, pickedCount) });
}

// ── Collections (tableaux d'éléments identifiés) ──

function baseIdOf(item: unknown, idPaths: readonly string[]): string {
  const parts = idPaths.map((p) => readPath(item, p));
  if (parts.every((p) => p === undefined || p === null || p === '')) {
    return `json:${stableStringify(item)}`;
  }
  return parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('|');
}

/** Identifiants des éléments d'un tableau, doublons numérotés (`id#2`) pour ne rien fusionner à tort. */
function indexById(items: readonly unknown[], idPaths: readonly string[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const seen = new Map<string, number>();
  for (const item of items) {
    const base = baseIdOf(item, idPaths);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base}#${n}`, item);
  }
  return out;
}

/** Identifiant d'un élément de collection selon la spécification (sans numéro de doublon). */
export function collectionItemId(item: unknown, idPaths: readonly string[]): string {
  return baseIdOf(item, idPaths);
}

function compareField(field: string, dir: 'asc' | 'desc') {
  return (x: unknown, y: unknown): number => {
    const a = readPath(x, field);
    const b = readPath(y, field);
    const sa = a === undefined || a === null ? '' : String(a);
    const sb = b === undefined || b === null ? '' : String(b);
    const c = sa < sb ? -1 : sa > sb ? 1 : 0;
    return dir === 'asc' ? c : -c;
  };
}

type Presence = 'keep-local' | 'keep-server' | 'drop';

/** Élément présent d'un seul côté : ajout, ou suppression de l'autre côté ? */
function decideSingleSide(
  side: 'local' | 'server',
  id: string,
  item: unknown,
  ancItem: unknown,
  ancestry: { readonly known: boolean; readonly keyAbsent: boolean },
  stampField: string | null,
  ctx: MergeContext,
): Presence {
  const keepIt: Presence = side === 'local' ? 'keep-local' : 'keep-server';
  const baseId = id.replace(/#\d+$/, '');
  if (ancestry.known) {
    // Ajout de ce côté. Exception : clé ABSENTE de l'ancêtre (l'appareil n'a jamais vu
    // la collection du serveur : nouvel appareil, données effacées puis réécrites) et
    // élément marqué supprimé ailleurs → la suppression est respectée.
    if (ancItem === undefined) {
      return ancestry.keyAbsent && isTombstoned(baseId, item, stampField, ctx.tombstones)
        ? 'drop'
        : keepIt;
    }
    // Présent dans l'ancêtre, retiré de l'autre côté : suppression respectée,
    // sauf si ce côté l'a modifié entre-temps (une modification l'emporte sur une suppression).
    return jsonEqual(item, ancItem) ? 'drop' : keepIt;
  }
  return isTombstoned(baseId, item, stampField, ctx.tombstones) ? 'drop' : keepIt;
}

function mergeCollection(
  spec: Extract<MergeSpec, { kind: 'collection' }>,
  local: unknown,
  server: unknown,
  anc: MergeAncestor,
  ctx: MergeContext,
): MergeOutcome {
  if (!Array.isArray(local) || !Array.isArray(server)) return mergeLww(local, server, anc, ctx);
  if (jsonEqual(local, server)) return keep(local);
  const stampField = spec.stamp ?? 'updatedAt';
  const L = indexById(local, spec.id);
  const S = indexById(server, spec.id);
  const ancKnown = anc.known;
  const A = anc.known && Array.isArray(anc.value) ? indexById(anc.value, spec.id) : new Map();
  const ancestry = { known: ancKnown, keyAbsent: anc.known && anc.value === undefined };

  const outcomes: MergeOutcome[] = [];
  const out: unknown[] = [];
  const itemCtx: MergeContext = { tiebreak: ctx.tiebreak, tombstones: null };
  const itemSpec: MergeSpec = { kind: 'newest', stamp: stampField };

  for (const [id, sItem] of S) {
    if (L.has(id)) {
      const lItem = L.get(id);
      const ancItem: MergeAncestor = ancKnown
        ? { known: true, value: A.get(id) }
        : UNKNOWN_ANCESTOR;
      const o = mergeValues(itemSpec, lItem, sItem, ancItem, itemCtx);
      outcomes.push(o);
      out.push(o.value);
    } else {
      const d = decideSingleSide('server', id, sItem, A.get(id), ancestry, stampField, ctx);
      if (d !== 'drop') out.push(sItem);
    }
  }
  for (const [id, lItem] of L) {
    if (S.has(id)) continue;
    const d = decideSingleSide('local', id, lItem, A.get(id), ancestry, stampField, ctx);
    if (d !== 'drop') out.push(lItem);
  }
  if (spec.sort) out.sort(compareField(spec.sort.field, spec.sort.dir));
  return combine(out, outcomes);
}

// ── Objets indexés ──

function mergeMap(
  entry: MergeSpec,
  local: unknown,
  server: unknown,
  anc: MergeAncestor,
  ctx: MergeContext,
): MergeOutcome {
  if (!isPlainObject(local) || !isPlainObject(server)) return mergeLww(local, server, anc, ctx);
  if (jsonEqual(local, server)) return keep(local);
  const ancObj: JsonObject | null = anc.known ? (isPlainObject(anc.value) ? anc.value : {}) : null;
  const entryCtx: MergeContext = { tiebreak: ctx.tiebreak, tombstones: null };
  const ancestry = { known: ancObj !== null, keyAbsent: anc.known && anc.value === undefined };
  const stampField = entry.kind === 'newest' ? entry.stamp : null;
  const out: JsonObject = {};
  const outcomes: MergeOutcome[] = [];
  const keys = [...Object.keys(server), ...Object.keys(local).filter((k) => !(k in server))];
  for (const k of keys) {
    const lv = local[k];
    const sv = server[k];
    if (lv === undefined && sv === undefined) continue;
    if (lv !== undefined && sv !== undefined) {
      const o = mergeValues(entry, lv, sv, childAncestor(ancObj, k), entryCtx);
      outcomes.push(o);
      if (o.value !== undefined) out[k] = o.value;
      continue;
    }
    const side = lv !== undefined ? 'local' : 'server';
    const item = lv !== undefined ? lv : sv;
    const d = decideSingleSide(side, k, item, ancObj?.[k], ancestry, stampField, ctx);
    if (d !== 'drop') out[k] = item;
  }
  return combine(out, outcomes);
}

function mergeComposite(
  spec: Extract<MergeSpec, { kind: 'composite' }>,
  local: unknown,
  server: unknown,
  anc: MergeAncestor,
  ctx: MergeContext,
): MergeOutcome {
  if (!isPlainObject(local) || !isPlainObject(server)) return mergeLww(local, server, anc, ctx);
  const ancObj: JsonObject | null = anc.known ? (isPlainObject(anc.value) ? anc.value : {}) : null;
  const partNames = Object.keys(spec.parts);
  const strip = (o: JsonObject): JsonObject =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !partNames.includes(k)));
  const rest = mergeMap(
    { kind: 'lww' },
    strip(local),
    strip(server),
    ancObj ? knownAncestor(strip(ancObj)) : UNKNOWN_ANCESTOR,
    ctx,
  );
  const out: JsonObject = { ...(rest.value as JsonObject) };
  const outcomes: MergeOutcome[] = [rest];
  for (const name of partNames) {
    const partSpec = spec.parts[name];
    if (!partSpec) continue;
    const lv = local[name];
    const sv = server[name];
    if (lv === undefined && sv === undefined) continue;
    if (lv === undefined || sv === undefined) {
      out[name] = lv !== undefined ? lv : sv;
      continue;
    }
    const prefix = `${name}:`;
    const tombstones = ctx.tombstones
      ? Object.fromEntries(
          Object.entries(ctx.tombstones)
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => [k.slice(prefix.length), v]),
        )
      : null;
    const o = mergeValues(partSpec, lv, sv, childAncestor(ancObj, name), {
      tiebreak: ctx.tiebreak,
      tombstones,
    });
    outcomes.push(o);
    out[name] = o.value;
  }
  return combine(out, outcomes);
}

// ─── Point d'entrée ───────────────────────────────────────────────────────────

/**
 * Fusionne deux valeurs **vivantes** (non supprimées) d'une même clé.
 * Pur, déterministe, sans exception : une valeur de forme inattendue retombe sur `lww`.
 */
export function mergeValues(
  spec: MergeSpec,
  local: unknown,
  server: unknown,
  ancestor: MergeAncestor,
  ctx: MergeContext,
): MergeOutcome {
  switch (spec.kind) {
    case 'lww':
    case 'keep-both':
      return mergeLww(local, server, ancestor, ctx);
    case 'max':
      return mergeMax(local, server, ancestor, ctx);
    case 'counter':
      return mergeCounter(spec, local, server, ancestor, ctx);
    case 'set':
      return mergeSet(local, server, ancestor, ctx);
    case 'multiset':
      return mergeMultiset(local, server, ancestor, ctx);
    case 'newest':
      return mergeNewest(spec, local, server, ancestor, ctx);
    case 'streak':
      return mergeStreak(local, server, ancestor, ctx);
    case 'collection':
      return mergeCollection(spec, local, server, ancestor, ctx);
    case 'map':
      return mergeMap(spec.entry, local, server, ancestor, ctx);
    case 'fields':
      return mergeMap({ kind: 'lww' }, local, server, ancestor, ctx);
    case 'composite':
      return mergeComposite(spec, local, server, ancestor, ctx);
  }
}
