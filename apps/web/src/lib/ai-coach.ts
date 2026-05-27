/**
 * AI Coach — client de l'Edge Function `ai-coach`.
 *
 * Pipeline :
 *   1. Récupère les N dernières séances et la session courante (contexte).
 *   2. POST authentifié à `/functions/v1/ai-coach` avec question + contexte.
 *   3. Affiche la réponse.
 *
 * Dégrade gracieusement : si `VITE_SUPABASE_URL` est manquant, lève une
 * erreur explicite (l'UI désactive le bouton).
 */

import { STORAGE_KEYS } from '@kinetic/core';
import type { WorkoutSession } from './training/types';

const SUPABASE_URL = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  ?.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  ?.VITE_SUPABASE_ANON_KEY;

export interface CoachQuery {
  question: string;
  recentSessions: WorkoutSession[];
}

export interface CoachAnswer {
  answer: string;
}

export function isAiCoachAvailable(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}

export async function askCoach(query: CoachQuery): Promise<CoachAnswer> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase non configuré — coach IA indisponible.');
  }
  // On utilise le token JWT du user courant si dispo, sinon la clé anon.
  let token = SUPABASE_ANON_KEY;
  try {
    const { supabase } = await import('@kinetic/adapters-web');
    if (supabase) {
      const sb = supabase as unknown as {
        auth: { getSession: () => Promise<{ data: { session: { access_token: string } | null } }> };
      };
      const { data } = await sb.auth.getSession();
      if (data.session?.access_token) token = data.session.access_token;
    }
  } catch {
    /* anonymous fallback */
  }

  // Compression du contexte : on ne garde que 50 séances et on retire les
  // champs verbeux pour rester sous la limite 20 KB côté Edge Function.
  const slim = query.recentSessions.slice(-50).map((s) => ({
    name: s.name,
    at: s.startedAt,
    avgRpe: s.avgRpe ?? null,
    durationMin: s.durationMin ?? null,
    entries: s.entries.map((e) => ({
      ex: e.exerciseId,
      sets: e.sets.map((set) => ({ r: set.reps, kg: set.weightKg, rpe: set.rpe })),
    })),
  }));

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/ai-coach`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      question: query.question,
      context: { sessions: slim },
    }),
  });
  if (!resp.ok) {
    throw new Error(`Coach IA indisponible (HTTP ${resp.status}).`);
  }
  const data = (await resp.json()) as { answer?: string; error?: string };
  if (data.error) throw new Error(`Coach IA : ${data.error}`);
  return { answer: (data.answer ?? '').trim() };
}

/** Helper pour notifier l'UI sans wrapper try/catch côté composant. */
export function dispatchCoachError(message: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
      detail: { kind: 'error', message },
    }),
  );
}
