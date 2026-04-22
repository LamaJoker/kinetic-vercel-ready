/**
 * Store Alpine `xp` — miroir UI du total XP persisté.
 *
 * Ne contient PAS de logique métier :
 *   - Les règles de niveau vivent dans @kinetic/core/domain/xp.domain
 *   - La persistance est faite par les use-cases (completeTask_usecase, awardXp)
 *
 * Ce store se contente de :
 *   - Lire le total XP depuis storage à l'init
 *   - Exposer l'état dérivé (currentLevel, progressPercent, etc.)
 *   - Fournir `reload()` pour que d'autres stores demandent un refresh après un use-case
 */
import { computeXpState } from '@kinetic/core';
import type { XpState } from '@kinetic/core';
import { getDeps } from '../deps';

const KEY_XP = 'kinetic:xp';

export function xpStore() {
  const empty = computeXpState(0);
  return {
    xp:              empty.xp,
    currentLevel:    empty.currentLevel,
    title:           empty.title,
    progressPercent: empty.progressPercent,
    remaining:       empty.remaining,
    isMaxLevel:      empty.isMaxLevel,
    loading:         true,

    async init(): Promise<void> {
      await this.reload();
    },

    async reload(): Promise<void> {
      try {
        const deps = await getDeps();
        const raw  = await deps.storage.get<{ xp: number }>(KEY_XP);
        this._applyState(computeXpState(raw?.xp ?? 0));
      } catch (err) {
        console.error('[xp] reload failed:', err);
      } finally {
        this.loading = false;
      }
    },

    _applyState(state: XpState): void {
      this.xp              = state.xp;
      this.currentLevel    = state.currentLevel;
      this.title           = state.title;
      this.progressPercent = state.progressPercent;
      this.remaining       = state.remaining;
      this.isMaxLevel      = state.isMaxLevel;
    },
  };
}
