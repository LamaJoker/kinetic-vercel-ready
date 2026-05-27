/**
 * Health Sync — wrapper Capacitor pour Apple Health / Google Fit.
 *
 * État : STUB documenté. Le plugin `@capacitor-community/health` n'est pas
 * encore installé pour éviter de gonfler le bundle web. Le code est prêt :
 * une fois le plugin ajouté, décommenter la ligne d'import et activer.
 *
 * Installation (à faire quand tu veux activer) :
 *   pnpm -F @kinetic/web add @capacitor-community/health
 *   npx cap sync android
 *
 * Permissions Android (à ajouter dans `apps/web/android/app/src/main/AndroidManifest.xml`) :
 *   <uses-permission android:name="android.permission.health.READ_STEPS"/>
 *   <uses-permission android:name="android.permission.health.WRITE_EXERCISE"/>
 *
 * iOS (à faire dans Xcode) :
 *   Ajouter "HealthKit" comme Capability + Info.plist :
 *     NSHealthShareUsageDescription, NSHealthUpdateUsageDescription
 *
 * Pour l'instant : `isHealthAvailable()` retourne false → l'UI masque le bouton.
 */

import type { WorkoutSession } from './training/types';
import { Capacitor } from '@capacitor/core';

export interface HealthWorkoutWrite {
  type: 'strength_training';
  startedAt: Date;
  endedAt: Date;
  caloriesKcal?: number;
}

let _pluginCached: unknown | null = null;
let _availability: boolean | null = null;

/**
 * Tente de charger dynamiquement le plugin. Retourne null si absent —
 * permet de garder le bundle léger jusqu'à activation.
 */
async function getPlugin(): Promise<unknown | null> {
  if (_pluginCached !== null) return _pluginCached;
  if (!Capacitor.isNativePlatform()) {
    _pluginCached = null;
    return null;
  }
  try {
    // @ts-expect-error — module optionnel
    const mod = await import('@capacitor-community/health');
    _pluginCached = mod?.Health ?? mod?.default ?? mod;
    return _pluginCached;
  } catch {
    _pluginCached = null;
    return null;
  }
}

export async function isHealthAvailable(): Promise<boolean> {
  if (_availability !== null) return _availability;
  const plugin = await getPlugin();
  _availability = !!plugin;
  return _availability;
}

/**
 * writeWorkoutToHealth — pousse une séance terminée vers Apple Health
 * (HKWorkoutType.functionalStrengthTraining) ou Google Fit (RESISTANCE_TRAINING).
 *
 * Fait rien (no-op) si le plugin n'est pas installé ou hors-natif.
 * Renvoie true si l'écriture a réussi.
 */
export async function writeWorkoutToHealth(session: WorkoutSession): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin || !session.endedAt) return false;
  try {
    const startedAt = new Date(session.startedAt);
    const endedAt = new Date(session.endedAt);
    // Selon plugin (signature peut varier — wrapper-style ici)
    const p = plugin as {
      requestAuth?: (req: { read?: string[]; write?: string[] }) => Promise<unknown>;
      storeWorkout?: (data: {
        startTime: string;
        endTime: string;
        activityType: string;
        calories?: number;
      }) => Promise<unknown>;
    };
    if (typeof p.requestAuth === 'function') {
      await p.requestAuth({ write: ['workouts'] });
    }
    if (typeof p.storeWorkout === 'function') {
      await p.storeWorkout({
        startTime: startedAt.toISOString(),
        endTime: endedAt.toISOString(),
        activityType: 'STRENGTH_TRAINING',
        ...(session.caloriesKcal ? { calories: session.caloriesKcal } : {}),
      });
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[health-sync] write failed:', err);
    return false;
  }
}
