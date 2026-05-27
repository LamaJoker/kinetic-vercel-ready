/**
 * Store Achievements — détecte les unlocks au démarrage et après chaque
 * session sauvegardée, persiste l'ensemble des IDs débloqués, et émet une
 * notification pour chaque nouvel achievement.
 *
 * Logique pure dans @kinetic/core/domain/achievements.domain.
 */

import {
  STORAGE_KEYS,
  buildAchievementCatalog,
  computeUnlocked,
  detectLiftKey,
  newlyUnlocked,
  type Achievement,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { loadSessions, loadExercises } from '../lib/training/storage';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { estimateE1rmKg } from '../lib/training/rpe';

interface StreakShape {
  count?: number;
  best?: number;
}

export function achievementsStore() {
  return {
    catalog: buildAchievementCatalog() as Achievement[],
    unlockedIds: [] as string[],
    loading: true,
    _sessionSavedHandler: null as ((event: Event) => void) | null,
    _depsReadyHandler: null as (() => void) | null,
    _evaluating: false,

    get unlockedSet(): Set<string> {
      return new Set(this.unlockedIds);
    },

    get unlockedCount(): number {
      return this.unlockedIds.length;
    },

    get totalCount(): number {
      return this.catalog.length;
    },

    get progressPercent(): number {
      if (this.totalCount === 0) return 0;
      return Math.round((this.unlockedCount / this.totalCount) * 100);
    },

    isUnlocked(id: string): boolean {
      return this.unlockedSet.has(id);
    },

    async init(): Promise<void> {
      this._sessionSavedHandler = () => {
        void this.evaluate();
      };
      this._depsReadyHandler = () => {
        void this.reload();
      };
      window.addEventListener(STORAGE_KEYS.EVENT_SESSION_SAVED, this._sessionSavedHandler);
      window.addEventListener(STORAGE_KEYS.EVENT_DEPS_READY, this._depsReadyHandler);
      await this.reload();
    },

    destroy(): void {
      if (this._sessionSavedHandler) {
        window.removeEventListener(STORAGE_KEYS.EVENT_SESSION_SAVED, this._sessionSavedHandler);
        this._sessionSavedHandler = null;
      }
      if (this._depsReadyHandler) {
        window.removeEventListener(STORAGE_KEYS.EVENT_DEPS_READY, this._depsReadyHandler);
        this._depsReadyHandler = null;
      }
    },

    async reload(): Promise<void> {
      this.loading = true;
      try {
        const deps = await getDeps();
        const stored = await deps.storage.get<string[]>(STORAGE_KEYS.ACHIEVEMENTS_UNLOCKED);
        this.unlockedIds = Array.isArray(stored) ? stored : [];
        await this.evaluate({ silent: true });
      } catch (err) {
        console.warn('[achievements] reload failed:', err);
      } finally {
        this.loading = false;
      }
    },

    /**
     * evaluate — recalcule l'état complet et notifie les nouveaux unlocks.
     * `silent: true` au démarrage pour ne pas spammer si l'utilisateur revient
     * et a déjà débloqué des trucs en arrière-plan.
     */
    async evaluate(opts?: { silent?: boolean }): Promise<void> {
      if (this._evaluating) return;
      this._evaluating = true;
      try {
        const deps = await getDeps();
        const [sessions, exercises, streak] = await Promise.all([
          loadSessions(deps.storage),
          loadExercises(deps.storage),
          deps.storage.get<StreakShape>(STORAGE_KEYS.STREAK),
        ]);

        const completedSessions = (sessions as WorkoutSession[]).filter((s) => s.endedAt);

        // bestE1rmByLift : classifier chaque exercice par lift connu
        const namesById = new Map((exercises as Exercise[]).map((e) => [e.id, e.name]));
        const bestE1rmByLift: { bench?: number; squat?: number; deadlift?: number } = {};
        let totalTonnageKg = 0;
        const exerciseBestE1rm = new Map<string, number>();

        for (const s of completedSessions) {
          for (const entry of s.entries) {
            const name = namesById.get(entry.exerciseId) ?? entry.exerciseId;
            const lift = detectLiftKey(name);
            for (const set of entry.sets) {
              const e1 = estimateE1rmKg(set.weightKg, set.reps);
              totalTonnageKg += set.weightKg * set.reps;
              if (lift) {
                bestE1rmByLift[lift] = Math.max(bestE1rmByLift[lift] ?? 0, e1);
              }
              const cur = exerciseBestE1rm.get(entry.exerciseId) ?? 0;
              if (e1 > cur) exerciseBestE1rm.set(entry.exerciseId, e1);
            }
          }
        }

        // totalPRs : un PR par exercice où on a au moins UN set, comptabilisé
        // une seule fois (le record actuel = 1 PR existant). Cette définition
        // est suffisante pour le pacing des badges "5/10/25 PR".
        const totalPRs = exerciseBestE1rm.size;

        const currentUnlocked = computeUnlocked({
          totalCompletedSessions: completedSessions.length,
          bestStreak: streak?.best ?? 0,
          totalPRs,
          totalTonnageKg,
          bestE1rmByLift,
        });

        const newOnes = newlyUnlocked(this.unlockedIds, currentUnlocked);
        if (currentUnlocked.length !== this.unlockedIds.length || newOnes.length > 0) {
          this.unlockedIds = currentUnlocked;
          await deps.storage.set(STORAGE_KEYS.ACHIEVEMENTS_UNLOCKED, currentUnlocked);
        }

        if (!opts?.silent && newOnes.length > 0) {
          const catalogById = new Map(this.catalog.map((a) => [a.id, a]));
          for (const id of newOnes) {
            const ach = catalogById.get(id);
            if (!ach) continue;
            window.dispatchEvent(
              new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
                detail: {
                  kind: 'success',
                  message: `${ach.emoji} Achievement débloqué : ${ach.title}`,
                },
              }),
            );
          }
        }
      } catch (err) {
        console.warn('[achievements] evaluate failed:', err);
      } finally {
        this._evaluating = false;
      }
    },
  };
}
