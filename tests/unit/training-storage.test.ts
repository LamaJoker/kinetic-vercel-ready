import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  loadExercises,
  saveExercises,
  loadTemplates,
  saveTemplates,
  loadSessions,
  saveSessions,
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
