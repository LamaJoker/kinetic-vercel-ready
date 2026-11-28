# Synchronisation Kinetic : contrat de référence

> Statut : **référence normative** du protocole de synchronisation (serveur livré par la
> migration `supabase/migrations/010_sync_reliability.sql`, client à implémenter selon la
> partie 4). Remplace la partie « conflits » de l'ADR 0004. Les termes **DOIT**, **NE DOIT
> PAS** et **PEUT** sont normatifs.
>
> Tests serveur : `pnpm test:sql` (Postgres 16 jetable, schéma `auth` Supabase émulé, migrations
> 001→010 appliquées puis rejouées, 190+ assertions dans `tests/sql/`).

## 0. Garanties visées

| #   | Garantie                                                                                                                                                  | Mécanisme principal                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| G1  | **Une séance ne disparaît jamais silencieusement** (ni écrasée, ni perdue dans une outbox, ni effacée par un pull).                                       | Outbox atomique, écriture conditionnelle, copie « (conflit) », sauvegarde de récupération, erreurs permanentes visibles |
| G2  | **Une suppression est cohérente entre appareils** : elle se propage, ne ressuscite pas toute seule, et un appareil resté hors-ligne longtemps le détecte. | Tombstones serveur, `sync_pull_v2`, horizon de purge + `resync_required`                                                |
| G3  | **Une synchro interrompue reprend sans corruption** (kill de l'app, réseau coupé au milieu d'un lot, réponse perdue).                                     | Transactions IndexedDB (donnée + outbox ; page de pull + curseur), `sync_push` idempotent, version serveur              |
| G4  | **Isolation stricte** entre comptes, sur le serveur (RLS) **et** sur l'appareil (une base locale par compte).                                             | RLS + RPC `SECURITY INVOKER`, base IndexedDB par compte avec marqueur propriétaire                                      |
| G5  | **Aucun faux succès** : quota, valeur trop grosse, suppression cloud impossible hors-ligne… sont visibles par l'utilisateur, avec une action.             | Statuts `rejected` par élément, état de synchro exposé, `clear()` scindé                                                |

## 1. Vue d'ensemble

```
 Appareil (base IndexedDB du compte)                         Supabase (Postgres)
 ┌───────────────────────────────────────┐                   ┌──────────────────────────────────┐
 │ kv        : clé → valeur              │  sync_push(lot)   │ user_storage (user_id, key,      │
 │ outbox    : clé → {op, base, rev…}    │ ────────────────► │   value, deleted, deleted_at,    │
 │ versions  : clé → {updated_at, del.}  │  ok/conflict/     │   updated_at = version SERVEUR)  │
 │ meta      : owner, cursor, flags…     │ ◄──────────────── │ user_storage_usage (quota O(1))  │
 │ recovery  : copies mises de côté      │  sync_pull_v2     │ sync_meta (horizon de purge)     │
 └───────────────────────────────────────┘ ◄──────────────── └──────────────────────────────────┘
   écriture app = 1 transaction (kv + outbox)                   écriture = verrou par utilisateur
   page de pull = 1 transaction (kv + versions + cursor)        + version monotone (trigger)
```

Le modèle reste **clé → valeur JSON** (ADR 0003/0004) : pas de nouvelle table par domaine. La
fiabilité vient de trois ajouts : une **version serveur** par clé, des **tombstones**, et une
**écriture conditionnelle** (`base`) avec résolution de conflit **par domaine**.

## 2. Modèle de données serveur

### 2.1 `public.user_storage`

| Colonne      | Type          | Règle                                                                                                                      |
| ------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `user_id`    | `uuid`        | PK (avec `key`), FK `auth.users` `on delete cascade`, RLS `auth.uid() = user_id`. Immuable.                                |
| `key`        | `text`        | `^[a-zA-Z0-9:_-]{1,200}$` (contrainte `key_format`). Immuable (renommage refusé, `22023`).                                 |
| `value`      | `jsonb`       | `not null`, ≤ 1 048 576 octets **mesurés en `octet_length(value::text)`** (forme texte jsonb, avec espaces après `:`/`,`). |
| `deleted`    | `boolean`     | **Nouveau.** `false` = clé vivante, `true` = tombstone.                                                                    |
| `deleted_at` | `timestamptz` | **Nouveau.** Renseigné ssi `deleted` (= version de la suppression).                                                        |
| `created_at` | `timestamptz` | Fixé par le serveur à la création, préservé ensuite. Toute valeur client est ignorée.                                      |
| `updated_at` | `timestamptz` | **La version de la ligne.** Fixée par le serveur à chaque insert/update ; toute valeur client est ignorée (SEC-10/F13).    |

Contrainte `user_storage_tombstone_shape` : `(deleted ∧ value = 'null' ∧ deleted_at non nul) ∨ (¬deleted ∧ deleted_at nul)`.

**Trois états d'une clé, strictement distincts :**

| État                   | Ligne serveur                       | Dans `sync_pull_v2`             | Côté client                         |
| ---------------------- | ----------------------------------- | ------------------------------- | ----------------------------------- |
| Absente                | aucune                              | jamais renvoyée                 | clé absente                         |
| Vivante, valeur `null` | `deleted = false`, `value = 'null'` | `{deleted: false, value: null}` | clé présente, valeur `null`         |
| Supprimée              | `deleted = true`, `value = 'null'`  | `{deleted: true, value: null}`  | clé absente (suppression appliquée) |

Le client **NE DOIT PAS** déduire une suppression de `value === null` : seul `deleted` fait foi.

### 2.2 Version serveur, monotone, sous verrou par utilisateur

Trigger `user_storage_10_before_write` (BEFORE INSERT OR UPDATE) :

1. prend le **verrou de la ligne `user_storage_usage` de l'utilisateur** (`select … for update`,
   créée au besoin) ;
2. `updated_at := max(clock_timestamp(), last_version + 1 µs, ancienne version + 1 µs)` ;
   `last_version := updated_at` ;
3. `created_at` fixé à la création, préservé ensuite ;
4. tombstone normalisée (`value := 'null'`, `deleted_at := updated_at`) ;
5. ancien client qui réécrit une tombstone par upsert direct (sans colonne `deleted`) avec une
   nouvelle valeur → **recréation** (`deleted := false`).

Conséquences, prouvées par `tests/sql/40_server_version.sql` et `90_concurrency.sh` :

- **Versions strictement croissantes par utilisateur**, même dans une transaction, même si
  l'horloge du serveur recule. Deux lignes peuvent toutefois partager un `updated_at` dans des
  données historiques (avant 010) : le pull trie donc par `(updated_at, key)`.
- **Curseur sûr (F11)** : comme la version est attribuée _après_ la prise du verrou de
  l'utilisateur, et que ce verrou est tenu jusqu'au commit, toute ligne visible a une version
  inférieure à celle de toute écriture encore en cours pour ce compte. Un curseur ne peut plus
  « sauter » une transaction lente : le recouvrement de 5 s côté client devient inutile (il
  reste inoffensif).
- Les écritures d'un même compte sont **sérialisées**. C'est voulu (quelques écritures par
  minute par utilisateur) ; les comptes différents ne se bloquent jamais.

### 2.3 Suppressions : tombstones

- Une suppression est une **écriture** : `deleted = true`, nouvelle version, propagée par
  `sync_pull_v2`.
- Trigger `user_storage_05_delete_as_tombstone` (BEFORE DELETE) : un `DELETE` exécuté par le rôle
  `authenticated` (ancien client : `SupabaseStorage.remove/clear`) est **transformé en tombstone**
  (la ligne reste, `deleted = true`). Les suppressions physiques restent réservées au propriétaire
  de la table (purge), au `service_role` et aux cascades (suppression de compte :
  `auth.admin.deleteUser` → `on delete cascade`, testé).
- Purge : `purge_sync_tombstones(older_than interval default '180 days')` (§ 3.5).

### 2.4 Quota incrémental : `public.user_storage_usage`

| Colonne        | Sens                                                           |
| -------------- | -------------------------------------------------------------- |
| `keys`         | nombre de lignes **vivantes** (les tombstones ne comptent pas) |
| `bytes`        | somme de `octet_length(value::text)` des lignes vivantes       |
| `last_version` | plus grande version émise pour le compte (monotonie, § 2.2)    |

- Trigger `user_storage_90_after_write` (AFTER INSERT/UPDATE/DELETE) : `+nouvelle taille −ancienne`,
  `±1 clé` selon les transitions vivante ↔ tombstone ↔ absente. **O(taille de la ligne)**, plus
  jamais O(stockage de l'utilisateur) (SEC-05/F12/PERF-03 : 50 upserts sur un compte de 5 000 clés
  / 10 Mo passent en moins d’une seconde au total, assertion du test `60_quota.sql`). AFTER car un upsert déclenche
  BEFORE INSERT **puis** BEFORE UPDATE : seul AFTER reflète ce qui a été écrit (pas de double
  comptage, testé).
- Contrôle : seules les **hausses** sont refusées au-delà de la limite — `P0001` (clés) / `P0002`
  (octets). Un compte au-dessus du quota peut toujours supprimer ou réduire ses données.
- Limites : `user_storage_max_keys()` = 20 000, `user_storage_max_bytes()` = 50 Mo,
  `user_storage_max_value_bytes()` = 1 Mo.
- Initialisé depuis l'existant par la migration (table verrouillée en écriture le temps du
  calcul) ; réparable par `recompute_user_storage_usage(p_user uuid default null)` (`service_role`).
- Lecture : RLS `usage_select_own` ; aucune écriture client.

### 2.5 `public.sync_meta`

Une ligne (`id = 1`) : `tombstone_horizon` (les tombstones de version antérieure ont pu être
purgées ; ne recule jamais), `last_purge_at`, `last_purge_count`. Lisible par `authenticated`.

### 2.6 Index

| Index                                                                  | Sort                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `user_storage_pkey (user_id, key)`                                     | conservé (lectures par clé, upsert)                                                                                            |
| `idx_user_storage_user_updated_key (user_id, updated_at, key)`         | conservé (pull keyset)                                                                                                         |
| `idx_user_storage_tombstones (updated_at) where deleted`               | **ajouté** (purge)                                                                                                             |
| `idx_user_storage_user_key (user_id, key) include (value, updated_at)` | **supprimé** : une entrée d'index est limitée à 2 704 octets, toute valeur > ~2,7 Ko compressés était rejetée (SEC-01/PERF-01) |
| `idx_user_storage_updated (user_id, updated_at desc)`                  | **supprimé** : redondant (PERF-04)                                                                                             |

