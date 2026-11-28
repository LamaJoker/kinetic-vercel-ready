/**
 * Actions des raccourcis (icône de l'app, app Raccourcis d'iPhone) — chargé à la
 * demande par lib/mobile.ts quand un lien com.lamajoker.kinetic://open/<action>
 * arrive. Liens et textes : lib/deep-link.ts.
 */
import Alpine from 'alpinejs';
import {
  STORAGE_KEYS,
  addWater,
  formatWater,
  glassSize,
  localDay,
  waterGoal,
  waterTotal,
  type WaterLog,
  type WaterPrefs,
  currentBodyweightKg,
} from '@kinetic/core';
import { getDeps } from '../deps';
import type { ShortcutAction } from './deep-link';
import { waterShortcutMessage } from './shortcut-list';
import { hapticLight, hapticSuccess } from './haptics';
import { loadSessions, loadTemplates } from './training/storage';
import { buildTrainingSnapshot } from './training/next-session';
import { loadActiveSession } from './training/active-session';
import { loadProgramWeek, templateForToday } from './program-week';
import { notify } from './notify';

type OpenRoute = (route: string) => void;

/**
 * Attend que la page demandée soit affichée (et que le routeur ait remis le
 * défilement en haut), puis amène l'élément à l'écran et lui donne le focus.
 */
function revealWhenReady(selector: string, timeoutMs = 4000): void {
  const started = Date.now();
  const tryReveal = (): void => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) {
      if (Date.now() - started < timeoutMs) window.setTimeout(tryReveal, 150);
      return;
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    if (!el.hasAttribute('tabindex') && !/^(INPUT|BUTTON|A|SELECT|TEXTAREA)$/.test(el.tagName)) {
      el.setAttribute('tabindex', '-1');
    }
    el.focus({ preventScroll: true });
  };
  const onRoute = (): void => {
    window.removeEventListener(STORAGE_KEYS.EVENT_ROUTE_CHANGED, onRoute);
    // Le routeur remet la page en haut juste après l'affichage (≤ 300 ms).
    window.setTimeout(tryReveal, 450);
  };
  window.addEventListener(STORAGE_KEYS.EVENT_ROUTE_CHANGED, onRoute);
  window.setTimeout(
    () => window.removeEventListener(STORAGE_KEYS.EVENT_ROUTE_CHANGED, onRoute),
    timeoutMs,
  );
}

/** Modèle de la séance du jour : programme suivi, sinon la séance proposée à l'accueil. */
async function todayTemplateId(): Promise<string | null> {
  const deps = await getDeps();
  const [sessions, templates] = await Promise.all([
    loadSessions(deps.storage),
    loadTemplates(deps.storage),
  ]);
  try {
    const week = await loadProgramWeek(deps.storage);
    if (week?.plan.today) {
      const t = templateForToday(week, templates);
      if (t) return t.id;
    }
  } catch {
    /* programme illisible : séance proposée par l'accueil */
  }
  return buildTrainingSnapshot(sessions, templates).next?.templateId ?? null;
}

async function startToday(open: OpenRoute): Promise<void> {
  const deps = await getDeps();
  // Une séance est déjà en cours : on la reprend, sans en démarrer une autre.
  if (!(await loadActiveSession(deps.storage))) {
    const id = await todayTemplateId();
    if (id) {
      try {
        sessionStorage.setItem(STORAGE_KEYS.PROGRAM_AUTO_TEMPLATE, id);
      } catch {
        /* sessionStorage indisponible : la page Séances s'ouvre simplement */
      }
    } else {
      notify('info', 'Aucune séance prévue : choisis-en une.');
    }
  }
  hapticLight();
  open('/seances');
}

/** Objectif d'eau atteint : coche « Boire 2 L d'eau » dans la routine (comme la jauge). */
async function completeHydrationTask(): Promise<void> {
  try {
    const store = Alpine.store('vitalite') as
      | {
          tasks?: Array<{ id: string; done: boolean }>;
          complete?: (id: string, byUser?: boolean) => Promise<void>;
        }
      | undefined;
    const task = store?.tasks?.find((t) => t.id === 'hydration');
    if (task && !task.done && store?.complete) await store.complete('hydration', false);
  } catch {
    /* routine indisponible */
  }
}

async function addGlass(open: OpenRoute): Promise<void> {
  const deps = await getDeps();
  const date = localDay(new Date());
  const [log, prefs, profile, entries] = await Promise.all([
    deps.storage.get<WaterLog>(STORAGE_KEYS.WELLNESS_WATER),
    deps.storage.get<WaterPrefs>(STORAGE_KEYS.WELLNESS_WATER_PREFS),
    deps.storage.get<{ weightKg?: number }>(STORAGE_KEYS.USER_PROFILE),
    deps.storage.get<Array<{ weight?: number }>>(STORAGE_KEYS.BODYWEIGHT_ENTRIES),
  ]);
  const weight = currentBodyweightKg(entries) ?? Number(profile?.weightKg);
  const goal = waterGoal(prefs, Number.isFinite(weight) && weight > 0 ? weight : null);
  const glass = glassSize(prefs);
  const before = waterTotal(log, date);
  const next = addWater(log && typeof log === 'object' ? log : {}, date, glass);
  try {
    await deps.storage.set(STORAGE_KEYS.WELLNESS_WATER, next);
  } catch {
    notify('error', 'Impossible d’ajouter le verre.');
    return;
  }
  const total = waterTotal(next, date);
  const reached = before < goal && total >= goal;
  if (reached) {
    hapticSuccess();
    await completeHydrationTask();
  } else hapticLight();
  // L'accueil relit l'eau à l'affichage : la jauge montre le nouveau verre.
  open('/');
  notify(
    'success',
    waterShortcutMessage(formatWater(glass), formatWater(total), formatWater(goal), total >= goal),
  );
}

/** Exécute l'action d'un raccourci (la page cible est ouverte par l'action). */
export async function runShortcutAction(action: ShortcutAction, open: OpenRoute): Promise<void> {
  switch (action) {
    case 'start-today':
      await startToday(open);
      return;
    case 'add-water':
      await addGlass(open);
      return;
    case 'log-weight':
      revealWhenReady('#f-bodyweight-1');
      open('/bodyweight');
      return;
    case 'checkin':
      revealWhenReady('[aria-labelledby="form-title"]');
      open('/');
      return;
  }
}
