/**
 * Error Reporter — exfiltration optionnelle des erreurs critiques.
 *
 * Architecture :
 *   - Le buffer `STORAGE_KEYS.ERRORS` est déjà alimenté par les handlers
 *     `unhandledrejection` et `error` du main.ts.
 *   - Ce module ajoute :
 *       a) Une fonction `flushErrorsToServer()` qui POST le buffer à un
 *          endpoint configuré, puis le vide en cas de succès.
 *       b) Un appel auto-flush au boot (best effort, throttlé 30 min).
 *
 * Endpoint : on poste à une Edge Function Supabase optionnelle
 * `report-error` qui peut soit logger en console-only soit pousser à
 * Sentry/Posthog/un webhook. Si la fonction n'est pas déployée, le buffer
 * reste local — aucune erreur visible pour l'utilisateur.
 */

import { STORAGE_KEYS } from '@kinetic/core';

const LAST_FLUSH_KEY = STORAGE_KEYS.ERRORS_LAST_FLUSH;
const FLUSH_INTERVAL_MS = 30 * 60 * 1000;

interface ErrorReport {
  occurredAt: string;
  message: string;
  source: 'unhandled_rejection' | 'uncaught_error' | 'manual';
}

const SUPABASE_URL = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  ?.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  ?.VITE_SUPABASE_ANON_KEY;

function readBuffer(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.ERRORS) ?? '';
  } catch {
    return '';
  }
}

function clearBuffer(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.ERRORS);
  } catch {
    /* noop */
  }
}

function parseBuffer(raw: string): ErrorReport[] {
  if (!raw.trim()) return [];
  const lines = raw.split('\n').filter((l) => l.trim());
  return lines.map((line) => {
    // Format : "[ISO] rejection: message" ou "[ISO] error: message"
    const m = /^\[(.+?)\]\s+(\w+):\s+(.+)$/.exec(line);
    if (m) {
      return {
        occurredAt: m[1]!,
        source: m[2] === 'rejection' ? 'unhandled_rejection' : 'uncaught_error',
        message: m[3]!.slice(0, 500),
      };
    }
    return {
      occurredAt: new Date().toISOString(),
      source: 'manual',
      message: line.slice(0, 500),
    };
  });
}

function shouldFlush(): boolean {
  try {
    const last = Number(localStorage.getItem(LAST_FLUSH_KEY) ?? '0');
    return Date.now() - last > FLUSH_INTERVAL_MS;
  } catch {
    return true;
  }
}

function markFlushed(): void {
  try {
    localStorage.setItem(LAST_FLUSH_KEY, String(Date.now()));
  } catch {
    /* noop */
  }
}

/**
 * flushErrorsToServer — best effort. Si l'endpoint n'existe pas, on garde
 * le buffer local pour la prochaine tentative.
 */
export async function flushErrorsToServer(): Promise<{ sent: number; ok: boolean }> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return { sent: 0, ok: false };
  const raw = readBuffer();
  const reports = parseBuffer(raw);
  if (reports.length === 0) return { sent: 0, ok: true };
  try {
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/report-error`;
    let token = SUPABASE_ANON_KEY;
    try {
      const { supabase } = await import('@kinetic/adapters-web');
      if (supabase) {
        const sb = supabase as unknown as {
          auth: {
            getSession: () => Promise<{ data: { session: { access_token: string } | null } }>;
          };
        };
        const { data } = await sb.auth.getSession();
        if (data.session?.access_token) token = data.session.access_token;
      }
    } catch {
      /* noop */
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        userAgent: navigator?.userAgent?.slice(0, 200) ?? 'unknown',
        reports,
      }),
    });
    if (resp.ok) {
      clearBuffer();
      markFlushed();
      return { sent: reports.length, ok: true };
    }
    // 404 : endpoint pas déployé — on n'efface pas le buffer mais on
    // marque comme flushé pour ne pas retenter avant 30 min.
    if (resp.status === 404) {
      markFlushed();
      return { sent: 0, ok: false };
    }
    return { sent: 0, ok: false };
  } catch (err) {
    console.warn('[error-reporter] flush failed:', err);
    return { sent: 0, ok: false };
  }
}

/** À appeler une fois au boot — exfiltre best-effort, throttlé 30 min. */
export function initErrorReporter(): void {
  if (typeof window === 'undefined') return;
  if (!shouldFlush()) return;
  // Différé pour ne pas bloquer le first paint
  setTimeout(() => {
    void flushErrorsToServer().catch(() => null);
  }, 5000);
}
