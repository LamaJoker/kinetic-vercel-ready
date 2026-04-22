/**
 * apps/web/src/lib/analytics.ts
 *
 * Web Vitals + performance monitoring.
 * Aucun tracker externe — données envoyées en interne (Supabase Edge Function).
 *
 * Métriques collectées :
 *   - LCP (Largest Contentful Paint)
 *   - CLS (Cumulative Layout Shift)
 *   - FID / INP (Interaction to Next Paint)
 *   - TTFB (Time to First Byte)
 *   - FCP (First Contentful Paint)
 *
 * RGPD : aucune donnée personnelle. Uniquement les métriques de perf.
 */

export interface VitalMetric {
  name: 'LCP' | 'CLS' | 'FID' | 'INP' | 'TTFB' | 'FCP';
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  delta: number;
  id: string;
}

// ─── Seuils officiels Google Web Vitals ──────────────────────
const THRESHOLDS: Record<string, [number, number]> = {
  LCP:  [2500, 4000],  // ms : good < 2500, poor > 4000
  CLS:  [0.1, 0.25],   // score unitless
  FID:  [100, 300],    // ms
  INP:  [200, 500],    // ms
  TTFB: [800, 1800],   // ms
  FCP:  [1800, 3000],  // ms
};

function getRating(name: string, value: number): 'good' | 'needs-improvement' | 'poor' {
  const [good, poor] = THRESHOLDS[name] ?? [Infinity, Infinity];
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}

// ─── Collecte via PerformanceObserver ────────────────────────

type ReportFn = (metric: VitalMetric) => void;

function observe(type: string, callback: (entries: PerformanceEntryList) => void): void {
  try {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({ type, buffered: true });
  } catch {
    // Type non supporté — silencieux
  }
}

export function collectWebVitals(onMetric: ReportFn): void {
  // LCP
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number };
    if (last) {
      onMetric({
        name: 'LCP',
        value: last.startTime,
        rating: getRating('LCP', last.startTime),
        delta: last.startTime,
        id: 'lcp-' + Date.now(),
      });
    }
  });

  // CLS
  let clsValue = 0;
  let clsEntries: PerformanceEntry[] = [];
  observe('layout-shift', (entries) => {
    for (const entry of entries) {
      const ls = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
      if (!ls.hadRecentInput) {
        clsValue += ls.value;
        clsEntries.push(entry);
      }
    }
    onMetric({
      name: 'CLS',
      value: clsValue,
      rating: getRating('CLS', clsValue),
      delta: clsValue,
      id: 'cls-' + Date.now(),
    });
  });

  // FCP
  observe('paint', (entries) => {
    const fcp = entries.find((e) => e.name === 'first-contentful-paint');
    if (fcp) {
      onMetric({
        name: 'FCP',
        value: fcp.startTime,
        rating: getRating('FCP', fcp.startTime),
        delta: fcp.startTime,
        id: 'fcp-' + Date.now(),
      });
    }
  });

  // TTFB (via Navigation Timing)
  observe('navigation', (entries) => {
    const nav = entries[0] as PerformanceNavigationTiming;
    if (nav) {
      const ttfb = nav.responseStart - nav.requestStart;
      onMetric({
        name: 'TTFB',
        value: ttfb,
        rating: getRating('TTFB', ttfb),
        delta: ttfb,
        id: 'ttfb-' + Date.now(),
      });
    }
  });

  // INP (via event timing)
  let maxINP = 0;
  observe('event', (entries) => {
    for (const entry of entries) {
      const e = entry as PerformanceEntry & { processingEnd: number; processingStart: number; startTime: number };
      const duration = e.processingEnd - e.startTime;
      if (duration > maxINP) {
        maxINP = duration;
        onMetric({
          name: 'INP',
          value: maxINP,
          rating: getRating('INP', maxINP),
          delta: maxINP,
          id: 'inp-' + Date.now(),
        });
      }
    }
  });
}

// ─── Reporter : logs dev + envoi prod ────────────────────────

let _metricsBuffer: VitalMetric[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushMetrics(): void {
  if (_metricsBuffer.length === 0) return;
  const batch = [..._metricsBuffer];
  _metricsBuffer = [];

  // En prod : envoyer à une Edge Function Supabase / Vercel
  if (import.meta.env.PROD) {
    // sendBeacon est fire-and-forget, parfait pour les analytics
    navigator.sendBeacon(
      '/api/vitals',
      JSON.stringify({
        metrics: batch,
        url: location.pathname,
        ts: Date.now(),
      })
    );
  }
}

export function initAnalytics(): void {
  const isDev = import.meta.env.DEV;

  collectWebVitals((metric) => {
    if (isDev) {
      const emoji = metric.rating === 'good' ? '✅' : metric.rating === 'needs-improvement' ? '⚠️' : '❌';
      console.log(`[Vitals] ${emoji} ${metric.name}: ${metric.value.toFixed(1)} (${metric.rating})`);
    } else {
      _metricsBuffer.push(metric);
      if (_flushTimer) clearTimeout(_flushTimer);
      _flushTimer = setTimeout(flushMetrics, 5000);
    }
  });

  // Flush final avant fermeture de page
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushMetrics();
  });
}

// ─── Performance markers pour profiling ─────────────────────

export function markStart(label: string): void {
  performance.mark(`kinetic-${label}-start`);
}

export function markEnd(label: string): void {
  try {
    performance.mark(`kinetic-${label}-end`);
    performance.measure(
      `kinetic-${label}`,
      `kinetic-${label}-start`,
      `kinetic-${label}-end`
    );
    if (import.meta.env.DEV) {
      const measure = performance.getEntriesByName(`kinetic-${label}`).at(-1);
      if (measure) {
        console.log(`[Perf] ${label}: ${measure.duration.toFixed(2)}ms`);
      }
    }
  } catch {
    // Silencieux si le mark start est absent
  }
}
