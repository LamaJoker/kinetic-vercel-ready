/**
 * Propriétés des stratégies de fusion (tests générés, graine fixe : reproductibles).
 *
 * - idempotence : merge(a, a) = a ;
 * - commutativité quand elle est attendue (contenu des unions, max, compteurs, série) ;
 * - aucune perte d'élément : tout identifiant présent d'un côté est dans le résultat,
 *   sauf suppression explicite (ancêtre ou suppression d'élément) ;
 * - suppressions respectées : un élément supprimé d'un côté et inchangé de l'autre ne revient pas ;
 * - invariant de résolution : `push: false` ⇒ résultat = serveur ; aucune valeur serveur
 *   écrasée sans copie de récupération.
 */
import { describe, it, expect } from 'vitest';
import {
  STORAGE_KEYS,
  SYNC_MERGE_RULES,
  domainMergeRegistry,
  mergeValues,
  UNKNOWN_ANCESTOR,
  ABSENT_ANCESTOR,
  knownAncestor,
  sameKeyState,
  jsonEqual,
} from '@kinetic/core';
import type { MergeSpec, MergeAncestor, SyncKeyState, MergeContext } from '@kinetic/core';

// ─── Générateur pseudo-aléatoire (mulberry32) ───────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    bool: (p = 0.5) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
  };
}
type R = ReturnType<typeof rng>;

const RUNS = 300;
const LOCAL: MergeContext = { tiebreak: 'local', tombstones: null };

interface Item {
  id: string;
  v: number;
  updatedAt?: string;
}
const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function genItems(r: R): Item[] {
  const out: Item[] = [];
  for (const id of ids) {
    if (!r.bool(0.45)) continue;
    const it: Item = { id, v: r.int(3) };
    if (r.bool(0.5)) it.updatedAt = `2026-11-${String(10 + r.int(10)).padStart(2, '0')}T00:00:00Z`;
    out.push(it);
  }
  return out;
}

/** Modifie une liste : retire, ajoute, change des éléments. */
function mutate(r: R, base: readonly Item[]): Item[] {
  const out: Item[] = [];
  for (const it of base) {
    if (r.bool(0.2)) continue; // suppression
    if (r.bool(0.2)) out.push({ ...it, v: it.v + 10, updatedAt: '2026-11-25T00:00:00Z' });
    else out.push(it);
  }
  if (r.bool(0.5)) out.push({ id: `n${r.int(1000)}`, v: r.int(5) });
  return out;
}

const idSet = (xs: unknown): Set<string> => new Set((xs as Item[]).map((x) => x.id));
const COLLECTION: MergeSpec = { kind: 'collection', id: ['id'] };
const SORTED: MergeSpec = { kind: 'collection', id: ['id'], sort: { field: 'id', dir: 'asc' } };

// ─── Idempotence ────────────────────────────────────────────────────────────

