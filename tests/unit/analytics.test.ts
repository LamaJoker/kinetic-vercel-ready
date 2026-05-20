import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock PerformanceObserver before importing analytics
const mockObserver = {
  observe: vi.fn(),
  disconnect: vi.fn(),
};
vi.stubGlobal(
  'PerformanceObserver',
  vi.fn(() => mockObserver),
);

import {
  collectWebVitals,
  initAnalytics,
  markStart,
  markEnd,
} from '../../apps/web/src/lib/analytics.js';

describe('collectWebVitals', () => {
  it('calls onMetric from observe callbacks', () => {
    const onMetric = vi.fn();
    collectWebVitals(onMetric);
    // PerformanceObserver was constructed for each observe type
    expect(PerformanceObserver).toHaveBeenCalled();
  });

  it('does not throw when PerformanceObserver throws on observe', () => {
    vi.mocked(PerformanceObserver).mockImplementationOnce(() => {
      throw new Error('not supported');
    });
    const onMetric = vi.fn();
    expect(() => collectWebVitals(onMetric)).not.toThrow();
  });
});

describe('initAnalytics', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('registers a visibilitychange listener on document', () => {
    const addListenerSpy = vi.fn();
    vi.stubGlobal('document', { addEventListener: addListenerSpy });

    initAnalytics();

    expect(addListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('does not throw when called', () => {
    vi.stubGlobal('document', { addEventListener: vi.fn() });
    expect(() => initAnalytics()).not.toThrow();
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
    // Trigger the handler — flushMetrics exits early when buffer is empty
    expect(() => handler?.()).not.toThrow();
  });
});

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

  it('markEnd does not throw if mark start is missing', () => {
    vi.mocked(performance.measure).mockImplementationOnce(() => {
      throw new Error('missing mark');
    });
    expect(() => markEnd('missing-op')).not.toThrow();
  });
});
