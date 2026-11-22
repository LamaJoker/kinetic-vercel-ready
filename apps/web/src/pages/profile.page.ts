import { plural } from '../lib/plural';
import {
  STORAGE_KEYS,
  encodeProfile,
  buildProfileShareUrl,
  computeXpState,
  type SharedProfile,
  type ProfileBestLift,
  type ReportPeriodKey,
  workSetsOf,
} from '@kinetic/core';
import Alpine from 'alpinejs';
import { getDeps } from '../deps';
import { exportAsJson, exportAsCsv } from '../lib/training/export';
import { loadSessions, loadExercises, loadCustomExercises } from '../lib/training/storage';
import { estimateE1rmKg } from '../lib/training/rpe';
import { getThemeMode, setThemeMode, type ThemeMode } from '../lib/theme';
import { getDisplayDensity, setDisplayDensity, type DisplayDensity } from '../lib/display-mode';
import { hapticsEnabled, setHapticsEnabled, hapticTap } from '../lib/haptics';
import { wakeLockEnabled, setWakeLockEnabled, wakeLockSupported } from '../lib/wake-lock';
import {
  detectFormat,
  parseKineticJson,
  parseStrongCsv,
  parseHevyCsv,
  mergeIntoStorage,
  type ImportFormat,
  type ImportReport,
} from '../lib/training/import';
import { compactStorage, getStorageUsage, formatBytes } from '../lib/storage-maintenance';
import type { Exercise } from '../lib/training/types';
import { Capacitor } from '@capacitor/core';
import {
  getReminderPrefs,
  setReminderPrefs,
  requestReminderPermission,
  remindersPermitted,
  syncWeeklyRecap,
  syncSessionReminder,
  syncBackupReminder,
  hasChosenSessionDays,
  recordBackup,
  lastBackupAt,
  type ReminderPrefs,
} from '../lib/reminders';
import {
  healthAvailability,
  healthEnabled,
  enableHealth,
  disableHealth,
  openHealthSettings,
} from '../lib/health';

/** Période du bilan PDF (REPORT_PERIODS, @kinetic/core). */
type PdfPeriod = ReportPeriodKey;

const WEEK_CHIPS = [
  { day: 1, label: 'L', name: 'lundi' },
  { day: 2, label: 'M', name: 'mardi' },
  { day: 3, label: 'M', name: 'mercredi' },
  { day: 4, label: 'J', name: 'jeudi' },
  { day: 5, label: 'V', name: 'vendredi' },
  { day: 6, label: 'S', name: 'samedi' },
  { day: 0, label: 'D', name: 'dimanche' },
];

function backupLabel(now: Date = new Date()): string {
  const at = lastBackupAt();
  if (!at) return 'Jamais sauvegardé';
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days <= 0) return "Dernière sauvegarde aujourd'hui";
  if (days === 1) return 'Dernière sauvegarde hier';
  return `Dernière sauvegarde il y a ${days} jours`;
}

function isCloudSynced(): boolean {
  const auth = Alpine.store('auth') as { isAuthenticated: boolean; isGuest: boolean };
  return auth.isAuthenticated && !auth.isGuest;
}

async function programTrainingDays(): Promise<number[] | null> {
  const deps = await getDeps();
  const program = await deps.storage.get<{ schedule?: { dayOfWeek: number; restDay: boolean }[] }>(
    STORAGE_KEYS.PROGRAM_ACTIVE,
  );
  const days = program?.schedule?.filter((d) => !d.restDay).map((d) => d.dayOfWeek) ?? [];
  return days.length > 0 ? days : null;
}
import { canPinWidget, requestPinWidget } from '../lib/widget';
import { snapshotStorage, restoreStorage } from '../lib/backup';
import {
  autoBackupEnabled,
  backupFileLabel,
  lastAutoBackupAt,
  listBackupFiles,
  readBackupFile,
  runAutoBackup,
  setAutoBackupEnabled,
} from '../lib/auto-backup';

interface BackupFile {
  name: string;
  label: string;
}

/** Sous-titre « Dernière sauvegarde automatique : … » (app native). */
export function autoBackupLabel(at: Date | null): string {
  if (!at) return 'Aucune sauvegarde automatique pour l’instant';
  const date = at.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  return `Dernière sauvegarde automatique : ${date}`;
}

interface ProfileShape {
  displayName?: string;
}

