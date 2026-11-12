// Source SideStore (format AltStore) : SideStore y voit la dernière version de l'appli
// et propose la mise à jour. Écrit par la compilation GitHub (.github/workflows/iphone.yml).
const { VERSION, BUILD, BASE, SIZE } = process.env;
const site = 'https://dylandelaunay17.github.io/bibliotheque';

console.log(JSON.stringify({
  name: 'Biblio',
  identifier: 'io.github.dylandelaunay17.bibliotheque.source',
  apps: [{
    name: 'Biblio',
    bundleIdentifier: 'io.github.dylandelaunay17.bibliotheque',
    developerName: 'Dylan Delaunay',
    subtitle: 'Ma bibliothèque physique, et ma musique',
    localizedDescription: "Blu-ray, DVD, CD et livres, avec l'écoute des CD depuis iCloud Drive.",
    iconURL: `${site}/icons/icon-512.png`,
    tintColor: '#FFC814',
    versions: [{
      version: VERSION,
      buildVersion: BUILD,
      date: new Date().toISOString(),
      size: Number(SIZE),
      downloadURL: `${BASE}/Biblio.ipa`,
      minOSVersion: '15.0',
    }],
    appPermissions: { entitlements: [], privacy: {} },
  }],
  news: [],
}, null, 2));
