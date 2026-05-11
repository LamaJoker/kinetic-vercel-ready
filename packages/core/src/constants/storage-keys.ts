/**
 * STORAGE_KEYS — constantes centralisées pour toutes les clés IndexedDB / Supabase.
 *
 * Pourquoi centraliser ?
 *   Les magic strings dispersées dans 8+ fichiers créent des bugs silencieux :
 *   une typo dans une clé → les données ne sont jamais lues, sans erreur visible.
 *   Un objet typé ici force une erreur TS dès la compile si une clé est mal orthographiée.
 *
 * Convention : `kinetic:<domaine>:<sous-clé>` (lowercase, séparateurs `:`)
 */

// ─── XP & Niveaux ─────────────────────────────────────────────
export const STORAGE_KEYS = {
  // XP global
  XP: 'kinetic:xp' as const,

  // Streak
  STREAK: 'kinetic:streak' as const,

  // XP gagné par date ISO (kinetic:xp:earned:YYYY-MM-DD)
  XP_EARNED: (date: string) => `kinetic:xp:earned:${date}` as const,

  // ─── Vitalité ─────────────────────────────────────────────────
  // Tâches complétées par date (kinetic:vitalite:done:YYYY-MM-DD)
  VITALITE_DONE: (date: string) => `kinetic:vitalite:done:${date}` as const,
  // Tâches de base (définition)
  VITALITE_TASKS: 'kinetic:vitalite:tasks' as const,

  // ─── Nutrition ────────────────────────────────────────────────
  NUTRITION_LOG: (date: string) => `kinetic:nutrition:log:${date}` as const,
  NUTRITION_PLAN: 'kinetic:nutrition:plan' as const,
  NUTRITION_CUSTOM_FOODS: 'kinetic:nutrition:custom-foods' as const,

  // ─── Entraînement ─────────────────────────────────────────────
  TRAINING_SESSIONS: 'kinetic:training:sessions' as const,
  TRAINING_TEMPLATES: 'kinetic:training:templates' as const,
  TRAINING_EXERCISES: 'kinetic:training:exercises' as const,

  // ─── Programme ────────────────────────────────────────────────
  PROGRAM: 'kinetic:program' as const,

  // ─── Mesures corporelles ──────────────────────────────────────
  BODYWEIGHT_ENTRIES: 'kinetic:bodyweight:entries' as const,
  MEASUREMENTS: 'kinetic:measurements' as const,
  MEASUREMENTS_PHOTOS: 'kinetic:measurements:photos' as const,

  // ─── Profil utilisateur ───────────────────────────────────────
  USER_PROFILE: 'kinetic:userProfile' as const,

  // ─── Objectifs ────────────────────────────────────────────────
  GOALS: 'kinetic:goals' as const,

  // ─── Récompenses ──────────────────────────────────────────────
  REWARDS_UNLOCKED: 'kinetic:rewards:unlocked' as const,

  // ─── Sync interne ─────────────────────────────────────────────
  // Dernier timestamp de sync delta (kinetic:sync:last-at)
  SYNC_LAST_AT:     'kinetic:sync:last-at' as const,
  // Flag de première sync complète effectuée
  SYNC_INITIAL_DONE: '_kinetic:initial-sync-done' as const,
  // Device ID unique pour CRDT
  DEVICE_ID:        'kinetic:deviceId' as const,

  // ─── Notifications ────────────────────────────────────────────
  NOTIFICATIONS_ENABLED: 'kinetic:notifications:enabled' as const,
} as const;

/** Type union de toutes les clés statiques (sans les fonctions) */
export type StaticStorageKey = {
  [K in keyof typeof STORAGE_KEYS]: (typeof STORAGE_KEYS)[K] extends string
    ? (typeof STORAGE_KEYS)[K]
    : never;
}[keyof typeof STORAGE_KEYS];
