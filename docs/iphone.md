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

## Installation avec AltStore

1. Sur l'ordinateur, installe **AltServer** depuis le site officiel
   [altstore.io](https://altstore.io) et suis ses instructions (sur Windows, il demande
   aussi iTunes et iCloud téléchargés depuis le site d'Apple).
2. Branche l'iPhone en USB, fais « Se fier à cet ordinateur », puis dans AltServer :
   **Install AltStore** → choisis ton iPhone → saisis ton identifiant Apple.
3. Sur l'iPhone :
   - **Réglages → Général → VPN et gestion de l'appareil** : touche ton adresse Apple,
     puis **Se fier** ;
   - **Réglages → Confidentialité et sécurité → Mode développeur** : active-le
     (l'iPhone redémarre).
4. Sur l'iPhone, ouvre la page des versions du dépôt
   (`github.com/LamaJoker/kinetic-vercel-ready/releases`) dans Safari et télécharge
   le fichier **`kinetic-vX.Y.Z.ipa`** de la dernière version.
5. Ouvre **AltStore → My Apps → +** et choisis le fichier `.ipa` téléchargé
   (dans Fichiers → Téléchargements).
6. Lance Kinetic. Accepte les notifications si tu veux les rappels.

## Mettre à jour

Avant chaque mise à jour, fais une sauvegarde : **Profil → Données → JSON**, et garde
le fichier dans Fichiers ou iCloud Drive. Puis installe le nouveau `.ipa` de la même
façon : il remplace l'ancien et garde tes données.

## SideStore (sans ordinateur après l'installation)

SideStore renouvelle l'application depuis l'iPhone seul, sans ordinateur allumé. Son
installation est plus technique ; suis le guide de [sidestore.io](https://sidestore.io),
puis ajoute le `.ipa` de Kinetic comme à l'étape 5.

## Si ça ne marche pas

L'application iPhone est construite automatiquement mais n'a pas été testée sur un
vrai iPhone. Note ce qui se passe (écran, message d'erreur) et signale-le.