interface StreakShape {
  count?: number;
  best?: number;
}

interface StatsShape {
  tasksCompleted?: number;
}

/** Style de l'anneau d'avatar : progression dans le niveau, bornée 0–100. */
export function levelRingStyle(percent: number | null | undefined): string {
  const p = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0;
  return `--p: ${Math.round(Math.max(0, Math.min(100, p)))}`;
}

/** Pastille de niveau d'une récompense : teintée par l'accent si débloquée. */
export function rewardBadgeClass(unlocked: boolean): string {
  return unlocked
    ? 'bg-kinetic-neon/15 text-kinetic-neon ring-1 ring-kinetic-neon/30'
    : 'bg-kinetic-elevated text-gray-500';
}

export function profile() {
  return {
    get levelRingStyle(): string {
      const xp = Alpine.store('xp') as { progressPercent?: number } | undefined;
      return levelRingStyle(xp?.progressPercent);
    },

    rewardBadgeClass(level: number): string {
      const rewards = Alpine.store('rewards') as { isUnlocked(level: number): boolean } | undefined;
      return rewardBadgeClass(!!rewards?.isUnlocked(level));
    },

    displayName: '',
    displayNameInput: '',
    streak: 0,
    bestStreak: 0,
    tasksCompleted: 0,
    savedAt: '',
    showResetModal: false,
    exportLoading: false,
    showPdfSheet: false,
    pdfPeriod: '3m' as PdfPeriod,
    pdfLoading: false,
    importing: false,
    lastImportReport: null as ImportReport | null,
    restoring: false,
    compacting: false,
    storagePercent: null as number | null,
    storageLabel: '—',
    profilePseudo: '',
    profileShareUrl: '',
    sharingProfile: false,
    nativeApp: false,
    androidApp: false,
    reminderRoutine: true,
    reminderTime: '20:00',
    reminderWeekly: true,
    widgetPinSupported: false,
    reminderSession: true,
    reminderSessionTime: '18:00',
    reminderSessionDays: [] as number[],
    reminderBackup: true,
    weekChips: WEEK_CHIPS,
    lastBackupLabel: '',
    autoBackupOn: true,
    autoBackupLabel: '',
    autoBackupWhere: '',
    showBackupSheet: false,
    backupFiles: [] as BackupFile[],
    backupChoice: null as BackupFile | null,
    restoringBackup: false,
    cloudSynced: false,
    healthState: 'unsupported' as 'unsupported' | 'not-installed' | 'available',
    healthOn: false,
    themeMode: 'dark' as ThemeMode,
    density: 'simple' as DisplayDensity,
    /** Réglage « Vibrations » (app native seulement, voir lib/haptics.ts). */
    hapticsOn: true,
    /** Réglage « Garder l'écran allumé en séance » (lib/wake-lock.ts). */
    wakeLockOn: true,
    wakeLockAvailable: false,

    setTheme(mode: ThemeMode): void {
      this.themeMode = mode;
      setThemeMode(mode);
    },

    /** Tirer pour rafraîchir (lib/native-gestures.ts) : relit tout sans perdre un prénom en cours de saisie. */
    async refresh(): Promise<void> {
      const draft = this.displayNameInput;
      const editing = draft !== this.displayName;
      await this.init();
      if (editing) this.displayNameInput = draft;
    },

    toggleWakeLock(): void {
      this.wakeLockOn = !this.wakeLockOn;
      setWakeLockEnabled(this.wakeLockOn);
    },

    toggleHaptics(): void {
      this.hapticsOn = !this.hapticsOn;
      setHapticsEnabled(this.hapticsOn);
      hapticTap(); // confirme l'activation (ne fait rien si on vient de couper)
    },

    setDensity(density: DisplayDensity): void {
      this.density = density;
      setDisplayDensity(density);
    },

    showDeleteAccount: false,
    deleteConfirmText: '',
    deletingAccount: false,
    deleteAccountError: '',

    openDeleteAccount(): void {
      this.showDeleteAccount = true;
      this.deleteConfirmText = '';
      this.deleteAccountError = '';
    },

    /** Suppression définitive : serveur (cascade) puis appareil, puis déconnexion. */
    async confirmDeleteAccount(): Promise<void> {
      if (this.deleteConfirmText.trim().toUpperCase() !== 'SUPPRIMER') return;
      this.deletingAccount = true;
      this.deleteAccountError = '';
      try {
        const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
        const { supabase, signOut } = await import('@kinetic/adapters-web');
        const { deleteAccount, ACCOUNT_DELETED_FLAG } = await import('../lib/account');
        await deleteAccount({
          supabaseUrl: env['VITE_SUPABASE_URL'] ?? '',
          anonKey: env['VITE_SUPABASE_ANON_KEY'] ?? '',
          client: supabase as never,
        });
        const deps = await getDeps();
        await deps.storage.clear().catch(() => undefined);
        await signOut().catch(() => undefined);
        try {
          sessionStorage.setItem(ACCOUNT_DELETED_FLAG, '1');
        } catch {
          /* ignore */
        }
        window.location.assign('/login');
      } catch (err) {
        this.deleteAccountError = err instanceof Error ? err.message : 'La suppression a échoué.';
        this.deletingAccount = false;
      }
    },

    demoActive: false,

    /** Retire le jeu de démo puis relance l'onboarding (rechargement complet). */
    async exitDemo(): Promise<void> {
      try {
        const deps = await getDeps();
        const { clearDemoData } = await import('../lib/demo');
        await clearDemoData(deps.storage);
        window.location.assign('/onboarding');
      } catch (err) {
        console.error('[profile] exitDemo failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: "Impossible d'effacer la démo." },
          }),
        );
      }
    },

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        void import('../lib/demo')
          .then(({ isDemoActive }) => isDemoActive(deps.storage))
          .then((active) => {
            this.demoActive = active;
          })
          .catch(() => undefined);

        // Lectures parallèles : 3 round-trips IDB → 1 batch
        const [profileData, streakData, stats] = await Promise.all([
          deps.storage.get<ProfileShape>(STORAGE_KEYS.PROFILE),
          deps.storage.get<StreakShape>(STORAGE_KEYS.STREAK),
          deps.storage.get<StatsShape>(STORAGE_KEYS.STATS),
        ]);

        if (profileData && typeof profileData === 'object') {
          this.displayName = profileData.displayName ?? '';
          this.displayNameInput = this.displayName;
        }
        this._syncAvatarName();
        if (streakData && typeof streakData === 'object') {
          this.streak = streakData.count ?? 0;
          this.bestStreak = streakData.best ?? 0;
        }
        if (stats && typeof stats === 'object') {
          this.tasksCompleted = stats.tasksCompleted ?? 0;
        }

        await this._refreshStorageUsage();
        this.nativeApp = Capacitor.isNativePlatform();
        this.androidApp = this.nativeApp && Capacitor.getPlatform() === 'android';
        const reminders = getReminderPrefs();
        const permitted = await remindersPermitted();
        this.reminderRoutine = permitted && reminders.routine;
        this.reminderTime = reminders.routineTime;
        this.reminderWeekly = permitted && reminders.weekly;
        if (!hasChosenSessionDays()) {
          const fromProgram = await programTrainingDays();
          if (fromProgram)
            reminders.sessionDays = setReminderPrefs({ sessionDays: fromProgram }).sessionDays;
        }
        this.reminderSession = permitted && reminders.session;
        this.reminderSessionTime = reminders.sessionTime;
        this.reminderSessionDays = reminders.sessionDays;
        this.reminderBackup = permitted && reminders.backup;
        this.lastBackupLabel = backupLabel();
        this._refreshAutoBackup();
        this.cloudSynced = isCloudSynced();
        this.widgetPinSupported = await canPinWidget();
        this.healthState = await healthAvailability();
        this.healthOn = this.healthState === 'available' && healthEnabled();
        this.themeMode = getThemeMode();
        this.density = getDisplayDensity();
        this.hapticsOn = hapticsEnabled();
        this.wakeLockOn = wakeLockEnabled();
        this.wakeLockAvailable = wakeLockSupported();
      } catch (err) {
        console.error('[profile] init failed:', err);
      }
    },

    /** Applique un réglage de rappel ; demande l'autorisation système à l'activation. */
    async _saveReminders(patch: Partial<ReminderPrefs>): Promise<void> {
      const enabling =
        patch.routine === true ||
        patch.weekly === true ||
        patch.session === true ||
        patch.backup === true;
      if (enabling && !(await requestReminderPermission())) {
        patch = { ...patch, routine: false, weekly: false, session: false, backup: false };
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'error',
              message: 'Notifications refusées. Autorise-les dans les réglages du téléphone.',
            },
          }),
        );
      }
      const prefs = setReminderPrefs(patch);
      this.reminderRoutine = prefs.routine;
      this.reminderTime = prefs.routineTime;
      this.reminderWeekly = prefs.weekly;
      this.reminderSession = prefs.session;
      this.reminderSessionTime = prefs.sessionTime;
      this.reminderSessionDays = prefs.sessionDays;
      this.reminderBackup = prefs.backup;
      (Alpine.store('vitalite') as { _syncNative(): void })._syncNative();
      void syncWeeklyRecap();
      void syncSessionReminder();
      void syncBackupReminder(isCloudSynced());
    },

    toggleRoutineReminder(): Promise<void> {
      return this._saveReminders({ routine: !this.reminderRoutine });
    },

    toggleWeeklyRecap(): Promise<void> {
      return this._saveReminders({ weekly: !this.reminderWeekly });
    },

    setReminderTime(event: Event): Promise<void> {
      return this._saveReminders({ routineTime: (event.target as HTMLInputElement).value });
    },

    toggleSessionReminder(): Promise<void> {
      return this._saveReminders({ session: !this.reminderSession });
    },

    setSessionTime(event: Event): Promise<void> {
      return this._saveReminders({ sessionTime: (event.target as HTMLInputElement).value });
    },

    isSessionDay(day: number): boolean {
      return this.reminderSessionDays.includes(day);
    },

    toggleSessionDay(day: number): Promise<void> {
      const days = this.isSessionDay(day)
        ? this.reminderSessionDays.filter((d) => d !== day)
        : [...this.reminderSessionDays, day];
      return this._saveReminders({ sessionDays: days });
    },

    toggleBackupReminder(): Promise<void> {
      return this._saveReminders({ backup: !this.reminderBackup });
    },

    async toggleHealth(): Promise<void> {
      if (this.healthState === 'not-installed') {
        await openHealthSettings();
        return;
      }
      if (this.healthOn) {
        disableHealth();
        this.healthOn = false;
        return;
      }
      this.healthOn = await enableHealth();
      if (this.healthOn) {
        void (Alpine.store('vitalite') as { syncHealth(): Promise<void> }).syncHealth();
      } else {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'error',
              message: 'Accès refusé. Tu peux l’autoriser dans Health Connect.',
            },
          }),
        );
      }
    },

    async addWidget(): Promise<void> {
      if (await requestPinWidget()) return;
      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: {
            kind: 'info',
            message: "Appui long sur l'écran d'accueil, puis Widgets, puis Kinetic.",
          },
        }),
      );
    },

    async _refreshStorageUsage(): Promise<void> {
      const usage = await getStorageUsage();
      this.storagePercent = usage.percent;
      this.storageLabel =
        usage.usedBytes !== null
          ? `${formatBytes(usage.usedBytes)} / ${formatBytes(usage.quotaBytes)}`
          : 'Indisponible sur ce navigateur';
    },

    async compactNow(): Promise<void> {
      if (this.compacting) return;
      this.compacting = true;
      try {
        const deps = await getDeps();
        const report = await compactStorage(deps.storage);
        await this._refreshStorageUsage();
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'success',
              message:
                report.removedKeys > 0
                  ? `${plural(report.removedKeys, 'entrée journalière supprimée', 'entrées journalières supprimées')} (avant ${report.cutoffDate}).`
                  : 'Stockage déjà optimal — aucune entrée à purger.',
            },
          }),
        );
      } catch (err) {
        console.error('[profile] compact failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec du compactage. Réessaie.' },
          }),
        );
      } finally {
        this.compacting = false;
      }
    },

    /** Partage le prénom local avec le store auth (initiale de l'avatar, accueil compris). */
    _syncAvatarName(): void {
      const auth = Alpine.store('auth') as
        | { setProfileName?: (name: string | undefined) => void }
        | undefined;
      auth?.setProfileName?.(this.displayName);
    },

    async saveName(): Promise<void> {
      const name = this.displayNameInput.trim().slice(0, 40);
      try {
        const deps = await getDeps();
        const profileData = (await deps.storage.get<ProfileShape>(STORAGE_KEYS.PROFILE)) ?? {};
        await deps.storage.set(STORAGE_KEYS.PROFILE, { ...profileData, displayName: name });
        this.displayName = name;
        this._syncAvatarName();
        const now = new Date();
        this.savedAt = `Sauvegardé à ${now.getHours()}h${String(now.getMinutes()).padStart(2, '0')}`;
        setTimeout(() => {
          this.savedAt = '';
        }, 3000);
      } catch (err) {
        console.error('[profile] saveName failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec sauvegarde du nom. Réessaie.' },
          }),
        );
      }
    },

    /**
     * Construit un profil partagé compact (3 best lifts par e1RM) et
     * encode-le dans une URL. Tente l'API Web Share native, fallback clipboard.
     */
    async shareProfile(): Promise<void> {
      if (this.sharingProfile) return;
      this.sharingProfile = true;
      try {
        const deps = await getDeps();
        const [sessions, exercises, xpTotal] = await Promise.all([
          loadSessions(deps.storage),
          loadExercises(deps.storage),
          deps.storage.get<{ xp: number } | number>(STORAGE_KEYS.XP),
        ]);

        // Best lift par exercice (par e1RM Epley, sets et séances confondus)
        const bestByEx = new Map<string, ProfileBestLift>();
        for (const s of sessions) {
          for (const entry of s.entries) {
            for (const set of workSetsOf(entry.sets)) {
              const e1 = estimateE1rmKg(set.weightKg, set.reps);
              if (!(e1 > 0)) continue; // série chronométrée / distance : pas de « meilleure charge »
              const prev = bestByEx.get(entry.exerciseId);
              if (!prev || e1 > prev.e1rmKg) {
                bestByEx.set(entry.exerciseId, {
                  exerciseId: entry.exerciseId,
                  weightKg: set.weightKg,
                  reps: set.reps,
                  e1rmKg: Math.round(e1 * 10) / 10,
                });
              }
            }
          }
        }
        const bestLifts = [...bestByEx.values()].sort((a, b) => b.e1rmKg - a.e1rmKg).slice(0, 3);

        // Niveau XP (recalcule depuis totalXp pour rester fiable)
        // Format stocké : { xp } (xp store, use cases) — nombre brut toléré (ancien format).
        const rawXp = typeof xpTotal === 'number' ? xpTotal : xpTotal?.xp;
        const totalXp = typeof rawXp === 'number' && Number.isFinite(rawXp) ? rawXp : 0;
        const xp = computeXpState(Math.max(0, totalXp));

        const pseudo = (this.profilePseudo || this.displayName || 'Athlète Kinetic')
          .trim()
          .slice(0, 32);

        const payload: SharedProfile = {
          pseudo,
          level: xp.currentLevel,
          streak: this.streak,
          totalSessions: sessions.length,
          bestLifts: bestLifts.map((b) => ({
            // remplace l'id par un libellé court lisible (chez le destinataire,
            // si l'exercice n'existe pas dans son catalogue, on garde le label brut)
            exerciseId:
              exercises.find((e) => e.id === b.exerciseId)?.name?.slice(0, 32) ?? b.exerciseId,
            weightKg: b.weightKg,
            reps: b.reps,
            e1rmKg: b.e1rmKg,
          })),
        };
        const token = encodeProfile(payload);
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        const url = buildProfileShareUrl(origin, token);
        this.profileShareUrl = url;

        const nav = navigator as Navigator & {
          share?: (data: { title?: string; url?: string }) => Promise<void>;
        };
        try {
          if (typeof nav.share === 'function') {
            await nav.share({ title: `${pseudo} — Profil Kinetic`, url });
            return;
          }
        } catch {
          /* annulé ou non supporté → fallback clipboard */
        }
        try {
          await navigator.clipboard.writeText(url);
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'success', message: 'Lien profil copié ✓' },
            }),
          );
        } catch {
          /* le lien est de toute façon affiché dans l'UI */
        }
      } catch (err) {
        console.error('[profile] shareProfile failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Impossible de générer le lien — réessaie.' },
          }),
        );
      } finally {
        this.sharingProfile = false;
      }
    },

    // ─── Sauvegarde automatique (app native, lib/auto-backup.ts) ─────────────

    _refreshAutoBackup(): void {
      this.autoBackupOn = autoBackupEnabled();
      this.autoBackupLabel = autoBackupLabel(lastAutoBackupAt());
      this.autoBackupWhere = this.autoBackupOn
        ? this.androidApp
          ? 'Chaque semaine dans Documents'
          : 'Chaque semaine dans Fichiers › Sur mon iPhone › Kinetic'
        : 'Désactivée';
      this.lastBackupLabel = backupLabel();
    },

    async toggleAutoBackup(): Promise<void> {
      setAutoBackupEnabled(!this.autoBackupOn);
      this._refreshAutoBackup();
      if (this.autoBackupOn) {
        const deps = await getDeps();
        if (await runAutoBackup(deps.storage)) this._refreshAutoBackup();
      }
    },

    async openBackupList(): Promise<void> {
      const names = await listBackupFiles();
      this.backupFiles = names.map((name) => ({ name, label: backupFileLabel(name) }));
      this.backupChoice = null;
      this.showBackupSheet = true;
    },

    pickBackup(file: BackupFile): void {
      this.backupChoice = file;
    },

    closeBackupSheet(): void {
      if (this.restoringBackup) return;
      this.showBackupSheet = false;
      this.backupChoice = null;
    },

    /** Restaure la sauvegarde choisie (mêmes chemins que l'import d'un fichier Kinetic). */
    async confirmRestoreBackup(): Promise<void> {
      const choice = this.backupChoice;
      if (!choice || this.restoringBackup) return;
      this.restoringBackup = true;
      try {
        const bundle = parseKineticJson(await readBackupFile(choice.name));
        if (!bundle.data || Object.keys(bundle.data).length === 0) {
          throw new Error('not a full backup');
        }
        const deps = await getDeps();
        await restoreStorage(deps.storage, bundle.data);
        if (bundle.sessions.length > 0)
          await mergeIntoStorage(deps.storage, bundle, 'kinetic-json');
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: 'Sauvegarde restaurée. Redémarrage…' },
          }),
        );
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        console.error('[profile] restore backup failed:', err);
        this.restoringBackup = false;
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Sauvegarde illisible. Choisis-en une autre.' },
          }),
        );
      }
    },

    // ─── Bilan PDF (module chargé à la demande) ─────────────

    openPdfSheet(): void {
      this.showPdfSheet = true;
    },

    closePdfSheet(): void {
      if (!this.pdfLoading) this.showPdfSheet = false;
    },

    setPdfPeriod(key: PdfPeriod): void {
      this.pdfPeriod = key;
      hapticTap();
    },

    pdfPressed(key: PdfPeriod): boolean {
      return this.pdfPeriod === key;
    },

    async exportPdf(): Promise<void> {
      if (this.pdfLoading) return;
      this.pdfLoading = true;
      try {
        const { exportProgressPdf } = await import('../lib/progress-pdf');
        await exportProgressPdf(this.pdfPeriod);
        this.pdfLoading = false;
        this.showPdfSheet = false;
        if (!this.nativeApp)
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'success', message: 'Bilan PDF téléchargé.' },
            }),
          );
      } catch (err) {
        console.error('[profile] exportPdf failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Impossible de créer le bilan PDF. Réessaie.' },
          }),
        );
      } finally {
        this.pdfLoading = false;
      }
    },

    async exportJson(): Promise<void> {
      this.exportLoading = true;
      try {
        const deps = await getDeps();
        const [sessions, exercises, custom] = await Promise.all([
          loadSessions(deps.storage),
          deps.storage.get<Exercise[]>(STORAGE_KEYS.TRAINING_EXERCISES),
          loadCustomExercises(deps.storage),
        ]);
        const s = Array.isArray(sessions) ? sessions : [];
        const e = [...(Array.isArray(exercises) ? exercises : []), ...custom];
        await exportAsJson(s, e, await snapshotStorage(deps.storage));
        recordBackup();
        this.lastBackupLabel = backupLabel();
      } catch (err) {
        console.error('[profile] exportJson failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec export JSON. Réessaie.' },
          }),
        );
      } finally {
        this.exportLoading = false;
      }
    },

    async exportCsv(): Promise<void> {
      this.exportLoading = true;
      try {
        const deps = await getDeps();
        const [sessions, exercises, custom] = await Promise.all([
          loadSessions(deps.storage),
          deps.storage.get<Exercise[]>(STORAGE_KEYS.TRAINING_EXERCISES),
          loadCustomExercises(deps.storage),
        ]);
        const s = Array.isArray(sessions) ? sessions : [];
        const e = [...(Array.isArray(exercises) ? exercises : []), ...custom];
        if (s.length === 0) {
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'info', message: 'Aucune séance à exporter pour le moment.' },
            }),
          );
        }
        await exportAsCsv(s, e);
      } catch (err) {
        console.error('[profile] exportCsv failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec export CSV. Réessaie.' },
          }),
        );
      } finally {
        this.exportLoading = false;
      }
    },

    /**
     * importFile — lit le fichier choisi par l'utilisateur et fusionne dans le
     * storage. Détecte automatiquement Kinetic JSON / Strong CSV / Hevy CSV.
     */
    async importFile(event: Event): Promise<void> {
      const input = event.target as HTMLInputElement | null;
      const file = input?.files?.[0];
      if (!file) return;
      if (this.importing) return;
      this.importing = true;
      this.lastImportReport = null;
      try {
        const content = await file.text();
        const format: ImportFormat = detectFormat(content);

        let bundle;
        let csvSkipped = 0;
        if (format === 'kinetic-json') {
          bundle = parseKineticJson(content);
        } else if (format === 'hevy-csv') {
          const r = parseHevyCsv(content);
          bundle = r.bundle;
          csvSkipped = r.skipped;
        } else {
          const r = parseStrongCsv(content);
          bundle = r.bundle;
          csvSkipped = r.skipped;
        }

        const deps = await getDeps();
        if (bundle.data && Object.keys(bundle.data).length > 0) {
          await restoreStorage(deps.storage, bundle.data);
          if (bundle.sessions.length > 0) await mergeIntoStorage(deps.storage, bundle, format);
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'success', message: 'Sauvegarde restaurée. Redémarrage…' },
            }),
          );
          setTimeout(() => window.location.reload(), 1200);
          return;
        }

        if (bundle.sessions.length === 0) {
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: {
                kind: 'warning',
                message: 'Aucune séance détectée dans le fichier. Vérifie le format.',
              },
            }),
          );
          return;
        }

        const report = await mergeIntoStorage(deps.storage, bundle, format);
        this.lastImportReport = { ...report, skippedRows: csvSkipped };

        const label =
          report.importedSessions > 0
            ? plural(report.importedSessions, 'séance importée', 'séances importées') +
              (report.duplicateSessions > 0
                ? ` (${plural(report.duplicateSessions, 'doublon ignoré', 'doublons ignorés')})`
                : '')
            : `Aucune nouvelle séance (${plural(report.duplicateSessions, 'doublon')})`;
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: label },
          }),
        );
      } catch (err) {
        console.error('[profile] import failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'error',
              message: "Échec de l'import — fichier illisible ou format inconnu.",
            },
          }),
        );
      } finally {
        this.importing = false;
        // Reset l'input pour permettre de re-sélectionner le même fichier
        if (input) input.value = '';
      }
    },

    async restoreFromCloud(): Promise<void> {
      if (this.restoring) return;
      this.restoring = true;
      try {
        const deps = await getDeps();
        const storage = deps.storage as typeof deps.storage & {
          syncFromRemote?: (opts?: { force?: boolean }) => Promise<void>;
        };
        if (typeof storage.syncFromRemote !== 'function') {
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'info', message: 'Cloud non configuré sur cet appareil.' },
            }),
          );
          return;
        }
        await storage.syncFromRemote({ force: true });
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'success',
              message: 'Restauration cloud terminée. Recharge la page pour voir les données.',
            },
          }),
        );
      } catch (err) {
        console.error('[profile] restoreFromCloud failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Échec de restauration. Vérifie ta connexion.' },
          }),
        );
      } finally {
        this.restoring = false;
      }
    },

    async doReset(): Promise<void> {
      this.showResetModal = false;
      try {
        const deps = await getDeps();
        // Clear all storage — les stores Alpine se rechargent proprement au reload
        await deps.storage.clear();
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: 'Données réinitialisées ✓' },
          }),
        );
        // Reload complet pour repartir de zéro
        setTimeout(() => {
          window.location.reload();
        }, 1200);
      } catch (err) {
        console.error('[profile] doReset failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'error',
              message: 'Échec de la réinitialisation. Recharge la page et réessaie.',
            },
          }),
        );
      }
    },
  };
}
