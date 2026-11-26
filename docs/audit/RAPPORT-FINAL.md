# Rapport final — audit technique et corrections de Kinetic

Novembre 2026. Périmètre : synchronisation et intégrité des données, sécurité Supabase et
fonctions Edge, stockage local / PWA / Capacitor, qualité du code, tests, performance.
Détail constat par constat, avec preuve : [`STATUS.md`](./STATUS.md). Références techniques :
[`sync.md`](../architecture/sync.md), [`security.md`](../architecture/security.md),
[`code-quality.md`](../architecture/code-quality.md).

Versions publiées pendant le chantier : **v9.15.0** (synchronisation) et **v9.16.0**
(stockage local, qualité, performance). La sécurité serveur (migration 011, fonctions Edge)
ne dépend pas de la version de l'app : elle s'active quand elle est déployée sur Supabase.

---

## A. Problèmes détectés

63 constats, tous contre-vérifiés par un second passage (reproductions sur Postgres réel et
simulateur de synchro). Les plus graves :

| Gravité | Constat                                                                                                                                             | Effet pour l'utilisateur                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P0      | Démarrage hors-ligne ou lent (> 8 s) : l'app tournait sans couche de synchro                                                                        | Séances enregistrées jamais envoyées au cloud                                      |
| P0      | Changement de compte sur le même appareil                                                                                                           | Données et file d'envoi du compte A poussées dans le compte B                      |
| P0      | Nouvel appareil / liaison invité → compte                                                                                                           | Valeurs par défaut écrasant les données du cloud                                   |
| P0      | Index `INCLUDE(value)` (migration 002)                                                                                                              | Toute valeur > ~2,7 Ko refusée par le serveur (historiques longs non synchronisés) |
| P1      | Suppressions physiques, aucune tombstone                                                                                                            | Séance supprimée qui réapparaît depuis un autre appareil                           |
| P1      | Rejet serveur permanent réessayé à l'infini                                                                                                         | Échec silencieux, aucune information                                               |
| P1      | « Dernier synchronisé gagne » sur les listes agrégées                                                                                               | Pesées / modèles perdus en cas d'édition sur deux appareils                        |
| P1      | « Réinitialiser » : effaçait aussi le cloud, et annonçait un succès même en échec                                                                   | Perte ou résurrection des données                                                  |
| P1      | Lecture en échec confondue avec « absent »                                                                                                          | Modèles de l'utilisateur remplacés par les modèles par défaut                      |
| P1      | Import de sauvegarde sans confirmation                                                                                                              | Écrasement de toutes les données                                                   |
| P2      | `vitals_rate_limit` ouverte à anon, droits TRUNCATE hérités, ai-coach sans plafond global ni contrôle Pro par défaut, send-push exploitable en SSRF | Fuite, abus, coût                                                                  |
| P2      | Outbox non atomique, trigger de quota en O(données), Capacitor Android vulnérable (GHSA-rvm3-566m-v7fv)                                             | Perte après fermeture forcée, lenteur, faille native                               |

Les revues adversariales menées après les corrections ont trouvé **13 problèmes supplémentaires**,
tous corrigés avec un test (écritures sur liste périmée, base locale ancienne écrasant le cloud,
séance écrite en mode de secours perdue, mélange de comptes en mode de secours, effacement
pendant une synchro en vol, plafond IA global vidé par des comptes d'essai, trigger privilégié
exécuté sur les données d'autrui, X-Forwarded-For falsifiable, lien piégé dans le webhook,
plafond push refusant un rafraîchissement, etc.).

## B. Corrections apportées (principales)

