import Alpine from 'alpinejs';
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

interface XpStoreShape {
  setXp(n: number): void;
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
      const deps = await getDeps();

      const profileData = await deps.storage.get<ProfileShape>('kinetic:profile');
      if (profileData && typeof profileData === 'object') {
        this.displayName      = profileData.displayName ?? '';
        this.displayNameInput = this.displayName;
      }

      const streakData = await deps.storage.get<StreakShape>('kinetic:streak');
      if (streakData && typeof streakData === 'object') {
        this.streak     = streakData.count ?? 0;
        this.bestStreak = streakData.best  ?? 0;
      }

      const stats = await deps.storage.get<StatsShape>('kinetic:stats');
      if (stats && typeof stats === 'object') {
        this.tasksCompleted = stats.tasksCompleted ?? 0;
      }

      await this._refreshStorageUsage();
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
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: {
            kind: 'success',
            message: report.removedKeys > 0
              ? `${report.removedKeys} entrée(s) journalière(s) supprimée(s) (avant ${report.cutoffDate}).`
              : 'Stockage déjà optimal — aucune entrée à purger.',
          },
        }));
      } catch (err) {
        console.error('[profile] compact failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Échec du compactage. Réessaie.' },
        }));
      } finally {
        this.compacting = false;
      }
    },

    async saveName(): Promise<void> {
      const name = this.displayNameInput.trim().slice(0, 40);
      this.displayName = name;
      const deps = await getDeps();
      const profileData = (await deps.storage.get<ProfileShape>('kinetic:profile')) ?? {};
      await deps.storage.set('kinetic:profile', { ...profileData, displayName: name });
      const now = new Date();
      this.savedAt = `Sauvegardé à ${now.getHours()}h${String(now.getMinutes()).padStart(2,'0')}`;
      setTimeout(() => { this.savedAt = ''; }, 3000);
    },

    async exportJson(): Promise<void> {
      this.exportLoading = true;
      try {
        const deps = await getDeps();
        const [sessions, exercises] = await Promise.all([
          deps.storage.get<WorkoutSession[]>('kinetic:training:sessions'),
          deps.storage.get<Exercise[]>('kinetic:training:exercises'),
        ]);
        const s = Array.isArray(sessions) ? sessions : [];
        const e = Array.isArray(exercises) ? exercises : [];
        if (s.length === 0) {
          window.dispatchEvent(new CustomEvent('kinetic:notify', {
            detail: { kind: 'info', message: 'Aucune séance à exporter pour le moment.' },
          }));
        }
        exportAsJson(s, e);
      } catch (err) {
        console.error('[profile] exportJson failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
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
          deps.storage.get<WorkoutSession[]>('kinetic:training:sessions'),
          deps.storage.get<Exercise[]>('kinetic:training:exercises'),
        ]);
        const s = Array.isArray(sessions) ? sessions : [];
        const e = Array.isArray(exercises) ? exercises : [];
        if (s.length === 0) {
          window.dispatchEvent(new CustomEvent('kinetic:notify', {
            detail: { kind: 'info', message: 'Aucune séance à exporter pour le moment.' },
          }));
        }
        exportAsCsv(s, e);
      } catch (err) {
        console.error('[profile] exportCsv failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
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
          window.dispatchEvent(new CustomEvent('kinetic:notify', {
            detail: { kind: 'info', message: 'Cloud non configuré sur cet appareil.' },
          }));
          return;
        }
        await storage.syncFromRemote({ force: true });
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'success', message: 'Restauration cloud terminée. Recharge la page pour voir les données.' },
        }));
      } catch (err) {
        console.error('[profile] restoreFromCloud failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Échec de restauration. Vérifie ta connexion.' },
        }));
      } finally {
        this.restoring = false;
      }
    },

    async doReset(): Promise<void> {
      this.showResetModal = false;
      const deps = await getDeps();
      await deps.storage.clear();
      (Alpine.store('xp') as XpStoreShape).setXp(0);
      window.dispatchEvent(new CustomEvent('kinetic:notify', {
        detail: { kind: 'success', message: 'Données réinitialisées ✓' },
      }));
      setTimeout(() => { window.location.hash = '/'; }, 1200);
    },
  };
}
