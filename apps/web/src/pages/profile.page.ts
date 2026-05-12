import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../deps';
import { exportAsJson, exportAsCsv } from '../lib/training/export';
import {
  compactStorage,
  getStorageUsage,
  formatBytes,
} from '../lib/storage-maintenance';
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
    displayName:      '',
    displayNameInput: '',
    streak:           0,
    bestStreak:       0,
    tasksCompleted:   0,
    savedAt:          '',
    showResetModal:   false,
    exportLoading:    false,
    restoring:        false,
    compacting:       false,
    storagePercent:   null as number | null,
    storageLabel:     '—',

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
          this.displayName      = profileData.displayName ?? '';
          this.displayNameInput = this.displayName;
        }
        if (streakData && typeof streakData === 'object') {
          this.streak     = streakData.count ?? 0;
          this.bestStreak = streakData.best  ?? 0;
        }
        if (stats && typeof stats === 'object') {
          this.tasksCompleted = stats.tasksCompleted ?? 0;
        }

        await this._refreshStorageUsage();
      } catch (err) {
        console.error('[profile] init failed:', err);
      }
    },

    async _refreshStorageUsage(): Promise<void> {
      const usage = await getStorageUsage();
      this.storagePercent = usage.percent;
      this.storageLabel = usage.usedBytes !== null
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
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: {
            kind: 'success',
            message: report.removedKeys > 0
              ? `${report.removedKeys} entrée(s) journalière(s) supprimée(s) (avant ${report.cutoffDate}).`
              : 'Stockage déjà optimal — aucune entrée à purger.',
          },
        }));
      } catch (err) {
        console.error('[profile] compact failed:', err);
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'error', message: 'Échec du compactage. Réessaie.' },
        }));
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
        this.savedAt = `Sauvegardé à ${now.getHours()}h${String(now.getMinutes()).padStart(2,'0')}`;
        setTimeout(() => { this.savedAt = ''; }, 3000);
      } catch (err) {
        console.error('[profile] saveName failed:', err);
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'error', message: 'Échec sauvegarde du nom. Réessaie.' },
        }));
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
          window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'info', message: 'Aucune séance à exporter pour le moment.' },
          }));
        }
        await exportAsJson(s, e);
      } catch (err) {
        console.error('[profile] exportJson failed:', err);
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'error', message: 'Échec export JSON. Réessaie.' },
        }));
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
          window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'info', message: 'Aucune séance à exporter pour le moment.' },
          }));
        }
        await exportAsCsv(s, e);
      } catch (err) {
        console.error('[profile] exportCsv failed:', err);
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'error', message: 'Échec export CSV. Réessaie.' },
        }));
      } finally {
        this.exportLoading = false;
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
          window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'info', message: 'Cloud non configuré sur cet appareil.' },
          }));
          return;
        }
        await storage.syncFromRemote({ force: true });
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'success', message: 'Restauration cloud terminée. Recharge la page pour voir les données.' },
        }));
      } catch (err) {
        console.error('[profile] restoreFromCloud failed:', err);
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'error', message: 'Échec de restauration. Vérifie ta connexion.' },
        }));
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
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'success', message: 'Données réinitialisées ✓' },
        }));
        // Reload complet pour repartir de zéro
        setTimeout(() => { window.location.reload(); }, 1200);
      } catch (err) {
        console.error('[profile] doReset failed:', err);
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'error', message: 'Échec de la réinitialisation. Recharge la page et réessaie.' },
        }));
      }
    },
  };
}
