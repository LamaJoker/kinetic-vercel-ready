# Sécurité serveur Kinetic

> Statut : **référence** du modèle de sécurité de la base Supabase, livré par
> `supabase/migrations/011_security_hardening.sql` (à appliquer **après** 010).
> Tests : `pnpm test:sql` (Postgres 16 jetable, schéma `auth` Supabase émulé ; migrations
> 001→011 appliquées puis 010 et 011 rejouées ; fichiers `tests/sql/91_security_catalog.sql`,
> `92_security_isolation.sql`, `93_security_definer.sql`, `94_security_quota.sql`,
> `95_security_concurrency.sh`).
> Côté fonctions Edge : en-têtes de `supabase/functions/*/index.ts`.

## 1. Modèle de menace

| Acteur                     | Ce qu'il possède                                                  | Ce qu'il ne doit PAS pouvoir faire                                                                                                      |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Internaute anonyme         | la clé `anon` (publique, embarquée dans l'app) et l'URL du projet | lire ou écrire une donnée, appeler une RPC autre que `keep_alive`, remplir la base, épuiser un quota partagé                            |
| Utilisateur connecté       | un JWT `authenticated` valide (le sien)                           | lire/modifier les données d'un autre compte, s'octroyer Pro, contourner les bornes et quotas (taille, nombre, coût IA), remplir la base |
| Compte jetable en nombre   | N JWT valides (inscription ouverte)                               | faire exploser le coût IA ou la taille de la base au-delà des plafonds globaux                                                          |
| Fonction Edge compromise ? | — (hors périmètre : la clé `service_role` contourne la RLS)       | —                                                                                                                                       |

Hypothèses : la clé `service_role` et les secrets Edge ne sortent jamais du serveur (aucune
clé secrète dans le frontend ; `ai-coach` n'a pas de client) ; le rôle `postgres` (qui
applique les migrations) a `BYPASSRLS`, comme sur Supabase ; PostgREST n'expose que le
schéma `public`.

## 2. Ce qui est garanti (et testé)

| #   | Garantie                                                                                                                                                                             | Mécanisme                                                                             | Test                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------ |
| S1  | RLS activée **et forcée** sur toutes les tables de `public`, y compris les tables internes et mortes.                                                                                | boucle sur `pg_class` (011 §3), avertissement final (§8)                              | 91 (générique)                 |
| S2  | `anon` n'a **aucun** droit sur aucune table, vue ou séquence ; il n'exécute que `keep_alive()`.                                                                                      | `REVOKE ALL` (011 §4a, §5j)                                                           | 91 (générique), 92             |
| S3  | `authenticated` n'a que la liste blanche ci-dessous ; jamais `TRUNCATE` (qui ignore la RLS), `REFERENCES` ni `TRIGGER`.                                                              | §4b                                                                                   | 91 (liste exacte)              |
| S4  | Un utilisateur ne lit ni ne modifie les lignes d'un autre, sur chaque table.                                                                                                         | policies `auth.uid() = user_id` + droits                                              | 10, 92                         |
| S5  | Le plan Pro n'est modifiable que par `service_role` ; le client lit SON plan seulement ; `is_pro` réservé au serveur.                                                                | `entitlements` : SELECT seul, aucune policy d'écriture (009), vérifié                 | 91, 92, 93                     |
| S6  | Aucune fonction `SECURITY DEFINER` n'a de `search_path` détournable ; personne d'autre que le propriétaire ne crée d'objet dans `public`.                                            | `search_path = ''` (fonctions réécrites) ou `public, pg_temp` (010) ; `REVOKE CREATE` | 91 (générique sur pg_proc), 93 |
| S7  | Aucune `SECURITY DEFINER` acceptant un utilisateur (`uuid`) n'est exécutable par un client ; les deux seules exposées (`sync_lock_self`, `upsert_daily_log`) utilisent `auth.uid()`. | liste blanche d'`EXECUTE`                                                             | 91, 93                         |
| S8  | Les bornes d'entrée sont imposées par le serveur sur tous les chemins d'écriture client.                                                                                             | `CHECK` (§7), `upsert_daily_log` seul chemin d'écriture de `daily_logs`               | 92, 93                         |
| S9  | Quotas IA (par utilisateur horaire et 24 h, global journalier) et rate limits **atomiques** sous concurrence ; un refus ne consomme rien.                                            | verrou consultatif par utilisateur + incrément conditionnel `ON CONFLICT … WHERE`     | 94, 95 (connexions réelles)    |
| S10 | Les objets créés plus tard dans `public` ne sont ouverts à personne implicitement.                                                                                                   | `ALTER DEFAULT PRIVILEGES` (§6)                                                       | 91                             |
| S11 | 011 est idempotente et compatible avec les clients publiés (accès direct à `user_storage`, `sync_*`, `upsert_daily_log`, `get_changes_since`, `user_storage_delta`).                 | `CREATE OR REPLACE`, gardes `IF NOT EXISTS`, liste blanche                            | `test-sql.sh` (rejeu), 10→80   |

### Droits des clients après 011

| Objet                                                                                                                           | `anon`       | `authenticated` (filtré par RLS au propriétaire)                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user_storage`                                                                                                                  | —            | SELECT, INSERT, UPDATE, DELETE (DELETE → tombstone, voir sync.md)                                                                                                        |
| `daily_logs` / vue `user_stats`                                                                                                 | —            | SELECT ; écriture **uniquement** via `upsert_daily_log`                                                                                                                  |
| `profiles`                                                                                                                      | —            | SELECT ; UPDATE de `full_name` et `avatar_url` seulement                                                                                                                 |
| `entitlements`                                                                                                                  | —            | SELECT de son plan                                                                                                                                                       |
| `user_storage_usage`, `sync_meta`, vue `user_storage_delta`                                                                     | —            | SELECT (lus par `sync_usage` / `sync_pull_v2`)                                                                                                                           |
| `push_subscriptions`                                                                                                            | —            | SELECT, INSERT, UPDATE, DELETE de ses abonnements (validés)                                                                                                              |
| `ai_coach_usage`, `ai_coach_limits`, `ai_coach_daily_global`, `rate_limits`                                                     | —            | — (service_role seulement)                                                                                                                                               |
| tables mortes : `workout_sessions`, `workout_sets`, `bodyweight_entries`, `weekly_goals`, `vitals_metrics`, `vitals_rate_limit` | —            | — (voir §4)                                                                                                                                                              |
| RPC                                                                                                                             | `keep_alive` | `sync_push`, `sync_pull_v2`, `sync_pull`, `sync_delete_all`, `sync_usage`, `sync_lock_self`, `upsert_daily_log`, `get_changes_since`, `keep_alive`, `user_storage_max_*` |

Ajouter une table, une vue ou une RPC exposée aux clients **exige** de mettre à jour la liste
blanche de `tests/sql/91_security_catalog.sql` : c'est volontaire (revue obligatoire).

## 3. Constats corrigés par 011

| Constat (audit)                                                                                                                         | Correction                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-03 `vitals_rate_limit` sans RLS, `anon` avec tous les droits (écriture illimitée sans compte)                                       | RLS activée et forcée, aucun droit client ; policy d'insertion anonyme de `vitals_metrics` retirée                                            |
| SEC-04 tables mortes et `daily_logs` en écriture directe : contournement du quota de 50 Mo et des bornes                                | droits clients retirés sur les tables mortes ; `daily_logs` en lecture seule (RPC seule) ; `CHECK` bornes + `metadata` ≤ 4 Ko objet           |
| SEC-06 `push_subscriptions` : endpoint libre (SSRF), nombre illimité                                                                    | `CHECK` https + service push connu (pas de port, pas de userinfo, ≤ 1 000 car.), clés bornées, 10 abonnements max (trigger sous verrou)       |
| SEC-07 report-error sans limite                                                                                                         | `consume_rate_limit` (par HMAC d'IP ou utilisateur + plafond global), appelé par la fonction Edge                                             |
| SEC-08 coach IA : pas de plafond global ni journalier                                                                                   | `consume_ai_quota` : horaire + 24 h par utilisateur, global par jour UTC, taille max, interrupteur ; `consume_ai_coach_quota` (009) enveloppé |
| SEC-09 `digest()` hors `search_path` dans un `SECURITY DEFINER`                                                                         | `sha256()` natif (pg_catalog) : plus aucune dépendance à l'emplacement de pgcrypto (`extensions` sur Supabase ou `public`)                    |
| SEC-12 `get_changes_since` `SECURITY DEFINER` exécutable par `anon` ; `set_updated_at` `SECURITY DEFINER` ; `handle_new_user` non borné | les deux en `SECURITY INVOKER` ; `anon` révoqué ; nom ≤ 100 car. sans caractères de contrôle, avatar https ≤ 2 048 car. sinon `''`            |
| Nouveau : `TRUNCATE` accordé à `anon`/`authenticated` sur toutes les tables (droits par défaut Supabase) — `TRUNCATE` ignore la RLS     | révoqué partout                                                                                                                               |
| Nouveau : `profiles` — le client pouvait réécrire `email` ; la policy de 002 refusait toute mise à jour d'un profil sans avatar (`''`)  | UPDATE limité aux colonnes `full_name`, `avatar_url` ; policy réécrite, validation par `CHECK`                                                |
| Nouveau : `anon` avait SELECT/INSERT/UPDATE/DELETE sur `user_storage`, `profiles`, `daily_logs`… (bloqué par la RLS seulement)          | tous les droits `anon` retirés : défense en profondeur si une policy est un jour trop large                                                   |
| Nouveau : toute future table/fonction de `public` ouverte par défaut à `anon`, `authenticated` et `PUBLIC`                              | `ALTER DEFAULT PRIVILEGES` (pour le rôle qui applique les migrations)                                                                         |

Contraintes de validation (`CHECK`, ajoutées `NOT VALID` puis validées si les données
existantes les respectent ; sinon un `NOTICE` est émis et la contrainte s'applique quand même
à toute nouvelle écriture) : `profiles_full_name_len`, `profiles_avatar_url_https`,
`profiles_email_len`, `daily_logs_bounds`, `daily_logs_metadata_size`,
`push_subscriptions_endpoint_known`, `push_subscriptions_keys_len`,
`ai_coach_usage_prompt_chars`. Vérifier après déploiement :
`select conname from pg_constraint where not convalidated;` (doit être vide).

## 4. Tables mortes

`workout_sessions`, `workout_sets`, `bodyweight_entries`, `weekly_goals` (004),
`vitals_metrics`, `vitals_rate_limit` (001/003) ne sont plus utilisées par aucun client. Les
supprimer serait destructif : 011 les **ferme** (RLS forcée, aucun droit `anon` /
`authenticated`, policies existantes inopérantes faute de droit) et conserve les données.
Suppression éventuelle, plus tard et manuellement, après export :
`drop table public.workout_sets, public.workout_sessions, public.bodyweight_entries, public.weekly_goals, public.vitals_metrics, public.vitals_rate_limit;`
(+ `drop function public.check_vitals_rate_limit(), public.check_user_storage_quota();`).

## Interface SQL pour les fonctions Edge

Toutes les fonctions ci-dessous sont `SECURITY DEFINER`, `search_path` fixé, et **exécutables
uniquement par `service_role`** (client Supabase créé avec `SUPABASE_SERVICE_ROLE_KEY` dans la
fonction Edge). `anon` et `authenticated` reçoivent `42501`. Elles s'appellent par
`admin.rpc('<nom>', { ...params })`. Un appel = une transaction : le contrôle et
l'enregistrement sont atomiques (aucune course « compter puis insérer »).

### `consume_ai_quota(p_user uuid, p_prompt_chars integer default 0, p_hourly_limit integer default null) → jsonb`

`p_hourly_limit` (facultatif) ne peut que **baisser** le plafond horaire configuré.
Quota du coach IA : plafond horaire et journalier **par utilisateur**, plafond journalier
**global** (tous comptes confondus, borne de coût), taille maximale de la requête. Les
plafonds sont lus dans la table à une ligne `public.ai_coach_limits` (modifiable seulement
par `service_role` / SQL Editor), valeurs par défaut :

| colonne               | défaut | rôle                                                      |
| --------------------- | ------ | --------------------------------------------------------- |
| `hourly_per_user`     | 10     | requêtes / heure glissante / utilisateur                  |
| `daily_per_user`      | 30     | requêtes / 24 h glissantes / utilisateur                  |
| `daily_global`        | 2000   | requêtes / jour UTC, tous utilisateurs                    |
| `daily_global_unpaid` | 1000   | dont comptes **non payants** (essai, gratuit, Pro expiré) |
| `max_prompt_chars`    | 40000  | `p_prompt_chars` au-delà → refus (`prompt_too_large`)     |
| `enabled`             | true   | interrupteur d'urgence : `false` → tout est refusé        |

Réponse (toujours un objet, jamais d'exception pour un refus de quota) :

```json
{ "allowed": true,  "reason": "ok",           "retry_after_seconds": 0,
  "remaining_hour": 9, "remaining_day": 29 }
{ "allowed": false, "reason": "user_hourly" | "user_daily" | "global_daily"
                               | "prompt_too_large" | "disabled",
  "retry_after_seconds": 1800 }
```

- Une requête acceptée est **consommée** (ligne dans `ai_coach_usage` + compteur global du
  jour) : l'appeler AVANT l'appel Anthropic, et ne jamais « rembourser ».
- Erreurs (à traiter en fail-closed, HTTP 503) : `22023` si `p_user` est null ou
  `p_prompt_chars` négatif, `23503` si l'utilisateur n'existe pas.
- `consume_ai_coach_quota(p_user, p_limit, p_prompt_chars) → boolean` (009) reste disponible
  pour compatibilité : c'est maintenant un enveloppe de `consume_ai_quota` (`p_limit` ne peut
  que **baisser** le plafond horaire ; plafonds journaliers et global appliqués).
- `is_pro(p_user uuid) → boolean` (009) : inchangée, `service_role` seulement. Le droit Pro
  n'est modifiable que par `service_role` (table `entitlements`, voir plus bas).

### `consume_rate_limit(p_scope text, p_subject text, p_limit integer, p_window_seconds integer) → jsonb`

Limiteur générique à fenêtre fixe (pour `report-error`, `delete-account`, `send-push`…).

- `p_scope` : `^[a-z0-9_-]{1,40}$` (ex. `report_error_ip`, `report_error_global`) ;
- `p_subject` : `^[A-Za-z0-9_-]{1,128}$` (ni point ni deux-points : une IPv4/IPv6 brute est refusée par construction). **Jamais une IP brute ni un e-mail** : passer
  un HMAC-SHA-256 hexadécimal de l'IP calculé dans la fonction Edge avec un secret
  (`RATE_LIMIT_SECRET`), ou l'UUID de l'utilisateur, ou la constante `global` pour un
  plafond global ;
- `p_limit` : 1 à 1 000 000 ; `p_window_seconds` : 1 à 86 400.

Réponse : `{ "allowed": bool, "count": int, "limit": int, "retry_after_seconds": int }`.
L'appel qui dépasse la limite n'incrémente plus le compteur (pas d'amplification). Paramètre
invalide → `22023`.

### `purge_security_counters() → jsonb`

Purge (à planifier, quotidienne) : `ai_coach_usage` de plus de 30 jours, compteurs globaux IA
de plus de 30 jours, fenêtres de `rate_limits` expirées. `service_role` seulement. Planifiée
automatiquement si `pg_cron` est installé (`kinetic-purge-security-counters`, 04:23 UTC).

### Contraintes de `push_subscriptions` (lues par `send-push`)

- `endpoint` : `https://` sur un service push connu uniquement (FCM
  `fcm.googleapis.com`, Mozilla `updates.push.services.mozilla.com` /
  `*.push.services.mozilla.com`, Apple `web.push.apple.com` / `*.push.apple.com`, Windows
  `*.notify.windows.com`), 1 000 caractères max ; `p256dh` ≤ 200, `auth` ≤ 100,
  `user_agent` ≤ 500 ;
