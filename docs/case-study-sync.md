# Étude de cas — rendre la synchro hors-ligne fiable

> Kinetic est un carnet de musculation utilisé **en salle**, souvent sans réseau.
> Une série saisie entre deux efforts ne doit jamais disparaître.

## Le problème

La première version de la synchro (`HybridStorage`) écrivait en local (IndexedDB)
puis poussait vers Supabase. En relisant le code avec des scénarios réels, quatre
façons de perdre des données sont apparues :

| Scénario                                                       | Ce qui se passait                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Séance saisie hors-ligne, app fermée avant le retour du réseau | La file d'attente vivait en mémoire : elle disparaissait, la séance n'atteignait jamais le cloud       |
| Serveur indisponible 3 fois de suite                           | L'écriture était abandonnée en silence : téléphone et cloud divergeaient pour toujours                 |
| Séance supprimée hors-ligne                                    | La suppression n'était pas rejouée : la séance réapparaissait sur l'autre appareil                     |
| Horloge du téléphone en avance                                 | Le curseur de synchro reposait sur l'heure locale : des changements d'autres appareils étaient ignorés |

Et un problème de modèle : **tout l'historique tenait dans une seule valeur**.
Au-delà d'environ 1 Mo (quelques centaines de séances), IndexedDB et Supabase
refusaient l'écriture ; deux appareils ajoutant chacun une séance en perdaient une.

## Les décisions

**1. Une outbox persistante.** Chaque écriture ou suppression est inscrite dans une
file stockée en IndexedDB _avant_ de rendre la main. Au démarrage, la file est
rechargée et rejouée. Fermer l'app ne perd plus rien.

**2. Ne jamais abandonner.** Un échec replanifie l'envoi avec un délai croissant
(1 s, 2 s, 4 s… plafonné à 5 min). Au 3e échec, l'interface est prévenue, mais
l'écriture reste en file jusqu'au succès.

**3. Des suppressions qui voyagent.** Une suppression est une opération de la file
comme une autre (« tombstone »).

**4. L'heure du serveur comme référence.** Une fonction SQL `sync_pull` renvoie les
changements triés par `(updated_at, key)` avec une pagination par curseur ; le
client mémorise le dernier `updated_at` _serveur_ reçu, avec 5 s de recouvrement
pour les transactions lentes. Réappliquer une valeur identique est sans effet.

**5. Une clé par séance.** `kinetic:training:session:<id>` au lieu d'un tableau
géant. Le conflit « dernier qui écrit gagne » ne porte plus que sur une séance,
et une séance n'est modifiée que sur un appareil.

**6. Une garde de révision.** Si l'utilisateur modifie une valeur _pendant_ qu'elle
part vers le serveur, la nouvelle version n'est pas marquée comme envoyée par
erreur.

## Pourquoi pas un CRDT ?

Automerge ou Yjs fusionnent automatiquement les modifications concurrentes, mais
ajoutent une dépendance lourde et un format opaque en base. Les données de Kinetic
sont surtout **ajoutées** (séances, pesées) et rarement modifiées sur deux appareils
à la fois : une granularité fine + « dernier qui écrit gagne » suffit, pour un coût
bien moindre. Le détail est dans [l'ADR 0004](adr/0004-sync-outbox-lww-per-key.md).

## Comment c'est vérifié

- Tests d'intégration qui simulent un rechargement de page, une panne serveur,
  une suppression hors-ligne, une pagination de 1 200 lignes et une base où la
  migration n'est pas encore appliquée (repli automatique sur l'ancien mode).
- Migration SQL testée sur un vrai PostgreSQL 16 (droits RLS, pagination,
  quota atomique).
- Migration des données existantes (tableau → une clé par séance) testée pour ne
  jamais écraser une version plus récente.

## Résultat

- Aucune perte silencieuse dans les scénarios ci-dessus, chacun couvert par un test.
- Historique pratiquement illimité (quota relevé à 20 000 clés / 50 Mo).
- Une séance ajoutée en salle, hors-ligne, apparaît sur l'autre appareil au retour
  du réseau.

## Ce que je ferais ensuite

Passer les séances dans les tables relationnelles déjà prévues
(`workout_sessions`, `workout_sets`) pour permettre des statistiques côté serveur,
et ajouter un test de bout en bout à deux appareils contre un Supabase local.