describe('idempotence : merge(a, a) = a', () => {
  const specs: MergeSpec[] = [
    { kind: 'lww' },
    { kind: 'max' },
    { kind: 'counter', field: 'xp', fallback: 'max' },
    { kind: 'set' },
    { kind: 'multiset' },
    { kind: 'streak' },
    COLLECTION,
    SORTED,
    { kind: 'map', entry: { kind: 'max' } },
    { kind: 'fields' },
    { kind: 'composite', parts: { list: COLLECTION } },
  ];
  const samples = (r: R): unknown[] => [
    r.int(100),
    `2026-11-${10 + r.int(10)}`,
    { xp: r.int(100) },
    ids.filter(() => r.bool()),
    [250, 250, 500].filter(() => r.bool()),
    { count: r.int(5), best: 5 + r.int(5), lastActiveDate: '2026-11-25' },
    genItems(r),
    Object.fromEntries(ids.filter(() => r.bool()).map((k) => [k, `2026-11-${10 + r.int(10)}`])),
    { list: genItems(r), name: 'x' },
    null,
  ];
  it('pour toute stratégie, toute valeur et tout ancêtre', () => {
    const r = rng(1);
    for (let i = 0; i < RUNS / 5; i++) {
      for (const spec of specs) {
        for (const v of samples(r)) {
          const ancs: MergeAncestor[] = [
            UNKNOWN_ANCESTOR,
            ABSENT_ANCESTOR,
            knownAncestor(r.pick(samples(r))),
          ];
          for (const anc of ancs) {
            const out = mergeValues(spec, v, v, anc, LOCAL);
            expect(jsonEqual(out.value, v)).toBe(true);
            expect(out.discardedServer || out.discardedLocal).toBe(false);
          }
        }
      }
    }
  });

  it('résolution : états identiques → serveur, rien à pousser, pour toutes les clés', () => {
    const r = rng(2);
    const keys = registryKeys();
    for (let i = 0; i < RUNS; i++) {
      const key = r.pick(keys);
      const v = r.pick([genItems(r), { xp: r.int(9) }, ['a'], { a: 1 }, null, 3]);
      const res = resolve(key, { deleted: false, value: v }, { deleted: false, value: v });
      expect(res.push).toBe(false);
      expect(res.extraWrites ?? []).toHaveLength(0);
      expect(res.recovery ?? []).toHaveLength(0);
    }
  });
});

// ─── Commutativité ──────────────────────────────────────────────────────────

describe('commutativité', () => {
  it('collections : même ensemble d’identifiants quel que soit l’ordre (sans ancêtre)', () => {
    const r = rng(3);
    for (let i = 0; i < RUNS; i++) {
      const a = genItems(r);
      const b = genItems(r);
      const ab = mergeValues(COLLECTION, a, b, UNKNOWN_ANCESTOR, LOCAL).value;
      const ba = mergeValues(COLLECTION, b, a, UNKNOWN_ANCESTOR, LOCAL).value;
      expect(idSet(ab)).toEqual(idSet(ba));
    }
  });

  it('collections triées dont les éléments communs sont datés différemment : résultat identique', () => {
    const r = rng(4);
    for (let i = 0; i < RUNS; i++) {
      const a = genItems(r).map((x, k) => ({
        ...x,
        updatedAt: `2026-11-01T00:00:${String(k).padStart(2, '0')}Z`,
      }));
      const b = genItems(r).map((x, k) => ({
        ...x,
        updatedAt: `2026-11-02T00:00:${String(k).padStart(2, '0')}Z`,
      }));
      const ab = mergeValues(SORTED, a, b, UNKNOWN_ANCESTOR, LOCAL).value;
      const ba = mergeValues(SORTED, b, a, UNKNOWN_ANCESTOR, LOCAL).value;
      expect(ab).toEqual(ba);
    }
  });

  it('ensembles : même contenu', () => {
    const r = rng(5);
    for (let i = 0; i < RUNS; i++) {
      const a = ids.filter(() => r.bool());
      const b = ids.filter(() => r.bool());
      const ab = mergeValues({ kind: 'set' }, a, b, UNKNOWN_ANCESTOR, LOCAL).value as string[];
      const ba = mergeValues({ kind: 'set' }, b, a, UNKNOWN_ANCESTOR, LOCAL).value as string[];
      expect(new Set(ab)).toEqual(new Set(ba));
      expect(new Set(ab)).toEqual(new Set([...a, ...b]));
      expect(ab.length).toBe(new Set(ab).size);
    }
  });

  it('max, compteurs (avec et sans ancêtre), série, carte de max : valeur identique', () => {
    const r = rng(6);
    for (let i = 0; i < RUNS; i++) {
      const x = r.int(500);
      const y = r.int(500);
      const anc = knownAncestor({ xp: r.int(Math.min(x, y) + 1) });
      const counter: MergeSpec = { kind: 'counter', field: 'xp', fallback: 'max' };
      for (const a of [UNKNOWN_ANCESTOR, anc, ABSENT_ANCESTOR]) {
        expect(mergeValues(counter, { xp: x }, { xp: y }, a, LOCAL).value).toEqual(
          mergeValues(counter, { xp: y }, { xp: x }, a, LOCAL).value,
        );
      }
      expect(mergeValues({ kind: 'max' }, x, y, UNKNOWN_ANCESTOR, LOCAL).value).toBe(
        Math.max(x, y),
      );
      const s1 = {
        count: r.int(9),
        best: 9 + r.int(9),
        lastActiveDate: `2026-11-${10 + r.int(5)}`,
      };
      const s2 = {
        count: r.int(9),
        best: 9 + r.int(9),
        lastActiveDate: `2026-11-${10 + r.int(5)}`,
      };
      expect(mergeValues({ kind: 'streak' }, s1, s2, UNKNOWN_ANCESTOR, LOCAL).value).toEqual(
        mergeValues({ kind: 'streak' }, s2, s1, UNKNOWN_ANCESTOR, LOCAL).value,
      );
      const m1 = Object.fromEntries(
        ids.filter(() => r.bool()).map((k) => [k, `2026-${10 + r.int(3)}`]),
      );
      const m2 = Object.fromEntries(
        ids.filter(() => r.bool()).map((k) => [k, `2026-${10 + r.int(3)}`]),
      );
      const mm: MergeSpec = { kind: 'map', entry: { kind: 'max' } };
      const ab = mergeValues(mm, m1, m2, UNKNOWN_ANCESTOR, LOCAL).value;
      const ba = mergeValues(mm, m2, m1, UNKNOWN_ANCESTOR, LOCAL).value;
      expect(jsonEqual(ab, ba)).toBe(true);
    }
  });

  it('ensembles : associativité du contenu', () => {
    const r = rng(7);
    const SET: MergeSpec = { kind: 'set' };
    for (let i = 0; i < RUNS; i++) {
      const [a, b, c] = [0, 1, 2].map(() => ids.filter(() => r.bool()));
      const left = mergeValues(
        SET,
        mergeValues(SET, a, b, UNKNOWN_ANCESTOR, LOCAL).value,
        c,
        UNKNOWN_ANCESTOR,
        LOCAL,
      ).value;
      const right = mergeValues(
        SET,
        a,
        mergeValues(SET, b, c, UNKNOWN_ANCESTOR, LOCAL).value,
        UNKNOWN_ANCESTOR,
        LOCAL,
      ).value;
      expect(new Set(left as string[])).toEqual(new Set(right as string[]));
    }
  });
});

