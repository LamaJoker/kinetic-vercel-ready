/**
 * Store Alpine `entitlement` — plan free/Pro de l'utilisateur.
 *
 * Deux sources, par ordre de priorité :
 *
 * 1. `server` — utilisateur connecté : plan lu dans la table Supabase
 *    `entitlements` (migration 009). Non modifiable par le client ; le coach IA
 *    le revérifie côté serveur. Mis en cache (localStorage) pour le hors-ligne.
 * 2. `local`  — mode invité : essai de 7 jours stocké sur l'appareil. Une PWA
 *    offline ne peut pas protéger des calculs faits localement ; ce plan ne
 *    débloque donc que des fonctionnalités 100 % locales.
 *
 * Tant que le paiement (Stripe) n'est pas branché, la bascule manuelle
 * `setTier()` n'existe qu'en développement ou avec `VITE_DEMO_UNLOCK_PRO=true`
 * (démo portfolio), et uniquement pour la source locale.
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
import { fetchServerEntitlement } from '@kinetic/adapters-web';
import { getDeps } from '../deps';

const KEY = STORAGE_KEYS.ENTITLEMENT;
const CACHE_KEY = STORAGE_KEYS.ENTITLEMENT_SERVER_CACHE;

export type EntitlementSource = 'server' | 'server-cache' | 'local';

function demoUnlockEnabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env ?? {};
  return env['DEV'] === true || env['VITE_DEMO_UNLOCK_PRO'] === 'true';
}

function readCache(): Entitlement | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Entitlement) : null;
  } catch {
    return null;
  }
}

function writeCache(value: Entitlement): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    /* localStorage indisponible (navigation privée) */
  }
}

let authListenerInstalled = false;

export function entitlementStore() {
  return {
    entitlement: {} as Entitlement,
    source: 'local' as EntitlementSource,
    loaded: false,

    async init(): Promise<void> {
      if (!authListenerInstalled && typeof window !== 'undefined' && window.addEventListener) {
        authListenerInstalled = true;
        window.addEventListener(STORAGE_KEYS.EVENT_AUTH_CHANGED, () => void this.init());
      }

      try {
        if (await this.loadFromServer()) return;
        await this.loadLocal();
      } finally {
        this.loaded = true;
      }
    },

    /** @returns true si un plan serveur (ou son cache) a été appliqué. */
    async loadFromServer(): Promise<boolean> {
      try {
        const server = await fetchServerEntitlement();
        if (!server) return false; // invité ou Supabase non configuré
        this.entitlement = server;
        this.source = 'server';
        writeCache(server);
        return true;
      } catch (err) {
        const cached = readCache();
        if (cached) {
          this.entitlement = cached;
          this.source = 'server-cache';
          return true;
        }
        console.warn('[entitlement] plan serveur indisponible, repli local:', err);
        return false;
      }
    },

    async loadLocal(): Promise<void> {
      this.source = 'local';
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

    /** Bascule manuelle autorisée ? (dev / démo, plan local uniquement) */
    get canSelfUpgrade(): boolean {
      return this.source === 'local' && demoUnlockEnabled();
    },

    /** L'utilisateur a-t-il accès à cette feature Pro ? */
    can(feature: ProFeature): boolean {
      return canUse(this.entitlement, feature);
    },

    /**
     * setTier — bascule manuelle free/Pro (démo, avant Stripe).
     * Refusée pour un plan serveur : seul le backend peut modifier `entitlements`.
     */
    async setTier(tier: 'free' | 'pro'): Promise<void> {
      if (!this.canSelfUpgrade) {
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'info', message: 'Le paiement Pro arrive bientôt.' },
            }),
          );
        }
        return;
      }
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
