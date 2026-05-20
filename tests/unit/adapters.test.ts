/**
 * tests/unit/adapters.test.ts
 *
 * Unit tests for the three thin infrastructure adapters in packages/adapter-web/src:
 *   - SystemClock  (ClockPort)
 *   - ToastNotifier (NotifierPort)
 *   - UuidGenerator (IdGeneratorPort)
 *
 * These adapters have zero logic beyond delegating to browser APIs.
 * Tests verify the delegation is wired correctly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SystemClock } from '../../packages/adapter-web/src/SystemClock.js';
import { ToastNotifier } from '../../packages/adapter-web/src/ToastNotifier.js';
import { UuidGenerator } from '../../packages/adapter-web/src/UuidGenerator.js';

describe('SystemClock', () => {
  it('nowMs returns a number close to Date.now()', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const result = clock.nowMs();
    const after = Date.now();
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('todayIsoDate returns a YYYY-MM-DD string', () => {
    const clock = new SystemClock();
    expect(clock.todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('todayIsoDate reflects the current local date', () => {
    const clock = new SystemClock();
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    expect(clock.todayIsoDate()).toBe(`${y}-${m}-${day}`);
  });

  it('nowMs is monotonically non-decreasing across successive calls', () => {
    const clock = new SystemClock();
    const t1 = clock.nowMs();
    const t2 = clock.nowMs();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});

describe('ToastNotifier', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('dispatches a CustomEvent on window with the notification payload in detail', () => {
    const dispatched: CustomEvent[] = [];
    vi.stubGlobal('window', {
      dispatchEvent: (e: CustomEvent) => dispatched.push(e),
    });

    const notifier = new ToastNotifier();
    notifier.notify({ kind: 'success', message: 'Done!' });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].detail).toEqual({ kind: 'success', message: 'Done!' });
  });

  it('dispatches event with bubbles: true', () => {
    const dispatched: CustomEvent[] = [];
    vi.stubGlobal('window', {
      dispatchEvent: (e: CustomEvent) => dispatched.push(e),
    });

    const notifier = new ToastNotifier();
    notifier.notify({ kind: 'error', message: 'Oops' });

    expect(dispatched[0].bubbles).toBe(true);
  });

  it('works for all notification kinds', () => {
    const kinds: Array<'success' | 'error' | 'warning' | 'info'> = [
      'success',
      'error',
      'warning',
      'info',
    ];
    const dispatched: CustomEvent[] = [];
    vi.stubGlobal('window', { dispatchEvent: (e: CustomEvent) => dispatched.push(e) });

    const notifier = new ToastNotifier();
    for (const kind of kinds) {
      notifier.notify({ kind, message: `msg-${kind}` });
    }

    expect(dispatched).toHaveLength(4);
    dispatched.forEach((e, i) => {
      expect(e.detail.kind).toBe(kinds[i]);
    });
  });
});

describe('UuidGenerator', () => {
  it('newId returns a UUID v4 format string', () => {
    const gen = new UuidGenerator();
    const id = gen.newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('newId returns unique values on successive calls', () => {
    const gen = new UuidGenerator();
    const ids = new Set(Array.from({ length: 20 }, () => gen.newId()));
    expect(ids.size).toBe(20);
  });

  it('newId always contains exactly four hyphens', () => {
    const gen = new UuidGenerator();
    const id = gen.newId();
    expect(id.split('-')).toHaveLength(5);
  });
});