// ─── Aucune perte, suppressions respectées ──────────────────────────────────

describe('aucune perte d’élément et suppressions respectées', () => {
  it('sans ancêtre ni suppression : tout identifiant des deux côtés est conservé', () => {
    const r = rng(8);
    for (let i = 0; i < RUNS; i++) {
      const l = genItems(r);
      const s = genItems(r);
      const out = mergeValues(COLLECTION, l, s, UNKNOWN_ANCESTOR, LOCAL).value;
      expect(idSet(out)).toEqual(new Set([...idSet(l), ...idSet(s)]));
    }
  });

  it('deux appareils partent du même ancêtre : ajouts gardés, suppressions appliquées, modifications gardées', () => {
    const r = rng(9);
    for (let i = 0; i < RUNS; i++) {
      const anc = genItems(r);
      const l = mutate(r, anc);
      const s = mutate(r, anc);
      const out = mergeValues(COLLECTION, l, s, knownAncestor(anc), LOCAL).value as Item[];
      const outIds = idSet(out);
      const A = new Map(anc.map((x) => [x.id, x]));
      const L = new Map(l.map((x) => [x.id, x]));
      const S = new Map(s.map((x) => [x.id, x]));
      for (const id of new Set([...L.keys(), ...S.keys(), ...A.keys()])) {
        const a = A.get(id);
        const lv = L.get(id);
        const sv = S.get(id);
        const deletedLocally =
          a !== undefined && lv === undefined && (sv === undefined || jsonEqual(sv, a));
        const deletedRemotely =
          a !== undefined && sv === undefined && (lv === undefined || jsonEqual(lv, a));
        if (deletedLocally || deletedRemotely) {
          expect(outIds.has(id)).toBe(false); // jamais ressuscité
        } else if (lv !== undefined || sv !== undefined) {
          expect(outIds.has(id)).toBe(true); // jamais perdu
        }
        // Modifié d'un seul côté : la modification est gardée.
        if (a && lv && sv && jsonEqual(sv, a) && !jsonEqual(lv, a)) {
          expect(out.find((x) => x.id === id)).toEqual(lv);
        }
        if (a && lv && sv && jsonEqual(lv, a) && !jsonEqual(sv, a)) {
          expect(out.find((x) => x.id === id)).toEqual(sv);
        }
      }
      expect(out.length).toBe(outIds.size);
    }
  });

  it('suppressions d’éléments (sans ancêtre) : un élément supprimé non recréé ne revient pas', () => {
    const r = rng(10);
    for (let i = 0; i < RUNS; i++) {
      const l = genItems(r);
      const s = genItems(r);
      const tomb: Record<string, string> = {};
      for (const id of ids) if (r.bool(0.3)) tomb[id] = '2026-11-15T00:00:00Z';
      const out = mergeValues(COLLECTION, l, s, UNKNOWN_ANCESTOR, {
        tiebreak: 'local',
        tombstones: tomb,
      }).value as Item[];
      for (const it of out) {
        const inBoth = l.some((x) => x.id === it.id) && s.some((x) => x.id === it.id);
        if (tomb[it.id] && !inBoth) {
          // Survivant d'un seul côté : forcément recréé après la suppression.
          expect(it.updatedAt !== undefined && it.updatedAt > tomb[it.id]!).toBe(true);
        }
      }
      // Les éléments non supprimés ne sont jamais perdus.
      for (const it of [...l, ...s])
        if (!tomb[it.id]) expect(out.some((x) => x.id === it.id)).toBe(true);
    }
  });

  it('ensembles avec ancêtre : retraits appliqués, ajouts gardés', () => {
    const r = rng(11);
    for (let i = 0; i < RUNS; i++) {
      const a = ids.filter(() => r.bool());
      const l = [...a.filter(() => r.bool(0.8)), ...(r.bool() ? ['x1'] : [])];
      const s = [...a.filter(() => r.bool(0.8)), ...(r.bool() ? ['x2'] : [])];
      const out = new Set(
        mergeValues({ kind: 'set' }, l, s, knownAncestor(a), LOCAL).value as string[],
      );
      for (const v of new Set([...a, ...l, ...s])) {
        const removed = a.includes(v) && (!l.includes(v) || !s.includes(v));
        expect(out.has(v)).toBe(!removed);
      }
    }
  });

  it('compteur avec ancêtre : résultat = serveur + delta local (borné à 0)', () => {
    const r = rng(12);
    for (let i = 0; i < RUNS; i++) {
      const a = r.int(200);
      const l = Math.max(0, a + r.int(60) - 20);
      const s = Math.max(0, a + r.int(60) - 20);
      const out = mergeValues(
        { kind: 'counter', field: 'xp', fallback: 'max' },
        { xp: l },
        { xp: s },
        knownAncestor({ xp: a }),
        LOCAL,
      );
      // l = s : même état des deux côtés (ex. réponse perdue puis renvoi) → jamais compté deux fois.
      expect(out.value).toEqual({ xp: l === s ? l : Math.max(0, s + l - a) });
    }
  });
});