- au plus **10** abonnements par utilisateur (trigger, code `P0001`, message « 10 abonnements maximum ») ;
- `send-push` doit tout de même revalider l'URL et lire au plus 10 lignes (`.limit(10)`).

## Fonctions Edge

> Section maintenue avec le code de `supabase/functions/`. Tests : `pnpm test`
> (`tests/unit/edge-*.test.ts`, handlers réels exécutés sous Node avec des faux pour Supabase
> et Anthropic). Points d'entrée Deno vérifiés par `deno check supabase/functions/*/index.ts`.

### Organisation du code

| Fichier                                    | Rôle                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `_shared/*.ts`                             | logique pure, **sans import distant** : CORS, lecture bornée du corps, validation, masquage, quotas…  |
| `<fonction>/handler.ts`                    | logique de la fonction, dépendances injectées (Auth, RPC, `fetch`, journal) ; typée par `tsc`, lintée |
| `_deno/adapters.ts`, `<fonction>/index.ts` | branchement Deno + supabase-js (esm.sh) ; hors tsc/ESLint du monorepo, vérifiés par `deno check`      |

`tsconfig.edge.json` (référencé par `tsconfig.json`) inclut `_shared/` et `*/handler.ts` dans
`pnpm typecheck` ; `eslint.config.js` ne les ignore plus (seuls `*/index.ts` et `_deno/` le sont).

