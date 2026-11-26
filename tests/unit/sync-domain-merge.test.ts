/**
 * Fusion par domaine (packages/core/src/sync/domain-merge.ts, merge-strategies.ts).
 * Scénarios métier : docs/architecture/sync.md « Fusion par domaine ».
 */
import { describe, it, expect } from 'vitest';
import {
  STORAGE_KEYS,
  SYNC_MERGE_RULES,
  domainMergeRegistry,
  resolveSyncConflict,
  mergeRuleForKey,
  strategyNameForKey,
  isDeviceLocalKey,
  planGuestMerge,
  itemTombstoneKey,
  isItemTombstoneKey,
  collectionKeyOfTombstoneKey,
  mergeItemTombstoneMaps,
  withItemDeletions,
  pruneItemTombstones,
  deleteCollectionItems,
  itemIdFor,
  stampUpdatedAt,
  conflictCopyId,
  asItemTombstones,
} from '@kinetic/core';
import type { ConflictInput, SyncKeyState, ConflictResolution } from '@kinetic/core';

const NOW = '2026-11-25T10:15:30.123Z';
const alive = (value: unknown): SyncKeyState => ({ deleted: false, value });
const DEL: SyncKeyState = { deleted: true };

function resolve(
  key: string,
  local: SyncKeyState,
  server: SyncKeyState,
  extra: Partial<Pick<ConflictInput, 'ancestor' | 'itemTombstones' | 'pending'>> = {},
): ConflictResolution {
  return resolveSyncConflict(domainMergeRegistry, {
    key,
    local,
    server,
    serverVersion: '2026-11-25T10:00:00.000000Z',
    pending: extra.pending ?? { op: local.deleted ? 'delete' : 'set', seed: false, origin: 'app' },
    now: NOW,
    ...(extra.ancestor !== undefined ? { ancestor: extra.ancestor } : {}),
    ...(extra.itemTombstones !== undefined ? { itemTombstones: extra.itemTombstones } : {}),
  });
}

const valueOf = (r: ConflictResolution): unknown => (r.result.deleted ? undefined : r.result.value);

// ─── Registre ────────────────────────────────────────────────────────────────

