/**
 * PERF-11 : loadSessions garde la dernière liste lue (une requête `keys()` au lieu d'une
 * requête par séance), et ne sert jamais une liste périmée : invalidée par
 * saveSession / deleteSession, par une séance ajoutée ou supprimée par un autre chemin,
 * et par la synchro (EVENT_SYNC_APPLIED).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';

// Écouteurs `window` réels (EventTarget) : l'événement de synchro passe vraiment.
const target = new EventTarget();
vi.stubGlobal('window', target);

const { loadSessions, saveSession, deleteSession, invalidateSessionsCache, syncTouchesSessions } =
  await import('../../apps/web/src/lib/training/storage.js');
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

function session(id: string, day: number, weightKg = 60): WorkoutSession {
  const at = new Date(Date.UTC(2026, 0, day)).toISOString();
  return {
    id,
    name: id,
    startedAt: at,
    endedAt: at,
    entries: [{ exerciseId: 'bench', sets: [{ setIndex: 0, weightKg, reps: 5, performedAt: at }] }],
  };
}

let storage: InMemoryStorage;
let gets: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  storage = new InMemoryStorage();
  for (let i = 1; i <= 30; i++) await saveSession(storage, session(`s${i}`, i));
  gets = vi.spyOn(storage, 'get');
});
afterEach(() => vi.restoreAllMocks());

const sessionReads = (): number =>
  gets.mock.calls.filter(([k]) => String(k).startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX))
    .length;

describe('loadSessions : cache (PERF-11)', () => {
  it('deuxième lecture sans relire chaque séance, résultat identique', async () => {
    const first = await loadSessions(storage);
    expect(sessionReads()).toBe(30);
    const second = await loadSessions(storage);
    expect(sessionReads()).toBe(30); // aucune lecture de plus
    expect(second).toEqual(first);
  });

  it('chaque appel reçoit sa propre copie (modifier sa liste ne touche pas le cache)', async () => {
    const a = await loadSessions(storage);
    a.pop();
    a[0]!.name = 'modifié';
    a[0]!.entries[0]!.sets[0]!.weightKg = 999;
    const b = await loadSessions(storage);
    expect(b).toHaveLength(30);
    expect(b[0]!.name).toBe('s1');
    expect(b[0]!.entries[0]!.sets[0]!.weightKg).toBe(60);
  });

  it('invalidé par saveSession (ajout ET modification d’une séance existante)', async () => {
    await loadSessions(storage);
    await saveSession(storage, session('s5', 5, 120));
    let list = await loadSessions(storage);
    expect(list.find((s) => s.id === 's5')!.entries[0]!.sets[0]!.weightKg).toBe(120);
    await saveSession(storage, session('s99', 99));
    list = await loadSessions(storage);
    expect(list.at(-1)!.id).toBe('s99');
  });

  it('invalidé par deleteSession', async () => {
    await loadSessions(storage);
    await deleteSession(storage, 's3');
    const list = await loadSessions(storage);
    expect(list.map((s) => s.id)).not.toContain('s3');
    expect(list).toHaveLength(29);
  });

  it('séance ajoutée ou supprimée sans passer par ce module (démo, import) : vue', async () => {
    await loadSessions(storage);
    await storage.set(STORAGE_KEYS.TRAINING_SESSION('direct'), session('direct', 40));
    expect((await loadSessions(storage)).at(-1)!.id).toBe('direct');
    await storage.remove(STORAGE_KEYS.TRAINING_SESSION('s1'));
    expect((await loadSessions(storage)).map((s) => s.id)).not.toContain('s1');
  });

  it('invalidé par la synchro (contenu remplacé, mêmes clés) via EVENT_SYNC_APPLIED', async () => {
    await loadSessions(storage);
    // La synchro réécrit une séance existante directement dans la base.
    await storage.set(STORAGE_KEYS.TRAINING_SESSION('s2'), session('s2', 2, 200));
    target.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_SYNC_APPLIED, {
        detail: { keys: [STORAGE_KEYS.TRAINING_SESSION('s2')], source: 'sync' },
      }),
    );
    const list = await loadSessions(storage);
    expect(list.find((s) => s.id === 's2')!.entries[0]!.sets[0]!.weightKg).toBe(200);
  });

  it('synchro sans rapport avec les séances : cache conservé', async () => {
    await loadSessions(storage);
    const reads = sessionReads();
    target.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_SYNC_APPLIED, { detail: { keys: [STORAGE_KEYS.XP] } }),
    );
    await loadSessions(storage);
    expect(sessionReads()).toBe(reads);
  });

  it('écriture pendant une lecture : la lecture en cours n’est pas gardée', async () => {
    const reading = loadSessions(storage);
    await saveSession(storage, session('s7', 7, 140));
    await reading;
    const list = await loadSessions(storage);
    expect(list.find((s) => s.id === 's7')!.entries[0]!.sets[0]!.weightKg).toBe(140);
  });

  it('invalidateSessionsCache : relecture complète', async () => {
    await loadSessions(storage);
    await storage.set(STORAGE_KEYS.TRAINING_SESSION('s4'), session('s4', 4, 80));
    invalidateSessionsCache(storage);
    const list = await loadSessions(storage);
    expect(list.find((s) => s.id === 's4')!.entries[0]!.sets[0]!.weightKg).toBe(80);
  });

  it('syncTouchesSessions : clés de séance, ancien tableau, liste vide (= tout)', () => {
    expect(syncTouchesSessions([STORAGE_KEYS.TRAINING_SESSION('x')])).toBe(true);
    expect(syncTouchesSessions([STORAGE_KEYS.TRAINING_SESSIONS])).toBe(true);
    expect(syncTouchesSessions([])).toBe(true);
    expect(syncTouchesSessions(undefined)).toBe(true);
    expect(syncTouchesSessions([STORAGE_KEYS.XP, STORAGE_KEYS.STREAK])).toBe(false);
  });
});
