# ADR 0001 — Architecture hexagonale (ports & adapters)

- **Status** : Accepted
- **Date** : 2025-12-01

## Contexte

Kinetic est une PWA fitness multi-plateforme (Web + Android via Capacitor). La logique métier (XP, streak, programmes d'entraînement, nutrition) doit être :

- **Testable** sans navigateur, IDB ni Supabase.
- **Portable** vers d'autres adapters (potentiellement iOS natif, CLI de seed, edge functions).
- **Stable** face aux changements d'implémentation backend (Supabase peut être remplacé).

## Décision

Adopter l'**architecture hexagonale** :

```
packages/core/        ← Domain pur (0 dépendance externe)
  ├── domain/         ← Pure functions (xp, streak, nutrition…)
  ├── usecases/       ← Orchestration cas d'usage
  ├── ports/          ← Interfaces (StoragePort, ClockPort, SyncPort…)
  └── constants/

packages/adapter-web/ ← Implémentations concrètes (Supabase, IDB, fetch…)

apps/web/             ← UI Alpine.js (stores, pages, router)
  └── deps.factory.ts ← Wire-up des ports vers les adapters
```

**Règle invariante** : `packages/core` n'a **aucune** dépendance runtime externe (pas de `dependencies` dans son `package.json`).

## Conséquences

### Positives

- Domain testable en pur JS/TS (514 tests unitaires, < 2s).
- Coverage domain ≥ 80 % atteignable sans browser.
- Swap d'adapter sans toucher la logique métier.
- Frontière claire pour le code review : un PR qui ajoute un import externe dans `packages/core` est immédiatement signalé.

### Négatives

- Ajoute une couche de wire-up (`deps.factory.ts`).
- Demande de discipline : "où dois-je mettre ce code ?" → règle simple : _si ça parle au monde extérieur, c'est un port_.

### Tests d'enforcement

- `dependency-cruiser` (à venir) : aucun import de `apps/` ou `packages/adapter-web/` depuis `packages/core/`.
- ESLint : interdire les imports `node_modules` (sauf types) depuis `packages/core/`.

## Alternatives considérées

1. **Architecture monolithique** : tout dans `apps/web/src/`. Rejetée pour la testabilité.
2. **Clean Architecture stricte** (layers UI / Application / Domain / Infrastructure) : trop verbeux pour une PWA de cette taille.
3. **Feature folders sans séparation domain/adapter** : ré-importerait Supabase dans les tests.
