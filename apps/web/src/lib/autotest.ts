import { STORAGE_KEYS } from '@kinetic/core';

/**
 * Parcours automatique pour le test dans le simulateur iPhone.
 *
 * Le script de test dépose `kinetic-autotest.json` dans le dossier Documents
 * privé de l'application (inaccessible depuis l'extérieur sur un vrai téléphone).
 * Sans ce fichier, rien ne se passe. Avec lui :
 *   1. `demo: true` charge la démonstration (installation neuve uniquement,
 *      jamais par-dessus un profil existant), puis recharge l'application ;
 *   2. chaque route est affichée tour à tour ; `kinetic-autotest-step.json`
 *      indique l'étape en cours, et l'app attend `kinetic-autotest-ack.json`
 *      (capture prise) avant de passer à la suivante ;
 *   3. le fichier de plan est supprimé : le parcours ne se rejoue pas.
 */
export interface AutotestPlan {
  demo?: boolean;
  routes?: string[];
  stepMs?: number;
}

const PLAN_FILE = 'kinetic-autotest.json';
const STEP_FILE = 'kinetic-autotest-step.json';
const ACK_FILE = 'kinetic-autotest-ack.json';
const ACK_TIMEOUT_MS = 30000;

export function parsePlan(raw: string): AutotestPlan | null {
  try {
    const plan = JSON.parse(raw) as unknown;
    if (!plan || typeof plan !== 'object') return null;
    const { demo, routes, stepMs } = plan as Record<string, unknown>;
    return {
      demo: demo === true,
      routes: Array.isArray(routes)
        ? routes.filter((r): r is string => typeof r === 'string' && /^\/[a-z-]*$/.test(r))
        : [],
      stepMs: typeof stepMs === 'number' && stepMs >= 500 && stepMs <= 30000 ? stepMs : 3500,
    };
  } catch {
    return null;
  }
}

export async function runAutotest(openRoute: (route: string) => void): Promise<void> {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  const where = { directory: Directory.Documents, encoding: Encoding.UTF8 } as const;
  let raw: string;
  try {
    raw = String((await Filesystem.readFile({ path: PLAN_FILE, ...where })).data);
  } catch {
    return; // pas de plan : utilisation normale
  }
  const plan = parsePlan(raw);
  if (!plan) {
    await Filesystem.deleteFile({ path: PLAN_FILE, directory: Directory.Documents });
    return;
  }
  // Diagnostic joint à chaque étape : ce que l'écran affiche vraiment et les erreurs JS,
  // invisibles sinon dans les journaux du simulateur.
  const errors: string[] = [];
  const t0 = Date.now();
  window.addEventListener('error', (e) => errors.push(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) =>
    errors.push(`rejection: ${String((e as PromiseRejectionEvent).reason).slice(0, 200)}`),
  );
  // Erreurs et avertissements écrits par l'app elle-même (stockage, stores…).
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (errors.length < 12) {
        errors.push(
          `${level}: ${args
            .map((a) => String(a))
            .join(' ')
            .slice(0, 220)}`,
        );
      }
      original(...args);
    };
  }
  /** Nombre de clés stockées et séances, ou la raison de l'échec (stockage bloqué ?). */
  const storageProbe = async (): Promise<string> => {
    try {
      const { getDeps } = await import('../deps');
      const deps = await getDeps();
      const timeout = new Promise<string>((resolve) =>
        setTimeout(() => resolve('délai dépassé (3 s)'), 3000),
      );
      const probe = (async () => {
        const started = Date.now();
        const keys = await deps.storage.keys();
        const sessions = keys.filter((k) => k.includes('training:session')).length;
        return `${keys.length} clés, ${sessions} séances, ${Date.now() - started} ms`;
      })();
      return await Promise.race([probe, timeout]);
    } catch (err) {
      return `échec : ${String(err).slice(0, 160)}`;
    }
  };
  const snapshot = () => {
    const outlet = document.getElementById('app-outlet');
    return {
      ms: Date.now() - t0,
      path: window.location.pathname,
      busy: outlet?.getAttribute('aria-busy') ?? null,
      nav: document.documentElement.dataset.kNav ?? null,
      text: (outlet?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160),
      errors: errors.splice(0),
    };
  };
  const writeStep = async (step: number, route: string) => {
    const diag = { ...snapshot(), storage: await storageProbe() };
    await Filesystem.writeFile({
      path: STEP_FILE,
      data: JSON.stringify({ step, route, diag }),
      ...where,
    });
  };

  if (plan.demo) {
    const { getDeps } = await import('../deps');
    const deps = await getDeps();
    const hasProfile = Boolean(await deps.storage.get(STORAGE_KEYS.USER_PROFILE));
    await Filesystem.writeFile({
      path: PLAN_FILE,
      data: JSON.stringify({ ...plan, demo: false }),
      ...where,
    });
    if (!hasProfile) {
      const { loadDemoData } = await import('./demo');
      const started = Date.now();
      let outcome: string;
      try {
        outcome = `${await loadDemoData(deps.storage)} séances écrites`;
      } catch (err) {
        outcome = `échec : ${String(err).slice(0, 200)}`;
      }
      await Filesystem.writeFile({
        path: 'kinetic-autotest-demo.json',
        data: JSON.stringify({ outcome, ms: Date.now() - started, storage: await storageProbe() }),
        ...where,
      });
      window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_ONBOARDING_COMPLETE));
      window.location.assign('/');
      return;
    }
  }

  /** Attend que le script ait pris la capture de l'étape (fichier d'accusé), au plus 30 s. */
  const waitForAck = async (step: number, minMs: number): Promise<void> => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, minMs));
    while (Date.now() - start < ACK_TIMEOUT_MS) {
      try {
        const ack = JSON.parse(
          String((await Filesystem.readFile({ path: ACK_FILE, ...where })).data),
        ) as { step?: number };
        if ((ack.step ?? 0) >= step) return;
      } catch {
        /* pas encore d'accusé */
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };

  await Filesystem.deleteFile({ path: PLAN_FILE, directory: Directory.Documents });
  const routes = plan.routes ?? [];
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i] as string;
    openRoute(route);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await writeStep(i + 1, route);
    await waitForAck(i + 1, plan.stepMs ?? 3500);
  }
  await writeStep(routes.length + 1, 'fin');
}
