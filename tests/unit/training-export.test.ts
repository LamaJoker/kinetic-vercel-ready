import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capacitor is mobile-only — stub it so the pure export functions can be tested in Node.
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: vi.fn() },
  Directory: { Documents: 'DOCUMENTS' },
  Encoding: { UTF8: 'utf8' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }));

import {
  buildJsonExport,
  buildCsvExport,
  downloadOrShare,
  exportAsJson,
  exportAsCsv,
} from '../../apps/web/src/lib/training/export.js';
import type { WorkoutSession, Exercise } from '../../apps/web/src/lib/training/types.js';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

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

// ─── downloadOrShare / downloadWeb ────────────────────────────────────────────

describe('downloadOrShare — web path (Capacitor.isNativePlatform = false)', () => {
  let fakeA: { href: string; download: string; click: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    // Polyfill URL.createObjectURL for Node.js
    (URL as unknown as Record<string, unknown>).createObjectURL = vi
      .fn()
      .mockReturnValue('blob:mock-url');
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();

    fakeA = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => fakeA),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    });

    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  afterEach(() => {
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('creates a blob URL, clicks <a download>, and revokes the URL', async () => {
    await downloadOrShare('hello', 'test.txt', 'text/plain');

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(fakeA.click).toHaveBeenCalledOnce();
    expect(fakeA.download).toBe('test.txt');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('exportAsJson triggers downloadOrShare with JSON mime type', async () => {
    await exportAsJson(sessions, exercises);
    expect(fakeA.download).toMatch(/\.json$/);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('exportAsCsv triggers downloadOrShare with CSV mime type', async () => {
    await exportAsCsv(sessions, exercises);
    expect(fakeA.download).toMatch(/\.csv$/);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('downloadOrShare does nothing when document is undefined', async () => {
    vi.unstubAllGlobals();
    // document is not stubbed — typeof document === 'undefined' in Node
    await downloadOrShare('data', 'out.txt', 'text/plain');
    // No throw, no click
    expect(fakeA.click).not.toHaveBeenCalled();
  });
});

// ─── downloadOrShare / downloadNative ────────────────────────────────────────

describe('downloadOrShare — native path (Capacitor.isNativePlatform = true)', () => {
  beforeEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal(
      'CustomEvent',
      class extends Event {
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          super(type);
          this.detail = init?.detail;
        }
      },
    );
  });

  afterEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('writes file via Filesystem and opens Share sheet on success', async () => {
    vi.mocked(Filesystem.writeFile).mockResolvedValueOnce({ uri: 'file://Documents/test.txt' });
    vi.mocked(Share.share).mockResolvedValueOnce(undefined as never);

    await downloadOrShare('hello', 'test.txt', 'text/plain');

    expect(Filesystem.writeFile).toHaveBeenCalledOnce();
    expect(Share.share).toHaveBeenCalledOnce();
    expect(vi.mocked(Share.share).mock.calls[0][0]).toMatchObject({
      title: expect.any(String),
      url: 'file://Documents/test.txt',
    });
  });

  it('dispatches success notification when Share is cancelled (Share.share throws)', async () => {
    const dispatchFn = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: dispatchFn });

    vi.mocked(Filesystem.writeFile).mockResolvedValueOnce({ uri: 'file://Documents/export.json' });
    vi.mocked(Share.share).mockRejectedValueOnce(new Error('user cancelled'));

    await downloadOrShare('data', 'export.json', 'application/json');

    // Should have dispatched a success notification via the catch-share path
    expect(dispatchFn).toHaveBeenCalledOnce();
    const event = dispatchFn.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toMatchObject({ kind: 'success' });
  });
});