| Fichier(s)                                                                                              | Nature                                                                                                                                                                                                                                                                                                                               | Justification                                   | Résultat attendu                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/migrations/010_sync_reliability.sql`                                                          | Tombstones (`deleted`, `deleted_at`), version fixée par le serveur sous verrou utilisateur, `sync_push` par lots avec statut par élément (ok / conflict / rejected / deferred), `sync_pull_v2` paginé avec `resync_required`, quota incrémental O(1), purge des tombstones avec horizon, suppression de l'index fautif               | F1, F6, F11–F13, SEC-01/02/05/10, PERF-01/03/04 | Une suppression se propage ; aucune valeur légitime refusée ; aucune écriture perdue entre deux curseurs ; anciens clients toujours compatibles |
| `packages/adapter-web/src/sync/*` (SyncedStorage, engine, local-db, legacy-migration, fallback-storage) | Une base IndexedDB par compte, outbox écrite dans la **même transaction** que la donnée, envoi par lots, rejets visibles et réessayables, pull périodique / au premier plan / au retour du réseau, numéro de génération contre les réponses en vol, migration de l'ancienne base sans perte                                          | F2, F3, F7, F8, F10, QA-02/03, PERF-02/07/08/09 | Une séance n'est jamais perdue ni mélangée entre comptes, même hors-ligne, même après fermeture forcée                                          |
| `packages/core/src/sync/*`                                                                              | Fusion par domaine (LWW, union par identifiant avec suppressions, compteurs max, copie « (conflit) » pour les séances)                                                                                                                                                                                                               | F9, F4                                          | Aucune perte en cas d'édition simultanée                                                                                                        |
| `apps/web/src/deps.factory.ts`, `stores/auth.ts`                                                        | Session lue localement (`getSession`), plus d'attente réseau au démarrage                                                                                                                                                                                                                                                            | F10, PERF-08                                    | Démarrage immédiat, synchro dès qu'une session existe                                                                                           |
| Profil (`profile.page.ts/html`), `stores/sync.ts`                                                       | « Effacer les données de cet appareil » et « Supprimer toutes mes données cloud » séparés ; état de synchro visible (en attente, rejets, éléments mis de côté)                                                                                                                                                                       | F5, F4q, QA-04                                  | Plus de faux succès ; l'utilisateur voit ce qui n'est pas synchronisé                                                                           |
| `supabase/migrations/011_security_hardening.sql`                                                        | RLS activée et forcée partout, droits en liste blanche (anon : `keep_alive` seulement), TRUNCATE retiré, SECURITY DEFINER avec `search_path = ''`, droits par défaut fermés, contraintes de validation, quotas IA atomiques (part réservée aux payants), limiteur générique, contrôle de propriétaire avant les triggers privilégiés | SEC-03/04/06/08/09/12 + revue attaquant         | Aucune lecture/écriture croisée ; aucun abus de coût                                                                                            |
| `supabase/functions/_shared/*`, `*/handler.ts`                                                          | Logique Edge extraite, typée, lintée, testée ; CORS obligatoire en production ; corps borné avant lecture ; schémas stricts ; JWT et Pro vérifiés côté serveur (`REQUIRE_PRO` vrai par défaut) ; délais et erreurs Anthropic ; masquage des données personnelles                                                                     | SEC-06/07/08/11                                 | Fonctions sûres par défaut (échec fermé)                                                                                                        |
| `lib/backup.ts`, `lib/write-journal.ts`, `lib/photos.ts`, `lib/active-session.ts`                       | Restauration avec aperçu, confirmation et annulation ; retour arrière de migration ciblé ; photos par compte ; alerte si la séance en cours ne peut plus être enregistrée                                                                                                                                                            | F2q, F5q, F6q, F7q, F9q, F10q                   | Rien n'est écrasé sans accord et tout est annulable                                                                                             |
| `apps/web/package.json`                                                                                 | Capacitor 8.6.2 + `pnpm audit:native`                                                                                                                                                                                                                                                                                                | QA-07                                           | Faille native corrigée et surveillée                                                                                                            |
| `vite.config.ts`, `lib/derived-cache.ts`, `lib/pr-index.ts`, `lib/training/storage.ts`                  | Code rare chargé à la demande, calculs mémorisés, cache des séances                                                                                                                                                                                                                                                                  | PERF-05/06/11                                   | JS initial 129,1 → 121,6 KiB gzip ; pages fluides avec un long historique                                                                       |
| `tsconfig`, `vitest.config.ts`, `eslint.config.js`, `.github/workflows/ci.yml`                          | typecheck hors de `dist`, seuils de couverture, frontières d'architecture vérifiées, tests SQL en CI                                                                                                                                                                                                                                 | QA-05/06/12                                     | Régressions détectées automatiquement                                                                                                           |

## C. Sécurité

Garanti et testé (SQL réel + tests des fonctions Edge) :

- un utilisateur ne peut ni lire ni modifier les données d'un autre, sur **chaque** table ;
- le rôle anon n'a plus aucun droit (hors `keep_alive`) ;
- un client ne peut pas s'octroyer Pro (lecture seule, vérification serveur) ;
- aucune fonction SECURITY DEFINER exposée n'accepte un `user_id` fourni par l'appelant ;
- quotas IA par utilisateur / heure / jour, plafond global avec part réservée aux payants,
  exacts sous concurrence réelle ;
- corps trop gros refusé **avant** lecture (Content-Length absent, excessif ou mensonger) ;
- origine non autorisée refusée sans en-tête CORS permissif ; `*` et `null` jamais acceptés ;
- send-push réservé au serveur, endpoints en liste blanche (SQL et code) ;
- aucune clé secrète dans le frontend ; ai-coach n'a pas de client.

## D. Tests

| Suite                                                              | Résultat                                                                      | Commande                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Unitaires + intégration                                            | **2 692 tests, 226 fichiers, tous verts**                                     | `pnpm test`                                                      |
| Couverture                                                         | seuils respectés (global 83 % lignes ; core 97 % ; sync 87 % ; training 94 %) | `pnpm test:coverage`                                             |
| SQL sur Postgres 16 réel (migrations 001→011, 010 et 011 rejouées) | **457 assertions**                                                            | `pnpm test:sql`                                                  |
| E2E Playwright (Chromium mobile + bureau)                          | **112 / 112**                                                                 | `pnpm e2e`                                                       |
| Simulateur iPhone (parcours de 14 écrans)                          | vert à chaque version publiée                                                 | CI « Test iPhone »                                               |
| Types, lint, format, budget, audit natif                           | OK                                                                            | `pnpm typecheck`, `lint`, `format:check`, `size`, `audit:native` |

Scénarios exigés :

- **10 scénarios de synchro** : `tests/integration/sync-scenarios.test.ts` (32 tests), plus
  `sync-stale-writes`, `sync-compat-migration`, `sync-local-reset-race`,
  `sync-fallback-accounts`, `sync-periodic-pull`, `sync-client`, `sync-migration`.
- **8 scénarios de sécurité** : `tests/sql/92_security_isolation.sql` (données d'autrui,
  contournement RLS), `93_security_definer.sql`, `94/95/96` (quotas, concurrence, comptes
  d'essai), `97_attacker_foreign_write.sh` ; `tests/unit/edge-*.test.ts` (IA sans auth → 401,
  droits Pro forgés ignorés, quota → 429, requête malformée → 400, corps trop gros → 413,
  origine refusée → 403).
- **5 scénarios mobiles** : `tests/integration/mobile-*.test.ts` (fermeture forcée pendant une
  séance, redémarrage après séance non synchronisée, reprise après perte de réseau, migration
  d'anciennes données, restauration après reconnexion, réinstallation, sauvegarde aller-retour)
  et `training-session-flow.test.ts`.

**Non exécuté** (et pourquoi) :

- E2E Firefox et WebKit : navigateurs non installés dans l'environnement de travail (Chromium seul).
- Tests contre une **vraie instance Supabase** : aucune instance de test disponible. Le SQL est
  testé sur Postgres 16 avec une émulation fidèle d'`auth.uid()` et des rôles Supabase ;
  la passerelle Edge réelle (verify_jwt, en-têtes) n'est pas testée.
- Compilation iOS locale : pas de Xcode ici ; la compilation iOS est faite par la CI macOS.
- Les fichiers de tests ne sont pas vérifiés par TypeScript (475 erreurs mesurées, cf. F).

## E. Migrations (ordre et étapes manuelles)

1. **Sauvegarde** de la base (Dashboard → Database → Backups).
2. Activer l'extension **pg_cron** (facultatif mais recommandé) **avant** les migrations.
3. Appliquer **dans l'ordre**, une par exécution : `010_sync_reliability.sql`, puis
   `011_security_hardening.sql` (`supabase db push`, ou SQL Editor en rôle `postgres`).
   Les deux sont idempotentes et **non destructives** : aucune table ni colonne supprimée
   (seuls deux index et d'anciens triggers sont remplacés ; les dates de version placées dans
   le futur par d'anciens clients sont ramenées à l'heure actuelle).
4. Contrôles listés dans `security.md` § 5 (aucune table sans RLS, aucune contrainte non validée).
5. Sans pg_cron : planifier `select public.purge_sync_tombstones();` (hebdomadaire) et
   `select public.purge_security_counters();` (quotidien) en `service_role`.
6. **Puis seulement** redéployer les fonctions Edge, avec les secrets `ALLOWED_ORIGINS`
   (domaine web, `capacitor://localhost`, `https://localhost`) et `RATE_LIMIT_SECRET`
   (`openssl rand -hex 32`) — sinon elles répondent 503 (échec fermé).
