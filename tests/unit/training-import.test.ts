import { describe, it, expect, vi } from 'vitest';

// Capacitor only used by export; import.ts has zero Capacitor deps, but the
// storage helpers it imports do — stub them so we can run in Node.
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: vi.fn() },
  Directory: { Documents: 'DOCUMENTS' },
  Encoding: { UTF8: 'utf8' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }));

import {
  parseCsv,
  parseStrongCsv,
  parseHevyCsv,
  parseKineticJson,
  detectFormat,
  parseLocalDateTime,
  slugify,
  mergeIntoStorage,
} from '../../apps/web/src/lib/training/import.js';
import type { StoragePort } from '@kinetic/core';

// ─── Storage stub (mémoire) ─────────────────────────────────────────────────

function createMemoryStorage(): StoragePort {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (data.has(key) ? (data.get(key) as T) : null),
    set: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
    clear: async () => {
      data.clear();
    },
    keys: async () => [...data.keys()],
  } as unknown as StoragePort;
}

// ─── parseCsv ────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('handles basic comma-separated rows', () => {
    const rows = parseCsv('a,b,c\n1,2,3\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted cells with commas and escaped quotes', () => {
    const rows = parseCsv('name,note\n"Squat","Hello, ""world"""\n');
    expect(rows).toEqual([
      ['name', 'note'],
      ['Squat', 'Hello, "world"'],
    ]);
  });

  it('handles CRLF and missing trailing newline', () => {
    const rows = parseCsv('a,b\r\n1,2');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips BOM at start of content', () => {
    const rows = parseCsv('﻿a,b\n1,2');
    expect(rows[0]).toEqual(['a', 'b']);
  });
});

// ─── detectFormat ────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('detects JSON by leading brace', () => {
    expect(detectFormat('{"version":1}')).toBe('kinetic-json');
    expect(detectFormat('  \n[1,2,3]')).toBe('kinetic-json');
  });

  it('detects Hevy by header signature', () => {
    expect(detectFormat('title,start_time,exercise_title,set_index,weight_kg,reps\n')).toBe(
      'hevy-csv',
    );
  });

  it('defaults to Strong CSV otherwise', () => {
    expect(detectFormat('Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n')).toBe(
      'strong-csv',
    );
  });
});

// ─── parseLocalDateTime / slugify ────────────────────────────────────────────

