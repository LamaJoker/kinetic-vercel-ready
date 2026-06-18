/**
 * Entitlements Domain — couche d'accès gratuit / Pro (sans paiement).
 *
 * Encode le modèle de monétisation : l'historique et le log restent gratuits
 * (l'historique EST le produit) ; on gate la couche *intelligence*
 * (auto-progression, deload, analytics avancées, AI coach, scan nutrition,
 * programmes illimités, export). Le paiement (Stripe) viendra brancher un
 * `Entitlement` ; ce module ne décide que « ce plan donne-t-il accès à X ».
 *
 * Pur — aucune dépendance, aucun I/O. Source de vérité unique des règles d'accès.
 */

/** Niveau effectif d'un utilisateur. */
export type PlanTier = 'free' | 'pro';

/** Capacités gatées derrière le Pro. Le reste de l'app est gratuit. */
export type ProFeature =
  | 'auto_progression' // suggestions de charge RPE-aware
  | 'deload_advisor' // recommandation de semaine de décharge
  | 'advanced_analytics' // bilan hebdo, heatmap, volume/muscle, courbes e1RM, PR
  | 'ai_coach' // coach IA
  | 'nutrition_scanner' // scan code-barres OpenFoodFacts
  | 'unlimited_programs' // au-delà de la limite gratuite
  | 'data_export'; // export JSON/CSV

/** Liste figée des features Pro (utile pour l'UI : page d'upgrade, etc.). */
export const PRO_FEATURES: readonly ProFeature[] = [
  'auto_progression',
  'deload_advisor',
  'advanced_analytics',
  'ai_coach',
  'nutrition_scanner',
  'unlimited_programs',
  'data_export',
];

/** Nombre de programmes actifs autorisés en gratuit. */
export const FREE_ACTIVE_PROGRAM_LIMIT = 1;

/** Durée d'essai Pro offerte à l'inscription (jours). */
export const TRIAL_DAYS = 7;

/**
 * État d'abonnement persisté (renseigné plus tard par la couche paiement).
 * Tout optionnel → un objet vide = utilisateur gratuit.
 */
export interface Entitlement {
  /** Plan « acheté ». Par défaut 'free'. */
  tier?: PlanTier;
  /** Fin d'abonnement Pro (ISO). Si dépassé, retombe en 'free' (sauf essai actif). */
  proUntil?: string | null;
  /** Fin de période d'essai (ISO). Donne un accès Pro effectif tant que > maintenant. */
  trialEndsAt?: string | null;
}

function isFuture(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > nowMs;
}

/**
 * effectiveTier — niveau RÉEL compte tenu de l'expiration et de l'essai.
 * Pro si : abonnement Pro non expiré, OU essai encore actif.
 */
export function effectiveTier(
  entitlement: Entitlement | null | undefined,
  nowIso: string = new Date().toISOString(),
): PlanTier {
  const e = entitlement ?? {};
  const nowMs = Date.parse(nowIso);

  if (e.tier === 'pro') {
    // proUntil absent → Pro permanent (ou géré ailleurs) ; sinon vérifier l'expiration.
    if (e.proUntil == null || isFuture(e.proUntil, nowMs)) return 'pro';
  }
  if (isFuture(e.trialEndsAt, nowMs)) return 'pro';
  return 'free';
}

/** Raccourci booléen. */
export function isPro(entitlement: Entitlement | null | undefined, nowIso?: string): boolean {
  return effectiveTier(entitlement, nowIso) === 'pro';
}

/** L'utilisateur est-il en période d'essai (Pro effectif uniquement grâce au trial) ? */
export function isOnTrial(
  entitlement: Entitlement | null | undefined,
  nowIso: string = new Date().toISOString(),
): boolean {
  const e = entitlement ?? {};
  const nowMs = Date.parse(nowIso);
  const paidPro = e.tier === 'pro' && (e.proUntil == null || isFuture(e.proUntil, nowMs));
  return !paidPro && isFuture(e.trialEndsAt, nowMs);
}

/** Accès à une feature Pro précise. */
export function canUse(
  entitlement: Entitlement | null | undefined,
  feature: ProFeature,
  nowIso?: string,
): boolean {
  // Toutes les features listées sont Pro → accès ssi Pro effectif.
  return PRO_FEATURES.includes(feature) && isPro(entitlement, nowIso);
}

/** Nombre de programmes actifs autorisés selon le plan. */
export function activeProgramLimit(
  entitlement: Entitlement | null | undefined,
  nowIso?: string,
): number {
  return isPro(entitlement, nowIso) ? Infinity : FREE_ACTIVE_PROGRAM_LIMIT;
}

/**
 * startTrial — construit l'Entitlement d'un nouvel essai de TRIAL_DAYS jours.
 * À appeler à l'inscription (ou au 1er lancement).
 */
export function startTrial(nowIso: string = new Date().toISOString()): Entitlement {
  const end = new Date(Date.parse(nowIso) + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  return { tier: 'free', trialEndsAt: end.toISOString(), proUntil: null };
}
