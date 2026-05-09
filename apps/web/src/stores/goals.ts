/**
 * Store Alpine `goals` - objectifs hebdomadaires d'entrainement.
 * La logique pure vit dans `@kinetic/core/domain/goals.domain`.
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
type SessionList = Awaited<ReturnType<typeof loadSessions>>;
type SessionItem = SessionList[number];

export function goalsStore() {
  return {
    targetSessions: 3,
    targetTonnageKg: 0,
    doneSessions: 0,
    doneTonnageKg: 0,
    sessionsPercent: 0,
    tonnagePercent: 100,
    sessionsOk: false,
    tonnageOk: true,
    allOk: false,
    weekKey: '',
    xpAwardedWeek: '',
    loading: true,

    _sessionSavedHandler: null as (() => void) | null,
    _sessionSavedDetailHandler: null as ((event: Event) => void) | null,
    _sessionsCache: [] as SessionList,

    async init(): Promise<void> {
      this._sessionSavedHandler = () => void this.reload();
      this._sessionSavedDetailHandler = (event: Event) => {
        const detail = (event as CustomEvent<{ session?: SessionItem }>).detail;
        const session = detail?.session;
        if (!session) return;
        this._sessionsCache = [...this._sessionsCache, session];
        this._applyState(this._sessionsCache);
      };

      window.addEventListener('kinetic:session-saved', this._sessionSavedHandler);
      window.addEventListener('kinetic:session-saved', this._sessionSavedDetailHandler);
      await this.reload();
    },

    destroy(): void {
      if (this._sessionSavedHandler) {
        window.removeEventListener('kinetic:session-saved', this._sessionSavedHandler);
        this._sessionSavedHandler = null;
      }
      if (this._sessionSavedDetailHandler) {
        window.removeEventListener('kinetic:session-saved', this._sessionSavedDetailHandler);
        this._sessionSavedDetailHandler = null;
      }
    },

    async reload(): Promise<void> {
      this.loading = true;
      try {
        const deps = await getDeps();
        const saved = await deps.storage.get<{
          targetSessions: number;
          targetTonnageKg: number;
          xpAwardedWeek: string;
        }>(KEY_GOALS);

        if (saved) {
          this.targetSessions = saved.targetSessions ?? 3;
          this.targetTonnageKg = saved.targetTonnageKg ?? 0;
          this.xpAwardedWeek = saved.xpAwardedWeek ?? '';
        }

        this._sessionsCache = await loadSessions(deps.storage);
        const state = this._applyState(this._sessionsCache);

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
          targetSessions: this.targetSessions,
          targetTonnageKg: this.targetTonnageKg,
          xpAwardedWeek: this.xpAwardedWeek,
        });
      } catch (err) {
        console.error('[goals] save failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Echec sauvegarde des objectifs. Reessaie.' },
        }));
      }
    },

    async _awardBonus(deps: Awaited<ReturnType<typeof getDeps>>): Promise<void> {
      await awardXp(
        { storage: deps.storage, notifier: deps.notifier },
        { amount: WEEKLY_GOAL_BONUS_XP, silent: true },
      );
      this.xpAwardedWeek = this.weekKey;
      await this.save();

      window.dispatchEvent(new CustomEvent('kinetic:notify', {
        detail: { kind: 'success', message: `Objectifs semaine atteints - +${WEEKLY_GOAL_BONUS_XP} XP !` },
      }));
      window.dispatchEvent(new CustomEvent('kinetic:xp-updated'));
    },

    _applyState(sessions: SessionList) {
      const state = evaluateWeeklyGoals(sessions, {
        targetSessions: this.targetSessions,
        targetTonnageKg: this.targetTonnageKg,
      });

      this.weekKey = state.weekKey;
      this.doneSessions = state.doneSessions;
      this.doneTonnageKg = state.doneTonnageKg;
      this.sessionsPercent = state.sessionsPercent;
      this.tonnagePercent = state.tonnagePercent;
      this.sessionsOk = state.sessionsOk;
      this.tonnageOk = state.tonnageOk;
      this.allOk = state.allOk;

      return state;
    },
  };
}
