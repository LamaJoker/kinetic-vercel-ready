import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  loadExercises,
  saveExercises,
  loadTemplates,
  saveTemplates,
  loadSessions,
  saveSessions,
  saveSession,
  deleteSession,
  sessionStorageKey,
  foldLegacySessions,
} from '../../apps/web/src/lib/training/storage.js';
import { DEFAULT_EXERCISES, DEFAULT_TEMPLATES } from '../../apps/web/src/lib/training/seed.js';

describe('loadExercises', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns stored exercises when already populated', async () => {
    const exercises = [
      { id: 'test', name: 'Test', muscles: [], equipment: 'barbell' as const, incrementKg: 2.5 },
    ];
    await storage.set('kinetic:training:exercises', exercises);
    const result = await loadExercises(storage);
    expect(result).toEqual(exercises);
  });

  it('falls back to DEFAULT_EXERCISES when storage empty and fetch fails', async () => {
    const result = await loadExercises(storage);
    expect(result).toHaveLength(DEFAULT_EXERCISES.length);
    expect(result[0]!.id).toBe(DEFAULT_EXERCISES[0]!.id);
  });

  it('saves fetched exercises from /exercises.v1.json', async () => {
    const remoteExercises = [
      { id: 'remote', name: 'Remote Ex', muscles: ['back'], equipment: 'cable', incrementKg: 2.5 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => remoteExercises,
      }),
    );
    const result = await loadExercises(storage);
    expect(result[0]!.id).toBe('remote');
    // Should be persisted
    const stored = await storage.get('kinetic:training:exercises');
    expect(stored).toBeTruthy();
  });

  it('falls back to defaults if fetch returns empty array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }),
    );
    const result = await loadExercises(storage);
    expect(result.length).toBe(DEFAULT_EXERCISES.length);
  });

  it('falls back to defaults when fetch throws (catch noop path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await loadExercises(storage);
    expect(result).toHaveLength(DEFAULT_EXERCISES.length);
    expect(result[0]!.id).toBe(DEFAULT_EXERCISES[0]!.id);
  });

  it('uses fallback values for exercise fields missing in fetch response (covers lines 31-35)', async () => {
    // An exercise with missing optional fields: no muscles, no equipment, non-numeric incrementKg
    const sparseExercises = [{ id: 'sparse', name: 'Sparse Ex' }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => sparseExercises,
      }),
    );
    const result = await loadExercises(storage);
    expect(result).toHaveLength(1);
    const ex = result[0]!;
    expect(ex.muscles).toEqual([]); // Array.isArray false → []
    expect(ex.equipment).toBe('other'); // ?? 'other' fallback
    expect(ex.incrementKg).toBe(2.5); // !isFinite fallback
  });

  it('uses empty-string fallback when id and name are null (covers lines 31-32 ?? "" branches)', async () => {
    // null id/name hit the `?? ''` branches → both become '' → filtered out by x.id && x.name
    // A valid exercise in the same response must survive so normalized.length > 0
    const mixedExercises = [
      { id: null, name: null }, // ?? '' on lines 31-32 → filtered
      { id: 'valid', name: 'Valid Ex' }, // passes filter → returned
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => mixedExercises }),
    );
    const result = await loadExercises(storage);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('valid');
  });
});

describe('saveExercises', () => {
  it('persists exercises to storage', async () => {
    const storage = new InMemoryStorage();
    const ex = [
      {
        id: 'sq',
        name: 'Squat',
        muscles: ['quads'],
        equipment: 'barbell' as const,
        incrementKg: 2.5,
      },
    ];
    await saveExercises(storage, ex);
    const result = await storage.get('kinetic:training:exercises');
    expect(result).toEqual(ex);
  });
});

describe('loadTemplates', () => {
  it('returns stored templates when populated', async () => {
    const storage = new InMemoryStorage();
    const tpl = [{ id: 't1', name: 'Test', createdAt: '2026-01-01T00:00:00.000Z', exercises: [] }];
    await storage.set('kinetic:training:templates', tpl);
    const result = await loadTemplates(storage);
    expect(result).toEqual(tpl);
  });

  it('seeds DEFAULT_TEMPLATES when empty', async () => {
    const storage = new InMemoryStorage();
    const result = await loadTemplates(storage);
    expect(result.length).toBe(DEFAULT_TEMPLATES.length);
  });
});