### Variables d'environnement

| Variable                                               | Fonctions                              | Obligatoire                | Comportement si absente / invalide                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`                                      | ai-coach, delete-account, report-error | **oui en production**      | **503 `cors_not_configured` pour toute requête** (échec fermé). `*` et `null` sont ignorés.                                                                |
| `KINETIC_ENV`                                          | toutes                                 | non                        | absente = production. `development`/`local`/`test` : sans liste, seules `http://localhost[:port]` et `http://127.0.0.1[:port]` sont admises.               |
| `AI_COACH_REQUIRE_PRO`                                 | ai-coach                               | non                        | **vrai par défaut** ; seules `false`/`0`/`no`/`off` ouvrent le coach à tout compte connecté.                                                               |
| `ANTHROPIC_API_KEY`                                    | ai-coach                               | oui                        | 500 `server_misconfigured` (après authentification, jamais révélé à un anonyme).                                                                           |
| `ANTHROPIC_MODEL`                                      | ai-coach                               | non                        | liste blanche (`claude-sonnet-5` par défaut, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5`, `claude-sonnet-4-6`) ; valeur inconnue → défaut.  |
| `AI_COACH_MAX_TOKENS`                                  | ai-coach                               | non                        | borné à [256, 2048], défaut 1024.                                                                                                                          |
| `RATE_LIMIT_SECRET`                                    | toutes                                 | recommandé                 | clé HMAC des IP et des pseudonymes de journaux ; à défaut `SUPABASE_SERVICE_ROLE_KEY`.                                                                     |
| `SUPABASE_SERVICE_ROLE_KEY`                            | toutes                                 | oui (fournie par Supabase) | RPC de quotas / droits ; sans elle les contrôles échouent → 503.                                                                                           |
| `PUSH_SHARED_SECRET`                                   | send-push                              | non                        | ≥ 32 caractères, sinon ignoré ; alternative à la clé service_role pour appeler `send-push`.                                                                |
| `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` | send-push                              | oui                        | 500 `server_misconfigured`.                                                                                                                                |
| `ERROR_WEBHOOK_URL`                                    | report-error                           | non                        | relais seulement si l'URL est en `https://`.                                                                                                               |
| `TRUSTED_PROXY_HOPS`                                   | report-error                           | non                        | nombre de mandataires qui ajoutent une entrée à `X-Forwarded-For` (1 à 5, défaut 1) ; l'IP retenue est la N-ième en partant de la fin, jamais la première. |

Valeur type : `ALLOWED_ORIGINS=https://kinetic.vercel.app,capacitor://localhost,https://localhost`
(web + WebView Capacitor Android/iOS). Une requête **sans** en-tête `Origin` (serveur à serveur)
ne reçoit aucun en-tête CORS mais reste soumise à l'authentification.

### Contrôles communs

- **CORS strict** : origine exacte renvoyée (`Vary: Origin`), jamais `*` ni `null` ; origine non
  autorisée → 403 `origin_not_allowed` sans en-tête `Access-Control-Allow-Origin`.
- **POST seulement** (OPTIONS pour le préliminaire) ; autre méthode → 405.
- **Corps** : `Content-Type: application/json` exigé (415), `Content-Length` > limite → 413
  **avant toute lecture** ; lecture du flux bornée à min(limite, `Content-Length`) → un corps
  sans `Content-Length` ou au `Content-Length` mensonger est coupé (413) sans être chargé ;
  UTF-8 strict ; schéma strict (clés inconnues refusées, types et longueurs bornés) → 400.
- **Erreurs** : `{ error, message }`, message en français, aucun détail interne (pas de message
  Postgres, pas de corps d'erreur Anthropic). En-têtes `cache-control: no-store`,
  `x-content-type-options: nosniff`.
- **Journaux** : une ligne JSON par événement ; identifiants pseudonymisés (HMAC tronqué) ; tout
  texte passe par `redactSensitive` (e-mails, JWT, `Bearer`, clés `sk-ant-…`, paramètres d'URL,
  `token=`/`password:`, UUID, longues chaînes aléatoires, téléphones) et est borné.

### `ai-coach`

Limite 32 Ko, `Content-Length` **obligatoire** (411 sinon). Ordre : CORS → en-têtes du corps →
JWT vérifié par Supabase Auth (`auth.getUser(jwt)`, 401) → lecture bornée + schéma
`{ question (1–500), context? (objet ≤ 20 000 car., profondeur ≤ 8), history? (≤ 6 messages
user/assistant ≤ 1 000 car.) }` → droit Pro via `is_pro` (table `entitlements`, service_role ;
**le corps et les en-têtes du client ne sont jamais consultés** : un champ `isPro` est même
refusé en 400) → `consume_ai_quota` (429 + `Retry-After` ; réponse inattendue ou erreur → 503)
→ Anthropic avec `AbortController` (25 s), modèle/`max_tokens` bornés.
Erreurs Anthropic : 429/529 → 503 `ai_busy` ; 5xx, 4xx, réponse vide → 502 `ai_unavailable` ;
délai → 504 `ai_timeout` ; `stop_reason: refusal` → 422 `ai_refused`. Le quota consommé n'est
pas rendu (borne de coût). Aucun client web n'appelle aujourd'hui `ai-coach` : il n'y a **aucune
clé dans le frontend**.

### `delete-account`

Corps exactement `{ "confirm": "SUPPRIMER" }` (sinon 400 `confirmation_required`, y compris
champ supplémentaire), ≤ 1 Ko, JWT vérifié, 5 tentatives / heure / utilisateur
(`consume_rate_limit('delete_account', …)`, 429 ; erreur → 503). Idempotent : compte déjà
supprimé (Auth répond `user_not_found`) → 200 `{ deleted: true, alreadyDeleted: true }`.
Journal : `account_deleted` avec pseudonyme, sans e-mail ni UUID. Le client
(`apps/web/src/lib/account.ts`) envoie la confirmation ; un test fait appeler le vrai handler par
le vrai client. Limite connue : pas de réauthentification récente exigée (un jeton volé suffit
encore) — à ajouter avec un flux OTP `supabase.auth.reauthenticate()` côté UI.

### `send-push`

Fonction serveur → client uniquement : `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` ou
`x-push-secret: <PUSH_SHARED_SECRET>` (comparaison en temps constant) ; un JWT utilisateur → 401 ;
toute requête avec `Origin` → 403. Corps ≤ 4 Ko `{ user_id (UUID), title? ≤ 80, body? ≤ 200,
url? (chemin relatif `/…`), tag? }`. 20 envois / heure / destinataire. Au plus 10 abonnements
lus ; **chaque endpoint revalidé** (`_shared/push-endpoint.ts`, même liste que la contrainte SQL :
https, port par défaut, ni IP littérale ni identifiants, hôtes `fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `*.push.services.mozilla.com`, `web.push.apple.com`,
`*.push.apple.com`, `*.notify.windows.com`) ; un endpoint refusé n'est jamais contacté et sa
ligne est supprimée ; 404/410 → supprimée ; délai 10 s par envoi.

### `report-error`

≤ 64 Ko (Content-Length facultatif, lecture bornée), schéma `{ userAgent? ≤ 300, reports: [≤ 200]
{ occurredAt ≤ 40, message ≤ 1 000, source ∈ unhandled_rejection|uncaught_error|manual } }`,
50 rapports traités au plus. Limite : 20/h par utilisateur (JWT valide) ou 30/h par IP
pseudonymisée (HMAC de la **dernière** entrée de `x-forwarded-for`, celle qu'ajoute la passerelle ;
voir `TRUSTED_PROXY_HOPS`), puis 2 000/h au total ; erreur → 503. Messages masqués
avant journal et webhook ; webhook : `allowed_mentions: { parse: [] }`, `@` neutralisés, 1 900
caractères max, contenu client dans un bloc de code (accents graves remplacés : aucun lien
masqué ni mise en forme interprétés), délai 5 s. Le client n'envoie que les 50 rapports les plus récents, abandonne un
lot refusé (400/413) et garde le buffer sur 429. Conservation : journaux Supabase uniquement.

## Revue « attaquant » (compte gratuit + clé anon + son JWT)

Scénarios cherchés : lire/modifier les données d'un autre, s'octroyer Pro, consommer l'IA
sans quota ni Pro, requête sortante arbitraire, vider le quota global des autres, faire
planter une fonction, contourner CORS, lire des journaux avec données personnelles.

| Constat                                                                                                                                                                                                                                                                                                                | Démonstration                                                                                                    | Correction                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plafond IA global vidé par des comptes d'essai** : chaque inscription reçoit 7 jours d'essai Pro, sans CAPTCHA ; ~67 comptes × 30 requêtes épuisaient chaque jour les 2 000 requêtes globales, plus aucun abonné payant n'était servi.                                                                               | `tests/sql/96_attacker_ai_global.sql`                                                                            | `daily_global_unpaid` (défaut 1 000) : les comptes non payants (`tier <> 'pro'` ou `pro_until` dépassé, essais compris) n'ont qu'une part du plafond global, compteur `ai_coach_daily_global.unpaid_requests`, incrément atomique. |
| **Code privilégié exécuté sur les données d'une victime** : le trigger BEFORE `user_storage_10_before_write` (010, SECURITY DEFINER) s'exécute avant le contrôle RLS ; un `INSERT` portant le `user_id` d'une victime verrouillait sa ligne de compteur avant d'être refusé (synchro de la victime bloquée en rafale). | `tests/sql/97_attacker_foreign_write.sh` (sans correction : `55P03`, l'attaquant attend le verrou de la victime) | trigger `user_storage_01_owner_check` (SECURITY INVOKER, déclenché en premier) : `42501` immédiat, aucun verrou.                                                                                                                   |
| **`X-Forwarded-For` falsifié** (report-error) : la première entrée, choisie par le client, servait d'IP ; limite par IP contournée, plafond global de 2 000/h vidé pour tous, quota d'une victime épuisé en usurpant son adresse.                                                                                      | `tests/unit/edge-attacker.test.ts`                                                                               | dernière entrée (ajoutée par la passerelle), `TRUSTED_PROXY_HOPS` ; `cf-connecting-ip` ignoré.                                                                                                                                     |
| **Hameçonnage via le webhook** : un anonyme envoyait `[Session expirée](https://evil…)`, affiché comme lien cliquable dans le canal Discord/Slack de l'équipe.                                                                                                                                                         | `tests/unit/edge-attacker.test.ts`                                                                               | contenu dans un bloc de code, accents graves remplacés.                                                                                                                                                                            |

Vérifié sans faille : aucune RPC exposée n'accepte un `user_id` de l'appelant ; `entitlements`
en lecture seule ; `send-push` réservé au serveur ; endpoints push en liste blanche (SQL + Edge) ;
schémas stricts (champ `isPro` refusé) ; corps bornés avant lecture ; masquage sans
retour arrière exponentiel (50 messages de 1 000 caractères pathologiques < 15 ms).

Risques résiduels (non corrigeables par le code seul) :

- un essai Pro par compte, et un compte supprimé puis recréé avec le même e-mail reçoit un
  nouvel essai ; sans CAPTCHA ni vérification forte, des comptes jetables restent possibles.
  Le coût est borné par `daily_global_unpaid`. À faire : CAPTCHA à l'inscription, essai lié
  à l'e-mail normalisé (ou au paiement) ;
- `report-error` : 100 comptes × 20/h ou 67 IP réelles × 30/h suffisent encore à saturer le
  plafond global (2 000/h) ; seul effet, la perte de rapports d'erreurs ;
- un attaquant qui connaîtrait l'endpoint push d'une victime (secret, non devinable) pourrait
  l'enregistrer le premier (clé primaire) et empêcher son abonnement.

## 5. Mise en production (étapes manuelles)

1. **Sauvegarde** (Dashboard → Database → Backups) avant toute migration.
2. Appliquer **dans l'ordre** `010_sync_reliability.sql` puis `011_security_hardening.sql`
   (`supabase db push`, ou SQL Editor en rôle `postgres`, une migration par exécution). 011
   refuse de s'appliquer si 010 est absente ou si le rôle n'a pas `BYPASSRLS`.
3. Contrôles après application (SQL Editor) :
   - aucun `WARNING` « n'a pas la RLS activée » dans la sortie ;
   - `select conname from pg_constraint where not convalidated;` → vide (sinon nettoyer les
     lignes non conformes puis `alter table … validate constraint …`) ;
   - `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;` → vide.
4. **Purges** : si `pg_cron` est activé (Dashboard → Database → Extensions), 010 et 011 ont
   planifié `kinetic-purge-sync-tombstones` (hebdomadaire) et `kinetic-purge-security-counters`
   (quotidienne, 04:23 UTC) ; vérifier `select jobname, schedule from cron.job;`. Sinon,
   activer `pg_cron` **avant** 011 ou planifier `select public.purge_security_counters();`
   (quotidien) et `select public.purge_sync_tombstones();` (hebdomadaire) via un job externe en
   `service_role`.
5. **Plafonds IA** : ajuster si besoin (rôle `postgres` / SQL Editor) :
   `update public.ai_coach_limits set daily_global = 500, daily_per_user = 20;` ;
   interrupteur d'urgence : `update public.ai_coach_limits set enabled = false;`.
6. **Variables des fonctions Edge** (`supabase secrets set …`) : voir la section
   « Fonctions Edge » ci-dessus (`ALLOWED_ORIGINS` et `RATE_LIMIT_SECRET` au minimum ;
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` sont injectées par
   Supabase). `RATE_LIMIT_SECRET` aléatoire (≥ 32 octets) : jamais d'IP brute vers
   `consume_rate_limit` (refusée par construction).
7. **Auth** (hors SQL, recommandé pour une app commerciale) : activer le CAPTCHA à
   l'inscription (hCaptcha / Turnstile natif Supabase Auth) — sans lui, N comptes jetables ×
   50 Mo restent possibles ; les plafonds globaux IA bornent le coût, pas le stockage —, et
   une alerte sur la taille de la base.

## 6. Limites connues

- `service_role` et `postgres` ont `BYPASSRLS` : `FORCE ROW LEVEL SECURITY` ne les concerne
  pas. Toute fonction Edge qui utilise `service_role` doit filtrer elle-même par utilisateur.
- Les droits par défaut de `supabase_admin` (objets créés par l'outillage Supabase) ne
  peuvent pas être modifiés par une migration ; seuls ceux du rôle qui applique les
  migrations le sont.
- Les fonctions de 010 gardent `search_path = public, pg_temp` (sûr : personne d'autre que
  le propriétaire ne peut créer dans `public`, `pg_temp` en dernier, noms qualifiés) ; les
  fonctions réécrites par 011 utilisent `search_path = ''`.
- Les quotas IA sont en fenêtre glissante par utilisateur et par jour UTC pour le global ;
  `consume_rate_limit` est en fenêtre fixe (un pic de 2 × limite reste possible à cheval sur
  deux fenêtres).
- La concurrence est testée sur un Postgres 16 local avec le shim Supabase, pas sur une
  instance Supabase réelle.
