/**
 * Store Alpine `goals` - objectifs hebdomadaires d'entrainement.
 * La logique pure vit dans `@kinetic/core/domain/goals.domain`.
 *
 * PERF FIX: l'event `kinetic:session-saved` porte désormais la session dans son
 * detail. On applique un delta en mémoire au lieu de relire toute la liste IDB.
 * Sur 200+ séances, cela évite 100-300 ko de lectures disque à chaque save.
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

    // ── Cache sessions ──────────────────────────────────────────────────────
    // Chargé une seule fois depuis IDB au init/reload.
    // Mis à jour en delta via l'event `kinetic:session-saved` pour éviter les
    // re-lectures disque inutiles à chaque sauvegarde de séance.
    _sessionsCache: [] as SessionList,

    // Handlers stockés pour cleanup dans destroy()
    _sessionSavedHandler: null as ((event: Event) => void) | null,

    async init(): Promise<void> {
      // Un seul handler gère les deux cas :
      //  - detail.session présent  → delta (path rapide, 0 IDB)
      //  - detail.session absent   → reload complet (fallback sûr)
      this._sessionSavedHandler = (event: Event) => {
        const detail = (event as CustomEvent<{ session?: SessionItem }>).detail;
        const session = detail?.session;
        if (session) {
          // FIX #1 — delta en mémoire, pas de re-lecture IDB.
          // On dédoublonne par id : si la session existe déjà (édition),
          // on la remplace ; sinon on append. Évite la double comptabilisation
          // du tonnage / nombre de séances en cas de re-save.
          this._sessionsCache = this._upsertSession(this._sessionsCache, session);
          this._applyState(this._sessionsCache);
          // Le bonus XP éventuel est traité en async sans bloquer l'event loop
          void this._maybeAwardBonus();
        } else {
          // Événement sans payload (ancienne version ou test) → reload complet
          void this.reload();
        }
      };

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
          targetSessions: number;
          targetTonnageKg: number;
          xpAwardedWeek: string;
        }>(KEY_GOALS);

        if (saved) {
          this.targetSessions  = saved.targetSessions  ?? 3;
          this.targetTonnageKg = saved.targetTonnageKg ?? 0;
          this.xpAwardedWeek   = saved.xpAwardedWeek   ?? '';
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
          targetSessions:  this.targetSessions,
          targetTonnageKg: this.targetTonnageKg,
          xpAwardedWeek:   this.xpAwardedWeek,
        });
      } catch (err) {
        console.error('[goals] save failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Echec sauvegarde des objectifs. Reessaie.' },
        }));
      }
    },

    /** Vérifie et crédite le bonus si nécessaire — utilisé après un delta. */
    async _maybeAwardBonus(): Promise<void> {
      const state = { allOk: this.allOk, weekKey: this.weekKey };
      if (!shouldAwardWeeklyBonusXp(state, this.xpAwardedWeek)) return;
      try {
        const deps = await getDeps();
        await this._awardBonus(deps);
      } catch (err) {
        console.warn('[goals] _maybeAwardBonus failed:', err);
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

    /**
     * Insère ou remplace une session dans le cache, en se basant sur l'id si
     * disponible. Si la session n'a pas d'id (cas dégénéré), on retombe sur
     * une comparaison par (startedAt + endedAt) qui est suffisamment unique
     * pour éviter les duplicatas issus d'un re-save de la même séance.
     */
    _upsertSession(list: SessionList, session: SessionItem): SessionList {
      const sessionWithId = session as SessionItem & { id?: string };
      const matchById = sessionWithId.id != null;

      const idx = list.findIndex((s) => {
        const sWithId = s as SessionItem & { id?: string };
        if (matchById && sWithId.id != null) return sWithId.id === sessionWithId.id;
        return s.startedAt === session.startedAt && s.endedAt === session.endedAt;
      });

      if (idx >= 0) {
        const next = list.slice();
        next[idx] = session;
        return next;
      }
      return [...list, session];
    },

    _applyState(sessions: SessionList) {
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

      return state;
    },
  };
}
