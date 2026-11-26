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

// Lecture lazy pour rester testable (vi.stubEnv).
function envUrl(): string | undefined {
  const meta = import.meta as ImportMeta & { env?: Record<string, string> };
  return meta.env?.VITE_SUPABASE_URL;
}
function envAnonKey(): string | undefined {
  const meta = import.meta as ImportMeta & { env?: Record<string, string> };
  return meta.env?.VITE_SUPABASE_ANON_KEY;
}

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

/** Nombre maximal de rapports par envoi (le serveur n'en traite pas plus). */
export const MAX_REPORTS_PER_FLUSH = 50;

/** Remplace les caractères de contrôle (refusés par le serveur) par une espace. */
function clean(text: string, max: number): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch;
  }
  return out.slice(0, max);
}

function parseBuffer(raw: string): ErrorReport[] {
  if (!raw.trim()) return [];
  const lines = raw.split('\n').filter((l) => l.trim());
  // Les plus récents d'abord conservés : le buffer peut contenir des centaines de lignes.
  return lines.slice(-MAX_REPORTS_PER_FLUSH).map((line) => {
    // Format : "[ISO] rejection: message" ou "[ISO] error: message"
    const m = /^\[(.+?)\]\s+(\w+):\s+(.+)$/.exec(line);
    if (m) {
      return {
        occurredAt: clean(m[1]!, 40),
        source: m[2] === 'rejection' ? 'unhandled_rejection' : 'uncaught_error',
        message: clean(m[3]!, 500),
      };
    }
    return {
      occurredAt: new Date().toISOString(),
      source: 'manual',
      message: clean(line, 500),
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
  const SUPABASE_URL = envUrl();
  const SUPABASE_ANON_KEY = envAnonKey();
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
    // 400/413 : contenu refusé par le serveur (format ou taille) — le renvoyer
    // tel quel échouerait toujours ; on l'abandonne pour ne pas boucler.
    if (resp.status === 400 || resp.status === 413) {
      clearBuffer();
      markFlushed();
      return { sent: 0, ok: false };
    }
    // 429 : limite de débit — on garde le buffer et on attend le prochain créneau.
    if (resp.status === 429) markFlushed();
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
