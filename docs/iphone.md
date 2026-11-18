# Installer Kinetic sur iPhone, sans payer

Kinetic n'est pas sur l'App Store. On l'installe soi-même avec son **compte Apple
gratuit** et un outil d'installation gratuit, **AltStore** (le plus simple) ou
**SideStore**.

## Ce qu'il faut

- Un iPhone sous iOS 15 ou plus récent.
- Un ordinateur **Windows ou Mac** pour la première installation.
- Ton identifiant Apple (le compte gratuit suffit).

## Les limites du compte gratuit

- L'application doit être **renouvelée tous les 7 jours**. AltStore le fait tout seul
  si l'ordinateur (avec AltServer ouvert) est allumé sur le même Wi-Fi que l'iPhone.
  Si le délai passe, Kinetic ne s'ouvre plus jusqu'au renouvellement ; **tes données
  restent sur le téléphone**.
- Trois applications installées de cette façon au maximum.
- Pas de widget ni d'Apple Santé (ils demandent un compte développeur payant).
  Les rappels (routine, séance, bilan, sauvegarde) fonctionnent.

> **AltStore PAL ne convient pas.** La version européenne d'AltStore (« PAL »),
> installable depuis l'iPhone, n'accepte que des apps vérifiées par Apple avec un
> compte développeur payant. Il faut **AltStore « Classic »**, installé par AltServer
> depuis un ordinateur, comme ci-dessous.

## Installation avec AltStore

1. Sur l'ordinateur, installe **AltServer** depuis le site officiel
   [altstore.io](https://altstore.io) et suis ses instructions (sur Windows, il demande
   aussi iTunes et iCloud téléchargés depuis le site d'Apple, pas depuis le Microsoft
   Store).
2. Branche l'iPhone en USB, déverrouille-le et fais « Se fier à cet ordinateur ».
3. AltServer n'a **pas de fenêtre** : c'est une petite icône en forme de losange,
   près de l'horloge sur Windows (flèche **^** pour les icônes cachées) ou dans la
   barre de menus en haut à droite sur Mac. Clique dessus → **Install AltStore** →
   choisis ton iPhone. C'est **seulement à ce moment** qu'il demande ton identifiant
   Apple et ton mot de passe.
   - L'iPhone n'apparaît pas ? Sur Windows, ouvre iTunes avec l'iPhone branché,
     touche l'icône du téléphone et coche « Synchroniser avec cet iPhone en Wi-Fi ».
4. Sur l'iPhone :
   - **Réglages → Général → VPN et gestion de l'appareil** : touche ton adresse Apple,
     puis **Se fier** ;
   - **Réglages → Confidentialité et sécurité → Mode développeur** : active-le
     (l'iPhone redémarre).
5. Sur l'iPhone, ouvre la page des versions du dépôt
   (`github.com/LamaJoker/kinetic-vercel-ready/releases`) dans Safari et télécharge
   le fichier **`kinetic-vX.Y.Z.ipa`** de la dernière version.
6. Ouvre **AltStore → My Apps → +** et choisis le fichier `.ipa` téléchargé
   (dans Fichiers → Téléchargements).
7. Lance Kinetic. Accepte les notifications si tu veux les rappels.

## Mettre à jour

Avant chaque mise à jour, fais une sauvegarde : **Profil → Données → JSON**, et garde
le fichier dans Fichiers ou iCloud Drive. Puis installe le nouveau `.ipa` de la même
façon : il remplace l'ancien et garde tes données.

Pour renouveler la signature avant les 7 jours : ouvre AltStore → **My Apps** →
**Refresh All**, avec l'ordinateur allumé (AltServer ouvert) sur le même Wi-Fi.

## SideStore (sans ordinateur après l'installation)

SideStore renouvelle l'application depuis l'iPhone seul, sans ordinateur allumé. Son
installation est plus technique ; suis le guide de [sidestore.io](https://sidestore.io),
puis ajoute le `.ipa` de Kinetic comme à l'étape 5.

## Si ça ne marche pas

Chaque version est construite automatiquement et parcourue dans le simulateur
d'iPhone avant publication. Si quelque chose ne va pas sur ton téléphone, note ce qui
se passe (écran, message d'erreur) et signale-le.
