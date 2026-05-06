/**
 * Store Alpine `goals` — objectifs hebdomadaires d'entraînement.
 * La logique pure vit dans `@kinetic/core/domain/goals.domain`.
 * Ce store gère uniquement la persistance IDB et le bridge UI/event.
 */
import {
  evaluateWeeklyGoals,
  shouldAwardWeeklyBonusXp,
  WEEKLY_GOAL_BONUS_XP,
  awardXp,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { loadSessions } from '../lib/training/storage';

const KEY_GOALS = 'kinetic:goals:weekly';

export function goalsStore() {
  return {
    targetSessions:  3,
    targetTonnageKg: 0,
    doneSessions:    0,
    doneTonnageKg:   0,
    sessionsPercent: 0,
    tonnagePercent:  100,
    sessionsOk:      false,
    tonnageOk:       true,
    allOk:           false,
    weekKey:         '',
    xpAwardedWeek:   '',
    loading:         true,

    // M3 FIX: stocker le handler pour pouvoir le retirer dans destroy()
    _sessionSavedHandler: null as (() => void) | null,

    async init(): Promise<void> {
      this._sessionSavedHandler = () => void this.reload();
      window.addEventListener('kinetic:session-saved', this._sessionSavedHandler);
      await this.reload();
    },

    destroy(): void {
      if (this._sessionSavedHandler) {
        window.removeEventListener('kinetic:session-saved', this._sessionSavedHandler);
        this._sessionSavedHandler = null;
      }
    },

    async reload(): Promise<void> {
      this.loading = true;
      try {
        const deps = await getDeps();

        const saved = await deps.storage.get<{
          targetSessions: number; targetTonnageKg: number; xpAwardedWeek: string;
        }>(KEY_GOALS);
        if (saved) {
          this.targetSessions  = saved.targetSessions  ?? 3;
          this.targetTonnageKg = saved.targetTonnageKg ?? 0;
          this.xpAwardedWeek   = saved.xpAwardedWeek   ?? '';
        }

        const sessions = await loadSessions(deps.storage);
        const state = evaluateWeeklyGoals(sessions, {
          targetSessions:  this.targetSessions,
          targetTonnageKg: this.targetTonnageKg,
        });

        this.weekKey         = state.weekKey;
        this.doneSessions    = state.doneSessions;
        this.doneTonnageKg   = state.doneTonnageKg;
        this.sessionsPercent = state.sessionsPercent;
        this.tonnagePercent  = state.tonnagePercent;
        this.sessionsOk      = state.sessionsOk;
        this.tonnageOk       = state.tonnageOk;
        this.allOk           = state.allOk;

        if (shouldAwardWeeklyBonusXp(state, this.xpAwardedWeek)) {
          await this._awardBonus(deps);
        }
      } catch (err) {
        console.error('[goals] reload failed:', err);
      } finally {
        this.loading = false;
      }
    },

    async save(): Promise<void> {
      try {
        const deps = await getDeps();
        await deps.storage.set(KEY_GOALS, {
          targetSessions:  this.targetSessions,
          targetTonnageKg: this.targetTonnageKg,
          xpAwardedWeek:   this.xpAwardedWeek,
        });
      } catch (err) {
        console.error('[goals] save failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Échec sauvegarde des objectifs. Réessaie.' },
        }));
      }
    },

    async _awardBonus(deps: Awaited<ReturnType<typeof getDeps>>): Promise<void> {
      // H3 FIX: utiliser awardXp() pour mettre à jour correctement
      // kinetic:xp ET les logs journaliers de sync cloud (silent=true car
      // on gère nous-mêmes la notification)
      await awardXp(
        { storage: deps.storage, notifier: deps.notifier },
        { amount: WEEKLY_GOAL_BONUS_XP, silent: true },
      );
      this.xpAwardedWeek = this.weekKey;
      await this.save();

      window.dispatchEvent(new CustomEvent('kinetic:notify', {
        detail: { kind: 'success', message: `🏆 Objectifs semaine atteints — +${WEEKLY_GOAL_BONUS_XP} XP !` },
      }));
      window.dispatchEvent(new CustomEvent('kinetic:xp-updated'));
    },
  };
}
