/**
 * Store Alpine `rewards` — système de récompenses par niveau.
 *
 * Responsabilités :
 *  - Afficher la modale de déverrouillage lors d'un level-up
 *  - Gérer les jetons de Gel de Streak (1 par semaine à partir du niveau 6)
 *  - Exposer des getters dérivés du niveau courant :
 *      historyDays, hasXpBonus, hasAdvancedCoach, hasLegendBadge
 *
 * Les effets "bonus XP" et "historique étendu" sont lus
 * par vitaliteStore via `Alpine.store('rewards')`.
 */

import { REWARDS, processActivity } from '@kinetic/core';
import type { Reward, StreakState } from '@kinetic/core';
import { getDeps } from '../deps';

// ─── Clés storage ────────────────────────────────────────────────────────────
const KEY_FREEZE_TOKENS      = 'kinetic:rewards:freeze-tokens';
const KEY_FREEZE_WEEK        = 'kinetic:rewards:freeze-replenished-week';
const KEY_STREAK             = 'kinetic:streak';
const KEY_THEME              = 'kinetic:rewards:theme';

// ─── Thèmes ───────────────────────────────────────────────────────────────────
export interface Theme {
  id:     string;
  label:  string;
  emoji:  string;
  neon:   string;   // couleur hex de prévisualisation
  accent: string;
}

