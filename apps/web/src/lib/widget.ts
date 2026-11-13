/**
 * Widget d'écran d'accueil (Android) — pousse la série et l'avancement de la
 * routine vers le plugin natif `KineticWidget`. Sans effet sur le web.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { STORAGE_KEYS } from '@kinetic/core';
import type { StreakState } from '@kinetic/core';
import { getDeps } from '../deps';

export interface RoutineProgress {
  done: number;
  total: number;
}

export interface WidgetSnapshot extends RoutineProgress {
  streak: number;
  lastActiveDate: string;
  /** Jour (local, AAAA-MM-JJ) auquel `done` se rapporte. */
  date: string;
}

interface KineticWidgetPlugin {
  update(snapshot: WidgetSnapshot): Promise<void>;
  canPin(): Promise<{ supported: boolean }>;
  requestPin(): Promise<{ requested: boolean }>;
}

const KineticWidget = registerPlugin<KineticWidgetPlugin>('KineticWidget');

export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function buildWidgetSnapshot(
  streak: StreakState | null | undefined,
  routine: RoutineProgress,
  date: string,
): WidgetSnapshot {
  const total = Math.max(0, Math.floor(routine.total));
  return {
    streak: Math.max(0, streak?.count ?? 0),
    lastActiveDate: streak?.lastActiveDate ?? '',
    done: Math.min(total, Math.max(0, Math.floor(routine.done))),
    total,
    date,
  };
}

function isAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function syncWidget(routine: RoutineProgress): Promise<void> {
  if (!isAndroid()) return;
  try {
    const deps = await getDeps();
    const streak = await deps.storage.get<StreakState>(STORAGE_KEYS.STREAK);
    await KineticWidget.update(buildWidgetSnapshot(streak, routine, localIsoDate()));
  } catch (err) {
    console.warn('[widget] sync failed:', err);
  }
}

export async function canPinWidget(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return (await KineticWidget.canPin()).supported;
  } catch {
    return false;
  }
}

export async function requestPinWidget(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return (await KineticWidget.requestPin()).requested;
  } catch {
    return false;
  }
}
