/**
 * STORAGE_KEYS — constantes centralisées pour toutes les clés IndexedDB / Supabase.
 *
 * Pourquoi centraliser ?
 *   Les magic strings dispersées dans 8+ fichiers créent des bugs silencieux :
 *   une typo dans une clé → les données ne sont jamais lues, sans erreur visible.
 *   Un objet typé ici force une erreur TS dès la compile si une clé est mal orthographiée.
 *
 * Convention : `kinetic:<domaine>:<sous-clé>` (lowercase, séparateurs `:`)
 *
 * IMPORTANT : certaines clés (_DEBUG, _ERRORS, _COACH_GOAL, _AUTO_TEMPLATE) ciblent
 * localStorage / sessionStorage plutôt que StoragePort (IDB). Elles sont listées ici
 * pour garantir la cohérence des noms.
 */

// ─── XP & Niveaux ─────────────────────────────────────────────
export const STORAGE_KEYS = {
  // XP global
  XP: 'kinetic:xp' as const,

  // Streak
  STREAK: 'kinetic:streak' as const,

  // XP gagné par date ISO (kinetic:xp:earned:YYYY-MM-DD)
  XP_EARNED: (date: string) => `kinetic:xp:earned:${date}` as const,
  // Préfixe pour le scan de maintenance (storage-maintenance.ts)
  XP_EARNED_PREFIX: 'kinetic:xp:earned:' as const,

  // ─── Vitalité ─────────────────────────────────────────────────
  // Tâches complétées par date (kinetic:vitalite:done:YYYY-MM-DD)
  VITALITE_DONE: (date: string) => `kinetic:vitalite:done:${date}` as const,
  // Préfixe pour le scan de maintenance
  VITALITE_DONE_PREFIX: 'kinetic:vitalite:done:' as const,
  // Tâches de base (définition)
  VITALITE_TASKS: 'kinetic:vitalite:tasks' as const,
  // Tâches personnalisées créées par l'utilisateur
  VITALITE_CUSTOM_TASKS: 'kinetic:vitalite:custom-tasks' as const,

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
  PROGRAM_ACTIVE: 'kinetic:program:active' as const,
  PROGRAM_GENERATED_COUNT: 'kinetic:program:generatedCount' as const,
  PROGRAM_COMPLETED_DAYS: (weekKey: string) => `kinetic:program:completedDays:${weekKey}` as const,
  PROGRAM_TODO_STATUS: (dayKey: string) => `kinetic:program:todoStatus:${dayKey}` as const,
  // Clé sessionStorage : template pré-sélectionné depuis la page Programme
  PROGRAM_AUTO_TEMPLATE: 'kinetic:program:auto-template' as const,

  // ─── Objectif coach séance (localStorage) ─────────────────────
  COACH_GOAL: 'kinetic:coach-goal' as const,

  // ─── Mesures corporelles ──────────────────────────────────────
  BODYWEIGHT_ENTRIES: 'kinetic:bodyweight:entries' as const,
  BODYWEIGHT_GOAL: 'kinetic:bodyweight:goal' as const,
  MEASUREMENTS_ENTRIES: 'kinetic:measurements:entries' as const,
  MEASUREMENTS_PHOTOS: 'kinetic:measurements:photos' as const,
  MEASUREMENT_PHOTO_DATA: (id: string) => `kinetic:measurements:photo:${id}` as const,

  // ─── Profil utilisateur ───────────────────────────────────────
  USER_PROFILE: 'kinetic:userProfile' as const,
  PROFILE: 'kinetic:profile' as const, // displayName et préférences UI
  STATS: 'kinetic:stats' as const, // stats agrégées en cache (totalSessions, etc.)

  // ─── Objectifs ────────────────────────────────────────────────
  GOALS: 'kinetic:goals' as const,
  GOALS_WEEKLY: 'kinetic:goals:weekly' as const,

  // ─── Récompenses ──────────────────────────────────────────────
  REWARDS_UNLOCKED: 'kinetic:rewards:unlocked' as const,
  REWARDS_FREEZE_TOKENS: 'kinetic:rewards:freeze-tokens' as const,
  REWARDS_FREEZE_WEEK: 'kinetic:rewards:freeze-replenished-week' as const,
  REWARDS_THEME: 'kinetic:rewards:theme' as const,

  // ─── Tâches internes (usecases) ───────────────────────────────
  AWARDED_IDS: 'kinetic:awarded-ids' as const,
  COMPLETED_KEYS: 'kinetic:completed-keys' as const,
  VITALITE_LAST_RESET: 'kinetic:vitalite:last-reset' as const,
  PENDING_TASK_MUTATION: 'kinetic:pending:task-mutation' as const,

  // ─── Sync interne ─────────────────────────────────────────────
  SYNC_LAST_AT: 'kinetic:sync:last-at' as const,
  SYNC_INITIAL_DONE: '_kinetic:initial-sync-done' as const,
  DEVICE_ID: 'kinetic:deviceId' as const,

  // ─── Rappels & Notifications ──────────────────────────────────
  NOTIFICATIONS_ENABLED: 'kinetic:notifications:enabled' as const,
  REMINDER_DATE: 'kinetic:reminder:lastDate' as const,
  DAILY_LOG: (date: string) => `kinetic:dailyLog:${date}` as const,

  // ─── Schéma IDB & Diagnostics ─────────────────────────────────
  SCHEMA_VERSION: 'kinetic:schema-version' as const,
  AUTH_DEBUG: 'kinetic:auth-debug' as const, // localStorage, diagnostic OAuth APK
  ERRORS: 'kinetic:errors' as const, // localStorage, buffer d'erreurs runtime

  // ─── Événements DOM (CustomEvent names) ────────────────────────
  EVENT_NOTIFY: 'kinetic:notify' as const,
  EVENT_AUTH_CHANGED: 'kinetic:auth-changed' as const,
  EVENT_AUTH_READY: 'kinetic:auth-ready' as const,
  EVENT_DEPS_READY: 'kinetic:deps-ready' as const,
  EVENT_ONBOARDING_COMPLETE: 'kinetic:onboarding-complete' as const,
  EVENT_LEVELUP: 'kinetic:levelup' as const,
  EVENT_XP_UPDATED: 'kinetic:xp-updated' as const,
  EVENT_STREAK_UPDATED: 'kinetic:streak-updated' as const,
  EVENT_SESSION_SAVED: 'kinetic:session-saved' as const,
  EVENT_SYNC_FAILED: 'kinetic:sync-failed' as const,
  EVENT_ROUTE_CHANGED: 'kinetic:route-changed' as const,
} as const;

/** Type union de toutes les clés statiques (sans les fonctions) */
export type StaticStorageKey = {
  [K in keyof typeof STORAGE_KEYS]: (typeof STORAGE_KEYS)[K] extends string
    ? (typeof STORAGE_KEYS)[K]
    : never;
}[keyof typeof STORAGE_KEYS];
