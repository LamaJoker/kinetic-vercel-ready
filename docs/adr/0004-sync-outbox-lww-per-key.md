# ADR 0004 — Synchronisation : outbox persistante, LWW par clé, curseur serveur

- **Status** : Accepted
- **Date** : 2026-09-15
- **Remplace partiellement** : ADR 0003 (mécanisme de sync)

## Contexte

L'audit de septembre 2026 a relevé quatre défauts dans `HybridStorage` :

1. La file des écritures en attente était **en mémoire** : fermer l'app avant la
   confirmation du cloud perdait définitivement la synchro de ces écritures.
2. Après 3 échecs, l'écriture était **abandonnée** : local et cloud divergeaient
   pour toujours.
3. `remove()` n'était pas rejoué : une donnée supprimée hors-ligne **ressuscitait**
   sur les autres appareils.
4. Le curseur de delta sync utilisait **l'horloge du téléphone** (décalages → changements manqués).

S'y ajoutait un problème de modèle : tout l'historique d'entraînement vivait dans
**une seule valeur** (`kinetic:training:sessions`). Au-delà de ~1 MB, IndexedDB et
Supabase refusaient l'écriture, et deux appareils ajoutant une séance en parallèle
en perdaient une (Last-Write-Wins sur tout le tableau).

## Décision

- **Outbox persistante** (`kinetic:sync:outbox` en IndexedDB) : chaque `set` /
  `remove` y est inscrit avant de rendre la main ; rejouée au démarrage, au retour
  réseau et par un timer de retry.
- **Aucun abandon** : backoff exponentiel plafonné à 5 min ; événement
  `kinetic:sync-failed` au 3e échec pour l'UI.
- **Tombstones** : `remove` est une opération de l'outbox.
- **Garde de révision** : une écriture faite pendant un flush n'est pas marquée
  comme synchronisée par erreur.
- **Curseur serveur** : RPC `sync_pull(p_since, p_after_key, p_limit)` (migration 009) — pagination keyset sur `(updated_at, key)`, recouvrement de 5 s.
  Fallback automatique sur l'ancien mode si la RPC n'est pas déployée.
- **Conflits** : Last-Write-Wins **par clé**, et granularité fine des données :
  une clé par séance (`kinetic:training:session:<id>`), migration IDB v2.
- **Première liaison** d'un appareil à un compte : les données locales absentes du
  cloud (mode invité) sont poussées.

## Alternatives considérées

1. **CRDT complet** (Automerge/Yjs) : fusion automatique, mais dépendance lourde,
   format opaque en base, et peu de valeur pour des données majoritairement
   append-only (séances, pesées).
2. **Tables relationnelles dédiées** (`workout_sessions`, `workout_sets`, déjà
   créées en migration 004) : meilleure requêtabilité, mais synchro par table à
   écrire et tester. Reste l'étape suivante si des requêtes serveur deviennent
   nécessaires (analytics, coach IA sur l'historique complet).

## Conséquences

- ✅ Plus de perte silencieuse ; comportement vérifié par tests d'intégration
  (reload simulé, tombstone, backoff, pagination, fallback legacy).
- ✅ Historique illimité en pratique (quota serveur relevé à 20 000 clés / 50 MB).
- ⚠️ Deux modifications hors-ligne de **la même** clé sur deux appareils : la
  dernière synchronisée gagne. Acceptable pour les réglages et les séances (une
  séance est éditée sur un seul appareil).
- ⚠️ Un appareil resté sur une ancienne version peut réécrire le tableau legacy ;
  il est replié automatiquement à la prochaine lecture.
