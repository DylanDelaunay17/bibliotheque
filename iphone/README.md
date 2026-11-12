# Appli iPhone (Biblio)

L'appli affiche le site en ligne (https://dylandelaunay17.github.io/bibliotheque/), donc les
mises à jour habituelles arrivent sans la réinstaller. Elle ajoute ce qu'un site ne peut pas faire :

- **Ma musique (iCloud Drive)** : onglet Plus → « Choisir le dossier ». L'accès au dossier est gardé.
  Les albums trouvés (étiquettes des fichiers, sinon dossiers Artiste › Album) sont reliés aux CD
  de même titre ; « Écouter (mes fichiers) » dans la fiche les joue en qualité d'origine
  (MP3, AAC, ALAC, FLAC, WAV).
- Lecture écran verrouillé, commandes de l'écran de verrouillage, AirPlay, écouteurs.
- Pochettes : un CD sans pochette prend celle des fichiers (intégrée, ou cover.jpg / folder.jpg).
- Un fichier resté dans iCloud est téléchargé au moment de le jouer (le titre suivant d'avance).

Code natif : `ios/App/App/MusicLibraryPlugin.swift` ; côté site : `js/music.js`.

## Installation avec SideStore (compte Apple gratuit)

Sans compte développeur payant, une appli installée hors App Store doit être re-signée tous les
7 jours. SideStore s'en charge tout seul, en arrière-plan.

1. **Installer SideStore** en suivant le guide officiel : https://docs.sidestore.io
   (installation depuis le Mac, puis l'appli de VPN local qu'il indique sur l'iPhone).
2. Sur l'iPhone : Réglages → Confidentialité et sécurité → **Mode développeur** → activer (redémarrage).
3. Dans SideStore → Sources → **+** → coller :
   `https://github.com/DylanDelaunay17/bibliotheque/releases/download/iphone/sidestore.json`
4. Installer **Biblio** depuis cette source. SideStore la signe avec votre identifiant Apple.
5. Ouvrir Biblio, se connecter au compte de la bibliothèque (onglet Plus) : tout arrive.

Mises à jour : SideStore propose la nouvelle version quand le code natif change. Le reste
(écrans, fonctions du site) se met à jour tout seul.
Limite du compte gratuit : 3 applis actives en même temps, SideStore compris.

## Compilation

Chaque modification de `iphone/` envoyée sur GitHub relance `.github/workflows/iphone.yml` :
un Mac de GitHub compile un .ipa **non signé** et le publie, avec `sidestore.json`,
dans la version « iphone » du dépôt. Rien n'est à installer sur le Mac (ni Xcode ni CocoaPods).

Pour compiler soi-même (Xcode requis) :

```
cd iphone
npm install
node node_modules/@capacitor/cli/bin/capacitor sync ios
open ios/App/App.xcodeproj
```
