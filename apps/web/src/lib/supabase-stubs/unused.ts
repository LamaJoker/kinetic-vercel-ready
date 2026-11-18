/**
 * lib/supabase-stubs/unused.ts
 *
 * Remplaçants légers des sous-modules de supabase-js que Kinetic n'utilise
 * pas : Realtime (websockets), Storage (fichiers) et Edge Functions.
 * `createClient()` les importe et les instancie quand même, ce qui pesait
 * ~22 KiB gzip de JS jamais exécuté. vite.config.ts redirige
 * `@supabase/realtime-js`, `@supabase/storage-js` et `@supabase/functions-js`
 * vers les fichiers de ce dossier.
 *
 * Seuls `auth` (connexion) et `rpc` / `from` (PostgREST, synchronisation)
 * servent. Si un jour l'app a besoin d'une de ces fonctions, retirer l'alias
 * correspondant dans vite.config.ts : l'appel lève une erreur explicite
 * plutôt que d'échouer en silence.
 */

export function unavailable(feature: string): never {
  throw new Error(
    `Supabase ${feature} n'est pas inclus dans Kinetic (voir apps/web/src/lib/supabase-stubs).`,
  );
}
