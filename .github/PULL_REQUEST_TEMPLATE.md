## Pourquoi

<!-- Quel problème cette PR résout ? Quel est le contexte ? -->

## Quoi

<!-- Liste concise des changements principaux. -->

- [ ] ...

## Comment tester

<!-- Étapes manuelles pour valider. Indique les commandes (`pnpm test`, etc.). -->

1.
2.

## Checklist

- [ ] `pnpm lint` passe (0 warning)
- [ ] `pnpm typecheck` passe
- [ ] `pnpm test` passe avec couverture maintenue
- [ ] `pnpm build` passe + `pnpm size` sous budget
- [ ] E2E mis à jour si parcours utilisateur modifié
- [ ] A11y vérifiée (axe via `pnpm e2e:a11y` si UI modifiée)
- [ ] Doc mise à jour (README, ADR, CONTRIBUTING) si pertinent
- [ ] Pas de secret committé (vérifié par gitleaks en CI)

## Risques / rollback

<!-- Y a-t-il des migrations DB ? Des changements de contrat API ? Comment rollback ? -->