describe('saveTemplates', () => {
  it('JSON round-trips templates before storing (removes Alpine proxies)', async () => {
    const storage = new InMemoryStorage();
    const tpl = [{ id: 't1', name: 'Push', createdAt: '2026-01-01T00:00:00.000Z', exercises: [] }];
    await saveTemplates(storage, tpl);
    const stored = await storage.get('kinetic:training:templates');
    expect(stored).toEqual(tpl);
  });
});

describe('loadSessions / saveSessions', () => {
  it('returns empty array when nothing stored', async () => {
    const storage = new InMemoryStorage();
    expect(await loadSessions(storage)).toEqual([]);
  });

  it('round-trips sessions', async () => {
    const storage = new InMemoryStorage();
    const sessions = [
      {
        id: 's1',
        name: 'Séance 1',
        startedAt: '2026-01-01T10:00:00.000Z',
        endedAt: '2026-01-01T11:00:00.000Z',
        entries: [],
      },
    ];
    await saveSessions(storage, sessions);
    const result = await loadSessions(storage);
    expect(result).toEqual(sessions);
  });
});

// ─── Séances : une clé par séance ────────────────────────────────────────────

describe('sessions — une clé par séance', () => {
  const mk = (id: string, startedAt: string) => ({ id, name: id, startedAt, entries: [] });

  it('saveSession écrit uniquement la clé de la séance', async () => {
    const storage = new InMemoryStorage();
    await saveSession(storage, mk('s1', '2026-01-01T00:00:00Z'));
    expect(await storage.keys()).toEqual(['kinetic:training:session:s1']);
  });

  it('loadSessions renvoie les séances triées par date de début', async () => {
    const storage = new InMemoryStorage();
    await saveSession(storage, mk('late', '2026-02-01T00:00:00Z'));
    await saveSession(storage, mk('early', '2026-01-01T00:00:00Z'));
    const sessions = await loadSessions(storage);
    expect(sessions.map((s) => s.id)).toEqual(['early', 'late']);
  });

  it('saveSessions ne supprime jamais les séances absentes de la liste', async () => {
    const storage = new InMemoryStorage();
    await saveSession(storage, mk('keep', '2026-01-01T00:00:00Z'));
    await saveSessions(storage, [mk('other', '2026-01-02T00:00:00Z')]);
    expect((await loadSessions(storage)).map((s) => s.id)).toEqual(['keep', 'other']);
  });

  it('deleteSession supprime la séance ciblée', async () => {
    const storage = new InMemoryStorage();
    await saveSession(storage, mk('a', '2026-01-01T00:00:00Z'));
    await saveSession(storage, mk('b', '2026-01-02T00:00:00Z'));
    await deleteSession(storage, 'a');
    expect((await loadSessions(storage)).map((s) => s.id)).toEqual(['b']);
  });

  it('assainit les ids non conformes au format de clé, sans collision', () => {
    const k1 = sessionStorageKey('strong/2026 01 01');
    const k2 = sessionStorageKey('strong_2026_01_01');
    expect(k1).toMatch(/^[a-zA-Z0-9:_-]{1,200}$/);
    expect(k1).not.toBe(k2);
  });

  it('dépasse largement l ancienne limite de 1 MB par valeur', async () => {
    const storage = new InMemoryStorage();
    const bigEntries = Array.from({ length: 30 }, (_, i) => ({
      exerciseId: `ex-${i}`,
      sets: Array.from({ length: 5 }, (_, j) => ({
        setIndex: j,
        reps: 8,
        weightKg: 100,
        rpe: 8,
        performedAt: '2026-01-01T00:00:00Z',
      })),
    }));
    for (let i = 0; i < 1500; i++) {
      const startedAt = `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`;
      await saveSession(storage, { ...mk(`s${i}`, startedAt), entries: bigEntries });
    }
    const oneSessionBytes = JSON.stringify(await storage.get('kinetic:training:session:s0')).length;
    // L'historique complet ferait ~1500 × taille d'une séance : bien au-delà de 1 MB…
    expect(oneSessionBytes * 1500).toBeGreaterThan(1_048_576);
    // …mais chaque valeur stockée reste minuscule.
    expect(oneSessionBytes).toBeLessThan(20_000);
    expect(await loadSessions(storage)).toHaveLength(1500);
  });

  it('foldLegacySessions est idempotent', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:training:sessions', [mk('x', '2026-01-01T00:00:00Z')]);
    expect(await foldLegacySessions(storage)).toBe(1);
    expect(await foldLegacySessions(storage)).toBe(0);
    expect((await loadSessions(storage)).map((s) => s.id)).toEqual(['x']);
  });
});