export const THEMES: readonly Theme[] = [
  { id: 'electrique', label: 'Électrique', emoji: '⚡', neon: '#A8FF00', accent: '#FF6A00' },
  { id: 'cyber',      label: 'Cyber',      emoji: '🩵', neon: '#00E0FF', accent: '#0070FF' },
  { id: 'violet',     label: 'Violet',     emoji: '💜', neon: '#C060FF', accent: '#FF40A0' },
  { id: 'phoenix',    label: 'Phoenix',    emoji: '🔴', neon: '#FFD200', accent: '#FF3C32' },
  { id: 'fantome',    label: 'Fantôme',    emoji: '🩶', neon: '#DCDCE6', accent: '#8C8CA0' },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Numéro de semaine ISO-8601. */
function isoWeekKey(date: Date = new Date()): string {
  const d    = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day  = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function notify(kind: 'success' | 'error' | 'info', message: string): void {
  window.dispatchEvent(new CustomEvent('kinetic:notify', { detail: { kind, message } }));
}

// ─── Store ───────────────────────────────────────────────────────────────────
export function rewardsStore() {
  return {
    // ── Modal level-up ──
    showRewardModal: false,
    pendingReward:   null as Reward | null,
    pendingLevel:    0,

    // ── Gel de streak ──
    freezeTokens:  0,
    freezeLoading: false,

    // ── Thème de couleur ──
    currentTheme: 'electrique',
    allThemes:    THEMES,

    // Référence statique pour les templates
    allRewards: REWARDS,

    // ─────────────────────────────────────────────────────────────────────────
    init(): void {
      // Écouter les level-up pour afficher la modale de récompense
      window.addEventListener('kinetic:levelup', (e: Event) => {
        const detail = (e as CustomEvent<{ level: number; title: string }>).detail;
        if (!detail) return;
        const reward = REWARDS.find((r) => r.level === detail.level);
        // On n'affiche pas la modale pour le niveau 1 (récompense "base")
        if (reward && reward.kind !== 'base') {
          this.pendingReward   = reward;
          this.pendingLevel    = detail.level;
          this.showRewardModal = true;
        }
      });

      // Charger / renouveler les jetons de gel
      void this._initFreezeTokens();

      // Appliquer le thème sauvegardé
      void this._loadTheme();
    },

    // ─── Jetons de gel ───────────────────────────────────────────────────────
    async _initFreezeTokens(): Promise<void> {
      try {
        const deps    = await getDeps();
        const weekKey = isoWeekKey();
        const lastWeek = await deps.storage.get<string>(KEY_FREEZE_WEEK);

        // Nouveau renouvellement hebdomadaire (1 jeton max 2)
        if (lastWeek !== weekKey) {
          const level = this._currentLevel();
          if (level >= 6) {
            const current = (await deps.storage.get<number>(KEY_FREEZE_TOKENS)) ?? 0;
            const renewed = Math.min(current + 1, 2);
            await deps.storage.set(KEY_FREEZE_TOKENS, renewed);
            await deps.storage.set(KEY_FREEZE_WEEK,   weekKey);
          }
        }

        this.freezeTokens = (await deps.storage.get<number>(KEY_FREEZE_TOKENS)) ?? 0;
      } catch (err) {
        console.error('[rewards] _initFreezeTokens failed:', err);
      }
    },

    /**
     * useStreakFreeze — consomme un jeton pour marquer aujourd'hui comme actif
     * dans le streak, sans exiger de tâche complétée.
     */
    async useStreakFreeze(): Promise<void> {
      if (this.freezeTokens <= 0 || this.freezeLoading) return;
      this._assertLevel(6);

      this.freezeLoading = true;
      try {
        const deps    = await getDeps();
        const today   = todayIso();

        // Lire le streak courant
        const streakData = (await deps.storage.get<StreakState>(KEY_STREAK)) ?? {
          count: 0, best: 0, lastActiveDate: null,
        };

        // Appliquer l'activité du jour (même logique que compléter une tâche)
        const updated = processActivity(streakData, today);
        await deps.storage.set(KEY_STREAK, updated);

        // Décrémenter le jeton
        const newCount = this.freezeTokens - 1;
        await deps.storage.set(KEY_FREEZE_TOKENS, newCount);
        this.freezeTokens = newCount;

        // Rafraîchir le dashboard streak si visible
        window.dispatchEvent(new CustomEvent('kinetic:streak-updated'));

        notify(
          'success',
          `🧊 Streak protégé ! Il te reste ${newCount} jeton${newCount !== 1 ? 's' : ''}.`,
        );
      } catch (err) {
        console.error('[rewards] useStreakFreeze failed:', err);
        notify('error', "Impossible d'utiliser le gel. Réessaie.");
      } finally {
        this.freezeLoading = false;
      }
    },

    // ─── Thème de couleur ────────────────────────────────────────────────────

    /** Applique un thème visuellement + le persiste. */
    async applyTheme(themeId: string): Promise<void> {
      if (!THEMES.find((t) => t.id === themeId)) return;
      this._setThemeDom(themeId);
      this.currentTheme = themeId;
      try {
        const deps = await getDeps();
        await deps.storage.set(KEY_THEME, themeId);
      } catch (err) {
        console.error('[rewards] applyTheme save failed:', err);
      }
    },

    async _loadTheme(): Promise<void> {
      try {
        const deps    = await getDeps();
        const saved   = (await deps.storage.get<string>(KEY_THEME)) ?? 'electrique';
        this.currentTheme = saved;
        this._setThemeDom(saved);
      } catch { /* pas bloquant */ }
    },

    _setThemeDom(themeId: string): void {
      if (typeof document !== 'undefined') {
        document.documentElement.dataset['theme'] = themeId;
      }
    },

    // ─── Modale ──────────────────────────────────────────────────────────────
    dismissModal(): void {
      this.showRewardModal = false;
      this.pendingReward   = null;
    },

    // ─── Getters dérivés du niveau ────────────────────────────────────────────

    /** Nombre de jours d'historique disponibles dans Vitalité. */
    get historyDays(): number {
      const lv = this._currentLevel();
      if (lv >= 4) return 30;
      if (lv >= 2) return 14;
      return 7;
    },

    /** Vrai si le bonus XP +20 % est actif (niveau ≥ 5). */
    get hasXpBonus(): boolean {
      return this._currentLevel() >= 5;
    },

    /** Vrai si le coach avancé est débloqué (niveau ≥ 3). */
    get hasAdvancedCoach(): boolean {
      return this._currentLevel() >= 3;
    },

    /** Vrai si le gel de streak est disponible (niveau ≥ 6). */
    get hasStreakFreeze(): boolean {
      return this._currentLevel() >= 6;
    },

    /** Vrai si les thèmes de couleur sont débloqués (niveau ≥ 7). */
    get hasColorThemes(): boolean {
      return this._currentLevel() >= 7;
    },

    /** Vrai si le badge Légende est obtenu (niveau 8). */
    get hasLegendBadge(): boolean {
      return this._currentLevel() >= 8;
    },

    /** Retourne true si le niveau requis est atteint (utilisé dans templates). */
    isUnlocked(minLevel: number): boolean {
      return this._currentLevel() >= minLevel;
    },

    // ─── Helpers internes ────────────────────────────────────────────────────

    _currentLevel(): number {
      try {
        const Alpine = (window as unknown as { Alpine: { store: (n: string) => { currentLevel?: number } } }).Alpine;
        return Alpine?.store('xp')?.currentLevel ?? 1;
      } catch {
        return 1;
      }
    },

    _assertLevel(min: number): void {
      if (this._currentLevel() < min) {
        throw new Error(`Cette fonctionnalité nécessite le niveau ${min}.`);
      }
    },
  };
}
