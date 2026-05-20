/**
 * tests/unit/analytics.test.ts
 *
 * Covers: collectWebVitals (all 5 observer callbacks + ratings + edge-cases),
 * initAnalytics (dev logging path + visibilitychange), flushMetrics (non-empty
 * buffer path via vi.stubEnv PROD mode), markStart, markEnd.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── PerformanceObserver stub with callback capture ─────────────────────────
// collectWebVitals() creates 5 observers (LCP, CLS, FCP, TTFB, INP).
// We capture each constructor callback so tests can fire it with mock entries.

let _observerCbs: Array<(list: { getEntries: () => unknown[] }) => void> = [];

const makePerformanceObserverStub = () =>
  vi.fn((cb: (list: { getEntries: () => unknown[] }) => void) => {
    _observerCbs.push(cb);
    return { observe: vi.fn(), disconnect: vi.fn() };
  });

// Stub before ESM imports execute (vi.stubGlobal hoists correctly here because
// analytics.ts has no top-level side effects that use PerformanceObserver).
vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());

// ─── Imports after stub ──────────────────────────────────────────────────────

import {
  collectWebVitals,
  initAnalytics,
  markStart,
  markEnd,
} from '../../apps/web/src/lib/analytics.js';

// ─── Helper ─────────────────────────────────────────────────────────────────

/** Fire the Nth PerformanceObserver callback with synthetic entries. */
function fireObserver(index: number, entries: unknown[]) {
  _observerCbs[index]?.({ getEntries: () => entries });
}

// ─── collectWebVitals — observer callback coverage ──────────────────────────

describe('collectWebVitals — LCP observer', () => {
  beforeEach(() => {
    _observerCbs = [];
    vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports LCP metric with good rating (< 2500 ms)', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(0, [{ startTime: 1000 }]);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LCP', value: 1000, rating: 'good' }),
    );
  });

  it('reports LCP metric with needs-improvement rating (2500 – 4000 ms)', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(0, [{ startTime: 3000 }]);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LCP', rating: 'needs-improvement' }),
    );
  });

  it('reports LCP metric with poor rating (> 4000 ms)', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(0, [{ startTime: 5000 }]);
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({ name: 'LCP', rating: 'poor' }));
  });

  it('does not call onMetric when LCP entries list is empty', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(0, []);
    expect(onMetric).not.toHaveBeenCalled();
  });

  it('uses the LAST entry in the list (latest LCP candidate)', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(0, [{ startTime: 500 }, { startTime: 2000 }]);
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({ value: 2000 }));
  });
});

describe('collectWebVitals — CLS observer', () => {
  beforeEach(() => {
    _observerCbs = [];
    vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('accumulates shift values when hadRecentInput=false', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(1, [
      { hadRecentInput: false, value: 0.05 },
      { hadRecentInput: false, value: 0.03 },
    ]);
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({ name: 'CLS', value: 0.08 }));
  });

  it('ignores entries with hadRecentInput=true (covers false branch)', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(1, [
      { hadRecentInput: false, value: 0.05 },
      { hadRecentInput: true, value: 0.9 }, // should be skipped
    ]);
    // Only the first entry is counted
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({ value: 0.05 }));
  });

  it('reports CLS poor rating when accumulated value > 0.25', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(1, [{ hadRecentInput: false, value: 0.3 }]);
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({ name: 'CLS', rating: 'poor' }));
  });
});

describe('collectWebVitals — FCP observer', () => {
  beforeEach(() => {
    _observerCbs = [];
    vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports FCP metric when first-contentful-paint entry is present', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(2, [{ name: 'first-contentful-paint', startTime: 800 }]);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'FCP', value: 800, rating: 'good' }),
    );
  });

  it('does not call onMetric when no first-contentful-paint entry (covers if-fcp false branch)', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(2, [{ name: 'other-paint', startTime: 800 }]);
    expect(onMetric).not.toHaveBeenCalled();
  });

  it('reports FCP needs-improvement rating (1800 < value <= 3000 ms)', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(2, [{ name: 'first-contentful-paint', startTime: 2000 }]);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'FCP', rating: 'needs-improvement' }),
    );
  });
});

