# Qualité du code : garde-fous et chantiers

Ce document suit les constats « qualité » de l'audit de novembre 2026 (QA-05, QA-06,
QA-11 à QA-14) : ce qui est corrigé et vérifié par un test, et ce qui reste à faire, avec
un plan.

## Garde-fous en place

| Constat                                                                                                                               | Garde-fou                                                                                                                                                                                                                                                                                    | Preuve                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| QA-05 : `tsc --build` écrivait du JS, des `.d.ts` et des sourcemaps dans `apps/web/dist` (copié dans les apps natives par `cap sync`) | `apps/web/tsconfig.json` émet seulement les déclarations, dans `node_modules/.cache/tsc-web`. `scripts/check-bundle-size.mjs` échoue si `dist` contient des `.ts`, `.map`, `.tsbuildinfo` ou un dossier `src/`                                                                               | `tests/unit/typecheck-output.test.ts`                                 |
| QA-06 : flux enregistrement / suppression de séance non testé, seuils de couverture jamais vérifiés                                   | Tests d'intégration du flux réel (`saveSession`, `deleteSession`, séance en cours, édition, annulation, restauration forcée) sur la pile de synchro réelle. Seuils de couverture globaux et par dossier critique, vérifiés en CI par `pnpm test:coverage`                                    | `tests/integration/training-session-flow.test.ts`, `vitest.config.ts` |
| QA-12 : pages qui instancient des adaptateurs, core compilé avec la lib DOM                                                           | Core compilé sans DOM (`lib: ["ES2022"]`, `types: []`, globaux communs dans `packages/core/src/platform-globals.d.ts`). ESLint `no-restricted-imports` : le core n'importe ni adaptateur, ni app, ni SDK ; les pages n'importent pas `@kinetic/adapters-web` (elles passent par `getDeps()`) | `tests/unit/architecture-boundaries.test.ts`                          |
| QA-13 : code mort                                                                                                                     | `apps/web/src/lib/sync.ts` (jamais importé par l'app) et son test supprimés ; dépendance `vite-tsconfig-paths` (jamais utilisée) retirée                                                                                                                                                     | `pnpm typecheck`, `pnpm test`                                         |
| Tests SQL hors CI                                                                                                                     | Job `sql` de `.github/workflows/ci.yml` : `pnpm test:sql` sur Postgres 16                                                                                                                                                                                                                    | CI                                                                    |

### Seuils de couverture (`pnpm test:coverage`)

Mesure du 26/11/2026 (lignes / branches / fonctions), et seuils fixés un peu en dessous :

| Périmètre                       | Mesure             | Seuils (lignes, instructions / branches / fonctions) |
| ------------------------------- | ------------------ | ---------------------------------------------------- |
| Global                          | 85,2 / 89,0 / 90,3 | 83, 83 / 87 / 88                                     |
| `packages/core/src`             | 98,8 / 91,4 / 98,6 | 97, 97 / 89 / 97                                     |
| `packages/adapter-web/src/sync` | 89,8 / 81,9 / 85,7 | 87, 87 / 79 / 83                                     |
| `apps/web/src/lib/training`     | 96,5 / 91,2 / 96,7 | 94, 94 / 88 / 94                                     |

Règle : on remonte un seuil quand la couverture progresse. On ne le baisse jamais pour
faire passer la CI : on ajoute le test manquant.

Les pages (`apps/web/src/pages/**`) restent exclues de la couverture unitaire. Elles
sont couvertes par Playwright. La logique critique qu'elles appellent (lib/training,
synchro, core) est mesurée, elle.

## Exceptions connues

- **Pages qui importent encore `@kinetic/adapters-web`** (listées dans `eslint.config.js`) :
  - `auth-callback.page.ts` et `profile.page.ts` : client d'authentification (échange du
    code OAuth, déconnexion, suppression du compte). C'est voulu.
  - `seances.page.ts` et `photos.page.ts` : `new UuidGenerator()`. À remplacer par
    `(await getDeps()).idGen`, comme `timers.page.ts`, puis retirer ces deux fichiers
    de la liste d'exceptions ESLint.
- **`HybridStorage`** (packages/adapter-web/src/supabase) : l'app ne s'en sert plus
  (remplacé par `SyncedStorage`). Il est gardé parce que les tests de migration
  (`sync-scenarios`, `sync-compat-migration`) s'en servent pour reproduire les données
  écrites par l'ancien client. Le constat F14 (restauration forcée qui réécrivait une
  séance supprimée hors-ligne) concernait ce code. Avec `SyncedStorage`, la restauration
  forcée est un pull complet en mode resync qui garde les écritures en attente. C'est
  vérifié par `training-session-flow.test.ts` › « F14 ».
- **Fonctions Edge `ai-coach` et `send-push`** : sans appelant dans l'app, mais
  durcies et documentées dans `security.md`. Les supprimer est une décision serveur
  (tables et RPC liées). Elle n'est pas prise ici.

