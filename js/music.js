// Ma musique (iCloud Drive), seulement dans l'appli iPhone : module natif MusicLibrary
// (iphone/ios/App/App/MusicLibraryPlugin.swift). Dans le navigateur, `available` est faux
// et tout le reste de l'appli fonctionne comme avant (écoute sur YouTube).
const cap = window.Capacitor;
const native = cap?.isNativePlatform?.() ? (cap.registerPlugin?.('MusicLibrary') || cap.Plugins?.MusicLibrary) : null;

export const available = !!native;
export const plugin = native;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Sans « (Deluxe) », « [Remastered] », « Disc 1 »… pour rapprocher un album de son CD.
const bare = s => norm(String(s || '').replace(/[([][^)\]]*[)\]]/g, ' ')).replace(/\b(cd|disc|disque) ?\d+$/, '').trim();

let albums = new Map(); // titre d'album simplifié → [{ artist, tracks }]
let folder = null;

function index(tracks) {
  const groups = new Map();
  for (const t of tracks) {
    const artist = t.albumArtist || t.artist || '';
    const key = `${bare(t.album)}\u0000${norm(artist)}`;
    if (!groups.has(key)) groups.set(key, { album: t.album, artist, tracks: [] });
    groups.get(key).tracks.push(t);
  }
  albums = new Map();
  for (const g of groups.values()) {
    g.tracks.sort((a, b) => (a.disc - b.disc) || (a.track - b.track) || a.path.localeCompare(b.path));
    const k = bare(g.album);
    if (!k) continue;
    albums.set(k, [...(albums.get(k) || []), g]);
  }
}

export async function load() {
  if (!native) return;
  const s = await native.status();
  folder = s.folder;
  index((await native.library()).tracks || []);
}

export const status = () => ({ folder, albums: [...albums.values()].reduce((n, l) => n + l.length, 0) });

export async function pickFolder() {
  const r = await native.pickFolder();
  folder = r.folder;
  return r;
}

export async function scan() {
  const r = await native.scan();
  await load();
  return r.count;
}

// L'album de mes fichiers qui correspond à un CD : même titre, et même artiste s'il y en a plusieurs.
export function findAlbum(item) {
  const list = albums.get(bare(item.title)) || [];
  if (list.length <= 1) return list[0] || null;
  const a = norm(item.creator);
  return list.find(g => norm(g.artist) === a) || list.find(g => a && (norm(g.artist).includes(a) || a.includes(norm(g.artist)))) || null;
}

// Liste des titres façon MusicBrainz, pour un CD dont la liste en ligne est introuvable.
export function discsOf(album) {
  const discs = new Map();
  for (const t of album.tracks) {
    if (!discs.has(t.disc)) discs.set(t.disc, { disc: t.disc, format: 'CD', tracks: [] });
    discs.get(t.disc).tracks.push({ n: String(t.track || discs.get(t.disc).tracks.length + 1), title: t.title, length: t.duration || null });
  }
  return [...discs.values()];
}

// Position dans l'album de mes fichiers du titre k de la fiche (même titre, sinon même rang).
export function trackIndex(album, title, k) {
  const i = album.tracks.findIndex(t => norm(t.title) === norm(title));
  return i >= 0 ? i : Math.min(k, album.tracks.length - 1);
}

export async function artwork(album) {
  const r = await native.artwork({ path: album.tracks[0].path, size: 420 });
  return r.dataUrl || '';
}