// ─── Invariants de résolution sur toutes les clés du registre ───────────────

function registryKeys(): string[] {
  const keys: string[] = [];
  for (const rule of SYNC_MERGE_RULES) {
    if (rule.scope !== 'synced') continue;
    if (rule.exact) keys.push(rule.exact);
    if (rule.prefix) keys.push(`${rule.prefix}x1`);
  }
  keys.push('kinetic:cle-inconnue', STORAGE_KEYS.TRAINING_SESSION('s1'));
  return keys;
}

function resolve(key: string, local: SyncKeyState, server: SyncKeyState, ancestor?: SyncKeyState) {
  return domainMergeRegistry.strategyFor(key).resolve({
    key,
    local,
    server,
    serverVersion: 'v',
    pending: { op: local.deleted ? 'delete' : 'set', seed: false, origin: 'app' },
    now: '2026-11-25T00:00:00Z',
    ...(ancestor ? { ancestor } : {}),
  });
}

function genState(r: R): SyncKeyState {
  if (r.bool(0.15)) return { deleted: true };
  return {
    deleted: false,
    value: r.pick<unknown>([
      genItems(r),
      { xp: r.int(50) },
      ids.filter(() => r.bool()),
      { a: r.int(3), b: r.int(3) },
      { count: r.int(5), best: 6, lastActiveDate: '2026-11-2' + r.int(9) },
      { accepted: genItems(r), completed: [] },
      { d: [250, 250].slice(r.int(2)) },
      r.int(9),
      null,
      'texte',
    ]),
  };
}

