export type UserGoal = 'lose_fat' | 'gain_muscle' | 'recomp' | 'performance';

export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

export interface UserProfile {
  version: 1;
  createdAt: string;
  updatedAt: string;

  sex: 'male' | 'female';
  ageYears: number;
  heightCm: number;
  weightKg: number;

  activity: ActivityLevel;
  goal: UserGoal;
}