## QA-14 : duplications (plan, non migré)

Mesure : 113 `dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, …))` dans 33
fichiers, dont 13 petites fonctions locales `notify()` presque identiques. La détection
de plateforme passe surtout par `Capacitor.isNativePlatform()` de `@capacitor/core`.
C'est l'API officielle, pas une vraie duplication. Seules trois lectures de
`window['Capacitor']` (auth, stores/auth, auth-callback) la contournent, pour ne pas
charger `@capacitor/core` au démarrage.

La migration n'a pas été faite dans ce lot, pour deux raisons :

1. Le budget du JS de démarrage est presque plein (129,1 / 130 KiB gzip). Un nouveau
   module partagé entre les stores (démarrage) et des écrans à la demande peut changer le
   découpage de Rollup et ajouter un lot au démarrage. Il faut le ranger explicitement
   (`STARTUP_SHARED_LIBS` dans `apps/web/vite.config.ts`) et vérifier le budget.
2. Les fichiers concernés sont en cours de modification par d'autres chantiers
   (séances, stockage, photos).

Plan :

1. Créer `apps/web/src/lib/notify.ts` :
   `notify(kind: 'success' | 'error' | 'warning' | 'info', message: string)` et
   `notifyError(message, err)`, qui journalise puis notifie. L'ajouter à
   `STARTUP_SHARED_LIBS`.
2. Remplacer les 13 fonctions locales `notify()`, fichier par fichier. Garder les textes
   à l'identique : les tests e2e lisent les toasts.
3. Remplacer les dispatch en ligne restants, en commençant par `seances.page.ts` (environ 30).
4. `lib/platform.ts` : `isNativeShell()` (lecture de `window.Capacitor` sans importer
   `@capacitor/core`) pour les trois lectures directes.
5. Réutiliser `plain()` (lib/training/storage.ts), à exporter, à la place des
   `JSON.parse(JSON.stringify(…))` qui retirent les proxys Alpine.

À chaque étape : `node scripts/check-bundle-size.mjs` (JS initial inchangé ou en baisse)
et `pnpm e2e` sur mobile-chrome.

## QA-11 : découpage du composant Séances (plan, non fait)

`apps/web/src/pages/seances.page.ts` compte environ 3 350 lignes, dont près de 3 000
pour la fabrique `seances()` (218 méthodes). Le découpage n'est pas fait dans ce lot :
c'est le composant le plus utilisé, et seules sa logique de stockage (lib/training) et
ses parcours e2e sont couverts.

Principe : chaque tranche devient une fabrique `xxxSlice(host)` dans
`apps/web/src/pages/seances/` (ou dans `lib/training/` quand elle n'a pas de DOM).
Elle est étalée dans l'objet Alpine (`...restTimerSlice()`), avec le même nom de
propriétés, pour que le gabarit `seances.html` ne change pas. Le build CSP impose des
expressions simples dans le HTML : on garde les mêmes méthodes publiques.

Ordre proposé, du moins risqué au plus risqué, avec un test par tranche :

| #   | Tranche (sections actuelles)                                                                           | Destination                                                                               | Test à écrire avant                                       |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Catégorisation musculaire (`getMuscleCategory`, complexité 33)                                         | table de correspondance dans `packages/core`                                              | unitaire, table exhaustive des catégories actuelles       |
| 2   | Affichage des séries chronométrées / supersets, records (PR)                                           | `lib/training/format.ts` (pur)                                                            | unitaire sur des séances types                            |
| 3   | Chronomètre intégré, minuteur de repos                                                                 | `seances/rest-timer.slice.ts` (s'appuie sur `lib/training/rest-timer.ts`)                 | unitaire avec horloge factice                             |
| 4   | Mode salle, menus contextuels, raccourcis +/-                                                          | `seances/gym-mode.slice.ts`, `seances/shortcuts.slice.ts`                                 | unitaire + e2e existant                                   |
| 5   | Correction d'une série et annulation (`undoSet`), édition d'une séance passée (`saveEditedSession`)    | `seances/history-edit.slice.ts`, finalisation pure dans `lib/training/session-edit.ts`    | intégration (étendre `training-session-flow.test.ts`)     |
| 6   | Séance en cours : saisie, exercice actif, substitution, forme basse, persistance, `saveCurrentSession` | `seances/current-session.slice.ts`, finalisation pure dans `lib/training/session-save.ts` | intégration (déjà en place) + e2e « terminer une séance » |
| 7   | Coach, progression, objectifs de force                                                                 | `seances/insights.slice.ts` (chargé à la demande si possible)                             | unitaire                                                  |

Ensuite, abaisser `complexity` de 35 à 25 dans `eslint.config.js`. Corriger d'abord les
trois fonctions du core qui sont au seuil (`recap.domain.ts`, `week-plan.domain.ts`,
`progress-report.domain.ts`). Les autres grandes fabriques (profil, nutrition,
progression, mensurations, `stores/vitalite.ts`) suivront le même modèle.