describe('collectWebVitals — TTFB observer', () => {
  beforeEach(() => {
    _observerCbs = [];
    vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports TTFB metric from navigation timing entry', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(3, [{ responseStart: 300, requestStart: 100 }]);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'TTFB', value: 200, rating: 'good' }),
    );
  });

  it('does not call onMetric when navigation entries list is empty', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(3, []);
    expect(onMetric).not.toHaveBeenCalled();
  });

  it('reports TTFB poor rating when value > 1800 ms', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(3, [{ responseStart: 2000, requestStart: 0 }]);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'TTFB', rating: 'poor' }),
    );
  });
});

describe('collectWebVitals — INP observer', () => {
  beforeEach(() => {
    _observerCbs = [];
    vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports INP metric when event duration exceeds current max', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    // duration = processingEnd - startTime = 300 - 100 = 200
    fireObserver(4, [{ processingEnd: 300, processingStart: 150, startTime: 100 }]);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'INP', value: 200, rating: 'good' }),
    );
  });

  it('does not re-report INP when new event is shorter than current max (covers > branch false path)', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    // First event: duration 200 — sets maxINP
    fireObserver(4, [{ processingEnd: 300, processingStart: 150, startTime: 100 }]);
    onMetric.mockClear();
    // Second event: duration 50 (< 200) — no new report
    fireObserver(4, [{ processingEnd: 200, processingStart: 180, startTime: 170 }]);
    expect(onMetric).not.toHaveBeenCalled();
  });

  it('reports INP poor rating when duration > 500 ms', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    fireObserver(4, [{ processingEnd: 700, processingStart: 100, startTime: 100 }]);
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({ name: 'INP', rating: 'poor' }));
  });
});

describe('collectWebVitals — observe() error swallowing', () => {
  beforeEach(() => {
    _observerCbs = [];
    vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not throw when PerformanceObserver constructor throws (covers catch noop)', () => {
    vi.mocked(PerformanceObserver).mockImplementationOnce(() => {
      throw new Error('not supported');
    });
    const onMetric = vi.fn();
    expect(() => collectWebVitals(onMetric)).not.toThrow();
  });

  it('constructs PerformanceObserver for each of the 5 metric types', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    // 5 observers: LCP, CLS, FCP, TTFB, INP
    expect(vi.mocked(PerformanceObserver)).toHaveBeenCalledTimes(5);
  });
});

// ─── initAnalytics — DEV logging path ───────────────────────────────────────