## 3. API serveur (RPC PostgREST)

Toutes les RPC client sont `SECURITY INVOKER` (la RLS s'applique), exécutables par
`authenticated` seulement, et lèvent `42501` sans utilisateur authentifié.

### 3.1 `sync_push(p_items jsonb) → jsonb`

Entrée : tableau d'éléments.

```jsonc
[
  {
    "key": "kinetic:training:session:abc",
    "value": { "...": "..." },
    "base": "2026-11-25T10:00:00.123456+00:00",
  },
  { "key": "kinetic:goals:strength", "value": [], "base": null }, // création attendue
  { "key": "kinetic:training:session:old", "deleted": true, "base": "…" }, // suppression
]
```

- `key` : obligatoire. `value` : obligatoire sauf si `deleted: true` (JSON `null` est une valeur
  valide). `deleted` : booléen, défaut `false`. `base` : la **version serveur connue du client**
  pour cette clé (`updated_at` reçu au dernier pull ou push réussi, chaîne renvoyée **telle
  quelle**, microsecondes comprises), ou `null` si le client croit la clé absente.
- Le serveur prend le verrou de l'utilisateur **avant** tout verrou de ligne (deux lots
  concurrents du même compte ne s'interbloquent pas, testé), puis traite chaque élément dans une
  **sous-transaction** : un élément en erreur n'annule jamais le lot.

Règle de décision, ligne serveur verrouillée (`for update`) :

| Ligne serveur                     | `base`                   | Résultat                                                                                                         |
| --------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| absente (jamais créée, ou purgée) | quelconque               | **ok** : création (y compris d'une tombstone si `deleted`)                                                       |
| présente                          | `null` ou `< updated_at` | si l'état envoyé est **identique** à l'état serveur → **ok** idempotent (version inchangée) ; sinon **conflict** |
| présente                          | `≥ updated_at`           | **ok** : écriture, nouvelle version                                                                              |

Sortie : tableau **aligné sur l'entrée** (même ordre, même longueur), un objet par élément :

```jsonc
{ "key": "…", "status": "ok", "updated_at": "…", "deleted": false }
{ "key": "…", "status": "conflict", "updated_at": "<version serveur>", "server_deleted": false,
  "server_value": { … } }                    // ou "server_value_omitted": true (réponse > 4 Mo)
{ "key": "…", "status": "rejected", "reason": "quota_bytes", "updated_at": null }
{ "key": "…", "status": "deferred", "reason": "batch_limit", "updated_at": null }
```

En conflit sur une tombstone, `server_deleted: true` et pas de `server_value`. Si
`server_value_omitted`, le client relit la clé par un pull (ou `select value` sur la table).

Codes `reason` :

| Statut     | `reason`           | Cause                                                                                         | Action client                                         |
| ---------- | ------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `rejected` | `invalid_item`     | élément non objet, `key` absente, `deleted`/`base` de mauvais type                            | bloquer l'entrée (bug) + rapport d'erreur             |
| `rejected` | `invalid_key`      | clé hors `^[a-zA-Z0-9:_-]{1,200}$`                                                            | bloquer                                               |
| `rejected` | `invalid_base`     | `base` non convertible en `timestamptz`                                                       | bloquer (bug) ; un nouveau pull de la clé répare      |
| `rejected` | `missing_value`    | ni `value` ni `deleted: true`                                                                 | bloquer (bug)                                         |
| `rejected` | `duplicate_key`    | même clé deux fois dans le lot (seule la première est traitée)                                | renvoyer dans un lot suivant (bug client)             |
| `rejected` | `value_too_large`  | valeur > 1 Mo (forme texte jsonb)                                                             | bloquer + message « trop volumineux »                 |
| `rejected` | `quota_keys`       | 20 000 clés vivantes atteintes                                                                | bloquer + message quota ; réessayer après suppression |
| `rejected` | `quota_bytes`      | 50 Mo atteints                                                                                | idem                                                  |
| `rejected` | `forbidden`        | refus RLS (session d'un autre compte ?)                                                       | bloquer, vérifier la session                          |
| `rejected` | `internal:<code>`  | erreur SQL imprévue                                                                           | bloquer + rapport d'erreur ; « Réessayer » manuel     |
| `deferred` | `batch_limit`      | au-delà de 100 éléments ou de 4 Mo cumulés dans le lot                                        | renvoyer **sans** backoff dans le lot suivant         |
| `deferred` | `transient:<code>` | interblocage, sérialisation, verrou, ressources (`40P01`, `40001`, `55P03`, `53xxx`, `23505`) | réessayer avec backoff                                |

Erreurs **d'appel** (tout le lot) : `42501` (non authentifié → rafraîchir la session puis
réessayer), `22023` (`p_items` n'est pas un tableau : bug), `PGRST202` (RPC absente : serveur non
migré → mode legacy, § 5), erreurs réseau / 5xx / timeout → backoff. Un appel qui échoue n'a rien
écrit **ou** a tout écrit : le rejouer est sûr grâce à l'idempotence (même état → `ok`).

Limites : ≤ 100 éléments, ≤ 4 Mo de valeurs par lot ; le client **DOIT** viser ≤ 100 éléments et
≤ 3 Mo de JSON (`JSON.stringify`) par lot, et refuser localement (sans l'envoyer) une valeur dont
`JSON.stringify(value).length × 1,1 > 1 048 576`.

### 3.2 `sync_pull_v2(p_since timestamptz default null, p_after_key text default '', p_limit int default 500) → jsonb`

Renvoie les lignes (vivantes **et tombstones**) strictement après `(p_since, p_after_key)`, triées
par `(updated_at, key)`, au plus `p_limit` (borné à 1..1000) **et** au plus ~4 Mo de valeurs
(toujours au moins une ligne).

```jsonc
{
  "changes": [{ "key": "…", "value": …, "deleted": false, "updated_at": "…" }, …],
  "has_more": true,                 // continuer avec since/after_key = dernier élément
  "resync_required": false,
  "reason": "tombstones_purged",    // ou "cursor_in_future" ; présent si resync_required
  "horizon": "…" | null,            // sync_meta.tombstone_horizon
  "server_time": "…"
}
```

- `p_since` `null` ou ≤ `1970-01-01` = **pull complet** (jamais `resync_required`).
- `resync_required: true` (et `changes` vide) si `p_since < horizon` (des tombstones ont pu être
  purgées depuis le curseur) ou si `p_since > server_time + 1 min` (curseur empoisonné par une
  ancienne version future).
- Pagination keyset **vérifiée** avec égalités de timestamps (`tests/sql/30_pull.sql`) : le client
  **DOIT** persister le couple `(cursor, afterKey)` = `(updated_at, key)` du **dernier changement
  appliqué**, en transmettant la chaîne `updated_at` reçue sans la reformater.

### 3.3 `sync_delete_all() → jsonb`

« Supprimer toutes mes données cloud » : tombstone sur chaque clé vivante du compte, en une
requête. Renvoie `{ deleted_count, updated_at }`. Les autres appareils reçoivent les tombstones.

### 3.4 `sync_usage() → jsonb`

`{ keys, bytes, max_keys, max_bytes, max_value_bytes }` pour l'affichage (« 12,3 Mo sur 50 Mo »).

### 3.5 Purge : `purge_sync_tombstones(older_than interval default '180 days') → bigint`

`service_role` uniquement (refusé à `authenticated`). Dans une transaction : `tombstone_horizon :=
max(horizon, now() − older_than)` **puis** suppression physique des tombstones de version
antérieure. `older_than < 1 jour` est refusé. Si l'extension `pg_cron` est installée, la migration
planifie `select public.purge_sync_tombstones()` chaque dimanche à 03:17 (job
`kinetic-purge-sync-tombstones`) ; sinon, l'appeler depuis un job externe (GitHub Actions avec la
clé `service_role` en secret — **jamais** dans le front).

### 3.6 Compatibilité des anciens clients (versions installées avant ce contrat)

| Chemin ancien client                          | Comportement après 010                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| upsert direct (`SupabaseStorage.set`)         | fonctionne ; version serveur ; recrée une clé supprimée ; quota O(1)                  |
| `DELETE` (`remove`, `clear`)                  | transformé en tombstone → la suppression atteint les nouveaux clients                 |
| `sync_pull(since, after_key, limit)`          | inchangée, **sans** tombstones                                                        |
| `select value` (`get`) sur une tombstone      | renvoie `null` → interprété « absent » (comportement correct)                         |
| `select key` (`keys`, `keysSince`)            | voit les tombstones ; utilisé seulement si `sync_pull` est absente (jamais après 009) |
| `get_changes_since`, vue `user_storage_delta` | sans tombstones                                                                       |

Limite connue : un upsert direct et un `sync_push` **sur la même clé au même instant** peuvent
s'interbloquer (ordres de verrou opposés) ; Postgres en annule un (`40P01`) : l'ancien client
réessaie (backoff existant), `sync_push` renvoie `deferred transient:40P01`. Aucune perte.

## 4. Contrat client (à implémenter dans `packages/core` + `packages/adapter-web` + `apps/web`)

### 4.1 Une base IndexedDB par compte

- Noms : `kinetic-u-<userId>` pour un compte, `kinetic-guest` pour le mode invité. Object stores :
  `kv` (données), `outbox`, `versions`, `meta`, `recovery`. Les photos en Blob
  (`kinetic-photos/blobs`) suivent la même règle : `kinetic-photos-u-<userId>` /
  `kinetic-photos-guest`.
- `meta.owner` = `userId` ou `'guest'`, écrit à la création. À l'ouverture, si `owner` ne
  correspond pas au compte attendu, la base **NE DOIT PAS** être utilisée (erreur explicite).
- **Changement de compte (F2)** : se déconnecter de A puis se connecter avec B ouvre
  `kinetic-u-B` (vide → pull complet). Les données et l'outbox de A restent dans `kinetic-u-A` et
  ne sont **jamais** poussées dans B. Avant la déconnexion, si `pending > 0` : flush immédiat
  (`ignoreBackoff`), puis, s'il reste des entrées, dialogue « N modifications ne sont pas encore
  enregistrées dans le cloud » → « Rester connecté » / « Se déconnecter quand même (elles seront
  envoyées à la prochaine connexion de ce compte) ».
- **Liaison invité → compte (F3)** : à la connexion, si `kinetic-guest` contient des données
  utilisateur, l'app **DOIT** d'abord faire le pull complet du compte, puis proposer
  explicitement : « Ajouter les données de cet appareil à votre compte » (fusion par domaine,
  § 4.8, chaque clé fusionnée passe par l'outbox avec la `base` serveur) / « Ne pas les ajouter »
  (la base invité est conservée intacte, récupérable plus tard depuis le profil). Jamais
  d'écrasement silencieux ni du cloud ni des données invité.
- **Migration de la base existante** (une seule fois, au premier lancement de la nouvelle
  version) — base actuelle `keyval-store` / store `keyval` (idb-keyval par défaut) :
  1. si `meta.migratedFrom` est absent de la base cible et que `keyval-store` existe ;
  2. propriétaire = `session.user.id` lu **localement** (`getSession()`), sinon `guest` ;
  3. en **une transaction** sur la base cible : copier toutes les clés de `keyval` dans `kv`
     (sauf `kinetic:sync:outbox`, `kinetic:sync:cursor`, `kinetic:sync:last-at`,
     `_kinetic:initial-sync-done`) ; convertir `kinetic:sync:outbox` (tableau
     `[key, {op: 'set'|'remove', attempts, nextTryAt, rev}]`) en entrées `outbox`
     (`op: 'remove'` → `delete`, `base: null`, `origin: 'legacy'`) ; écrire `meta.owner`,
     `meta.migratedFrom = 'keyval-store'`, `meta.needsReconcile = true` ;
  4. l'ancienne base **n'est pas supprimée** (filet de sécurité, et retour arrière possible vers
     une ancienne version de l'app) ; elle est marquée (`kinetic:migrated-to` = nom de la base
     cible) et pourra être supprimée deux versions plus tard ;
  5. échec à n'importe quelle étape : la transaction est annulée, l'app continue sur l'ancienne
     base en mode lecture/écriture locale et réessaie au lancement suivant (journalisé).
  - **Réconciliation** (`needsReconcile`) : premier pull **complet** ; pour chaque clé serveur
    vivante non en attente : valeur locale absente → appliquer ; égale → noter la version ;
    différente → fusion par domaine (§ 4.8) et, si le résultat diffère du serveur, entrée
    d'outbox avec `base` = version serveur ; pour chaque tombstone serveur dont la clé existe
    localement sans entrée en attente → appliquer la suppression **après** copie de la valeur
    locale dans `recovery` (provenance inconnue des données d'avant migration) ; chaque clé
    locale absente du serveur et non en attente → entrée d'outbox `base: null` (rattrape F10/F7 :
    écritures faites hors HybridStorage ou hors outbox).
  - **Curseur de l'ancien client** (`kinetic:sync:cursor`, recopié dans `meta.legacyCursor`,
    ignoré s'il est dans le futur) — revue compatibilité :
    - clé vivante différente, **modifiée au serveur après ce curseur** et absente de l'ancienne
      outbox : la copie locale est l'état périmé d'avant (téléphone resté fermé pendant qu'un
      autre appareil modifiait) → le **serveur gagne**, la valeur locale va dans `recovery`
      (message « … mises de côté »). Avant : la valeur périmée écrasait le cloud (`lww`) ou
      créait une copie « (conflit) » parasite de la séance ;
    - entrée de l'ancienne outbox sur une clé **inchangée au serveur depuis ce curseur** : l'état
      serveur est l'ancêtre ; l'entrée est rebasée dessus (`base` = version serveur) et
      s'applique sans faux conflit (modification) ni annulation (suppression).
  - Après la copie, l'ancienne outbox (désormais dans la base cible) est **retirée** de
    `keyval-store` : un retour arrière vers l'ancienne version la rejouait et écrasait dans le
    cloud les modifications faites depuis. Les données de `keyval-store` restent intactes.
- **Repli** (base du compte impossible à ouvrir : erreur IndexedDB passagère, migration en
  échec) : l'app tourne sur `keyval-store` via `LegacyFallbackStorage` (chargé à la demande),
  qui journalise chaque écriture dans la même transaction (`kinetic:sync:fallback-journal`,
  par base cible) ; le propriétaire est mémorisé dans localStorage
  (`kinetic:sync:fallback-owners`). À la prochaine ouverture réussie, `importFallbackWrites`
  reprend ces écritures : séance → écriture ordinaire (outbox `base: null`, une valeur en
  attente remplacée va dans `recovery`) ; clé propre à l'appareil → recopiée ; autre clé →
  `recovery` (calculée sur une base peut-être périmée, elle n'écrase rien). Avant : une séance
  enregistrée pendant le repli restait dans `keyval-store`, plus jamais relue.
- Tests de migration (vitest, `idb-keyval` mocké + implémentation mémoire du port) : base
  existante avec données + outbox legacy + curseur → aucune clé perdue, outbox convertie,
  réconciliation correcte, ré-exécution sans effet.

### 4.2 Écriture locale et outbox atomiques (F7, F4, QA-03, F11 local)

- Toute écriture de l'app sur une clé synchronisée = **une transaction IndexedDB** sur
  `['kv', 'outbox']` : valeur (ou suppression) **et** entrée d'outbox. Si la transaction échoue,
  l'appelant reçoit l'erreur (jamais de succès sans outbox).
- `outbox` : **une entrée par clé** (clé IDB = clé de donnée) :
  `{ op: 'set' | 'delete' | 'delete_all', base: string | null, rev: number, attempts: number,
nextTryAt: number, state: 'pending' | 'blocked', reason?: string, seed?: boolean,
queuedAt: number }`.
  - `base` est fixée à la **création** de l'entrée (= `versions[key].updated_at` ou `null`) et
    **n'est pas modifiée** par les écritures locales suivantes tant que l'entrée existe.
  - `rev` est incrémenté à chaque écriture locale (dans la même transaction) : un résultat `ok`
    ne retire l'entrée que si `rev` n'a pas changé depuis la lecture du lot ; sinon la `base`
    devient la version `ok` et l'entrée reste en attente.
- Plus de snapshot global `kinetic:sync:outbox` : multi-onglet sûr. Flush et pull se font sous
  `navigator.locks.request('kinetic-sync:<db>')` (Web Locks) ; les autres onglets sont prévenus
  par `BroadcastChannel('kinetic-sync')` pour relire les clés modifiées.
- Lecture interne de synchro : une erreur IndexedDB **DOIT** être levée (pas `null`) ; seule
  l'absence réelle renvoie `null` (QA F3 local, F7b).
- `set(key, null)` est une valeur `null` vivante (distincte de `remove`).
- Les clés purement locales (`kinetic:training:active-session`, `kinetic:schema-version`, et tout
  ce qui est dans `meta`) ne passent jamais par l'outbox.

### 4.3 Flush (push)

1. Sous le verrou Web Locks, lire les entrées `pending` dont `nextTryAt ≤ now` (ou toutes avec
   `ignoreBackoff`), `delete_all` en premier ; former des lots (≤ 100 entrées, ≤ 3 Mo de JSON),
   valeurs lues dans `kv` au moment du lot.
2. `sync_push(lot)`. Pour chaque résultat, dans une transaction `['kv','outbox','versions']` :
   - `ok` → `versions[key] = {updated_at, deleted}` ; retirer l'entrée si `rev` inchangé, sinon
     `base = updated_at` ;
   - `conflict` → résolution par domaine (§ 4.8) : écrire le résultat local, `versions[key] =`
     version serveur, et soit retirer l'entrée (le serveur gagne), soit la garder avec `base =`
     version serveur (le résultat fusionné sera poussé au lot suivant) ;
   - `rejected` → `state = 'blocked'`, `reason` ; plus de réessai automatique ; **la donnée locale
     est conservée** ; état de synchro mis à jour (§ 4.9) ;
   - `deferred` → reste `pending` ; `batch_limit` : relancé immédiatement ; `transient:*` : backoff.
3. Échec d'appel : réseau / 5xx / timeout → backoff exponentiel (1 s → 5 min) ; `401`/`42501` →
   `refreshSession()` puis un nouvel essai, sinon état « reconnexion nécessaire » ;
   `PGRST202` → mode legacy (§ 5).
   Sur un échec **réseau**, l'état envoyé est noté dans l'entrée (`sent`) : la requête a pu être
   appliquée sans que la réponse arrive. Au conflit suivant sur cette clé, un état serveur
   identique à `sent` signifie « notre envoi est passé » : avance rapide (la valeur locale est
   poussée sur la version serveur), sans fausse copie de conflit ni mise de côté. `sent` est
   effacé dès que la version serveur est connue (`ok`, conflit résolu).
4. Déclencheurs : après chaque écriture (anti-rebond 1 s, lots — PERF-07), retour réseau
   (`online`), retour au premier plan, démarrage (après le premier rendu), avant déconnexion.

### 4.4 Pull

- Déclencheurs : démarrage (après le premier rendu local), `visibilitychange` → visible,
  `online`, **toutes les 60 s tant que l'app est visible** (PERF-09), tirer pour rafraîchir.
- Boucle `sync_pull_v2(cursor, afterKey, 500)` tant que `has_more`. **Chaque page est appliquée
  dans une seule transaction** `['kv','outbox','versions','meta']`, curseur compris : si une
  écriture locale échoue, toute la page est annulée et le curseur n'avance pas (F8).
- Pour chaque changement : clé locale-seule → ignorée ; **entrée d'outbox présente** (lue dans la
  même transaction, donc sans course avec une écriture utilisateur — F4) → valeur locale
  intacte (le conflit sera traité au push) ; `deleted` → suppression locale ; sinon → valeur
  appliquée ; dans tous les cas `versions[key]` mis à jour sauf si en attente.
- `resync_required` (`tombstones_purged` ou `cursor_in_future`) → **pull complet** depuis `null`
  en mode resync : appliquer comme ci-dessus en collectant les clés serveur ; ensuite, chaque clé
  locale **absente du serveur, non en attente et non locale-seule** est **déplacée dans
  `recovery`** (pas supprimée silencieusement) puis retirée de `kv` ; message « N éléments de cet
  appareil absents du cloud ont été mis de côté » avec « Restaurer » (réécriture normale via
  l'outbox, `base: null`) et « Supprimer définitivement ».
- `recovery` : `{ key, value, reason: 'resync' | 'reconcile' | 'conflict', at }`, jamais
  synchronisé, purgé seulement par action utilisateur.

### 4.5 Toujours HybridStorage dès qu'un compte existe localement (F10, QA-02, PERF-02, PERF-08)

- Au démarrage, l'utilisateur est identifié par `supabase.auth.getSession()` (lecture locale du
  stockage `kinetic-auth`), **jamais** par `getUser()` (réseau, jusqu'à 8 s) sur le chemin
  critique. Session présente (même expirée) → base du compte + HybridStorage + outbox, même
  hors-ligne. Le jeton est rafraîchi au premier appel réseau.
- `getUser()` peut être appelé en arrière-plan pour valider le compte ; s'il renvoie « compte
  supprimé », l'app passe en état déconnecté sans effacer la base locale.

### 4.6 Pas de valeur par défaut persistée avant la première synchro (F3)

- Tant que `meta.initialPullDone` est faux, les lectures d'une clé synchronisée absente renvoient
  le défaut **en mémoire** sans l'écrire (modèles par défaut, objectifs, profil…). La garde
  d'onboarding attend le premier pull (ou un délai, hors-ligne) avant de conclure « pas de
  profil ».
- Si une valeur par défaut doit être écrite (ex. hors-ligne prolongé), l'entrée d'outbox porte
  `seed: true` : en conflit, **le serveur gagne** sans copie.

### 4.7 Effacer, supprimer (F5, QA-04, F4 qualité)

`clear()` disparaît de l'UI au profit de deux actions distinctes :

- **« Effacer les données de cet appareil »** : local uniquement. S'il reste des entrées en
  attente, avertir et proposer d'attendre la synchro. Supprime la base du compte (et les photos
  locales). Le cloud n'est pas touché ; la prochaine connexion refait un pull complet.
- **« Supprimer toutes mes données cloud »** : entrée `delete_all` dans l'outbox (persistée,
  envoyée avant tout le reste), puis `sync_delete_all()`. L'UI affiche « Suppression en attente »
  tant que le serveur n'a pas répondu, puis « Données cloud supprimées » ; en cas d'erreur, le
  message d'erreur et « Réessayer ». **Jamais** de succès affiché avant la réponse du serveur.
  Les entrées en attente plus anciennes que `delete_all` sont retirées (l'utilisateur a demandé
  la suppression) ; les données locales sont effacées après succès.
- « Supprimer mon compte » : inchangé (Edge Function `delete-account`, cascade physique).

### 4.8 Résolution de conflit par domaine (table de stratégies dans `packages/core`)

> Implémentation et registre détaillé : § 4.8 bis (`resolveSyncConflict(domainMergeRegistry, …)`).

Fonction pure `resolveConflict(key, local, server: {value, deleted}, entry) → { value | delete,
push: boolean, recoveryCopy?: … }`, choisie par motif de clé. **Aucune stratégie ne perd de
donnée locale sans copie** (sauf `seed`).

| Motif de clé                                                                                                                                                                                                                                                                                             | Stratégie             | Règle                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinetic:training:session:*`                                                                                                                                                                                                                                                                             | `keep-both`           | Valeurs différentes : la version serveur est appliquée **et** la version locale est enregistrée comme nouvelle séance `kinetic:training:session:<id>-c<horodatage>` nommée « <nom> (conflit) » (outbox `base: null`). Serveur supprimé + local modifié : la version locale est **recréée** (`base` = version de la tombstone).               |
| Collections tableau : `BODYWEIGHT_ENTRIES` (id = `date`), `MEASUREMENTS_ENTRIES`, `MEASUREMENTS_PHOTOS`, `TRAINING_TEMPLATES`, `TRAINING_CUSTOM_EXERCISES`, `STRENGTH_GOALS`, `NUTRITION_CUSTOM_FOODS`, `NUTRITION_RECIPES`, `NUTRITION_FAVORITES`, `TIMER_PRESETS`, `VITALITE_CUSTOM_TASKS` (id = `id`) | `union-by-id`         | Union par identifiant ; pour un même id, l'élément au `updatedAt` le plus récent (champ ajouté par les helpers d'écriture du domaine ; absent = le plus ancien ; égalité → local) ; puis retrait des ids présents dans les **tombstones d'éléments** (ci-dessous) plus récentes que l'élément. Ordre : celui du domaine (date, `createdAt`). |
| Ensembles : `ACHIEVEMENTS_UNLOCKED`, `REWARDS_UNLOCKED`, `VITALITE_HIDDEN_TASKS`, `AWARDED_IDS`, `COMPLETED_KEYS`                                                                                                                                                                                        | `set-union`           | Union (avec tombstones d'éléments pour les ensembles où l'app retire des éléments : `VITALITE_HIDDEN_TASKS`).                                                                                                                                                                                                                                |
| Objets par date : `WELLNESS_CHECKINS`, `WELLNESS_WATER`, `VITALITE_INTERVAL_LAST_DONE`, `PLATEAU_DISMISSED`, `CHALLENGES` (`accepted`/`completed` par id)                                                                                                                                                | `map-merge`           | Fusion par clé d'objet ; même clé : valeur de l'élément le plus récent (`updatedAt`, sinon local), `max` pour les dates de dernière réalisation.                                                                                                                                                                                             |
| Clés datées `kinetic:nutrition:log:*`, `kinetic:vitalite:done:*`, `kinetic:program:completedDays:*`, `kinetic:xp:earned:*`                                                                                                                                                                               | `union-by-id` / `max` | Journaux : union par id d'entrée ; XP du jour : `max`.                                                                                                                                                                                                                                                                                       |
| `XP`                                                                                                                                                                                                                                                                                                     | `max`                 | `max(local, serveur)` (l'XP ne diminue jamais ; une remise à zéro passe par la suppression).                                                                                                                                                                                                                                                 |
| `STREAK`                                                                                                                                                                                                                                                                                                 | `streak`              | `best = max` ; `count`/`lastActiveDate` de la valeur au `lastActiveDate` le plus récent (égalité → `max(count)`).                                                                                                                                                                                                                            |
| Réglages, préférences, profil (`USER_PROFILE`, `PROFILE`, `*_PREFS`, `PREF_UNIT`, `THEME_MODE`, `PROGRAM*`, `BODYWEIGHT_GOAL`, `NUTRITION_PLAN`, `GOALS_WEEKLY`, `REWARDS_*`…) et **toute clé non listée**                                                                                               | `lww`                 | « Dernière écriture **arrivée au serveur** gagne » : la modification locale en attente est repoussée avec `base =` version serveur (elle devient la plus récente sur l'horloge serveur). Entrée `seed` → le serveur gagne. La valeur serveur écrasée est copiée dans `recovery` (`reason: 'conflict'`).                                      |

Suppression locale en attente contre modification serveur : pour `keep-both` (séances), la
version serveur, plus récente, est **conservée** (la suppression est annulée et l'utilisateur
en est informé) ; pour les autres stratégies, la suppression est repoussée avec `base =`
version serveur et la valeur serveur est copiée dans `recovery`.

**Tombstones d'éléments** (suppression d'un élément dans une collection) : clé synchronisée
sœur `kinetic:deleted:<clé de la collection>` = `{ [id]: deletedAtIso }`, stratégie `map-merge`
(max). L'app **DOIT** écrire la collection et sa clé sœur dans **la même transaction locale**
(méthode atomique `setMany` ajoutée au `StoragePort`, implémentée par toutes les implémentations).
Une tombstone d'élément de plus de 180 jours peut être retirée par le client. Sans ce mécanisme,
un élément supprimé reviendrait par l'union (exigence F9).

À moyen terme, les collections qui grossissent (pesées, mensurations) **DEVRAIENT** passer à une
clé par élément comme les séances (le conflit devient alors `keep-both`/`lww` par élément).

### 4.8 bis Fusion par domaine (implémentation, `packages/core/src/sync/`)

> Implémente § 4.8. Modules purs : `merge-strategies.ts` (moteur), `domain-merge.ts` (registre,
> stratégies `MergeStrategy`, liaison invité, suppressions d'éléments). Tests :
> `tests/unit/sync-domain-merge.test.ts` (scénarios) et `tests/unit/sync-merge-properties.test.ts`
> (propriétés générées : idempotence, commutativité, aucune perte, suppressions respectées).
> Le tableau de § 4.8 reste la vue d'ensemble ; **en cas d'écart, cette section fait foi**.

#### Interface pour le client de synchro

```ts
import { resolveSyncConflict, domainMergeRegistry } from '@kinetic/core';

const r = resolveSyncConflict(domainMergeRegistry, {
  key, // clé en conflit
  local, //  { deleted: false, value } | { deleted: true }  (état kv actuel)
  server, // idem, depuis server_value / server_deleted (si server_value_omitted : relire d'abord)
  serverVersion, // updated_at serveur
  pending: { op, seed, origin }, // origin : 'app' | 'legacy' | 'reconcile' | 'guest'
  now, // ISO, fourni par l'appelant
  ancestor, // FACULTATIF mais fortement recommandé (voir ci-dessous)
  itemTombstones, // FACULTATIF : suppressions d'éléments (voir ci-dessous)
});
// r.result      → nouvel état local de la clé (écrire dans kv)
// r.push        → true : garder l'entrée d'outbox, base = version serveur, ancestor = server
//                 false : le serveur gagne (r.result = server), retirer l'entrée
// r.recovery    → copies à mettre dans `recovery` (reason 'conflict'), jamais synchronisées
// r.extraWrites → nouvelles clés (copie de séance) : écrire dans kv + outbox base: null
// r.notice      → message français à afficher (facultatif)
```

Le registre `defaultMergeRegistry` (tout `lww`) n'est qu'un repli : le client **DOIT** utiliser
`domainMergeRegistry`. Autres exports : `mergeRuleForKey`, `strategyNameForKey`,
`isDeviceLocalKey`, `planGuestMerge`, helpers de suppressions d'éléments, `mergeValues`
(moteur brut).

**Ancêtre (fusion à trois voies).** Une fusion à deux voies ne sait pas distinguer « ajouté ici »
de « supprimé là-bas », ni additionner deux incréments d'XP. Le client **DEVRAIT** donc conserver,
dans l'entrée d'outbox, l'état de la clé à la version `base` (`ancestor`, ou un champ `baseValue`) :

| Événement                                        | `ancestor` de l'entrée                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| création de l'entrée (aucune entrée pour la clé) | état de `kv` **avant** l'écriture (`{deleted:true}` si absente)                                           |
| écritures locales suivantes                      | inchangé (comme `base`)                                                                                   |
| `ok` avec `rev` changé                           | la valeur qui vient d'être poussée                                                                        |
| `conflict` résolu avec `push: true`              | l'état serveur reçu (`server`)                                                                            |
| entrée convertie depuis l'ancienne outbox        | **inconnu** (champ absent), sauf clé inchangée au serveur depuis le curseur legacy : état serveur (§ 4.1) |

Coût : une copie par entrée **en attente** seulement. Sans ancêtre, chaque stratégie retombe sur
sa règle à deux voies (colonne « sans ancêtre » ci-dessous), plus prudente mais moins précise.

**Suppressions d'éléments (`kinetic:deleted:<clé>`).** Clé sœur synchronisée
`{ [idÉlément]: dateIsoDeSuppression }`, stratégie `map` + `max` (une suppression n'est jamais
oubliée). Elle n'est **consultée que si l'ancêtre est inconnu** (avec l'ancêtre, la fusion à trois
voies voit déjà la suppression). Côté app, pour supprimer des éléments d'une collection :

```ts
const tomb = await storage.get(itemTombstoneKey(KEY));
const { items, writes } = deleteCollectionItems(KEY, list, [itemIdFor(KEY, entry)], tomb, nowIso);
await storage.setMany(writes); // collection + clé sœur dans UNE transaction
```

et, à chaque création ou modification d'élément, `stampUpdatedAt(item, nowIso)` (champ `updatedAt`,
rétro-compatible : absent = « le plus ancien »). Un élément recréé après sa suppression survit si
son `updatedAt` est postérieur à la suppression. Identifiants : `itemIdFor(clé, élément)` (`id`,
`date` pour les pesées, `nom|recette` pour les favoris, la valeur pour un ensemble, la clé pour
un objet indexé, `accepted:<id>` / `completed:<id>|<période>` pour `CHALLENGES`). Les
suppressions de plus de 180 jours sont purgées par `deleteCollectionItems`
(`pruneItemTombstones`). Côté client de synchro : `itemTombstones =
mergeItemTombstoneMaps(valeur locale de la clé sœur, valeur serveur si connue)`. Tant que l'app
n'écrit pas ces clés, rien ne change (carte vide).

Les marques sont consultées quand l'ancêtre est **inconnu** (entrée `legacy`) et aussi quand la
clé était **absente** de l'ancêtre (`base: null` : nouvel appareil, données de l'appareil
effacées puis réécrites, valeurs par défaut) : l'appareil n'a jamais vu la collection du serveur,
un élément présent localement et marqué supprimé ailleurs vient d'une copie périmée et n'est pas
ressuscité. Avec un ancêtre vivant connu, un élément absent de l'ancêtre est un ajout et n'est
jamais retiré par une marque (pesée supprimée puis ressaisie).

#### Règles communes (toutes stratégies)

1. États identiques → serveur gardé, `push: false` (renvoi après réponse perdue : sans effet).
2. Entrée `seed` → le serveur gagne, sans copie.
3. Local supprimé, serveur vivant : si le serveur n'a pas changé depuis l'ancêtre → suppression
   poussée ; sinon suppression poussée **et** valeur serveur copiée dans `recovery` (séances :
   suppression **annulée**, `notice`).
4. Local vivant, serveur supprimé : si le local n'a pas changé depuis l'ancêtre → la suppression
   s'applique ; sinon la valeur locale est **recréée** (une modification l'emporte sur une
   suppression ; séances : `notice`).
5. Les deux vivants : stratégie du domaine ; `push = résultat ≠ serveur` ; toute information
   serveur écartée sans raison (ni ancêtre, ni date plus récente, ni suppression) est copiée dans
   `recovery` ; idem pour une information locale écartée.
6. Valeur de forme inattendue (corrompue, ancien format) → repli `lww` avec copie : jamais
   d'exception, jamais de perte.

#### Stratégies

| Stratégie    | Avec ancêtre                                                                                                                     | Sans ancêtre                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `keep-both`  | seul le côté modifié gagne                                                                                                       | serveur appliqué + copie locale `kinetic:training:session:<id>-c<horodatage>` « <nom> (conflit) »                               |
| `collection` | par id : ajout gardé, suppression appliquée (sauf élément modifié de l'autre côté), modif. gardée                                | union ; même id : `updatedAt` (ou `stamp`) le plus récent, égalité → local + copie serveur ; suppressions d'éléments appliquées |
| `set`        | serveur + ajouts locaux − retraits locaux                                                                                        | union ; suppressions d'éléments appliquées aux valeurs présentes d'un seul côté                                                 |
| `map`        | par entrée, comme `collection`, valeur fusionnée avec la stratégie d'entrée                                                      | union des entrées                                                                                                               |
| `fields`     | champ par champ : le côté qui a changé gagne ; les deux → local + copie                                                          | champs locaux prioritaires, champs serveur seuls conservés, copie si écrasement                                                 |
| `counter`    | `serveur + (local − ancêtre)`, borné à 0 (incréments concurrents additionnés, annulation gardée)                                 | `max` (XP, compteurs croissants) ou `lww` (jetons consommables)                                                                 |
| `max`        | maximum (nombre, ou chaîne ISO / clé de semaine comparée lexicalement)                                                           | idem                                                                                                                            |
| `multiset`   | serveur + verres ajoutés localement − verres retirés localement                                                                  | la liste qui prolonge l'autre ; sinon la plus longue + copie de l'autre                                                         |
| `newest`     | le côté modifié ; les deux → horodatage (`at`) le plus récent                                                                    | horodatage le plus récent, égalité → local + copie                                                                              |
| `streak`     | `best = max(best, best', count retenu)` ; `count`/`lastActiveDate` de la date d'activité la plus récente (égalité → `count` max) | idem                                                                                                                            |
| `composite`  | chaque partie avec sa stratégie, le reste `fields`                                                                               | idem (suppressions préfixées par le nom de la partie)                                                                           |
| `lww`        | le côté modifié                                                                                                                  | local repoussé, valeur serveur copiée dans `recovery`                                                                           |

Propriétés vérifiées par les tests : `merge(a, a) = a` pour toute stratégie et tout ancêtre ;
contenu commutatif pour les unions, valeur commutative pour `max`/`counter`/`streak`/`map`+`max` ;
associativité du contenu des ensembles ; aucune perte d'identifiant hors suppression explicite ;
aucun élément supprimé ressuscité ; `push: false ⇒ résultat = serveur` sur toutes les clés du
registre ; une séance locale est toujours conservée (résultat, copie ou ancêtre identique).

#### Registre (`SYNC_MERGE_RULES`, première règle qui correspond ; clé non listée → `lww`)

| Clé ou motif                                                                                                                                                                                                                                                                  | Forme                                  | Stratégie                                                           | Justification                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC_OUTBOX`, `SYNC_CURSOR`, `SYNC_LAST_AT`, `SYNC_INITIAL_DONE`, `SCHEMA_VERSION`, `SCHEMA_MIGRATION_LOCK`, `SYNC_MIGRATED_TO`, `TRAINING_ACTIVE_SESSION`                                                                                                                   | interne                                | **appareil** (jamais d'outbox)                                      | état propre à l'appareil                                                                                                                                                         |
| `PENDING_TASK_MUTATION`                                                                                                                                                                                                                                                       | plan `{kind, set:[[clé, valeur]]}`     | **appareil**                                                        | journal de reprise en valeurs **absolues** : synchronisé, il réécrirait XP/série sur un autre appareil. Aujourd'hui synchronisé par `HybridStorage` → à ajouter aux clés locales |
| `kinetic:training:session:*`                                                                                                                                                                                                                                                  | `WorkoutSession` (une clé par séance)  | `keep-both`                                                         | donnée la plus précieuse (G1)                                                                                                                                                    |
| `kinetic:deleted:*`                                                                                                                                                                                                                                                           | `{ id: dateIso }`                      | `map` / `max`                                                       | une suppression n'est jamais oubliée                                                                                                                                             |
| `TRAINING_SESSIONS` (ancien), `TRAINING_TEMPLATES`, `TRAINING_EXERCISES`, `TRAINING_CUSTOM_EXERCISES`, `TIMER_PRESETS`, `MEASUREMENTS_PHOTOS`, `PROGRESS_PHOTOS`, `STRENGTH_GOALS`, `NUTRITION_RECIPES`, `VITALITE_CUSTOM_TASKS`, `VITALITE_TASKS`, `kinetic:nutrition:log:*` | tableau d'éléments `id`                | `collection` (id)                                                   | listes éditées sur plusieurs appareils (F9)                                                                                                                                      |
| `BODYWEIGHT_ENTRIES`                                                                                                                                                                                                                                                          | `{date, weight}[]`, une par jour       | `collection` (id = `date`), tri par date                            | F3b : 300 pesées cloud + 1 locale = 301                                                                                                                                          |
| `MEASUREMENTS_ENTRIES`                                                                                                                                                                                                                                                        | `{id, date, …}[]`                      | `collection` (id), tri par date                                     |                                                                                                                                                                                  |
| `NUTRITION_CUSTOM_FOODS`, `NUTRITION_FAVORITES`                                                                                                                                                                                                                               | `FoodPer100[]` (sans id)               | `collection` (id = `name` + `recipeId`)                             | identité naturelle                                                                                                                                                               |
| `NUTRITION_RECENTS`                                                                                                                                                                                                                                                           | `{food, grams, usedAt}[]`              | `collection` (id = aliment, date `usedAt`), tri décroissant         | dernier usage gagne                                                                                                                                                              |
| `CHALLENGES`                                                                                                                                                                                                                                                                  | `{accepted: Def[], completed: Done[]}` | `composite` : `accepted` par `id`, `completed` par `id`+`periodKey` | un même défi peut être réussi à chaque période                                                                                                                                   |
| `VITALITE_HIDDEN_TASKS`, `kinetic:vitalite:done:*`, `COMPLETED_KEYS`, `AWARDED_IDS`, `ACHIEVEMENTS_UNLOCKED`, `REWARDS_UNLOCKED`, `DEMO_MANIFEST`, `kinetic:program:completedDays:*`                                                                                          | `string[]` / `number[]`                | `set`                                                               | retraits (annuler une tâche, réafficher) gérés par l'ancêtre ou les suppressions d'éléments                                                                                      |
| `WELLNESS_CHECKINS`                                                                                                                                                                                                                                                           | `{jour: CheckIn}` (`at`)               | `map` / `newest(at)`                                                | check-in le plus récent du jour                                                                                                                                                  |
| `WELLNESS_WATER`                                                                                                                                                                                                                                                              | `{jour: ml[]}`                         | `map` / `multiset`                                                  | verres sans identité : ajouts des deux côtés gardés                                                                                                                              |
| `VITALITE_INTERVAL_LAST_DONE`, `PLATEAU_DISMISSED`                                                                                                                                                                                                                            | `{id: dateIso}`                        | `map` / `max`                                                       | dates monotones                                                                                                                                                                  |
| `kinetic:program:todoStatus:*`, `PROGRAM_ONE_RMS`                                                                                                                                                                                                                             | `{id: bool}` / `{exercice: kg}`        | `fields`                                                            | entrées indépendantes                                                                                                                                                            |
| `XP`, `kinetic:xp:earned:*`                                                                                                                                                                                                                                                   | `{xp}` (ancien : nombre)               | `counter(xp)`, repli `max`                                          | incréments concurrents additionnés ; l'XP ne baisse que par annulation (delta)                                                                                                   |
| `PROGRAM_GENERATED_COUNT`                                                                                                                                                                                                                                                     | nombre                                 | `counter`, repli `max`                                              | compteur croissant                                                                                                                                                               |
| `REWARDS_FREEZE_TOKENS`                                                                                                                                                                                                                                                       | nombre (consommé, rechargé)            | `counter`, repli `lww`                                              | `max` permettrait de dépenser deux fois un jeton                                                                                                                                 |
| `REWARDS_FREEZE_WEEK`, `VITALITE_LAST_RESET`, `TRAINING_CATALOG_VERSION`                                                                                                                                                                                                      | clé de semaine / date / version        | `max`                                                               | monotones                                                                                                                                                                        |
| `STREAK`                                                                                                                                                                                                                                                                      | `{count, best, lastActiveDate}`        | `streak`                                                            | règle de série                                                                                                                                                                   |
| `USER_PROFILE`, `PROFILE`, `STRENGTH_SCORE_PROFILE`, `NUTRITION_PLAN`, `NUTRITION_PREFS`, `WELLNESS_WATER_PREFS`, `PLATE_PREFS`, `GOALS`, `GOALS_WEEKLY`                                                                                                                      | objet de réglages                      | `fields`                                                            | deux réglages différents modifiés sur deux appareils sont tous deux gardés                                                                                                       |
| `PROGRAM_ACTIVE`, `ACTIVE_PROGRAM`, `PROGRAM_WEEK_PLAN`, `BODYWEIGHT_GOAL`, `REWARDS_THEME`, `STATS`, `kinetic:measurements:photo:*`, toute autre clé                                                                                                                         | valeur d'un bloc                       | `lww`                                                               | cohérence interne ; copie de la valeur écrasée                                                                                                                                   |

Les clés `localStorage`/`sessionStorage` de `STORAGE_KEYS` (thème, rappels, mode salle…) ne
passent pas par le `StoragePort` et ne sont pas synchronisées.

#### Liaison invité → compte : `planGuestMerge(entréesInvité, valeursCompte, now)`

Après le pull complet du compte, si l'utilisateur choisit « Ajouter les données de cet appareil à
votre compte ». Chaque clé invité est résolue avec `origin: 'guest'` et un ancêtre **absent** (les
deux historiques sont indépendants) : collections, ensembles, cartes → union ; compteurs →
**somme** (XP invité + XP du compte) ; série → règle `streak` ; réglages → champ par champ, **le
compte gagne** sur un même champ (les champs que seul l'invité a renseignés sont ajoutés) ; valeur
d'un bloc → le compte gagne ; séance de même id au contenu différent → copie « (cet appareil) ».
Exclus : clés propres à l'appareil, `DEMO_MANIFEST` et toutes les clés qu'il liste. Résultat :
`writes` (clé → valeur, à écrire via l'outbox avec la `base` serveur), `extraWrites` (copies,
`base: null`), `skipped`, `notices`. Aucune copie de récupération : la base invité est conservée
intacte (§ 4.1).

#### Limites connues

- Sans ancêtre ni suppression d'élément, une suppression d'élément peut revenir par l'union
  (cas des entrées converties de l'ancienne outbox) : c'est le prix de « aucune perte ».
- Suppression d'une **séance entière** venue de l'ancienne outbox (`origin: 'legacy'`, ancêtre
  inconnu) alors que la séance existe au serveur ET y a été modifiée après le dernier pull de
  l'ancien client (ou sans curseur legacy) : la suppression est annulée, avec un message
  (« … modifiée sur un autre appareil : elle a été conservée »). Si la séance n'a pas bougé au
  serveur depuis ce curseur, l'ancêtre est connu (§ 4.1) et la suppression s'applique. Cas unique,
  au premier lancement de la nouvelle version (testé : `sync-scenarios.test.ts`,
  `sync-compat-migration.test.ts`).
- `set` sans ancêtre : un élément supprimé puis ré-ajouté d'un seul côté reste supprimé si la
  clé sœur le marque (les ensembles n'ont pas de date de modification).
- Deux appareils qui modifient le même élément sans `updatedAt` : le local gagne, la valeur
  serveur est dans `recovery` (rien n'est perdu, mais l'utilisateur doit choisir).
- Les collections qui grossissent (pesées, mensurations, journal) gagneraient à passer à une clé
  par élément (le conflit deviendrait `keep-both`/`lww` par élément).

### 4.8 ter Écritures fondées sur un état périmé (vue de l'app)

Les pages et stores gardent en mémoire ce qu'ils ont lu (`this.templates`, séance ouverte…)
et réécrivent la valeur **entière** de la clé ; l'app n'écoute pas `kinetic:sync-applied`.
Si la synchro a modifié la clé entre la lecture et l'écriture (pull périodique, premier pull
d'un nouvel appareil pendant que la page affiche les modèles par défaut, résolution de
conflit, suppression totale), l'écriture partait avec la version la plus récente comme
`base` : aucun conflit au serveur, la modification de l'autre appareil était écrasée sans
copie.

`SyncedStorage` suit, **en mémoire et par instance**, la vue de l'app :

- `get(key)` et chaque écriture notent la révision de la clé vue par l'app (dans la
  transaction de lecture / d'écriture) ;
- le moteur signale chaque modification de `kv` par la synchro (`remoteTouched`, dans sa
  transaction) ; l'état que l'app avait vu est alors mémorisé ;
- une écriture sur une clé modifiée depuis la dernière lecture est **fusionnée** dans la
  transaction d'écriture (`engine.rebaseStaleWrite`) : fusion à trois voies par domaine
  (`resolveSyncConflict`) entre l'état vu (ancêtre), l'écriture de l'app et `kv`, avec les
  mêmes copies (`recovery`, séance « (conflit) ») qu'un conflit serveur. Si la fusion change
  ce que l'app a écrit, sa vue reste marquée périmée pour l'écriture suivante.

Limite : un pull fait par un **autre onglet** n'est pas vu (l'app mobile n'a qu'une vue web).
Les écritures sans lecture préalable dans le processus (nouvelle séance) ne sont pas concernées.

Envois sans réponse successifs : `sent` garde le dernier état envoyé sans réponse et
`sentEarlier` les précédents (4 au plus) ; un conflit dont l'état serveur est l'un d'eux est
notre propre écriture (avance rapide, pas de copie « (conflit) »).

### 4.9 État de synchro exposé à l'app

Type de `packages/core` :

```ts
interface SyncStatus {
  state: 'synced' | 'syncing' | 'pending' | 'offline' | 'auth_required' | 'error';
  pending: number; // entrées 'pending'
  blocked: ReadonlyArray<{ key: string; reason: string }>; // entrées 'blocked'
  recovery: number; // éléments mis de côté
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
}
```

Publié par l'adaptateur (événement `kinetic:sync-status`, remplace `kinetic:sync-failed` qui reste
émis pour compatibilité). L'UI (profil + bandeau discret) affiche en français : « Synchronisé »,
« N modifications en attente », « Hors ligne : vos données sont enregistrées sur cet appareil »,
« Reconnectez-vous pour synchroniser », et pour `blocked` la liste avec un libellé par raison
(`quota_bytes` → « Espace cloud plein (50 Mo) », `value_too_large` → « Élément trop volumineux
pour le cloud », etc.) et les actions « Réessayer », « Exporter une sauvegarde ».
`cloudSynced` (rappel de sauvegarde) = `pending === 0 && blocked.length === 0 && lastPushAt
récent`, et non « est connecté » (F6).

### 4.10 Implémentation client (`packages/adapter-web/src/sync/`, `apps/web`)

| Élément                         | Fichier                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Base par compte, propriétaire   | `sync/local-db.ts` (`LocalSyncDb`, `OwnerMismatchError`, `dbNameForOwner`)                                   |
| Wrapper IndexedDB multi-stores  | `sync/idb.ts` (transaction résolue après `oncomplete`, rollback si erreur)                                   |
| StoragePort + outbox atomique   | `sync/SyncedStorage.ts` (`get` lève en cas d'échec, `setMany` en une transaction, état, effacements)         |
| Push / pull / conflits / invité | `sync/engine.ts` (chargé à la demande après le premier rendu : hors du bundle de démarrage)                  |
| Migration `keyval-store`        | `sync/legacy-migration.ts` (chargé seulement si `meta.migratedFrom` est absent)                              |
| RPC Supabase + repli PGRST202   | `supabase/SupabaseSyncRemote.ts` (refuse tout appel si la session active n'est pas le compte de la base)     |
| Session locale                  | `supabase/auth.ts` → `getLocalSessionUser()` (lecture de `kinetic-auth`, sans réseau)                        |
| Choix de la base, cycle de vie  | `apps/web/src/deps.factory.ts`, `deps.ts` (`rebuildDepsForSession`, `pendingAfterFlush`)                     |
| État de synchro (UI)            | `apps/web/src/stores/sync.ts` (`$store.sync`), Profil › Compte (état, bloqués, mis de côté, invité, effacer) |
| Faux serveur 010 + IDB mémoire  | `tests/support/fake-sync-server.ts`, `tests/support/fake-indexeddb.ts`, `tests/support/sync-harness.ts`      |

Précisions de mise en œuvre :

- Les règles de fusion (`domainMergeRegistry`, `planGuestMerge`) sont chargées au premier conflit,
  à la réconciliation ou à la liaison invité (`loadMerge`), jamais au démarrage. La liste des clés
  locales du client (`LOCAL_ONLY_KEYS`) est vérifiée identique aux règles `device` du core par un
  test.
- Une écriture locale identique à la version serveur connue, ou la suppression d'une clé que
  l'appareil n'a jamais vue, ne crée pas d'entrée d'outbox (PERF-07).
- Les passes de pull complètes (première synchro, réconciliation, resync) mémorisent leur mode
  (`meta.pullMode`) : interrompues, elles reprennent de zéro au lancement suivant (pages
  idempotentes) ; le curseur n'est écrit qu'à la fin. Les pulls delta écrivent le curseur dans la
  transaction de chaque page.
- Au démarrage, les entrées en backoff sont retentées immédiatement ; un conflit répété plus de
  3 fois sur la même clé passe en backoff (anti-boucle).
- Une valeur dont `JSON.stringify(value).length × 1,1 > 1 Mo` est bloquée localement
  (`value_too_large`) sans être envoyée ; une nouvelle écriture de l'utilisateur la remet en
  attente ; « Réessayer » (Profil) remet en attente toutes les entrées bloquées.
- `PENDING_TASK_MUTATION` (journal de reprise d'une tâche) est désormais propre à l'appareil.
- Photos : les images (Blob) sont dans une base **par compte** (`kinetic-photos-u-<id>` /
  `kinetic-photos-guest`, `lib/photos.ts`, nom dérivé de `owner` de la base du compte ou de la
  cible du repli). Une image encore dans l'ancienne base commune `kinetic-photos` est déplacée
  dans celle du compte à sa première lecture. « Effacer les données de cet appareil » et la
  suppression du compte effacent la base d'images du compte (et ses images restées dans
  l'ancienne base, d'après ses métadonnées) avant les données. Les images ne sont pas
  synchronisées (passage vers Supabase Storage à faire).
- Clés propres à l'appareil ajoutées : `BACKUP_RESTORE_UNDO` (valeurs d'avant la dernière
  restauration d'une sauvegarde, pour l'annuler sur cet appareil).

Limites connues pendant la transition (ancien client installé sur un autre appareil) :

- l'ancien client écrit sans `base` (dernière écriture gagne) : il peut écraser une modification
  plus récente d'un nouveau client sans conflit détecté ; le nouveau client applique ensuite sa
  valeur comme n'importe quel changement serveur ;
- l'ancien client ne reçoit pas les suppressions (`sync_pull` sans tombstones) : il garde
  localement les clés supprimées ailleurs, et les recrée s'il les modifie (comportement d'avant 010) ;
- ses suppressions, en revanche, deviennent des tombstones et se propagent aux nouveaux clients ;
- sans migration 010 côté serveur, le nouveau client repasse en mode compatibilité (PGRST202) :
  upsert / delete / `sync_pull`, sans écriture conditionnelle ni tombstones.

### 4.11 Robustesse WebKit : IndexedDB qui ne répond plus

**Constat** (test simulateur iPhone, Capacitor 8 / WKWebView) : environ un lancement sur six
à dix, juste après le rechargement de la démo (`window.location.assign('/')`), toutes les
lectures du stockage restent sans réponse pendant des minutes (`deps.storage.keys()` > 3 s
à chaque écran) : écrans vides, aucune erreur. Non reproductible sous Chromium ni WebKit
Linux. Cause retenue : défaut connu de WebKit (bug 226547 et apparentés, parade
« safari-14-idb-fix ») — au démarrage ou juste après une navigation, `indexedDB.open` ou la
première transaction ne répond jamais tant que le processus IndexedDB n'est pas « réveillé ».

**Parade** (`packages/adapter-web/src/sync/idb.ts`, point unique d'ouverture) :

- **Réveil** : avant la première ouverture d'un chargement de page, `indexedDB.databases()`
  est appelé toutes les 100 ms jusqu'à la première réponse (succès ou erreur), au plus
  3 s ; au-delà, l'ouverture est tentée quand même.
- **Ouverture avec délai** : une requête `open` sans réponse (ni `success`, ni `error`, ni
  `upgradeneeded`) en 4 s est abandonnée et une nouvelle est faite (nouveau réveil), 3
  tentatives au plus, puis `IdbUnresponsiveError`. Une tentative abandonnée qui répond plus
  tard voit sa connexion **fermée** (aucune fuite) et sa montée de version éventuelle
  **annulée** (la tentative suivante, en file derrière elle, la fera). `onblocked` (autre
  connexion ouverte, `versionchange`, `deleteDatabase`) n'est **pas** ce cas : pas de délai,
  on attend la fermeture comme avant.
- **Lecture surveillée** (`LocalSyncDb.tx`) : une transaction `readonly` sans fin (ni
  `complete`, ni `error`, ni `abort`) après 5 s est abandonnée, la connexion fermée et
  rouverte, la lecture rejouée **une** fois ; un second blocage lève `IdbUnresponsiveError`.
  Tant qu'une écriture de la même **connexion** est en cours (page de pull, migration : elle
  peut légitimement retenir la lecture), l'échéance est repoussée (6 fois au plus, ≈ 35 s) ;
  une écriture bloquée sur une connexion abandonnée ne repousse pas la lecture rejouée.
  Les **écritures ne sont pas surveillées** : abandonner une écriture qui a peut-être été
  validée rendrait son résultat incertain, et les écritures longues sont légitimes. Le
  contrôle du propriétaire à l'ouverture (1re transaction de la connexion, celle que WebKit
  « avale » le plus souvent) est donc une **lecture** ; il n'écrit que si le propriétaire
  manque. En cas d'échec, `LocalSyncDb.open` et `SyncedStorage.open` ferment la connexion.
- **Fermeture** : `LocalSyncDb.close()` est définitive (`suspend()`, elle, permet la
  réouverture : voir § 4.11 bis). Une réouverture en cours (après une
  lecture bloquée) est annulée avant la requête d'ouverture, ou sa création de base refusée :
  une base supprimée entre-temps (effacement, suppression du compte) ne renaît pas vide.
- **`databaseExists`** : `databases()` a lui aussi un délai (repli sur une ouverture
  surveillée) ; un blocage lève `IdbUnresponsiveError`, **jamais** « absente » — sinon la
  migration noterait « pas d'ancienne base » et ne reprendrait plus jamais ses données.
- Délais injectables (`IdbGuardOptions`, option `idbGuard` de `SyncedStorage.open`) pour
  les tests.

`IdbUnresponsiveError` n'est **jamais** interprétée comme « base vide ». Un échec définitif
(réessais épuisés) est signalé aux abonnés de `onIdbUnresponsive`.

**Côté app** (`apps/web/src/deps.factory.ts`, `deps.ts`, `lib/storage-unresponsive.ts`) :

- à l'ouverture, `IdbUnresponsiveError` ne déclenche **pas** le repli `LegacyFallbackStorage`
  (même IndexedDB, donc bloqué aussi ; et une fois la migration faite, il ne montre que ses
  propres écritures de repli : un stockage vide). Ni repli, ni mémo de repli : l'erreur
  remonte ;
- reprise (ouverture ou lecture bloquée) : rechargement de la page **une seule fois**
  (marqueur horodaté `kinetic:idb-unresponsive-reload-at` en sessionStorage) ; nouveau
  blocage dans les 5 minutes, ou sessionStorage indisponible → message persistant plein
  écran « Le stockage de l'appareil ne répond pas. Tes données ne sont pas perdues : ferme
  complètement l'app puis rouvre-la. » avec un bouton « Réessayer » (rechargement demandé
  par l'utilisateur). Aucun écran vide présenté comme normal, aucune valeur par défaut
  écrite.

**Limites** : la parade réduit le risque sans supprimer le défaut WebKit (un processus
IndexedDB bloqué jusqu'à la fermeture de l'app reste possible : d'où le message). Le
temps de détection au démarrage peut atteindre ≈ 15 s (réveil 3 s + 3 × 4 s) avant le
rechargement. Tests : `tests/integration/idb-unresponsive.test.ts`,
`tests/unit/storage-unresponsive.test.ts`, `tests/unit/deps.factory.test.ts`.

### 4.11 bis Connexions fermées avant de quitter la page

**Constat** (run CI iOS 46139726618, version 9.17.0) : sur une installation neuve sur quatre,
juste après la démo (écriture réussie, 52 clés lues en 6 ms) puis la navigation pleine page,
même une ouverture DIRECTE `indexedDB.open('kinetic-guest')` (hors code de l'app) reste sans
réponse pendant toute la session (≈ 7 min), alors que `indexedDB.databases()` répond : le
moteur IndexedDB de WebKit est figé pour l'origine, pas une file d'attente de l'app.
Fréquence ≈ 1 lancement sur 7. Non reproduit sous Playwright WebKit Linux (79 contextes
neufs : démo puis `assign` / `replace` / `reload`, avec écritures de 1 Mo en cours, transaction
`readwrite` maintenue vivante, montée de version en attente au moment de la navigation :
0 gel). Cause la plus probable : la page quittée garde des connexions (et parfois une
écriture en cours) pendant son déchargement ou dans le cache de retour arrière, et le
serveur IndexedDB de WebKit met en file les ouvertures de la page suivante derrière elles.

**Parades** :

- `closeAllLocalDatabases({ waitMs })` (`packages/adapter-web/src/sync/connections.ts`) :
  attend au plus `waitMs` les écritures en cours (suivies dès l'appel de `LocalSyncDb.tx`,
  attente de connexion comprise), puis ferme toutes les connexions inscrites : base du
  compte (`LocalSyncDb.suspend`), repli (`LegacyFallbackStorage.suspend`), bases d'images
  (`lib/photos.ts`, idb-keyval : connexion fermée depuis une transaction, store oublié). C'est
  une **suspension** : la base est rouverte au prochain accès ; une transaction demandée sur
  la connexion fermée (`InvalidStateError`) est rejouée sur une connexion rouverte.
  `close()` d'IndexedDB laisse finir les transactions déjà créées : aucune écriture perdue ;
  l'attente évite qu'un déchargement ne les annule. Après `close()` (définitive), aucune
  suspension ne rouvre : une base supprimée ne renaît pas. La page qui part réagit encore
  (rendu du tableau de bord après la démo, écriture enchaînée, réouverture en cours) : après
  chaque fermeture, `closeAllLocalDatabases` observe 25 ms ; toute base rouverte entre-temps
  (`active()`) est attendue puis refermée, dans la limite de `waitMs`.
- `pagehide` (et `freeze`, Chromium) : connexions fermées tout de suite (`waitMs: 0`),
  rouvertes au retour si la page est restaurée du cache.
- Navigations pleine page voulues par l'app (`apps/web/src/lib/full-reload.ts`) : « Voir la
  démo », parcours de test, restauration / annulation de restauration, effacement de
  l'appareil, suppression des données cloud ou du compte, sortie de la démo, déconnexion,
  stockage bloqué (« Réessayer » et rechargement automatique, attente réduite à 1 s) et
  chunk introuvable : fermeture d'abord, puis `location.replace` (la page quittée n'a plus
  d'entrée d'historique : elle ne reste pas en cache de retour arrière) ou `reload`. Retour
  OAuth (repli) et `browserFinished` : fermeture puis navigation.
- Pas de navigation par le routeur après la démo : seuls `goals` et `achievements` se
  rechargent sur `kinetic:deps-ready` ; XP, série, récompenses, nutrition, vitalité
  garderaient leur état vide. Le rechargement complet est gardé, précédé de la fermeture.
- Rechargement automatique demandé mais page toujours là 10 s plus tard (navigation
  retenue) : le message de secours est affiché quand même (`RELOAD_GRACE_MS`).
- `lib/photos.ts` n'ouvre plus l'ancienne base `kinetic-photos` à l'import du module
  (idb-keyval ouvre — et crée — la base dès `createStore`) : seulement au premier usage.

**Natif iOS** : pas de plugin « relancer la vue ». Capacitor ne permet de recréer ni le
processus WebContent ni la `WKWebView` du pont sans API privée (`_killWebContentProcess`,
refusée à l'App Store) ou sans remplacer `CAPBridgeViewController` ; `webView.reload()`
garde le même processus et la même connexion au serveur IndexedDB (processus réseau
partagé) : il n'apporte rien de plus que le rechargement JS. Le message reste donc « ferme
complètement l'app puis rouvre-la ».

**Diagnostic du parcours de test** (`lib/autotest.ts`, `tests/ios/drive.py`) : chaque étape
rapporte aussi `secours` (message plein écran `#k-storage-stuck` affiché, hors de
`#app-outlet`), `rechargementAuto` (âge du marqueur de rechargement automatique) et
`reloads`. Le plan n'est plus supprimé au début : il est réécrit avant chaque étape
(`next`), un rechargement reprend le parcours à cette étape (3 rechargements au plus, puis
abandon noté). Tests : `tests/integration/idb-unresponsive.test.ts` (suspension, `pagehide`,
chaîne lecture bloquée → erreur → rechargement → 2e blocage → message),
`tests/unit/full-reload.test.ts`, `tests/unit/autotest.test.ts`.

## 5. Déploiement, compatibilité, retour arrière

Ordre :

1. **Serveur : appliquer 010** (`supabase db push`). Compatible avec les clients installés
   (§ 3.6, prouvé par `tests/sql/80_legacy_clients.sql` et `15_upgrade.sql`). Effets immédiats
   pour les anciens clients : grosses valeurs acceptées, quota rapide, versions serveur, et
   leurs suppressions deviennent des tombstones. Pour une très grosse table, faire avant
   `drop index concurrently if exists public.idx_user_storage_user_key;` (idem
   `idx_user_storage_updated`) hors transaction.
2. **Client : nouvelle version** implémentant la partie 4, avec repli : si `sync_push` /
   `sync_pull_v2` renvoient `PGRST202` (serveur pas encore migré), utiliser l'ancien chemin
   (upsert / delete / `sync_pull`) sans écriture conditionnelle, et l'indiquer en journal.
3. **Purge** : n'activer `purge_sync_tombstones` (pg_cron ou job) qu'une fois la nouvelle version
   majoritaire ; les anciens clients ne lisent pas les tombstones et ne sont pas concernés.
4. Plus tard (migration 011 future, hors périmètre) : quand les anciennes versions ont disparu,
   révoquer `insert/update/delete` direct sur `user_storage` pour `authenticated` afin que
   `sync_push` soit le seul chemin d'écriture.

Retour arrière :

- Serveur : 010 peut rester en place même si le client revient en arrière (compatible). Pour la
  retirer quand même : recréer les triggers `user_storage_updated_at` / `enforce_storage_quota`
  et les fonctions 009, supprimer les triggers `user_storage_*` de 010, puis
  `delete from user_storage where deleted` (les marqueurs de suppression, pas des données) ; les
  colonnes et tables ajoutées peuvent rester.
- Client : une ancienne version réinstallée relit `keyval-store`, conservée intacte par la
  migration (§ 4.1, étape 4) ; les écritures faites entre-temps sont dans le cloud et
  redescendent par l'ancien pull.

## 6. Choix et compromis

- **Clé → valeur conservé** plutôt que des tables par domaine : pas de refonte du domaine, un
  seul chemin de synchro à fiabiliser. Prix : la fusion des collections se fait côté client
  (table de stratégies) et nécessite des tombstones d'éléments.
- **Version = horodatage serveur** plutôt qu'un compteur entier : compatible avec le curseur
  existant (`updated_at`) et l'ancienne `sync_pull` ; la monotonie par utilisateur
  (`last_version + 1 µs`) supprime les inconvénients d'horloge.
- **Verrou par utilisateur** : sérialise les écritures d'un même compte (négligeable à l'échelle
  d'un utilisateur) en échange d'un curseur sans trou ni fenêtre de recouvrement, et d'un quota
  sans course. Coût : l'interblocage rare ancien client / nouveau client décrit en § 3.6.
- **Conflit = refus + résolution client** plutôt que fusion serveur : les règles métier restent
  dans `packages/core` (pures, testables), le serveur reste générique.
- **Écriture sur clé absente avec une `base`** = création acceptée : après une purge, mieux vaut
  recréer une donnée que la perdre (au pire une suppression vieille de plus de 180 jours est
  annulée).
- **DELETE ancien client → tombstone** plutôt que refus : les anciennes versions continuent de
  fonctionner, et leurs suppressions se propagent enfin.
- **Tombstones purgées à 180 jours** + `resync_required` : stockage borné ; un appareil inactif
  plus de 6 mois refait un pull complet, et ses clés orphelines vont en `recovery` (jamais
  effacées sans trace).
- **Une base locale par compte** plutôt qu'un effacement à la déconnexion : aucune donnée non
  synchronisée perdue en changeant de compte, isolation garantie par construction.
- **Quota en octets texte jsonb** (et non `pg_column_size`) : valeur exacte, identique à la
  contrainte de 1 Mo, recalculable ; coût O(taille de la ligne écrite).
- Photos en base64 dans `user_storage` (jusqu'à 1 Mo chacune) : acceptées, mais consomment le
  quota de 50 Mo ; les déplacer vers Supabase Storage reste un point ouvert.

## 7. Correspondance avec l'audit

| Constat                                | Traitement                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1, SEC-02, QA-01                      | Tombstones serveur, DELETE → tombstone, `sync_pull_v2` (§ 2.3, 3.2)                                                                                   |
| F2, local F1                           | Base IndexedDB par compte + `meta.owner` (§ 4.1)                                                                                                      |
| F3, local F3                           | Pas de défaut persisté avant le premier pull, `seed`, fusion explicite invité → compte (§ 4.1, 4.6)                                                   |
| F4                                     | Transactions IDB uniques donnée + outbox, pull lisant l'outbox dans sa transaction (§ 4.2, 4.4)                                                       |
| F5, local F4, QA-04                    | `clear()` scindé, `sync_delete_all`, `delete_all` persisté, pas de faux succès (§ 4.7)                                                                |
| F6, PERF-01, SEC-01                    | Index INCLUDE supprimé ; statuts `rejected` par élément, état `blocked` visible (§ 2.6, 3.1, 4.9)                                                     |
| F7, QA-03, local F11                   | Outbox par entrée, même transaction que la donnée, erreurs IDB levées (§ 4.2)                                                                         |
| F8                                     | Page de pull + curseur dans une transaction (§ 4.4)                                                                                                   |
| F9                                     | `sync_push` conditionnel + stratégies par domaine + tombstones d'éléments (§ 3.1, 4.8)                                                                |
| F10, QA-02, PERF-02, PERF-08, local F8 | `getSession()` local, HybridStorage toujours, réconciliation (§ 4.1, 4.5)                                                                             |
| F11                                    | Version attribuée sous verrou par utilisateur (§ 2.2, test `90_concurrency.sh`)                                                                       |
| F12, SEC-05, PERF-03                   | `user_storage_usage` incrémental (§ 2.4)                                                                                                              |
| F13, SEC-10                            | Version et `created_at` fixés par trigger ; versions futures ramenées ; `cursor_in_future`                                                            |
| F14                                    | Restauration forcée = pull complet en mode resync ; les entrées en attente sont conservées et résolues par stratégie, jamais écrasées silencieusement |
| PERF-04                                | Index redondant supprimé                                                                                                                              |
| PERF-07                                | Lots `sync_push` (§ 4.3)                                                                                                                              |
| PERF-09                                | Pull au premier plan + toutes les 60 s visible (§ 4.4)                                                                                                |
