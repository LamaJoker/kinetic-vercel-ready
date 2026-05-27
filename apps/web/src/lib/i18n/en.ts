/**
 * EN dictionary — must mirror fr.ts. Missing keys fall back to FR then to the
 * raw key (debuggable).
 */
export const en: Record<string, string> = {
  // ─── Generic / actions ─────────────────────────────────────────
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.confirm': 'Confirm',
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.error': 'Error',
  'common.share': 'Share',
  'common.copy': 'Copy',
  'common.add': 'Add',
  'common.remove': 'Remove',
  'common.edit': 'Edit',
  'common.back': 'Back',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.kg': 'kg',
  'common.reps': 'reps',
  'common.rpe': 'RPE',
  'common.minutes': 'minutes',
  'common.seconds': 'sec',

  // ─── Navigation ─────────────────────────────────────────────────
  'nav.dashboard': 'Home',
  'nav.sessions': 'Sessions',
  'nav.progression': 'Progress',
  'nav.profile': 'Profile',
  'nav.programs': 'Programs',
  'nav.records': 'Records',
  'nav.photos': 'Photos',

  // ─── Login ─────────────────────────────────────────────────────
  'login.title': 'Sign in',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.google': 'Continue with Google',
  'login.guest': 'Continue as guest',
  'login.signup': 'Sign up',

  // ─── Dashboard ─────────────────────────────────────────────────
  'dashboard.welcome': 'Hello!',
  'dashboard.next_workout': 'Next workout',
  'dashboard.start_workout': 'Start',
  'dashboard.streak': 'Streak',
  'dashboard.streak_days': '{count} day(s)',
  'dashboard.level': 'Level {level}',
  'dashboard.weekly_goals': 'Weekly goals',

  // ─── Sessions ─────────────────────────────────────────────────
  'sessions.title': 'Workouts',
  'sessions.current': 'Current workout',
  'sessions.none': 'No active workout',
  'sessions.free': 'Free workout',
  'sessions.start_free': 'Start free',
  'sessions.templates': 'Templates',
  'sessions.auto': 'Auto-generate',
  'sessions.rest': 'Rest',
  'sessions.skip_rest': 'Skip',
  'sessions.add_set': '+ Set',
  'sessions.add_exercise': 'Add exercise',
  'sessions.new_pr': 'New PR!',
  'sessions.save': 'Save',
  'sessions.history': 'History',

  // ─── Profile ──────────────────────────────────────────────────
  'profile.title': 'Profile',
  'profile.display_name': 'Display name',
  'profile.export': 'Export my data',
  'profile.import': 'Import',
  'profile.notifications': 'Push notifications',
  'profile.notifications_enable': 'Enable notifications',
  'profile.notifications_disable': 'Disable',
  'profile.share_profile': 'Share my profile',
  'profile.language': 'Language',
  'profile.logout': 'Sign out',

  // ─── Programs ─────────────────────────────────────────────────
  'programs.title': 'Pre-built programs',
  'programs.choose': 'Pick a program',
  'programs.start': 'Start program',
  'programs.week': 'Week {n}',
  'programs.duration': '{weeks} weeks',
  'programs.days_per_week': '{n} days/week',
  'programs.your_1rm': 'Your 1RMs (kg)',
  'programs.required_1rm': 'Required 1RMs for this program',

  // ─── Photos ───────────────────────────────────────────────────
  'photos.title': 'Progress photos',
  'photos.add': 'Add a photo',
  'photos.before_after': 'Before / After',
  'photos.weight_kg': 'Bodyweight (kg)',

  // ─── Records / Strength ───────────────────────────────────────
  'records.wilks': 'Wilks',
  'records.ipf_gl': 'IPF GL',
  'records.dots': 'DOTS',
  'records.tier_beginner': 'Beginner',
  'records.tier_novice': 'Novice',
  'records.tier_intermediate': 'Intermediate',
  'records.tier_advanced': 'Advanced',
  'records.tier_elite': 'Elite',

  // ─── PWA install ──────────────────────────────────────────────
  'pwa.install': 'Install the app',
  'pwa.install_ios': 'On iPhone: tap Share (□↑) then "Add to Home Screen" to install Kinetic.',
  'pwa.dismiss': 'Later',
};
