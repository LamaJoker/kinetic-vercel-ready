# Architecture Decision Records (ADR)

Ce dossier capture les décisions architecturales importantes de Kinetic.

## Format

Chaque ADR suit la structure :

1. **Contexte** : Quel problème on résout ?
2. **Décision** : Quel choix on fait ?
3. **Conséquences** : Quels trade-offs on accepte ?

Lecture : [Michael Nygard — Documenting architecture decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions.html).

## Liste

| #                                      | Titre                                      | Status   |
| -------------------------------------- | ------------------------------------------ | -------- |
| [0001](0001-hexagonal-architecture.md) | Architecture hexagonale (ports & adapters) | Accepted |
| [0002](0002-alpine-over-react.md)      | Alpine.js plutôt que React/Vue             | Accepted |
| [0003](0003-offline-first-storage.md)  | Stockage offline-first avec sync différée  | Accepted |

## Quand écrire un ADR ?

- Changement majeur d'architecture (framework, stockage, déploiement).
- Choix d'une dépendance qui sera difficile à remplacer.
- Décision controversée qui mérite d'être expliquée pour le futur.

**Pas** besoin d'ADR pour :

- Bug fixes
- Ajouts de features alignés avec l'architecture existante
- Refactoring local
