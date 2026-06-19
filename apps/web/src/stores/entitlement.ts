/**
 * Store Alpine `entitlement` — plan free/Pro de l'utilisateur.
 *
 * Charge l'Entitlement depuis le stockage, démarre un essai Pro de 7 jours au
 * tout premier lancement, et expose `isPro` / `can(feature)` aux écrans pour
 * gater la couche intelligence. Les règles vivent dans `entitlements.domain`
 * (@kinetic/core) ; ce store ne fait que l'état + la persistance.
 *
 * Tant que le paiement (Stripe) n'est pas branché, `setTier()` permet de
 * basculer manuellement (utile pour tester / offrir le Pro).
 */
import {
  STORAGE_KEYS,
  effectiveTier,
  isPro as isProDomain,
  isOnTrial as isOnTrialDomain,
  canUse,
  startTrial,
  type Entitlement,
  type ProFeature,
} from '@kinetic/core';
import { getDeps } from '../deps';

const KEY = STORAGE_KEYS.ENTITLEMENT;

export function entitlementStore() {
  return {
    entitlement: {} as Entitlement,
    loaded: false,

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const stored = await deps.storage.get<Entitlement>(KEY);
        if (stored) {
          this.entitlement = stored;
        } else {
          // Premier lancement → essai Pro de 7 jours.
          this.entitlement = startTrial();
          await deps.storage.set(KEY, this.entitlement);
        }
      } catch (err) {
        console.error('[entitlement] init failed:', err);
        this.entitlement = {}; // repli : gratuit
      } finally {
        this.loaded = true;
      }
    },

    get tier(): 'free' | 'pro' {
      return effectiveTier(this.entitlement);
    },

    get isPro(): boolean {
      return isProDomain(this.entitlement);
    },

    get isOnTrial(): boolean {
      return isOnTrialDomain(this.entitlement);
    },

    /** Jours d'essai restants (0 si pas d'essai actif). */
    get trialDaysLeft(): number {
      if (!this.isOnTrial || !this.entitlement.trialEndsAt) return 0;
      const ms = Date.parse(this.entitlement.trialEndsAt) - Date.now();
      return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    },

    /** L'utilisateur a-t-il accès à cette feature Pro ? */
    can(feature: ProFeature): boolean {
      return canUse(this.entitlement, feature);
    },

    /**
     * setTier — bascule manuelle free/Pro (avant Stripe). En 'pro', pose un
     * proUntil lointain ; en 'free', purge l'abonnement et l'essai.
     */
    async setTier(tier: 'free' | 'pro'): Promise<void> {
      this.entitlement =
        tier === 'pro'
          ? { tier: 'pro', proUntil: null, trialEndsAt: null }
          : { tier: 'free', proUntil: null, trialEndsAt: null };
      try {
        const deps = await getDeps();
        await deps.storage.set(KEY, this.entitlement);
      } catch (err) {
        console.error('[entitlement] setTier failed:', err);
      }
    },
  };
}
