import { describe, it, expect, vi } from 'vitest';

// Capacitor is mobile-only — stub it so the pure export functions can be tested in Node.
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: vi.fn() },
  Directory: { Documents: 'DOCUMENTS' },
  Encoding: { UTF8: 'utf8' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }));

import { buildJsonExport, buildCsvExport } from '../../apps/web/src/lib/training/export.js';
import type { WorkoutSession, Exercise } from '../../apps/web/src/lib/training/types.js';

const exercises: Exercise[] = [
  {
    id: 'bp',
    name: 'Bench Press',
    muscles: ['chest', 'triceps'],
    equipment: 'barbell',
    incrementKg: 2.5,
  },
];

const sessions: WorkoutSession[] = [
  {
    id: 's1',
    name: 'Push Day',
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T11:00:00.000Z',
    entries: [
      {
        exerciseId: 'bp',
        sets: [
          { setIndex: 0, reps: 8, weightKg: 100, rpe: 8, performedAt: '2026-01-01T10:05:00.000Z' },
          {
            setIndex: 1,
            reps: 8,
            weightKg: 100,
            rpe: 8.5,
            performedAt: '2026-01-01T10:10:00.000Z',
          },
        ],
      },
    ],
  },
];

describe('buildJsonExport', () => {
  it('produces valid JSON with version=1', () => {
    const json = buildJsonExport(sessions, exercises);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.exercises).toHaveLength(1);
    expect(typeof parsed.exportedAt).toBe('string');
  });

  it('includes session and exercise data', () => {
    const json = buildJsonExport(sessions, exercises);
    const parsed = JSON.parse(json);
    expect(parsed.sessions[0].id).toBe('s1');
    expect(parsed.exercises[0].id).toBe('bp');
  });

  it('pretty-prints with 2-space indent', () => {
    const json = buildJsonExport(sessions, exercises);
    expect(json).toContain('\n  ');
  });

  it('handles empty arrays', () => {
    const json = buildJsonExport([], []);
    const parsed = JSON.parse(json);
    expect(parsed.sessions).toHaveLength(0);
    expect(parsed.exercises).toHaveLength(0);
  });
});

describe('buildCsvExport', () => {
  it('starts with UTF-8 BOM', () => {
    const csv = buildCsvExport(sessions, exercises);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('has correct header row', () => {
    const csv = buildCsvExport(sessions, exercises);
    const firstLine = csv.slice(1).split('\r\n')[0]!;
    expect(firstLine).toContain('"session_id"');
    expect(firstLine).toContain('"exercise_name"');
    expect(firstLine).toContain('"weight_kg"');
    expect(firstLine).toContain('"e1rm_kg"');
  });

  it('produces one data row per set', () => {
    const csv = buildCsvExport(sessions, exercises);
    // BOM + header + 2 set rows + trailing CRLF
    const lines = csv.slice(1).split('\r\n').filter(Boolean);
    expect(lines.length).toBe(1 + 2); // header + 2 sets
  });

  it('uses CRLF line endings', () => {
    const csv = buildCsvExport(sessions, exercises);
    expect(csv).toContain('\r\n');
  });

  it('escapes double quotes in cell values', () => {
    const sessionsWithQuotes: WorkoutSession[] = [
      {
        ...sessions[0]!,
        name: 'He said "push"',
      },
    ];
    const csv = buildCsvExport(sessionsWithQuotes, exercises);
    expect(csv).toContain('He said ""push""');
  });

  it('resolves exercise names via exercise map', () => {
    const csv = buildCsvExport(sessions, exercises);
    expect(csv).toContain('Bench Press');
  });

  it('falls back to exerciseId when exercise not found', () => {
    const sessionsUnknown: WorkoutSession[] = [
      {
        ...sessions[0]!,
        entries: [
          {
            exerciseId: 'unknown-ex',
            sets: [
              {
                setIndex: 0,
                reps: 5,
                weightKg: 50,
                rpe: 7,
                performedAt: '2026-01-01T10:00:00.000Z',
              },
            ],
          },
        ],
      },
    ];
    const csv = buildCsvExport(sessionsUnknown, exercises);
    expect(csv).toContain('unknown-ex');
  });

  it('handles empty sessions', () => {
    const csv = buildCsvExport([], exercises);
    const lines = csv.slice(1).split('\r\n').filter(Boolean);
    expect(lines.length).toBe(1); // header only
  });

  it('computes e1rm using Epley formula', () => {
    const csv = buildCsvExport(sessions, exercises);
    // 100kg * (1 + 8/30) = 126.666... → "126.7"
    const expectedE1rm = (100 * (1 + 8 / 30)).toFixed(1);
    expect(csv).toContain(expectedE1rm);
  });
});
