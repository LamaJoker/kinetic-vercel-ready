/**
 * Rappel du soir « Il te manque 35 g de protéines aujourd'hui » (application
 * installée) — notification locale programmée pour aujourd'hui à l'heure choisie
 * (20 h par défaut), recalculée à chaque changement du journal et quand l'app
 * passe en arrière-plan. Aucune notification si l'objectif est atteint, si le
 * manque est sous le seuil, si rien n'a été noté aujourd'hui ou si le rappel est coupé.
 *
 * Chargé à la demande (page Nutrition, main.ts) : la logique vit dans @kinetic/core
 * (planProteinReminder), ce module ne fait que l'I/O.
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import {
  STORAGE_KEYS,
  normalizeNutritionPrefs,
  planProteinReminder,
  sumMacros,
  type MealLog,
  type NutritionPlan,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { ACCENT_HEX } from './palette';
import { PROTEIN_NOTIF_ID, remindersPermitted } from './reminders';

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function syncProteinReminder(now: Date = new Date()): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: PROTEIN_NOTIF_ID }] });
    const { storage } = await getDeps();
    const [rawPrefs, plan, log] = await Promise.all([
      storage.get<unknown>(STORAGE_KEYS.NUTRITION_PREFS),
      storage.get<NutritionPlan>(STORAGE_KEYS.NUTRITION_PLAN),
      storage.get<MealLog[]>(STORAGE_KEYS.NUTRITION_LOG(localIso(now))),
    ]);
    const items = (log ?? []).flatMap((m) => m.items ?? []);
    const reminder = planProteinReminder({
      now,
      prefs: normalizeNutritionPrefs(rawPrefs),
      consumedG: sumMacros(items).proteinG,
      targetG: plan?.macros?.proteinG ?? 0,
      loggedToday: items.length > 0,
    });
    if (!reminder || !(await remindersPermitted())) return;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: PROTEIN_NOTIF_ID,
          title: 'Protéines du jour',
          body: reminder.body,
          smallIcon: 'ic_stat_kinetic',
          iconColor: ACCENT_HEX,
          schedule: { at: reminder.at, allowWhileIdle: true },
          extra: { route: '/nutrition' },
        },
      ],
    });
  } catch (err) {
    console.warn('[reminders] protein reminder failed:', err);
  }
}
