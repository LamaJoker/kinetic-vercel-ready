/**
 * Dictionnaire FR — strings critiques uniquement (UI minimum viable).
 *
 * Convention de nommage : <page>.<element>.
 * Pour l'interpolation, utiliser {var} dans la string : "Niveau {level}".
 */
export const fr: Record<string, string> = {
  // ─── Generic / actions ─────────────────────────────────────────
  'common.save': 'Enregistrer',
  'common.cancel': 'Annuler',
  'common.delete': 'Supprimer',
  'common.confirm': 'Confirmer',
  'common.close': 'Fermer',
  'common.loading': 'Chargement…',
  'common.error': 'Erreur',
  'common.share': 'Partager',
  'common.copy': 'Copier',
  'common.add': 'Ajouter',
  'common.remove': 'Retirer',
  'common.edit': 'Modifier',
  'common.back': 'Retour',
  'common.yes': 'Oui',
  'common.no': 'Non',
  'common.kg': 'kg',
  'common.reps': 'reps',
  'common.rpe': 'RPE',
  'common.minutes': 'minutes',
  'common.seconds': 'sec',

  // ─── Navigation ─────────────────────────────────────────────────
  'nav.dashboard': 'Accueil',
  'nav.sessions': 'Séances',
  'nav.progression': 'Progression',
  'nav.profile': 'Profil',
  'nav.programs': 'Programmes',
  'nav.records': 'Records',
  'nav.photos': 'Photos',

  // ─── Login ─────────────────────────────────────────────────────
  'login.title': 'Connexion',
  'login.email': 'Email',
  'login.password': 'Mot de passe',
  'login.submit': 'Se connecter',
  'login.google': 'Continuer avec Google',
  'login.guest': 'Continuer en mode invité',
  'login.signup': "S'inscrire",

  // ─── Dashboard ─────────────────────────────────────────────────
  'dashboard.welcome': 'Bonjour !',
  'dashboard.next_workout': 'Prochaine séance',
  'dashboard.start_workout': 'Commencer',
  'dashboard.streak': 'Série',
  'dashboard.streak_days': '{count} jour(s)',
  'dashboard.level': 'Niveau {level}',
  'dashboard.weekly_goals': 'Objectifs hebdo',

  // ─── Sessions ─────────────────────────────────────────────────
  'sessions.title': 'Séances',
  'sessions.current': 'Séance en cours',
  'sessions.none': 'Aucune séance en cours',
  'sessions.free': 'Séance libre',
  'sessions.start_free': 'Démarrer libre',
  'sessions.templates': 'Modèles',
  'sessions.auto': 'Générer auto',
  'sessions.rest': 'Repos',
  'sessions.skip_rest': 'Passer',
  'sessions.add_set': '+ Série',
  'sessions.add_exercise': 'Ajouter un exercice',
  'sessions.new_pr': 'Nouveau record !',
  'sessions.save': 'Sauver',
  'sessions.history': 'Historique',

  // ─── Profile ──────────────────────────────────────────────────
  'profile.title': 'Profil',
  'profile.display_name': "Nom d'affichage",
  'profile.export': 'Exporter mes données',
  'profile.import': 'Importer',
  'profile.notifications': 'Notifications push',
  'profile.notifications_enable': 'Activer les notifications',
  'profile.notifications_disable': 'Désactiver',
  'profile.share_profile': 'Partager mon profil',
  'profile.language': 'Langue',
  'profile.logout': 'Se déconnecter',

  // ─── Programs ─────────────────────────────────────────────────
  'programs.title': 'Programmes pré-écrits',
  'programs.choose': 'Choisis un programme',
  'programs.start': 'Démarrer le programme',
  'programs.week': 'Semaine {n}',
  'programs.duration': '{weeks} semaines',
  'programs.days_per_week': '{n} jours/semaine',
  'programs.your_1rm': 'Tes 1RM (kg)',
  'programs.required_1rm': '1RM requis pour ce programme',

  // ─── Photos ───────────────────────────────────────────────────
  'photos.title': 'Photos de progrès',
  'photos.add': 'Ajouter une photo',
  'photos.before_after': 'Avant / Après',
  'photos.weight_kg': 'Poids (kg)',

  // ─── Records / Strength ───────────────────────────────────────
  'records.wilks': 'Wilks',
  'records.ipf_gl': 'IPF GL',
  'records.dots': 'DOTS',
  'records.tier_beginner': 'Débutant',
  'records.tier_novice': 'Novice',
  'records.tier_intermediate': 'Intermédiaire',
  'records.tier_advanced': 'Avancé',
  'records.tier_elite': 'Elite',

  // ─── PWA install ──────────────────────────────────────────────
  'pwa.install': "Installer l'application",
  'pwa.install_ios':
    "Sur iPhone : appuie sur Partager (□↑) puis « Sur l'écran d'accueil » pour installer Kinetic.",
  'pwa.dismiss': 'Plus tard',

  // ─── Dashboard tools ──────────────────────────────────────────
  'tools.plates': 'Calculateur plates',
  'tools.plates_sub': 'Combien par côté ?',
  'tools.achievements': 'Achievements',
  'tools.achievements_sub': 'débloqués',
  'tools.ai_coach': 'Coach IA',
  'tools.ai_coach_sub': 'Pose une question sur ta progression',

  // ─── Dashboard greeting ───────────────────────────────────────
  'greeting.morning': 'Bonjour 👋',
  'greeting.afternoon': 'Bon après-midi 🌤️',
  'greeting.evening': 'Bonsoir 🌙',

  // ─── Login full ───────────────────────────────────────────────
  'login.subtitle': 'Connexion magique sans mot de passe',
  'login.email_placeholder': 'ton@email.com',
  'login.magic_link': 'Recevoir un lien magique',
  'login.or': 'ou',
  'login.no_account': 'Pas de compte ? On en crée un automatiquement.',

  // ─── Records ──────────────────────────────────────────────────
  'records.title': 'Records',
  'records.active_prs': 'PR actifs',
  'records.last_7d': '7 derniers j',
  'records.top_e1rm': 'Top e1RM',
  'records.strength_scores': 'Scores de force',
  'records.sbd_normalized': 'SBD normalisé',
  'records.bodyweight': 'Poids (kg)',
  'records.sex': 'Sexe',
  'records.total_sbd': 'Total SBD',
  'records.tier': 'Tier',
  'records.scores_help':
    'Renseigne ton poids corporel et fais au moins un PR en squat / bench / deadlift.',
};
