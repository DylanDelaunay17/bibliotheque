# Ma Bibliothèque physique

Application web pour téléphone (PWA) qui répertorie Blu-ray, DVD, CD et livres.
100 % gratuite : pas de serveur, pas de compte, pas de base de données payante.
Les données restent dans le téléphone (IndexedDB) et s'exportent en JSON ou en CSV.

## Mettre en ligne gratuitement (GitHub Pages)

La caméra ne fonctionne qu'en **https**. GitHub Pages fournit le https gratuitement.

1. Créer un compte gratuit sur github.com puis un dépôt public, par exemple `bibliotheque`.
2. Envoyer **tout le contenu de ce dossier** à la racine du dépôt (bouton « Add file → Upload files », ou `git push`).
3. Dans le dépôt : *Settings → Pages → Source : Deploy from a branch → main / (root)*.
4. Après une minute, l'appli est disponible à l'adresse `https://<votre-pseudo>.github.io/bibliotheque/`.
5. Sur le téléphone, ouvrir cette adresse :
   - **iPhone (Safari)** : Partager → « Sur l'écran d'accueil ».
   - **Android (Chrome)** : menu ⋮ → « Installer l'application ».

Alternative équivalente : Cloudflare Pages (glisser-déposer du dossier).

**Mise à jour de l'appli** : après une modification, augmenter `VERSION` dans `sw.js` (v1 → v2…).

## Sources de données (gratuites, vérifiées le 11/11/2026)

| Type | Par code-barres | Par titre |
|---|---|---|
| Livres | Open Library (ISBN) | Open Library |
| CD | MusicBrainz + Cover Art Archive | MusicBrainz |
| Blu-ray / DVD | *aucune base gratuite utilisable depuis un navigateur* | Wikipédia, ou TMDB si une clé gratuite est saisie dans « Plus » |

Pour les films, le scan garde le code-barres puis propose la recherche par titre. Le code est enregistré avec l'objet, donc le prochain scan du même boîtier signale tout de suite un doublon.
Non retenus : Google Books (quota anonyme épuisé), UPCitemdb (bloqué depuis un navigateur).
Plan B pour tout le reste : saisie manuelle et photo de la jaquette.

## Scan

- Android/Chrome : détecteur natif du navigateur (`BarcodeDetector`).
- iPhone et autres : ZXing (open source, Apache 2.0), embarqué dans `vendor/`.
- Un code-barres n'est accepté que si sa clé de contrôle EAN est valide et s'il est lu deux fois de suite à l'identique.
- Lampe (Android), bouton photo 📷 pour la faible lumière, saisie du numéro à la main.

## Collection Disney & Pixar

Onglet **Collection → Créer cette collection** : 138 numéros, 4 pour 30 €, 4 par mois.
- « Cocher des numéros » : saisir par exemple `1-10, 14, 20-30` pour cocher les 22 titres possédés d'un coup.
- « Coller les titres » : un titre par ligne, ou `N;Titre`.
- « Nouveaux numéros » : rallonge la liste quand Disney ajoute des titres.
- Le compteur, le budget, les mois restants et la date de fin estimée se recalculent à chaque case cochée.
- Un Blu-ray ajouté dont le titre correspond à un numéro de la collection propose de cocher ce numéro.

## Plan de test sur le terrain (à faire sur le téléphone)

Tester une vingtaine d'objets et noter ce qui échoue :

| # | Objet | Conditions | Scan OK ? | Résultat trouvé ? | Remarque |
|---|---|---|---|---|---|
| 1–5 | Livres récents (ISBN 978…) | lumière normale | | | |
| 6–8 | Livres anciens (ISBN 10 chiffres ou sans code) | | | | |
| 9–12 | CD récents | lumière normale | | | |
| 13–14 | CD anciens / jaquette abîmée | | | | |
| 15–17 | Blu-ray Disney | lumière faible + lampe | | | |
| 18–19 | DVD anciens | jaquette rayée, reflets | | | |
| 20 | QR code | | | | |

À vérifier en plus : doublon signalé au 2ᵉ scan, export puis import d'une sauvegarde, fonctionnement en mode avion (l'appli s'ouvre, la recherche en ligne affiche un message clair).

## Idées pour plus tard

- Version numérique : déjà disponible dans chaque fiche (case « existe en fichier » + emplacement).
  Reste à décider s'il faut importer une liste de fichiers en une fois.

## Fichiers

```
index.html            page unique
css/app.css           styles (thème clair/sombre automatique)
js/app.js             écrans et logique
js/store.js           stockage local IndexedDB
js/lookup.js          recherches Open Library / MusicBrainz / Wikipédia / TMDB
js/scanner.js         scan caméra et photo
vendor/zxing-*.min.js bibliothèque de scan (Apache 2.0)
sw.js                 fonctionnement hors ligne
manifest.webmanifest  installation sur l'écran d'accueil
```
