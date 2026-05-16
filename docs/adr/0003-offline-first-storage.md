# ADR 0003 — Stockage offline-first avec sync différée

- **Status** : Accepted
- **Date** : 2025-12-01

## Contexte

Une PWA fitness est utilisée :

- En salle de sport (réseau souvent dégradé)
- En extérieur (running, vélo)
- Sans connexion (avion, métro)

Bloquer sur le réseau = mauvaise UX. L'utilisateur doit pouvoir logger ses séances et voir ses stats sans connexion.

## Décision

**IndexedDB** (`idb-keyval`) est la source de vérité locale. Toutes les écritures vont d'abord en IDB. **Supabase** est synchronisé en arrière-plan via `SupabaseDailyLogSync` quand le réseau est disponible.

Pattern :

1. `usecase.complete()` → `storagePort.set(key, value)` (synchrone côté UI, IDB est rapide).
2. Si online, `syncPort.push(record)` envoie vers Supabase.
3. Si offline, l'enregistrement attend dans une queue IDB.
4. À la reconnexion, la queue est drainée (event `kinetic:online`).

Les `daily_logs` Supabase sont **append-only** côté RLS (pas d'UPDATE/DELETE pour les users).

## Conséquences

### Positives

- UX instantanée : aucune attente réseau pour les actions critiques.
- Mode guest pleinement fonctionnel (pas besoin de compte pour tester).
- Resilience native aux coupures réseau.

### Négatives

- **Conflits de sync** possibles si deux appareils écrivent en parallèle → CRDT light pour `daily_logs` (cf. `tests/unit/crdt.test.ts`).
- IDB peut être purgé par le navigateur (low storage). Mitigation : prompt `navigator.storage.persist()` à l'onboarding.
- Données sensibles en clair côté client (IDB n'est pas chiffré). Pas de risque tant que pas de creds.

## Implémentation

- Port : `packages/core/src/ports/StoragePort.ts`
- Adapters : `IdbStorage.ts`, `SupabaseStorage.ts`, `HybridStorage.ts` (compose les deux)
- Tests : `tests/integration/hybrid-storage.test.ts`, `tests/unit/crdt.test.ts`
