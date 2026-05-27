import {
  STORAGE_KEYS,
  encodeProfile,
  buildProfileShareUrl,
  computeXpState,
  type SharedProfile,
  type ProfileBestLift,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { exportAsJson, exportAsCsv } from '../lib/training/export';
import { loadSessions, loadExercises } from '../lib/training/storage';
import { estimateE1rmKg } from '../lib/training/rpe';
import { enablePush, disablePush, isPushAvailable, getPushStatus } from '../lib/push';
import { getLocale, setLocale, type Locale } from '../lib/i18n';
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
import type { Exercise, WorkoutSession } from '../lib/training/types';

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

export function profile() {
  return {
    displayName: '',
    displayNameInput: '',
    streak: 0,
    bestStreak: 0,
    tasksCompleted: 0,
    savedAt: '',
    showResetModal: false,
    exportLoading: false,
    importing: false,
    lastImportReport: null as ImportReport | null,
    restoring: false,
    compacting: false,
    storagePercent: null as number | null,
    storageLabel: '—',
    profilePseudo: '',
    profileShareUrl: '',
    sharingProfile: false,
    pushSupported: false,
    pushSubscribed: false,
    pushBusy: false,
    locale: 'fr' as Locale,

    setUiLocale(locale: Locale): void {
      this.locale = locale;
      setLocale(locale);
      // Soft reload : force le re-render des templates en redispatchant
      window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_LOCALE_RELOAD));
    },

    async init(): Promise<void> {
      try {
        const deps = await getDeps();

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
        if (streakData && typeof streakData === 'object') {
          this.streak = streakData.count ?? 0;
          this.bestStreak = streakData.best ?? 0;
        }
        if (stats && typeof stats === 'object') {
          this.tasksCompleted = stats.tasksCompleted ?? 0;
        }

        await this._refreshStorageUsage();
        this._refreshPushStatus();
        this.locale = getLocale();
      } catch (err) {
        console.error('[profile] init failed:', err);
      }
    },

    _refreshPushStatus(): void {
      this.pushSupported = isPushAvailable();
      const status = getPushStatus();
      this.pushSubscribed = status.subscribed && status.permission === 'granted';
    },

    async togglePush(): Promise<void> {
      if (this.pushBusy) return;
      this.pushBusy = true;
      try {
        if (this.pushSubscribed) {
          await disablePush();
          this.pushSubscribed = false;
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'info', message: 'Notifications push désactivées.' },
            }),
          );
        } else {
          const sub = await enablePush();
          if (sub) {
            this.pushSubscribed = true;
            window.dispatchEvent(
              new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
                detail: { kind: 'success', message: 'Notifications push activées ✓' },
              }),
            );
          } else {
            window.dispatchEvent(
              new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
                detail: {
                  kind: 'warning',
                  message:
                    'Activation refusée — vérifie la permission Notifications dans ton navigateur.',
                },
              }),
            );
          }
        }
      } finally {
        this.pushBusy = false;
      }
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
                  ? `${report.removedKeys} entrée(s) journalière(s) supprimée(s) (avant ${report.cutoffDate}).`
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

    async saveName(): Promise<void> {
      const name = this.displayNameInput.trim().slice(0, 40);
      try {
        const deps = await getDeps();
        const profileData = (await deps.storage.get<ProfileShape>(STORAGE_KEYS.PROFILE)) ?? {};
        await deps.storage.set(STORAGE_KEYS.PROFILE, { ...profileData, displayName: name });
        this.displayName = name;
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
          deps.storage.get<number>(STORAGE_KEYS.XP),
        ]);

        // Best lift par exercice (par e1RM Epley, sets et séances confondus)
        const bestByEx = new Map<string, ProfileBestLift>();
        for (const s of sessions) {
          for (const entry of s.entries) {
            for (const set of entry.sets) {
              const e1 = estimateE1rmKg(set.weightKg, set.reps);
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
        const totalXp = typeof xpTotal === 'number' && Number.isFinite(xpTotal) ? xpTotal : 0;
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

    async exportJson(): Promise<void> {
      this.exportLoading = true;
      try {
        const deps = await getDeps();
        const [sessions, exercises] = await Promise.all([
          deps.storage.get<WorkoutSession[]>(STORAGE_KEYS.TRAINING_SESSIONS),
          deps.storage.get<Exercise[]>(STORAGE_KEYS.TRAINING_EXERCISES),
        ]);
        const s = Array.isArray(sessions) ? sessions : [];
        const e = Array.isArray(exercises) ? exercises : [];
        if (s.length === 0) {
          window.dispatchEvent(
            new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
              detail: { kind: 'info', message: 'Aucune séance à exporter pour le moment.' },
            }),
          );
        }
        await exportAsJson(s, e);
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
        const [sessions, exercises] = await Promise.all([
          deps.storage.get<WorkoutSession[]>(STORAGE_KEYS.TRAINING_SESSIONS),
          deps.storage.get<Exercise[]>(STORAGE_KEYS.TRAINING_EXERCISES),
        ]);
        const s = Array.isArray(sessions) ? sessions : [];
        const e = Array.isArray(exercises) ? exercises : [];
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

        const deps = await getDeps();
        const report = await mergeIntoStorage(deps.storage, bundle, format);
        this.lastImportReport = { ...report, skippedRows: csvSkipped };

        const label =
          report.importedSessions > 0
            ? `${report.importedSessions} séance(s) importée(s)` +
              (report.duplicateSessions > 0
                ? ` (${report.duplicateSessions} doublon(s) ignoré(s))`
                : '')
            : `Aucune nouvelle séance (${report.duplicateSessions} doublon(s))`;
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