describe('parseLocalDateTime', () => {
  it('parses "YYYY-MM-DD HH:MM:SS" as local time', () => {
    const iso = parseLocalDateTime('2025-12-01 18:32:48');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('parses date-only', () => {
    const iso = parseLocalDateTime('2025-12-01');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back gracefully on garbage', () => {
    const iso = parseLocalDateTime('not-a-date');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('slugify', () => {
  it('produces stable kebab-case ids', () => {
    expect(slugify('Bench Press (Barbell)')).toBe('bench-press-barbell');
    expect(slugify('Élévations latérales')).toBe('elevations-laterales');
  });
});

// ─── Strong CSV ──────────────────────────────────────────────────────────────

const STRONG_CSV = [
  'Date,Workout Name,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,Workout Duration,RPE',
  '"2025-12-01 18:32:48","Push","Bench Press (Barbell)",1,100,5,,,"","",1h 12m,8',
  '"2025-12-01 18:32:48","Push","Bench Press (Barbell)",2,100,5,,,"","",1h 12m,8.5',
  '"2025-12-01 18:32:48","Push","Overhead Press",1,50,8,,,"","",1h 12m,7',
  '"2025-12-02 17:00:00","Pull","Pull-up",1,0,10,,,"","",45m,8',
].join('\r\n');

describe('parseStrongCsv', () => {
  it('groups sets into sessions and entries', () => {
    const { bundle, skipped } = parseStrongCsv(STRONG_CSV);
    expect(skipped).toBe(0);
    expect(bundle.sessions).toHaveLength(2);
    const push = bundle.sessions.find((s) => s.name === 'Push')!;
    expect(push.entries).toHaveLength(2);
    const bench = push.entries.find((e) => e.exerciseId === 'bench-press-barbell')!;
    expect(bench.sets).toHaveLength(2);
    expect(bench.sets[0]!.reps).toBe(5);
    expect(bench.sets[0]!.weightKg).toBe(100);
  });

  it('auto-creates exercises with stable slugs', () => {
    const { bundle } = parseStrongCsv(STRONG_CSV);
    const ids = bundle.createdExercises.map((e) => e.id).sort();
    expect(ids).toEqual(['bench-press-barbell', 'overhead-press', 'pull-up']);
  });

  it('skips rows with missing reps', () => {
    const bad =
      'Date,Workout Name,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,Workout Duration,RPE\n' +
      '"2025-12-01 18:32:48","Push","Bench Press",1,100,,,,"","",1h,8\n';
    const { bundle, skipped } = parseStrongCsv(bad);
    expect(skipped).toBe(1);
    expect(bundle.sessions).toHaveLength(0);
  });

  it('clamps RPE within [6, 10]', () => {
    const csv =
      'Date,Workout Name,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,Workout Duration,RPE\n' +
      '"2025-12-01 18:32:48","Push","Bench",1,100,5,,,"","",1h,12\n';
    const { bundle } = parseStrongCsv(csv);
    expect(bundle.sessions[0]!.entries[0]!.sets[0]!.rpe).toBe(10);
  });
});

// ─── Hevy CSV ────────────────────────────────────────────────────────────────

const HEVY_CSV = [
  'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
  '"Push","2025-12-01 18:32:48","2025-12-01 19:44:48","","Bench Press (Barbell)",,"",0,normal,100,5,,,8',
  '"Push","2025-12-01 18:32:48","2025-12-01 19:44:48","","Bench Press (Barbell)",,"",1,normal,100,5,,,8.5',
].join('\n');

describe('parseHevyCsv', () => {
  it('groups sets and parses weight_kg + rpe', () => {
    const { bundle } = parseHevyCsv(HEVY_CSV);
    expect(bundle.sessions).toHaveLength(1);
    const entry = bundle.sessions[0]!.entries[0]!;
    expect(entry.sets).toHaveLength(2);
    expect(entry.sets[0]!.weightKg).toBe(100);
    expect(entry.sets[0]!.rpe).toBe(8);
  });
});

// ─── parseKineticJson ────────────────────────────────────────────────────────

describe('parseKineticJson', () => {
  it('extracts sessions and exercises, filtering invalid entries', () => {
    const payload = JSON.stringify({
      version: 1,
      sessions: [
        {
          id: 's1',
          name: 'Push',
          startedAt: '2025-12-01T10:00:00Z',
          entries: [],
        },
        { id: 'bad' }, // missing name + startedAt + entries → filtered
      ],
      exercises: [
        { id: 'bp', name: 'Bench', muscles: ['chest'] },
        { id: 'broken' }, // missing muscles → filtered
      ],
    });
    const bundle = parseKineticJson(payload);
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.exercises).toHaveLength(1);
  });
});

// ─── mergeIntoStorage ────────────────────────────────────────────────────────

describe('mergeIntoStorage', () => {
  it('dedupes sessions by id and reports duplicates', async () => {
    const storage = createMemoryStorage();
    // Première session déjà présente
    await storage.set('kinetic:training:sessions', [
      {
        id: 'existing',
        name: 'Old',
        startedAt: '2025-11-01T10:00:00Z',
        entries: [],
      },
    ]);
    await storage.set('kinetic:training:exercises', [
      { id: 'bp', name: 'Bench Press', muscles: ['chest'], equipment: 'barbell', incrementKg: 2.5 },
    ]);

    const bundle = {
      sessions: [
        {
          id: 'existing', // doublon
          name: 'Old (re-import)',
          startedAt: '2025-11-01T10:00:00Z',
          entries: [],
        },
        {
          id: 'new',
          name: 'New session',
          startedAt: '2025-12-01T10:00:00Z',
          entries: [],
        },
      ],
      exercises: [],
      createdExercises: [
        {
          id: 'sq',
          name: 'Squat',
          muscles: ['quads'],
          equipment: 'barbell',
          incrementKg: 2.5,
        },
      ],
    } as const;

    const report = await mergeIntoStorage(storage, bundle, 'kinetic-json');
    expect(report.importedSessions).toBe(1);
    expect(report.duplicateSessions).toBe(1);
    expect(report.createdExercises).toBe(1);

    const sessions = await storage.get<unknown[]>('kinetic:training:sessions');
    expect(sessions).toHaveLength(2);
  });
});
