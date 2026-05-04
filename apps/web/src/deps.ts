/**
 * Container de dépendances — résout les ports en implémentations concrètes.
 *
 * FIX #5 : Deux améliorations :
 *   1. Timeout porté de 3s → 8s pour absorber les cold starts Supabase et les
 *      connexions 3G. En dessous de 8s, l'app reste en attente sans dégradation.
 *   2. Écoute de 'kinetic:auth-changed' : si le user se connecte APRÈS le timeout,
 *      on reconstruit les deps avec HybridStorage pour ne pas rester en mode local.
 *
 * Garanties :
 *  - Timeout 8s sur Supabase → fallback local garanti. L'app ne bloque JAMAIS.
 *  - Un seul appel Supabase en cours à la fois grâce au pattern inflight.
 *  - Protection contre les race conditions post-resetDeps() : une AbortController
 *    annule les résolutions en cours si resetDeps() est appelé (ex: logout).
 */
import {
  IdbStorage, SystemClock, UuidGenerator, ToastNotifier,
  HybridStorage, SupabaseStorage, SupabaseDailyLogSync, NoopDailyLogSync,
  supabase, getAuthUser,
} from '@kinetic/adapters-web';
import type { StoragePort, ClockPort, IdGeneratorPort, NotifierPort, DailyLogSyncPort } from '@kinetic/core';

export interface AppDeps {
  storage:       StoragePort;
  clock:         ClockPort;
  idGen:         IdGeneratorPort;
  notifier:      NotifierPort;
  dailyLogSync:  DailyLogSyncPort;
}

let _deps: AppDeps | null = null;
let _inflight: Promise<AppDeps> | null = null;
// AbortController actif pour le build courant — permet d'annuler si resetDeps() est appelé
let _abortCtrl: AbortController | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function getDeps(): Promise<AppDeps> {
  if (_deps) return _deps;
  if (_inflight) return _inflight;

  // Nouveau build — crée un AbortController pour ce cycle
  const ctrl = new AbortController();
  _abortCtrl = ctrl;

  _inflight = (async (): Promise<AppDeps> => {
    const local    = new IdbStorage();
    const clock    = new SystemClock();
    const idGen    = new UuidGenerator();
    const notifier = new ToastNotifier();

    let storage: StoragePort           = local;
    let dailyLogSync: DailyLogSyncPort = new NoopDailyLogSync();

    // Vérifier que l'URL Supabase n'est pas le placeholder par défaut
    const supabaseUrl = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
    const hasRealSupabase = supabase !== null
      && typeof supabaseUrl === 'string'
      && supabaseUrl.length > 10
      && !supabaseUrl.includes('xxxxxxxxxxxxxxxxxxxx');

    if (hasRealSupabase && supabase) {
      try {
        // FIX #5 : Timeout porté à 8s (était 3s) — cold start Supabase ≈ 2-4s, 3G RTT ≈ 3-5s
        const user = await withTimeout(getAuthUser(), 8000);

        // Si resetDeps() a été appelé pendant la résolution (ex: logout mid-flight),
        // on abandonne ce build pour ne pas créer une connexion Supabase obsolète.
        if (ctrl.signal.aborted) {
          return { storage: local, clock, idGen, notifier, dailyLogSync };
        }

        if (user) {
          const remote = new SupabaseStorage(supabase, user.id);
          const hybrid = new HybridStorage(local, remote);
          void hybrid.syncFromRemote().catch((err) =>
            console.warn('[deps] remote sync failed:', err)
          );
          storage      = hybrid;
          dailyLogSync = new SupabaseDailyLogSync(supabase);
        }
      } catch (err) {
        console.warn('[deps] Supabase unreachable, using local storage:', err);
      }
    }

    const result: AppDeps = { storage, clock, idGen, notifier, dailyLogSync };

    // Ne sauvegarder que si ce build n'a pas été annulé par resetDeps()
    if (!ctrl.signal.aborted) {
      _deps = result;
    }

    return result;
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

export function resetDeps(): void {
  // Annuler toute résolution en cours
  _abortCtrl?.abort();
  _abortCtrl = null;
  _deps      = null;
  // _inflight se vide seul via le `finally` ci-dessus
}

export function _resetDepsForTesting(mock: AppDeps): void {
  _deps = mock;
}

/**
 * FIX #5 : Écouter kinetic:auth-changed pour rebascule HybridStorage.
 *
 * Scénario : getDeps() timeout → mode local → SIGNED_IN arrive après →
 * authStore dispatche 'kinetic:auth-changed' → on reset et reconstruit.
 */
// M4 FIX: flag module-level pour éviter le double enregistrement en HMR Vite
const _WIN = typeof window !== 'undefined' ? (window as Window & { _kineticAuthChangedListening?: boolean }) : null;

if (_WIN && !_WIN._kineticAuthChangedListening) {
  _WIN._kineticAuthChangedListening = true;
  _WIN.addEventListener('kinetic:auth-changed', async () => {
    // Si les deps courantes sont déjà en mode Hybrid, rien à faire
    if (_deps?.storage instanceof HybridStorage) return;

    console.info('[deps] auth-changed received after timeout — rebuilding with HybridStorage');
    resetDeps();

    try {
      await getDeps();
    } catch (err) {
      console.warn('[deps] rebuild after auth-changed failed:', err);
      return;
    }

    // Notifier les stores Alpine pour qu'ils rechargent leurs données cloud
    _WIN!.dispatchEvent(new CustomEvent('kinetic:deps-ready'));
  });
}
