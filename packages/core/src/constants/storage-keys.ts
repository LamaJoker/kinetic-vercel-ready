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
  // IDs des tâches par défaut masquées par l'utilisateur (réversible)
  VITALITE_HIDDEN_TASKS: 'kinetic:vitalite:hiddenIds' as const,
  // Date de dernière complétion par tâche à intervalle (non-quotidienne)
  VITALITE_INTERVAL_LAST_DONE: 'kinetic:vitalite:interval-last-done' as const,

  // ─── Nutrition ────────────────────────────────────────────────
  NUTRITION_LOG: (date: string) => `kinetic:nutrition:log:${date}` as const,
  NUTRITION_PLAN: 'kinetic:nutrition:plan' as const,
  NUTRITION_CUSTOM_FOODS: 'kinetic:nutrition:custom-foods' as const,

  // ─── Entraînement ─────────────────────────────────────────────
  /** @deprecated Format historique (tableau unique). Lu uniquement pour la migration v2. */
  TRAINING_SESSIONS: 'kinetic:training:sessions' as const,
  /** Une clé par séance — évite la limite 1 MB et les conflits LWW sur tout l'historique. */
  TRAINING_SESSION: (id: string) => `kinetic:training:session:${id}` as const,
  TRAINING_SESSION_PREFIX: 'kinetic:training:session:' as const,
  TRAINING_TEMPLATES: 'kinetic:training:templates' as const,
  TRAINING_EXERCISES: 'kinetic:training:exercises' as const,
  /** Version du catalogue d'exercices stocké (cf. EXERCISE_CATALOG_VERSION), locale à l'appareil. */
  TRAINING_CATALOG_VERSION: 'kinetic:training:catalog-version' as const,
  /** Exercices créés par l'utilisateur (custom: true) : à part du catalogue, qui peut être remplacé. */
  TRAINING_CUSTOM_EXERCISES: 'kinetic:training:custom-exercises' as const,
  /** Modèle ouvert dans l'éditeur (sessionStorage, survit au rechargement). */
  TEMPLATE_EDITOR_ID: 'kinetic:template-editor:id' as const,
  /** Séance en cours (brouillon + repos), locale à l'appareil : survit au changement d'onglet,
   *  au rechargement et à la fermeture de l'app par l'OS. Effacée à la sauvegarde ou à l'abandon. */
  TRAINING_ACTIVE_SESSION: 'kinetic:training:active-session' as const,

  // ─── Programme ────────────────────────────────────────────────
  PROGRAM: 'kinetic:program' as const,
  PROGRAM_ACTIVE: 'kinetic:program:active' as const,
  PROGRAM_GENERATED_COUNT: 'kinetic:program:generatedCount' as const,
  PROGRAM_COMPLETED_DAYS: (weekKey: string) => `kinetic:program:completedDays:${weekKey}` as const,
  PROGRAM_TODO_STATUS: (dayKey: string) => `kinetic:program:todoStatus:${dayKey}` as const,
  // Clé sessionStorage : template pré-sélectionné depuis la page Programme
  PROGRAM_AUTO_TEMPLATE: 'kinetic:program:auto-template' as const,
  /** Semaine qui s'adapte : { week, programId, moves, skipped, unavailable } (semaine en cours). */
  PROGRAM_WEEK_PLAN: 'kinetic:program:week-plan' as const,

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
  /** Mode démo : liste des clés écrites par le jeu de données de démo (pour le retirer proprement). */
  /** sessionStorage : compte supprimé (message sur l'écran de connexion). */
  ACCOUNT_DELETED: 'kinetic:account-deleted' as const,
  DEMO_MANIFEST: 'kinetic:demo:manifest' as const,
  PROFILE: 'kinetic:profile' as const, // displayName et préférences UI
  STATS: 'kinetic:stats' as const, // stats agrégées en cache (totalSessions, etc.)

  // ─── Objectifs ────────────────────────────────────────────────
  GOALS: 'kinetic:goals' as const,
  GOALS_WEEKLY: 'kinetic:goals:weekly' as const,
  /** Objectifs de force (« Squat 140 kg ») : StrengthGoal[]. */
  STRENGTH_GOALS: 'kinetic:goals:strength' as const,
  /** Alertes de plateau masquées : exercice → date ISO de fin du masquage. */
  PLATEAU_DISMISSED: 'kinetic:plateau:dismissed' as const,

  // ─── Récompenses ──────────────────────────────────────────────
  REWARDS_UNLOCKED: 'kinetic:rewards:unlocked' as const,
  REWARDS_FREEZE_TOKENS: 'kinetic:rewards:freeze-tokens' as const,
  REWARDS_FREEZE_WEEK: 'kinetic:rewards:freeze-replenished-week' as const,
  REWARDS_THEME: 'kinetic:rewards:theme' as const,

  // ─── Achievements (badges débloqués par exploit) ──────────────
  ACHIEVEMENTS_UNLOCKED: 'kinetic:achievements:unlocked' as const,

  // ─── Préférences UI ───────────────────────────────────────────
  PREF_UNIT: 'kinetic:pref:unit' as const, // 'kg' | 'lb'

  // ─── Plate calculator ─────────────────────────────────────────
  PLATE_PREFS: 'kinetic:plate-prefs' as const,

  // ─── Import en attente depuis ?import=<token> ─────────────────
  // sessionStorage : ne survit pas au rechargement complet, on consomme
  // dès que la page Séances est rendue.
  PENDING_SHARED_IMPORT: 'kinetic:pending-shared-import' as const,

  // ─── Tâches internes (usecases) ───────────────────────────────
  AWARDED_IDS: 'kinetic:awarded-ids' as const,
  COMPLETED_KEYS: 'kinetic:completed-keys' as const,
  VITALITE_LAST_RESET: 'kinetic:vitalite:last-reset' as const,
  PENDING_TASK_MUTATION: 'kinetic:pending:task-mutation' as const,

  // ─── Sync interne ─────────────────────────────────────────────
  SYNC_LAST_AT: 'kinetic:sync:last-at' as const,
  /** Curseur serveur (updated_at max reçu) — remplace SYNC_LAST_AT basé sur l'horloge client. */
  SYNC_CURSOR: 'kinetic:sync:cursor' as const,
  /** Outbox persistante des écritures non confirmées par le cloud (survit au reload). */
  SYNC_OUTBOX: 'kinetic:sync:outbox' as const,
  /** sessionStorage : horodatage du dernier reload après un chunk introuvable (anti-boucle). */
  PRELOAD_RELOAD_AT: 'kinetic:preload-reload-at' as const,
  SYNC_INITIAL_DONE: '_kinetic:initial-sync-done' as const,
  DEVICE_ID: 'kinetic:deviceId' as const,

  // ─── Rappels & Notifications ──────────────────────────────────
  NOTIFICATIONS_ENABLED: 'kinetic:notifications:enabled' as const,
  REMINDER_DATE: 'kinetic:reminder:lastDate' as const,
  REMINDER_PREFS: 'kinetic:reminder:prefs' as const, // localStorage, réglages des rappels
  BACKUP_LAST_AT: 'kinetic:backup:lastAt' as const, // localStorage, date du dernier export
  AUTO_BACKUP_LAST_AT: 'kinetic:backup:autoLastAt' as const, // localStorage, dernière sauvegarde auto (natif)
  AUTO_BACKUP_OFF: 'kinetic:backup:autoOff' as const, // localStorage, '1' = sauvegarde auto désactivée
  FIRST_SEEN_AT: 'kinetic:firstSeenAt' as const, // localStorage, premier lancement
  REST_ALERT_ASKED: 'kinetic:restAlert:asked' as const, // localStorage, permission d'alerte de repos déjà demandée
  BACKUP_REMINDED_AT: 'kinetic:backup:remindedAt' as const, // localStorage, dernier rappel de sauvegarde programmé
  HEALTH_ENABLED: 'kinetic:health:enabled' as const, // localStorage, Health Connect activé
  DAILY_LOG: (date: string) => `kinetic:dailyLog:${date}` as const,
  PWA_INSTALL_DISMISSED: 'kinetic:pwa:install-dismissed' as const, // localStorage, timestamp du dernier dismiss
  PROGRESS_PHOTOS: 'kinetic:progress-photos' as const, // IDB, blobs photos compressés
  ACTIVE_PROGRAM: 'kinetic:active-program' as const, // user-selected program state
  PROGRAM_ONE_RMS: 'kinetic:program:one-rms' as const, // user 1RM input for programs
  AVAILABLE_EQUIPMENT: 'kinetic:available-equipment' as const, // user inventory for substitutions
  STRENGTH_SCORE_PROFILE: 'kinetic:strength-score-profile' as const, // bw + sex pour Wilks/IPF GL/DOTS
  THEME_MODE: 'kinetic:theme-mode' as const, // 'system' | 'dark' | 'light' — defaut dark
  DISPLAY_DENSITY: 'kinetic:display-density' as const, // 'simple' | 'advanced' — defaut simple
  HAPTICS_ENABLED: 'kinetic:haptics' as const, // localStorage, '0' = vibrations coupées (défaut : actives)
  WAKE_LOCK_ENABLED: 'kinetic:wake-lock' as const, // localStorage, '0' = écran libre en séance (défaut : gardé allumé)

  // ─── Schéma IDB & Diagnostics ─────────────────────────────────
  SCHEMA_VERSION: 'kinetic:schema-version' as const,
  SCHEMA_MIGRATION_LOCK: 'kinetic:schema-migration' as const,
  AUTH_DEBUG: 'kinetic:auth-debug' as const, // localStorage, diagnostic OAuth APK
  ERRORS: 'kinetic:errors' as const, // localStorage, buffer d'erreurs runtime

  // ─── Événements DOM (CustomEvent names) ────────────────────────
  EVENT_NOTIFY: 'kinetic:notify' as const,
  EVENT_AUTH_CHANGED: 'kinetic:auth-changed' as const,
  EVENT_AUTH_READY: 'kinetic:auth-ready' as const,
  EVENT_DEPS_READY: 'kinetic:deps-ready' as const,
  EVENT_ONBOARDING_COMPLETE: 'kinetic:onboarding-complete' as const,
  EVENT_LEVELUP: 'kinetic:levelup' as const,
  EVENT_CELEBRATE: 'kinetic:celebrate' as const, // record battu, routine à 100 % (lib/celebration.ts)
  EVENT_XP_UPDATED: 'kinetic:xp-updated' as const,
  EVENT_STREAK_UPDATED: 'kinetic:streak-updated' as const,
  EVENT_SESSION_SAVED: 'kinetic:session-saved' as const,
  EVENT_ACTIVE_SESSION_CHANGED: 'kinetic:active-session-changed' as const, // bandeau « Séance en cours »
  EVENT_SYNC_FAILED: 'kinetic:sync-failed' as const,
  EVENT_ROUTE_CHANGED: 'kinetic:route-changed' as const,
  EVENT_THEME_CHANGED: 'kinetic:theme-changed' as const,
  EVENT_DENSITY_CHANGED: 'kinetic:density-changed' as const,
  EVENT_WAKE_LOCK_CHANGED: 'kinetic:wake-lock-changed' as const, // réglage « Garder l'écran allumé en séance »
  EVENT_REFRESH: 'kinetic:refresh' as const, // tirer pour rafraîchir (lib/native-gestures.ts)
  ERRORS_LAST_FLUSH: 'kinetic:errors:last-flush' as const, // localStorage, throttle exfiltration
} as const;

/** Type union de toutes les clés statiques (sans les fonctions) */
export type StaticStorageKey = {
  [K in keyof typeof STORAGE_KEYS]: (typeof STORAGE_KEYS)[K] extends string
    ? (typeof STORAGE_KEYS)[K]
    : never;
}[keyof typeof STORAGE_KEYS];
