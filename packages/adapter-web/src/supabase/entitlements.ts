import type { Entitlement } from '@kinetic/core';
import { supabase } from './auth.js';

/**
 * fetchServerEntitlement — lit le plan de l'utilisateur connecté dans la table
 * `entitlements` (migration 009). Le client ne peut PAS écrire cette table :
 * c'est la source de vérité pour les fonctionnalités vérifiées côté serveur
 * (coach IA).
 *
 * @returns `null` si Supabase n'est pas configuré ou si personne n'est connecté.
 * @throws  si la requête échoue (hors-ligne, projet en pause, migration absente).
 */
export async function fetchServerEntitlement(): Promise<Entitlement | null> {
  if (!supabase) return null;

  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from('entitlements')
    .select('tier, pro_until, trial_ends_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`[entitlements] ${error.message}`);
  if (!data) return { tier: 'free', proUntil: null, trialEndsAt: null };

  return {
    tier: data.tier === 'pro' ? 'pro' : 'free',
    proUntil: data.pro_until,
    trialEndsAt: data.trial_ends_at,
  };
}