describe('registre de fusion', () => {
  it('chaque clé exacte du registre existe dans STORAGE_KEYS', () => {
    const values = new Set(Object.values(STORAGE_KEYS).filter((v) => typeof v === 'string'));
    for (const rule of SYNC_MERGE_RULES) {
      if (rule.exact !== undefined) expect(values.has(rule.exact as never)).toBe(true);
      expect(rule.why.length).toBeGreaterThan(5);
    }
  });

  it('associe les bonnes stratégies aux clés du domaine', () => {
    expect(strategyNameForKey(STORAGE_KEYS.TRAINING_SESSION('abc'))).toBe('keep-both');
    expect(strategyNameForKey(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toBe('collection');
    expect(strategyNameForKey(STORAGE_KEYS.NUTRITION_LOG('2026-11-25'))).toBe('collection');
    expect(strategyNameForKey(STORAGE_KEYS.VITALITE_DONE('2026-11-25'))).toBe('set');
    expect(strategyNameForKey(STORAGE_KEYS.XP)).toBe('counter');
    // `kinetic:xp` ne doit pas capturer `kinetic:xp:earned:*` (règles exactes ≠ préfixes).
    expect(mergeRuleForKey(STORAGE_KEYS.XP_EARNED('2026-11-25')).prefix).toBe(
      STORAGE_KEYS.XP_EARNED_PREFIX,
    );
    expect(strategyNameForKey(STORAGE_KEYS.STREAK)).toBe('streak');
    expect(strategyNameForKey(STORAGE_KEYS.WELLNESS_CHECKINS)).toBe('map');
    expect(strategyNameForKey(STORAGE_KEYS.USER_PROFILE)).toBe('fields');
    expect(strategyNameForKey(STORAGE_KEYS.CHALLENGES)).toBe('composite');
    expect(strategyNameForKey(itemTombstoneKey(STORAGE_KEYS.BODYWEIGHT_ENTRIES))).toBe('map');
    expect(strategyNameForKey('kinetic:inconnue')).toBe('lww');
  });

  it('les clés propres à l’appareil sont signalées', () => {
    expect(isDeviceLocalKey(STORAGE_KEYS.TRAINING_ACTIVE_SESSION)).toBe(true);
    expect(isDeviceLocalKey(STORAGE_KEYS.PENDING_TASK_MUTATION)).toBe(true);
    expect(isDeviceLocalKey(STORAGE_KEYS.SYNC_OUTBOX)).toBe(true);
    expect(isDeviceLocalKey(STORAGE_KEYS.SCHEMA_VERSION)).toBe(true);
    expect(isDeviceLocalKey(STORAGE_KEYS.XP)).toBe(false);
    expect(isDeviceLocalKey(STORAGE_KEYS.TRAINING_SESSION('x'))).toBe(false);
  });
});

// ─── Règles communes ─────────────────────────────────────────────────────────

describe('règles communes de résolution', () => {
  it('états identiques : le serveur est gardé, rien à pousser', () => {
    const r = resolve(STORAGE_KEYS.XP, alive({ xp: 5 }), alive({ xp: 5 }));
    expect(r.push).toBe(false);
    expect(r.result).toEqual(alive({ xp: 5 }));
  });

  it('entrée seed : le serveur gagne sans copie', () => {
    const r = resolve(
      STORAGE_KEYS.TRAINING_TEMPLATES,
      alive([{ id: 'default' }]),
      alive([{ id: 'mine' }]),
      {
        pending: { op: 'set', seed: true, origin: 'app' },
      },
    );
    expect(r.push).toBe(false);
    expect(r.result).toEqual(alive([{ id: 'mine' }]));
    expect(r.recovery ?? []).toHaveLength(0);
  });

  it('suppression locale contre modification serveur (hors séance) : suppression poussée, serveur mis de côté', () => {
    const r = resolve(STORAGE_KEYS.NUTRITION_PLAN, DEL, alive({ kcal: 2500 }));
    expect(r.result).toEqual(DEL);
    expect(r.push).toBe(true);
    expect(r.recovery).toEqual([{ value: { kcal: 2500 }, reason: 'conflict' }]);
  });

  it('suppression locale, serveur inchangé depuis l’ancêtre : pas de copie', () => {
    const r = resolve(STORAGE_KEYS.NUTRITION_PLAN, DEL, alive({ kcal: 2500 }), {
      ancestor: alive({ kcal: 2500 }),
    });
    expect(r).toEqual({ result: DEL, push: true });
  });

  it('modification locale contre suppression serveur : la modification est recréée', () => {
    const r = resolve(STORAGE_KEYS.BODYWEIGHT_ENTRIES, alive([{ date: 'd1', weight: 80 }]), DEL);
    expect(r.push).toBe(true);
    expect(valueOf(r)).toEqual([{ date: 'd1', weight: 80 }]);
  });

  it('valeur locale inchangée depuis l’ancêtre et suppression serveur : la suppression s’applique', () => {
    const v = [{ date: 'd1', weight: 80 }];
    const r = resolve(STORAGE_KEYS.BODYWEIGHT_ENTRIES, alive(v), DEL, { ancestor: alive(v) });
    expect(r).toEqual({ result: DEL, push: false });
  });

  it('lww sans ancêtre : le local est repoussé, la valeur serveur est mise de côté', () => {
    const r = resolve(STORAGE_KEYS.PROGRAM_ACTIVE, alive({ id: 'A' }), alive({ id: 'B' }));
    expect(r.push).toBe(true);
    expect(valueOf(r)).toEqual({ id: 'A' });
    expect(r.recovery).toEqual([{ value: { id: 'B' }, reason: 'conflict' }]);
  });

  it('lww avec ancêtre : seul le côté qui a changé gagne, sans copie', () => {
    const r = resolve(STORAGE_KEYS.PROGRAM_ACTIVE, alive({ id: 'A' }), alive({ id: 'B' }), {
      ancestor: alive({ id: 'A' }),
    });
    expect(r).toEqual({ result: alive({ id: 'B' }), push: false });
  });

  it('valeur JSON null vivante distincte d’une suppression', () => {
    const r = resolve(STORAGE_KEYS.BODYWEIGHT_GOAL, alive(null), DEL);
    expect(r.result).toEqual(alive(null));
    expect(r.push).toBe(true);
  });
});

// ─── Séances : keep-both ─────────────────────────────────────────────────────

describe('séances (keep-both) : une séance ne disparaît jamais', () => {
  const key = STORAGE_KEYS.TRAINING_SESSION('s1');
  const sLocal = {
    id: 's1',
    name: 'Push',
    startedAt: 't0',
    entries: [{ exerciseId: 'bench', sets: [1] }],
  };
  const sServer = {
    id: 's1',
    name: 'Push',
    startedAt: 't0',
    entries: [{ exerciseId: 'bench', sets: [2] }],
  };

  it('modifiée des deux côtés : serveur appliqué + copie locale « (conflit) »', () => {
    const r = resolve(key, alive(sLocal), alive(sServer));
    expect(r.result).toEqual(alive(sServer));
    expect(r.push).toBe(false);
    const copyId = conflictCopyId('s1', NOW);
    expect(copyId).toBe('s1-c20261125101530123');
    expect(r.extraWrites).toEqual([
      {
        key: STORAGE_KEYS.TRAINING_SESSION(copyId),
        value: { ...sLocal, id: copyId, name: 'Push (conflit)' },
      },
    ]);
    expect(r.notice).toContain('les deux versions ont été conservées');
  });

  it('le suffixe « (conflit) » n’est pas répété', () => {
    const r = resolve(key, alive({ ...sLocal, name: 'Push (conflit)' }), alive(sServer));
    expect((r.extraWrites?.[0]?.value as { name: string }).name).toBe('Push (conflit)');
  });

  it('ancêtre connu : seul le côté modifié gagne, pas de copie', () => {
    expect(resolve(key, alive(sLocal), alive(sServer), { ancestor: alive(sLocal) })).toEqual({
      result: alive(sServer),
      push: false,
    });
    expect(resolve(key, alive(sLocal), alive(sServer), { ancestor: alive(sServer) })).toEqual({
      result: alive(sLocal),
      push: true,
    });
  });

  it('suppression locale contre modification distante : la séance est conservée', () => {
    const r = resolve(key, DEL, alive(sServer));
    expect(r.result).toEqual(alive(sServer));
    expect(r.push).toBe(false);
    expect(r.notice).toContain('conservée');
  });

  it('suppression locale d’une séance non modifiée ailleurs : la suppression part', () => {
    expect(resolve(key, DEL, alive(sServer), { ancestor: alive(sServer) })).toEqual({
      result: DEL,
      push: true,
    });
  });

  it('supprimée ailleurs, modifiée ici : la version locale est recréée', () => {
    const r = resolve(key, alive(sLocal), DEL);
    expect(r.result).toEqual(alive(sLocal));
    expect(r.push).toBe(true);
    expect(r.notice).toContain('a été conservée');
  });

  it('valeur de forme inattendue : copiée telle quelle', () => {
    const r = resolve(key, alive('brut'), alive(sServer));
    expect(r.extraWrites?.[0]).toEqual({
      key: STORAGE_KEYS.TRAINING_SESSION('s1-c20261125101530123'),
      value: 'brut',
    });
  });
});

// ─── Collections ─────────────────────────────────────────────────────────────

describe('collections (union par identifiant)', () => {
  it('F9 : objectifs ajoutés sur deux appareils → les deux sont gardés', () => {
    const g0 = { id: 'g0', exerciseId: 'squat', targetKg: 100 };
    const g1 = { id: 'g1', exerciseId: 'bench', targetKg: 80 };
    const g2 = { id: 'g2', exerciseId: 'dead', targetKg: 150 };
    const r = resolve(STORAGE_KEYS.STRENGTH_GOALS, alive([g0, g1]), alive([g0, g2]), {
      ancestor: alive([g0]),
    });
    expect(r.push).toBe(true);
    expect(valueOf(r)).toEqual([g0, g2, g1]);
    expect(r.recovery).toBeUndefined();
  });

  it('F3b : 300 pesées cloud + 1 pesée locale → 301 pesées triées', () => {
    const cloud = Array.from({ length: 300 }, (_, i) => ({
      date: `2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      weight: 80 + (i % 5),
    }));
    const local = [{ date: '2026-11-25', weight: 79 }];
    const r = resolve(STORAGE_KEYS.BODYWEIGHT_ENTRIES, alive(local), alive(cloud), {
      ancestor: DEL,
    });
    const out = valueOf(r) as Array<{ date: string }>;
    expect(out).toHaveLength(301);
    expect(out.at(-1)).toEqual(local[0]);
    expect([...out].sort((a, b) => a.date.localeCompare(b.date))).toEqual(out);
  });

  it('même id modifié des deux côtés : updatedAt le plus récent gagne, sans copie', () => {
    const a = { id: 't1', name: 'Local', updatedAt: '2026-11-25T09:00:00Z' };
    const b = { id: 't1', name: 'Serveur', updatedAt: '2026-11-25T10:00:00Z' };
    const r = resolve(STORAGE_KEYS.TRAINING_TEMPLATES, alive([a]), alive([b]));
    expect(r).toEqual({ result: alive([b]), push: false });
  });

  it('même id sans date : le local gagne et la valeur serveur est mise de côté', () => {
    const a = { id: 't1', name: 'Local' };
    const b = { id: 't1', name: 'Serveur' };
    const r = resolve(STORAGE_KEYS.TRAINING_TEMPLATES, alive([a]), alive([b]));
    expect(valueOf(r)).toEqual([a]);
    expect(r.push).toBe(true);
    expect(r.recovery).toEqual([{ value: [b], reason: 'conflict' }]);
  });

  it('suppression locale (ancêtre connu) : l’élément ne ressuscite pas', () => {
    const e1 = { id: 'm1', date: '2026-01-01' };
    const e2 = { id: 'm2', date: '2026-02-01' };
    const e3 = { id: 'm3', date: '2026-03-01' };
    // Local a supprimé m1 ; le serveur a ajouté m3.
    const r = resolve(STORAGE_KEYS.MEASUREMENTS_ENTRIES, alive([e2]), alive([e1, e2, e3]), {
      ancestor: alive([e1, e2]),
    });
    expect(valueOf(r)).toEqual([e2, e3]);
  });

  it('suppression distante (ancêtre connu) : l’élément local non modifié est retiré', () => {
    const e1 = { id: 'm1', date: '2026-01-01' };
    const e2 = { id: 'm2', date: '2026-02-01' };
    const e4 = { id: 'm4', date: '2026-04-01' };
    const r = resolve(STORAGE_KEYS.MEASUREMENTS_ENTRIES, alive([e1, e2, e4]), alive([e2]), {
      ancestor: alive([e1, e2]),
    });
    expect(valueOf(r)).toEqual([e2, e4]);
  });

  it('suppression distante d’un élément modifié localement : la modification l’emporte', () => {
    const e1 = { id: 'm1', date: '2026-01-01', waist: 80 };
    const e1b = { ...e1, waist: 79 };
    const r = resolve(STORAGE_KEYS.MEASUREMENTS_ENTRIES, alive([e1b]), alive([]), {
      ancestor: alive([e1]),
    });
    expect(valueOf(r)).toEqual([e1b]);
  });

  it('sans ancêtre : les suppressions d’éléments (clé sœur) empêchent la résurrection', () => {
    const p1 = { date: '2026-11-01', weight: 80 };
    const p2 = { date: '2026-11-02', weight: 81 };
    // B a supprimé la pesée du 01 (tombstone), A (legacy, ancêtre inconnu) l'a encore.
    const r = resolve(STORAGE_KEYS.BODYWEIGHT_ENTRIES, alive([p1, p2]), alive([p2]), {
      itemTombstones: { '2026-11-01': '2026-11-20T00:00:00Z' },
    });
    expect(r).toEqual({ result: alive([p2]), push: false });
  });

  it('élément recréé après sa suppression (updatedAt plus récent) : conservé', () => {
    const p1 = stampUpdatedAt({ date: '2026-11-01', weight: 79 }, '2026-11-21T00:00:00Z');
    const r = resolve(STORAGE_KEYS.BODYWEIGHT_ENTRIES, alive([p1]), alive([]), {
      itemTombstones: { '2026-11-01': '2026-11-20T00:00:00Z' },
    });
    expect(valueOf(r)).toEqual([p1]);
  });

  it('clé jamais vue du serveur (ancêtre ABSENT, base nulle) : les suppressions d’éléments sont respectées', () => {
    // Nouvel appareil / données effacées puis réécrites : l'élément `a` vient d'une copie
    // locale périmée, il a été supprimé ailleurs (marque) → pas de résurrection.
    const r = resolve(
      STORAGE_KEYS.TRAINING_TEMPLATES,
      alive([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
      alive([{ id: 'b' }]),
      { ancestor: DEL, itemTombstones: { a: '2026-11-20T00:00:00Z' } },
    );
    expect(valueOf(r)).toEqual([{ id: 'b' }, { id: 'c' }]);
    // Sans marque : union (ajouts des deux côtés).
    const u = resolve(STORAGE_KEYS.TRAINING_TEMPLATES, alive([{ id: 'a' }]), alive([{ id: 'b' }]), {
      ancestor: DEL,
    });
    expect(valueOf(u)).toEqual([{ id: 'b' }, { id: 'a' }]);
  });

  it('ancêtre connu (vivant) : un élément ajouté localement n’est pas retiré par une vieille marque', () => {
    // Pesée du 01 supprimée puis ressaisie ici (sans updatedAt) après la base : c'est un ajout.
    const p1 = { date: '2026-11-01', weight: 79 };
    const p2 = { date: '2026-11-02', weight: 81 };
    const r = resolve(
      STORAGE_KEYS.BODYWEIGHT_ENTRIES,
      alive([p1, p2]),
      alive([p2, { date: '2026-11-03', weight: 80 }]),
      {
        ancestor: alive([p2]),
        itemTombstones: { '2026-11-01': '2026-11-20T00:00:00Z' },
      },
    );
    expect(valueOf(r)).toEqual([p1, p2, { date: '2026-11-03', weight: 80 }]);
  });

  it('sans ancêtre ni suppression : union (aucune perte)', () => {
    const r = resolve(STORAGE_KEYS.TIMER_PRESETS, alive([{ id: 'a' }]), alive([{ id: 'b' }]));
    expect(valueOf(r)).toEqual([{ id: 'b' }, { id: 'a' }]);
  });

  it('doublons d’identifiant conservés (aucune fusion à tort)', () => {
    const r = resolve(
      STORAGE_KEYS.BODYWEIGHT_ENTRIES,
      alive([
        { date: 'd', weight: 1 },
        { date: 'd', weight: 2 },
      ]),
      alive([{ date: 'd', weight: 1 }]),
      { ancestor: DEL },
    );
    expect(valueOf(r)).toEqual([
      { date: 'd', weight: 1 },
      { date: 'd', weight: 2 },
    ]);
  });

  it('éléments sans identifiant : identité = contenu', () => {
    const r = resolve(STORAGE_KEYS.TIMER_PRESETS, alive([{ name: 'x' }]), alive([{ name: 'y' }]), {
      ancestor: DEL,
    });
    expect(valueOf(r)).toEqual([{ name: 'y' }, { name: 'x' }]);
  });

  it('récents nutrition : identité = aliment, usage le plus récent, tri décroissant', () => {
    const food = { name: 'Riz', kcalPer100: 130, proteinPer100: 2, carbsPer100: 28, fatPer100: 0 };
    const l = [{ food, grams: 150, usedAt: '2026-11-25T08:00:00Z' }];
    const s = [
      { food, grams: 100, usedAt: '2026-11-24T08:00:00Z' },
      { food: { ...food, name: 'Pâtes' }, grams: 90, usedAt: '2026-11-24T09:00:00Z' },
    ];
    const r = resolve(STORAGE_KEYS.NUTRITION_RECENTS, alive(l), alive(s));
    expect(valueOf(r)).toEqual([l[0], s[1]]);
  });

  it('forme inattendue (pas un tableau) : repli lww avec copie', () => {
    const r = resolve(STORAGE_KEYS.TIMER_PRESETS, alive({ oops: 1 }), alive([{ id: 'a' }]));
    expect(valueOf(r)).toEqual({ oops: 1 });
    expect(r.recovery).toEqual([{ value: [{ id: 'a' }], reason: 'conflict' }]);
  });
});

// ─── Ensembles ───────────────────────────────────────────────────────────────

describe('ensembles', () => {
  const key = STORAGE_KEYS.VITALITE_DONE('2026-11-25');
  it('union sans ancêtre', () => {
    expect(valueOf(resolve(key, alive(['a', 'b']), alive(['c', 'a'])))).toEqual(['c', 'a', 'b']);
  });
  it('annulation locale (retrait) respectée avec ancêtre', () => {
    const r = resolve(key, alive(['a']), alive(['a', 'b', 'c']), { ancestor: alive(['a', 'b']) });
    expect(valueOf(r)).toEqual(['a', 'c']);
  });
  it('retrait distant respecté avec ancêtre', () => {
    const r = resolve(key, alive(['a', 'b', 'd']), alive(['a']), { ancestor: alive(['a', 'b']) });
    expect(valueOf(r)).toEqual(['a', 'd']);
  });
  it('retrait signalé par suppression d’élément (sans ancêtre)', () => {
    const r = resolve(STORAGE_KEYS.VITALITE_HIDDEN_TASKS, alive(['a', 'b']), alive(['a']), {
      itemTombstones: { b: '2026-11-20T00:00:00Z' },
    });
    expect(r).toEqual({ result: alive(['a']), push: false });
  });
  it('tableau mixte : repli lww', () => {
    const r = resolve(key, alive([{ x: 1 }]), alive(['a']));
    expect(valueOf(r)).toEqual([{ x: 1 }]);
  });
});

// ─── Compteurs, max, série ───────────────────────────────────────────────────

describe('compteurs et scalaires monotones', () => {
  it('XP : incréments concurrents additionnés avec ancêtre', () => {
    const r = resolve(STORAGE_KEYS.XP, alive({ xp: 110 }), alive({ xp: 120 }), {
      ancestor: alive({ xp: 100 }),
    });
    expect(valueOf(r)).toEqual({ xp: 130 });
  });
  it('XP : annulation locale (−10) appliquée au total serveur', () => {
    const r = resolve(STORAGE_KEYS.XP, alive({ xp: 90 }), alive({ xp: 120 }), {
      ancestor: alive({ xp: 100 }),
    });
    expect(valueOf(r)).toEqual({ xp: 110 });
  });
  it('XP : jamais négatif', () => {
    const r = resolve(STORAGE_KEYS.XP, alive({ xp: 0 }), alive({ xp: 5 }), {
      ancestor: alive({ xp: 50 }),
    });
    expect(valueOf(r)).toEqual({ xp: 0 });
  });
  it('XP sans ancêtre : max ; ancien format nombre accepté', () => {
    expect(valueOf(resolve(STORAGE_KEYS.XP, alive({ xp: 110 }), alive({ xp: 120 })))).toEqual({
      xp: 120,
    });
    expect(valueOf(resolve(STORAGE_KEYS.XP, alive(150), alive({ xp: 120 })))).toEqual({ xp: 150 });
  });
  it('XP du jour : même règle', () => {
    const r = resolve(STORAGE_KEYS.XP_EARNED('2026-11-25'), alive({ xp: 20 }), alive({ xp: 30 }), {
      ancestor: alive({ xp: 10 }),
    });
    expect(valueOf(r)).toEqual({ xp: 40 });
  });
  it('jetons de gel : delta avec ancêtre, sinon lww (pas de double dépense)', () => {
    expect(
      valueOf(
        resolve(STORAGE_KEYS.REWARDS_FREEZE_TOKENS, alive(1), alive(1), { ancestor: alive(2) }),
      ),
    ).toBe(1);
    const both = resolve(STORAGE_KEYS.REWARDS_FREEZE_TOKENS, alive(0), alive(2), {
      ancestor: alive(1),
    });
    expect(valueOf(both)).toBe(1);
    const noAnc = resolve(STORAGE_KEYS.REWARDS_FREEZE_TOKENS, alive(0), alive(2));
    expect(valueOf(noAnc)).toBe(0);
    expect(noAnc.recovery).toEqual([{ value: 2, reason: 'conflict' }]);
  });
  it('max sur dates ISO et nombres', () => {
    expect(
      valueOf(resolve(STORAGE_KEYS.VITALITE_LAST_RESET, alive('2026-11-24'), alive('2026-11-25'))),
    ).toBe('2026-11-25');
    expect(valueOf(resolve(STORAGE_KEYS.TRAINING_CATALOG_VERSION, alive(7), alive(5)))).toBe(7);
  });
  it('série : best = max, série courante la plus récente', () => {
    const l = { count: 3, best: 10, lastActiveDate: '2026-11-25' };
    const s = { count: 12, best: 12, lastActiveDate: '2026-11-20' };
    expect(valueOf(resolve(STORAGE_KEYS.STREAK, alive(l), alive(s)))).toEqual({
      count: 3,
      best: 12,
      lastActiveDate: '2026-11-25',
    });
    const same = resolve(
      STORAGE_KEYS.STREAK,
      alive({ count: 4, best: 4, lastActiveDate: '2026-11-25' }),
      alive({ count: 5, best: 5, lastActiveDate: '2026-11-25' }),
    );
    expect(valueOf(same)).toEqual({ count: 5, best: 5, lastActiveDate: '2026-11-25' });
  });
});

// ─── Objets indexés et réglages ──────────────────────────────────────────────

describe('objets indexés et réglages', () => {
  it('check-ins : jours des deux côtés, même jour → le plus récent (at)', () => {
    const l = {
      '2026-11-24': { date: '2026-11-24', energy: 3, at: '2026-11-24T08:00:00Z' },
      '2026-11-25': { date: '2026-11-25', energy: 5, at: '2026-11-25T09:00:00Z' },
    };
    const s = {
      '2026-11-23': { date: '2026-11-23', energy: 2, at: '2026-11-23T08:00:00Z' },
      '2026-11-25': { date: '2026-11-25', energy: 1, at: '2026-11-25T07:00:00Z' },
    };
    expect(valueOf(resolve(STORAGE_KEYS.WELLNESS_CHECKINS, alive(l), alive(s)))).toEqual({
      '2026-11-23': s['2026-11-23'],
      '2026-11-25': l['2026-11-25'],
      '2026-11-24': l['2026-11-24'],
    });
  });

  it('eau : verres ajoutés des deux côtés conservés (ancêtre)', () => {
    const r = resolve(
      STORAGE_KEYS.WELLNESS_WATER,
      alive({ d: [250, 250, 500] }),
      alive({ d: [250, 250, 330] }),
      { ancestor: alive({ d: [250, 250] }) },
    );
    expect(valueOf(r)).toEqual({ d: [250, 250, 330, 500] });
  });

  it('eau : verre retiré localement retiré du total', () => {
    const r = resolve(
      STORAGE_KEYS.WELLNESS_WATER,
      alive({ d: [250] }),
      alive({ d: [250, 250, 330] }),
      { ancestor: alive({ d: [250, 250] }) },
    );
    expect(valueOf(r)).toEqual({ d: [250, 330] });
  });

  it('eau sans ancêtre : la liste qui prolonge l’autre gagne', () => {
    const r = resolve(STORAGE_KEYS.WELLNESS_WATER, alive({ d: [250] }), alive({ d: [250, 250] }));
    expect(r).toEqual({ result: alive({ d: [250, 250] }), push: false });
    const r2 = resolve(STORAGE_KEYS.WELLNESS_WATER, alive({ d: [500] }), alive({ d: [250, 250] }));
    expect(valueOf(r2)).toEqual({ d: [250, 250] });
    expect(r2.recovery).toEqual([{ value: { d: [500] }, reason: 'conflict' }]);
  });

  it('alertes masquées : date maximale par exercice', () => {
    const r = resolve(
      STORAGE_KEYS.PLATEAU_DISMISSED,
      alive({ bench: '2026-12-01', squat: '2026-11-01' }),
      alive({ bench: '2026-11-15', dead: '2026-12-10' }),
    );
    expect(valueOf(r)).toEqual({ bench: '2026-12-01', dead: '2026-12-10', squat: '2026-11-01' });
  });

  it('profil : champ par champ avec ancêtre, sans copie', () => {
    const anc = { name: 'Léa', weightKg: 60, goal: 'force' };
    const r = resolve(
      STORAGE_KEYS.USER_PROFILE,
      alive({ ...anc, weightKg: 61 }),
      alive({ ...anc, goal: 'masse' }),
      { ancestor: alive(anc) },
    );
    expect(valueOf(r)).toEqual({ name: 'Léa', weightKg: 61, goal: 'masse' });
    expect(r.recovery).toBeUndefined();
  });

  it('profil sans ancêtre : champs locaux prioritaires, champs serveur seuls conservés, copie', () => {
    const r = resolve(
      STORAGE_KEYS.USER_PROFILE,
      alive({ name: 'Léa', weightKg: 61 }),
      alive({ name: 'Lea', heightCm: 170 }),
    );
    expect(valueOf(r)).toEqual({ name: 'Léa', heightCm: 170, weightKg: 61 });
    expect(r.recovery).toEqual([{ value: { name: 'Lea', heightCm: 170 }, reason: 'conflict' }]);
  });

  it('défis : acceptés et réussis fusionnés séparément', () => {
    const a1 = { id: 'c1', periodKey: '2026-11' };
    const a2 = { id: 'c2', periodKey: '2026-11' };
    const done1 = { id: 'c1', periodKey: '2026-10', completedAt: 'x' };
    const done2 = { id: 'c1', periodKey: '2026-11', completedAt: 'y' };
    const r = resolve(
      STORAGE_KEYS.CHALLENGES,
      alive({ accepted: [a1], completed: [done1] }),
      alive({ accepted: [a1, a2], completed: [done2] }),
    );
    expect(valueOf(r)).toEqual({ accepted: [a1, a2], completed: [done2, done1] });
  });

  it('défis : abandon (suppression d’élément accepted:<id>) respecté sans ancêtre', () => {
    const a1 = { id: 'c1' };
    const r = resolve(
      STORAGE_KEYS.CHALLENGES,
      alive({ accepted: [], completed: [] }),
      alive({ accepted: [a1], completed: [] }),
      { itemTombstones: { 'accepted:c1': '2026-11-20T00:00:00Z' } },
    );
    expect(valueOf(r)).toEqual({ accepted: [], completed: [] });
  });

  it('cartes de suppressions : union, date la plus récente', () => {
    const k = itemTombstoneKey(STORAGE_KEYS.BODYWEIGHT_ENTRIES);
    const r = resolve(
      k,
      alive({ a: '2026-01-02', b: '2026-01-01' }),
      alive({ a: '2026-01-01', c: 'x' }),
    );
    expect(valueOf(r)).toEqual({ a: '2026-01-02', c: 'x', b: '2026-01-01' });
  });
});

// ─── Liaison invité → compte ─────────────────────────────────────────────────

describe('liaison invité → compte (planGuestMerge)', () => {
  it('fusionne sans écraser le cloud : union, somme d’XP, réglages du compte', () => {
    const session = { id: 'g1', name: 'Jambes', entries: [] };
    const plan = planGuestMerge(
      [
        [STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ date: '2026-11-25', weight: 79 }]],
        [STORAGE_KEYS.XP, { xp: 50 }],
        [STORAGE_KEYS.USER_PROFILE, { name: 'Invité', heightCm: 180 }],
        [STORAGE_KEYS.TRAINING_SESSION('g1'), session],
        [STORAGE_KEYS.TRAINING_ACTIVE_SESSION, { draft: true }],
        [STORAGE_KEYS.PENDING_TASK_MUTATION, { kind: 'complete_task' }],
        [STORAGE_KEYS.THEME_MODE, 'light'],
      ],
      new Map<string, unknown>([
        [STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ date: '2026-11-01', weight: 80 }]],
        [STORAGE_KEYS.XP, { xp: 1000 }],
        [STORAGE_KEYS.USER_PROFILE, { name: 'Léa' }],
        [STORAGE_KEYS.THEME_MODE, 'dark'],
      ]),
      NOW,
    );
    expect(plan.writes).toEqual([
      {
        key: STORAGE_KEYS.BODYWEIGHT_ENTRIES,
        value: [
          { date: '2026-11-01', weight: 80 },
          { date: '2026-11-25', weight: 79 },
        ],
      },
      { key: STORAGE_KEYS.XP, value: { xp: 1050 } },
      { key: STORAGE_KEYS.USER_PROFILE, value: { name: 'Léa', heightCm: 180 } },
      { key: STORAGE_KEYS.TRAINING_SESSION('g1'), value: session },
    ]);
    expect(plan.skipped).toEqual([
      STORAGE_KEYS.TRAINING_ACTIVE_SESSION,
      STORAGE_KEYS.PENDING_TASK_MUTATION,
      STORAGE_KEYS.THEME_MODE,
    ]);
    expect(plan.extraWrites).toEqual([]);
  });

  it('séance de même id et contenu différent : copie « (cet appareil) », séance du compte intacte', () => {
    const key = STORAGE_KEYS.TRAINING_SESSION('s1');
    const plan = planGuestMerge(
      [[key, { id: 's1', name: 'Dos', entries: [1] }]],
      new Map([[key, { id: 's1', name: 'Dos', entries: [2] }]]),
      NOW,
    );
    expect(plan.writes).toEqual([]);
    expect(plan.extraWrites).toEqual([
      {
        key: STORAGE_KEYS.TRAINING_SESSION('s1-c20261125101530123'),
        value: { id: 's1-c20261125101530123', name: 'Dos (cet appareil)', entries: [1] },
      },
    ]);
    expect(plan.notices).toHaveLength(1);
  });

  it('données de démo exclues', () => {
    const plan = planGuestMerge(
      [
        [STORAGE_KEYS.DEMO_MANIFEST, [STORAGE_KEYS.BODYWEIGHT_ENTRIES]],
        [STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ date: 'd', weight: 1 }]],
        [STORAGE_KEYS.STRENGTH_GOALS, [{ id: 'g' }]],
      ],
      new Map(),
      NOW,
    );
    expect(plan.writes).toEqual([{ key: STORAGE_KEYS.STRENGTH_GOALS, value: [{ id: 'g' }] }]);
    expect(plan.skipped).toEqual([STORAGE_KEYS.DEMO_MANIFEST, STORAGE_KEYS.BODYWEIGHT_ENTRIES]);
  });
});

// ─── Helpers de suppression d'éléments ───────────────────────────────────────

describe('suppressions d’éléments (clé sœur)', () => {
  it('clé sœur et retour', () => {
    const k = itemTombstoneKey(STORAGE_KEYS.STRENGTH_GOALS);
    expect(k).toBe(STORAGE_KEYS.ITEM_TOMBSTONES(STORAGE_KEYS.STRENGTH_GOALS));
    expect(isItemTombstoneKey(k)).toBe(true);
    expect(collectionKeyOfTombstoneKey(k)).toBe(STORAGE_KEYS.STRENGTH_GOALS);
    expect(collectionKeyOfTombstoneKey(STORAGE_KEYS.XP)).toBeNull();
  });

  it('identifiant d’élément selon le domaine', () => {
    expect(itemIdFor(STORAGE_KEYS.BODYWEIGHT_ENTRIES, { date: 'd1', weight: 1 })).toBe('d1');
    expect(itemIdFor(STORAGE_KEYS.STRENGTH_GOALS, { id: 'g1' })).toBe('g1');
    expect(itemIdFor(STORAGE_KEYS.NUTRITION_FAVORITES, { name: 'Riz' })).toBe('Riz|');
    expect(itemIdFor(STORAGE_KEYS.VITALITE_HIDDEN_TASKS, 'water')).toBe('water');
    expect(itemIdFor(STORAGE_KEYS.CHALLENGES, { id: 'c1' }, 'accepted')).toBe('accepted:c1');
    expect(itemIdFor(STORAGE_KEYS.CHALLENGES, { id: 'c1', periodKey: 'p' }, 'completed')).toBe(
      'completed:c1|p',
    );
  });

  it('deleteCollectionItems : retire les éléments et prépare les deux écritures atomiques', () => {
    const items = [
      { date: 'd1', weight: 1 },
      { date: 'd2', weight: 2 },
    ];
    const out = deleteCollectionItems(STORAGE_KEYS.BODYWEIGHT_ENTRIES, items, ['d1'], null, NOW);
    expect(out.items).toEqual([{ date: 'd2', weight: 2 }]);
    expect(out.tombstones).toEqual({ d1: NOW });
    expect(out.writes).toEqual([
      { key: STORAGE_KEYS.BODYWEIGHT_ENTRIES, value: [{ date: 'd2', weight: 2 }] },
      { key: itemTombstoneKey(STORAGE_KEYS.BODYWEIGHT_ENTRIES), value: { d1: NOW } },
    ]);
  });

  it('fusion, ajout et purge des cartes', () => {
    expect(mergeItemTombstoneMaps({ a: '2', b: '1' }, { a: '1', c: '3', bad: 4 })).toEqual({
      a: '2',
      b: '1',
      c: '3',
    });
    expect(withItemDeletions({ a: '2026-01-01' }, ['a', 'b'], '2026-02-01')).toEqual({
      a: '2026-02-01',
      b: '2026-02-01',
    });
    expect(
      pruneItemTombstones({ old: '2026-01-01T00:00:00Z', recent: '2026-11-01T00:00:00Z' }, NOW),
    ).toEqual({ recent: '2026-11-01T00:00:00Z' });
    expect(asItemTombstones('x')).toEqual({});
  });
});
