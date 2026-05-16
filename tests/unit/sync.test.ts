import { describe, it, expect, vi, afterEach } from 'vitest';

// Static import of CRDT re-exports (no browser globals needed)
import {
  createClock,
  incrementClock,
  mergeClock,
  compareClocks,
  resolveConflict,
} from '../../apps/web/src/lib/sync.js';

describe('CRDT re-exports from sync.ts', () => {
  it('re-exports createClock', () => {
    expect(typeof createClock).toBe('function');
    const clock = createClock('device-a');
    expect(clock).toBeDefined();
  });

  it('re-exports incrementClock', () => {
    const clock = createClock('dev1');
    const incremented = incrementClock(clock, 'dev1');
    expect(incremented['dev1']).toBeGreaterThan(clock['dev1'] ?? 0);
  });

  it('re-exports mergeClock', () => {
    const a = incrementClock(createClock('a'), 'a');
    const b = incrementClock(createClock('b'), 'b');
    const merged = mergeClock(a, b);
    expect(merged['a']).toBeDefined();
    expect(merged['b']).toBeDefined();
  });

  it('re-exports compareClocks', () => {
    const a = incrementClock(createClock('dev'), 'dev');
    const b = createClock('dev');
    const result = compareClocks(a, b);
    expect(['concurrent', 'before', 'after', 'equal']).toContain(result);
  });

  it('re-exports resolveConflict', () => {
    const clock = createClock('d');
    const v1 = { clock: incrementClock(clock, 'd'), value: 'first' };
    const v2 = { clock: incrementClock(incrementClock(clock, 'd'), 'd'), value: 'second' };
    const result = resolveConflict(v1, v2);
    expect(result.value).toBe('second'); // v2 has higher clock
  });
});

describe('getOrCreateDeviceId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns server fallback ID when window is undefined', async () => {
    vi.stubGlobal('window', undefined);
    const { getOrCreateDeviceId } = await import('../../apps/web/src/lib/sync.js');
    const id = getOrCreateDeviceId();
    expect(id).toMatch(/^server-/);
  });

  it('returns a volatile UUID when localStorage throws (private mode)', async () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error('QuotaExceededError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    vi.stubGlobal('window', { localStorage: throwingStorage });
    vi.stubGlobal('localStorage', throwingStorage);
    vi.stubGlobal('crypto', { randomUUID: () => 'volatile-fallback-id' });

    const { getOrCreateDeviceId } = await import('../../apps/web/src/lib/sync.js');
    const id = getOrCreateDeviceId();
    // Should not throw and should return something UUID-like
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});