7. Recommandé : CAPTCHA à l'inscription dans Supabase Auth.

Les anciennes versions de l'app continuent de fonctionner après 010/011 (testé :
`80_legacy_clients.sql`, `87_production_compat.sql`).

## F. Risques restants

1. **Migrations jamais appliquées sur une vraie instance Supabase** : à faire d'abord sur un
   projet de test, avec sauvegarde.
2. **Restauration « tout remplacer »** (F5q partiel) : aperçu, confirmation et annulation
   existent, mais pas de fusion clé par clé.
3. **Tests non typés** (QA-06 partiel) : un faux objet de test incorrect peut masquer un bug.
4. **Suppression de compte sans réauthentification récente** (SEC-11 partiel).
5. **Pas de CAPTCHA** : comptes jetables jusqu'à 50 Mo chacun (borné par quota, pas par compte).
6. **Stockage plein** : l'utilisateur est prévenu mais l'espace récupérable n'est pas affiché.
7. **Dette de structure** : composant Séances de ~2 400 lignes (plan de découpage documenté),
   notifications dupliquées.
8. **Marges de budget** : total JS 343,5 / 350 KiB, gabarits 95,6 / 100 KiB.
9. Un pull fait par un **autre onglet** n'est pas vu par une page déjà ouverte (cas web multi-onglets).

## G. Évaluation honnête

- **Usage personnel** : prêt. Les pertes de données identifiées sont corrigées et prouvées par
  des tests qui échouaient avant correction.
- **Commercialisation (milliers d'utilisateurs)** : **pas encore**. Le code est au niveau requis
  sur la synchro et la sécurité, mais il manque, dans l'ordre :
  1. appliquer et valider 010/011 sur une instance Supabase de test, puis de production ;
  2. une campagne de tests sur vrais appareils (iPhone réel, Android réel, réseau dégradé) ;
  3. CAPTCHA à l'inscription, supervision (taille de base, erreurs, coût IA) ;
  4. typer les tests et découper le composant Séances ;
  5. les obligations hors code d'une app payante (comptes développeur Apple/Google, paiement,
     politique de confidentialité validée, support).