describe('initAnalytics — DEV console logging (import.meta.env.DEV = true)', () => {
  beforeEach(() => {
    _observerCbs = [];
    vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());
    vi.stubGlobal('document', { addEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('logs metric to console with ✅ emoji for good rating', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    initAnalytics();
    // Fire LCP at 1000ms (good)
    fireObserver(0, [{ startTime: 1000 }]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Vitals]'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✅'));
    consoleSpy.mockRestore();
  });

  it('logs metric to console with ⚠️ emoji for needs-improvement rating', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    initAnalytics();
    // LCP at 3000ms (needs-improvement)
    fireObserver(0, [{ startTime: 3000 }]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('⚠️'));
    consoleSpy.mockRestore();
  });

  it('logs metric to console with ❌ emoji for poor rating', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    initAnalytics();
    // LCP at 5000ms (poor)
    fireObserver(0, [{ startTime: 5000 }]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('❌'));
    consoleSpy.mockRestore();
  });

  it('registers a visibilitychange listener on document', () => {
    const addListenerSpy = vi.fn();
    vi.stubGlobal('document', { addEventListener: addListenerSpy });
    initAnalytics();
    expect(addListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('calls the visibilitychange handler without throwing when document is hidden', () => {
    let handler: (() => void) | null = null;
    vi.stubGlobal('document', {
      addEventListener: (_: string, fn: () => void) => {
        handler = fn;
      },
      visibilityState: 'hidden',
    });
    initAnalytics();
    expect(() => handler?.()).not.toThrow();
  });
});

// ─── initAnalytics — PROD path (buffer + sendBeacon) ────────────────────────

describe('initAnalytics — PROD mode (buffer + flushMetrics via visibilitychange)', () => {
  beforeEach(() => {
    _observerCbs = [];
    vi.stubGlobal('PerformanceObserver', makePerformanceObserverStub());
    vi.stubEnv('PROD', 'true');
    vi.stubEnv('DEV', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('buffers metric and calls sendBeacon when visibilitychange fires (covers lines 176-179, 148-162)', () => {
    vi.useFakeTimers();
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('location', { pathname: '/test' });

    let visibilityHandler: (() => void) | null = null;
    vi.stubGlobal('document', {
      addEventListener: (_: string, fn: () => void) => {
        visibilityHandler = fn;
      },
      visibilityState: 'hidden',
    });

    initAnalytics();
    // Fire LCP so a metric is buffered (non-DEV path → _metricsBuffer.push)
    fireObserver(0, [{ startTime: 1000 }]);
    // Trigger visibilitychange → flushMetrics → sendBeacon
    visibilityHandler?.();

    // In PROD mode, sendBeacon should have been called with the buffered metric
    expect(sendBeacon).toHaveBeenCalledWith('/api/vitals', expect.stringContaining('"metrics"'));

    vi.useRealTimers();
  });

  it('setTimeout flushMetrics fires after 5000ms in PROD mode (covers _flushTimer path)', () => {
    vi.useFakeTimers();
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('location', { pathname: '/prod-test' });
    vi.stubGlobal('document', { addEventListener: vi.fn() });

    initAnalytics();
    // Add a metric to the buffer
    fireObserver(0, [{ startTime: 1200 }]);
    // Advance timers past the 5000ms flush delay
    vi.advanceTimersByTime(5100);

    expect(sendBeacon).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ─── markStart / markEnd ─────────────────────────────────────────────────────

describe('markStart / markEnd', () => {
  let marks: Record<string, number>;

  beforeEach(() => {
    marks = {};
    vi.stubGlobal('performance', {
      mark: vi.fn((name: string) => {
        marks[name] = Date.now();
      }),
      measure: vi.fn(),
      getEntriesByName: vi.fn(() => [{ duration: 42 }]),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('markStart calls performance.mark with correct name', () => {
    markStart('test-op');
    expect(performance.mark).toHaveBeenCalledWith('kinetic-test-op-start');
  });

  it('markEnd calls performance.mark and measure', () => {
    markStart('test-op');
    markEnd('test-op');
    expect(performance.mark).toHaveBeenCalledWith('kinetic-test-op-end');
    expect(performance.measure).toHaveBeenCalledWith(
      'kinetic-test-op',
      'kinetic-test-op-start',
      'kinetic-test-op-end',
    );
  });

  it('markEnd does not throw if mark start is missing (covers catch noop)', () => {
    vi.mocked(performance.measure).mockImplementationOnce(() => {
      throw new Error('missing mark');
    });
    expect(() => markEnd('missing-op')).not.toThrow();
  });

  it('markEnd logs to console in DEV mode when measure entry is found', () => {
    // DEV=true by default in Vitest
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    markStart('perf-op');
    markEnd('perf-op');
    // Should log the duration since performance.getEntriesByName returns [{duration: 42}]
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Perf]'));
    consoleSpy.mockRestore();
  });

  it('markEnd does not log when getEntriesByName returns empty (covers if-measure false branch)', () => {
    vi.mocked(performance.getEntriesByName).mockReturnValueOnce([]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    markStart('empty-op');
    markEnd('empty-op');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
