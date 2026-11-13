# Publier Kinetic sur Google Play

Tout ce qu'il faut pour la fiche et l'envoi. Les textes respectent les limites de
la Play Console (titre 30 caractères, description courte 80, longue 4000).

## Avant le premier envoi

1. **Compte développeur Google Play** — 25 $ une fois. Un compte personnel créé
   depuis novembre 2023 doit d'abord faire un **test fermé avec 12 testeurs
   pendant 14 jours** avant de pouvoir publier en production.
2. **Clé de signature** — voir [`ANDROID.md`](../ANDROID.md), section « release ».
   Sauvegarde le fichier `.keystore` et ses mots de passe hors de l'ordinateur.
3. **Version** — augmente `version` dans `apps/web/package.json` à chaque envoi.
4. **Fichier à envoyer** — `pnpm android:bundle`, puis
   `apps/web/android/app/build/outputs/bundle/release/app-release.aab`.

## Fiche

| Champ              | Valeur                                                                         |
| ------------------ | ------------------------------------------------------------------------------ |
| Nom                | `Kinetic – Carnet de muscu`                                                    |
| Description courte | `Séances, charges, records et routine. Fonctionne hors ligne, sans publicité.` |
| Catégorie          | Santé et remise en forme                                                       |
| Coordonnées        | ton adresse e-mail de contact (obligatoire)                                    |
| Confidentialité    | `https://kinetic-prod.vercel.app/legal/confidentialite`                        |

### Description longue

```text
Kinetic est un carnet de musculation qui calcule à ta place entre deux séries.

SÉANCES
• Note poids, répétitions et ressenti en un geste
• La charge de la prochaine série est proposée d'après ta dernière séance
• Minuteur de repos qui laisse la séance visible
• Programmes prêts à l'emploi ou générés selon tes objectifs

PROGRESSION
• Records personnels détectés automatiquement
• Tonnage et volume par semaine, équilibre entre groupes musculaires
• Alerte quand une semaine de récupération devient utile
• Bilan de la semaine chaque dimanche

AU QUOTIDIEN
• Routine de récupération : sommeil, hydratation, mobilité
• Série de jours, niveaux et récompenses pour rester régulier
• Widget d'écran d'accueil : ta série et ta routine d'un coup d'œil
• Rappel à l'heure de ton choix, seulement si la routine reste à faire

NUTRITION ET CORPS
• Objectifs de calories et de macros calculés d'après ton profil
• Journal des repas, recherche d'aliments par code-barres
• Poids, mensurations et photos avant / après

TES DONNÉES T'APPARTIENNENT
• Fonctionne entièrement hors ligne, sans compte
• Synchronisation facultative, hébergée en Europe
• Les photos ne quittent jamais ton téléphone
• Export complet en un geste, import depuis Strong et Hevy
• Aucune publicité, aucune revente de données
```

## Visuels

Générés par `node scripts/generate-store-assets.mjs` dans `docs/play-store/` :

| Fichier               | Usage                      | Taille      |
| --------------------- | -------------------------- | ----------- |
| `icon-512.png`        | Icône de la fiche          | 512 × 512   |
| `feature-graphic.png` | Bannière de la fiche       | 1024 × 500  |
| `screenshot-*.png`    | Captures téléphone (2 à 8) | 1080 × 1920 |

Les captures utilisent les données de démonstration de l'application.

## Questionnaires de la Play Console

**Sécurité des données** (d'après la politique de confidentialité en vigueur) :

- Données collectées **uniquement avec un compte** : adresse e-mail, données de
  santé et de forme (séances, poids, mensurations, repas).
- Usage : fonctionnement de l'application (synchronisation). Pas de publicité,
  pas de partage à des fins commerciales.
- Chiffrées en transit : oui. Suppression possible : oui, depuis Profil, puis
  « Supprimer mon compte ».
- Photos : restent sur l'appareil, non collectées.
- Coach IA, s'il est activé : la question et un résumé des séances sont transmis
  à un sous-traitant pour générer la réponse — à déclarer comme partage.

**Classification du contenu** : aucun contenu sensible, tous publics.
**Public cible** : 16 ans et plus (application de musculation, pas destinée aux enfants).
**Annonces** : l'application ne contient pas d'annonces.
**Application de santé** : déclarer « Fitness » ; pas de fonction médicale.

## Vérifications sur un vrai téléphone avant l'envoi

- [ ] Installation de l'APK de publication, premier lancement, démonstration
- [ ] Connexion Google et lien par e-mail (retour dans l'application)
- [ ] Widget : ajout depuis Profil, mise à jour après une tâche cochée, appui
- [ ] Rappel de routine reçu application fermée ; appui ouvre la routine
- [ ] Mode avion : séance complète enregistrée, synchronisée au retour du réseau
- [ ] Suppression du compte depuis Profil