describe('invariants de résolution (toutes les clés du registre)', () => {
  it('push:false ⇒ résultat = serveur ; valeur serveur écrasée ⇒ copie ou ancêtre qui l’explique', () => {
    const r = rng(13);
    const keys = registryKeys();
    for (let i = 0; i < RUNS * 5; i++) {
      const key = r.pick(keys);
      const local = genState(r);
      const server = genState(r);
      const ancestor = r.bool() ? genState(r) : undefined;
      const res = resolve(key, local, server, ancestor);
      if (!res.push) expect(sameKeyState(res.result, server)).toBe(true);
      // Le résultat local n'est jamais « supprimé » si le local était vivant et que rien
      // (ancêtre identique) n'autorise la suppression.
      if (!local.deleted && res.result.deleted) {
        expect(ancestor && !ancestor.deleted && jsonEqual(ancestor.value, local.value)).toBe(true);
      }
      // Sans ancêtre, une stratégie lww qui écrase une valeur serveur vivante la met de côté.
      if (
        ancestor === undefined &&
        !server.deleted &&
        !local.deleted &&
        res.push &&
        !res.result.deleted &&
        jsonEqual(res.result.value, local.value) &&
        domainMergeRegistry.strategyFor(key).name === 'lww'
      ) {
        expect(res.recovery?.some((c) => jsonEqual(c.value, server.value))).toBe(true);
      }
    }
  });

  it('séances : jamais de perte (local conservé dans le résultat, une copie ou poussé)', () => {
    const r = rng(14);
    const key = STORAGE_KEYS.TRAINING_SESSION('s1');
    for (let i = 0; i < RUNS; i++) {
      const mk = () => ({ id: 's1', name: 'S', entries: [r.int(4)] });
      const local: SyncKeyState = r.bool(0.2) ? { deleted: true } : { deleted: false, value: mk() };
      const server: SyncKeyState = r.bool(0.2)
        ? { deleted: true }
        : { deleted: false, value: mk() };
      const ancestor: SyncKeyState | undefined = r.bool()
        ? { deleted: false, value: mk() }
        : undefined;
      const res = resolve(key, local, server, ancestor);
      if (!local.deleted) {
        const kept =
          (!res.result.deleted && jsonEqual(res.result.value, local.value)) ||
          (res.extraWrites ?? []).some((w) =>
            jsonEqual(
              (w.value as { entries: unknown }).entries,
              (local.value as { entries: unknown }).entries,
            ),
          ) ||
          (ancestor !== undefined && !ancestor.deleted && jsonEqual(ancestor.value, local.value));
        expect(kept).toBe(true);
      }
      if (!server.deleted && !res.result.deleted) {
        // La version serveur n'est remplacée que si elle n'avait pas changé depuis l'ancêtre.
        if (!jsonEqual(res.result.value, server.value)) {
          expect(ancestor && !ancestor.deleted && jsonEqual(ancestor.value, server.value)).toBe(
            true,
          );
        }
      }
    }
  });
});
