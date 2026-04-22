import { getDeps } from '../deps';
import type { ActivityLevel, UserGoal, UserProfile } from '../lib/user/types';
import { saveUserProfile, loadUserProfile } from '../lib/user/storage';
import { estimateTdeeKcal, estimateTargetCaloriesKcal } from '../lib/user/nutrition';
import { navigate } from '../router';

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function onboarding() {
  return {
    saving: false,

    // Form state
    goal: 'lose_fat' as UserGoal,
    sex: 'male' as 'male' | 'female',
    ageYears: 28,
    heightCm: 175,
    weightKg: 75,
    activity: 'moderate' as ActivityLevel,

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const existing = await loadUserProfile(deps.storage);
        if (existing) {
          this.goal = existing.goal;
          this.sex = existing.sex;
          this.ageYears = existing.ageYears;
          this.heightCm = existing.heightCm;
          this.weightKg = existing.weightKg;
          this.activity = existing.activity;
        }
      } catch (err) {
        console.warn('[onboarding] init failed:', err);
      }
    },

    get tdee(): number | null {
      const p = this._profileDraft();
      if (!p) return null;
      return Math.round(estimateTdeeKcal(p));
    },

    get targetCalories(): number | null {
      const p = this._profileDraft();
      if (!p) return null;
      return estimateTargetCaloriesKcal(p);
    },

    _profileDraft(): UserProfile | null {
      const ageYears = clamp(Number(this.ageYears), 12, 90);
      const heightCm = clamp(Number(this.heightCm), 120, 230);
      const weightKg = clamp(Number(this.weightKg), 30, 250);
      if (!Number.isFinite(ageYears) || !Number.isFinite(heightCm) || !Number.isFinite(weightKg)) return null;

      const now = nowIso();
      return {
        version: 1,
        createdAt: now,
        updatedAt: now,
        sex: this.sex,
        ageYears,
        heightCm,
        weightKg,
        activity: this.activity,
        goal: this.goal,
      };
    },

    async save(): Promise<void> {
      const draft = this._profileDraft();
      if (!draft) return;

      this.saving = true;
      try {
        const deps = await getDeps();
        const existing = await loadUserProfile(deps.storage);
        const now = nowIso();
        const next: UserProfile = existing
          ? { ...draft, createdAt: existing.createdAt, updatedAt: now }
          : { ...draft, createdAt: now, updatedAt: now };
        await saveUserProfile(deps.storage, next);

        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'success', message: 'Profil sauvegarde' },
        }));
        window.dispatchEvent(new CustomEvent('kinetic:onboarding-complete'));

        navigate('/', true);
      } catch (err) {
        console.error('[onboarding] save failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Erreur sauvegarde profil' },
        }));
      } finally {
        this.saving = false;
      }
    },
  };
}
