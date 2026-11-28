/**
 * Health Connect (application Android) : enregistre les pesées et lit les pas et
 * le sommeil pour valider automatiquement les tâches correspondantes de la routine.
 * Sans effet sur le web.
 */
import { Capacitor } from '@capacitor/core';
import { STORAGE_KEYS, localDayDate } from '@kinetic/core';
import type { HealthDataType, HealthSample } from '@capgo/capacitor-health';

export const STEPS_GOAL = 8000;
export const SLEEP_GOAL_MIN = 7 * 60;

const READ: HealthDataType[] = ['steps', 'sleep'];
const WRITE: HealthDataType[] = ['weight', 'bodyFat'];

export interface HealthToday {
  steps: number | null;
  sleepMinutes: number | null;
}

async function plugin() {
  return (await import('@capgo/capacitor-health')).Health;
}

function isAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function healthEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.HEALTH_ENABLED) === '1';
  } catch {
    return false;
  }
}

function setHealthEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEYS.HEALTH_ENABLED, '1');
    else localStorage.removeItem(STORAGE_KEYS.HEALTH_ENABLED);
  } catch {
    /* ignore */
  }
}

export type HealthAvailability = 'available' | 'not-installed' | 'unsupported';

export async function healthAvailability(): Promise<HealthAvailability> {
  if (!isAndroid()) return 'unsupported';
  try {
    return (await (await plugin()).isAvailable()).available ? 'available' : 'not-installed';
  } catch {
    return 'unsupported';
  }
}

/** Demande les autorisations. Vrai si au moins une lecture ou écriture est accordée. */
export async function enableHealth(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    const status = await (await plugin()).requestAuthorization({ read: READ, write: WRITE });
    const granted = status.readAuthorized.length + status.writeAuthorized.length > 0;
    setHealthEnabled(granted);
    return granted;
  } catch (err) {
    console.warn('[health] authorization failed:', err);
    setHealthEnabled(false);
    return false;
  }
}

export function disableHealth(): void {
  setHealthEnabled(false);
}

export async function openHealthSettings(): Promise<void> {
  try {
    await (await plugin()).openHealthConnectSettings();
  } catch {
    /* ignore */
  }
}

/**
 * Enregistre une pesée (et la masse grasse) dans Health Connect. `day` (« AAAA-MM-JJ »,
 * local) : pesée d'un jour passé, datée de ce jour à midi pour ne pas passer pour le
 * poids actuel ; sans `day` (ou pour aujourd'hui), datée de maintenant.
 */
export async function writeBodyweight(
  weightKg: number,
  bodyFatPct: number | null,
  day?: string,
): Promise<void> {
  if (!isAndroid() || !healthEnabled()) return;
  try {
    const health = await plugin();
    const now = new Date();
    const past = day ? localDayDate(day) : null;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (past) past.setHours(12);
    const at = (past && past < startOfToday ? past : now).toISOString();
    await health.saveSample({
      dataType: 'weight',
      value: weightKg,
      unit: 'kilogram',
      startDate: at,
      endDate: at,
    });
    if (bodyFatPct != null && bodyFatPct > 0) {
      await health.saveSample({
        dataType: 'bodyFat',
        value: bodyFatPct,
        unit: 'percent',
        startDate: at,
        endDate: at,
      });
    }
  } catch (err) {
    console.warn('[health] weight write failed:', err);
  }
}

/** Minutes de sommeil réel d'une session (sans les éveils quand les phases sont connues). */
export function sleepMinutes(sample: HealthSample): number {
  if (sample.hasStageData && sample.stages?.length) {
    return sample.stages
      .filter((stage) => stage.stage !== 'awake' && stage.stage !== 'inBed')
      .reduce((sum, stage) => sum + stage.durationMinutes, 0);
  }
  return sample.value;
}

/** Nuit rattachée à `now` : sessions qui se terminent entre 18 h la veille et maintenant. */
export function lastNightWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setDate(start.getDate() - 1);
  start.setHours(18, 0, 0, 0);
  return { start, end: now };
}

export async function readHealthToday(now: Date = new Date()): Promise<HealthToday> {
  const empty: HealthToday = { steps: null, sleepMinutes: null };
  if (!isAndroid() || !healthEnabled()) return empty;
  const health = await plugin();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);

  let steps: number | null = null;
  try {
    const { samples } = await health.queryAggregated({
      dataType: 'steps',
      startDate: midnight.toISOString(),
      endDate: now.toISOString(),
      bucket: 'day',
      aggregation: 'sum',
    });
    steps = Math.round(samples.reduce((sum, sample) => sum + sample.value, 0));
  } catch (err) {
    console.warn('[health] steps read failed:', err);
  }

  let sleep: number | null = null;
  try {
    const { start, end } = lastNightWindow(now);
    const { samples } = await health.readSamples({
      dataType: 'sleep',
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
    const nights = samples.filter((sample) => Date.parse(sample.endDate) >= start.getTime());
    if (nights.length > 0) sleep = Math.round(nights.reduce((sum, s) => sum + sleepMinutes(s), 0));
  } catch (err) {
    console.warn('[health] sleep read failed:', err);
  }

  return { steps, sleepMinutes: sleep };
}
