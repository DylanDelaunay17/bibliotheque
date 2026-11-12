// Contenu des fiches : synopsis et bande-annonce des films (TMDB, via le relais),
// liste des titres des CD (MusicBrainz), résumé des livres (Open Library).
// Chargé à la première ouverture d'une fiche puis gardé avec l'objet (consultable hors ligne).
import { relayUrl, getJSON } from './lookup.js';

const MB = 'https://musicbrainz.org/ws/2';

// La meilleure vidéo : bande-annonce officielle en français, sinon en anglais ;
// jamais un spot TV, une critique ou un extrait promotionnel.
function pickTrailer(videos) {
  const score = v => (v.type === 'Trailer' ? 3 : 0) + (v.lang === 'fr' ? 4 : 0) + (v.official ? 1 : 0)
    + (/trailer|bande[- ]annonce/i.test(v.name) ? 2 : 0) - (/spot|review|promo|clip|featurette|sneak|tickets/i.test(v.name) ? 6 : 0);
  const best = [...(videos || [])].sort((a, b) => score(b) - score(a))[0];
  return best && score(best) > 0 ? { key: best.key, name: best.name, lang: best.lang } : null;
}

export async function filmDetails(tmdbId) {
  const m = await getJSON(`${relayUrl()}/tmdb/movie?id=${tmdbId}`);
  if (!m) return null;
  return {
    overview: m.overview, tagline: m.tagline, runtime: m.runtime,
    directors: m.directors || [], cast: m.cast || [], trailer: pickTrailer(m.videos),
  };
}

// Disques et titres d'une édition MusicBrainz.
async function releaseTracks(id) {
  const r = await getJSON(`${MB}/release/${id}?inc=recordings&fmt=json`);
  return (r?.media || []).map(m => ({
    disc: m.position, format: m.format || '',
    tracks: (m.tracks || []).map(t => ({ n: t.number || String(t.position), title: t.title, length: t.length || t.recording?.length || null })),
  })).filter(d => d.tracks.length);
}

// Retrouve l'édition du CD : identifiant connu, code-barres, groupe d'éditions, ou titre + artiste.
export async function cdTracks(item) {
  let id = item.mbReleaseId;
  if (!id && item.barcode) {
    const r = await getJSON(`${MB}/release/?query=barcode:${item.barcode}&fmt=json&limit=3`);
    id = (r?.releases || []).find(x => x.score >= 90)?.id;
  }
  if (!id && item.mbGroupId) {
    const r = await getJSON(`${MB}/release?release-group=${item.mbGroupId}&fmt=json&limit=10`);
    const rel = r?.releases || [];
    id = (rel.find(x => x.status === 'Official' && x.country === 'FR') || rel.find(x => x.status === 'Official') || rel[0])?.id;
  }
  if (!id && item.title) {
    const q = `release:"${item.title.replace(/"/g, ' ')}"${item.creator ? ` AND artist:"${item.creator.replace(/"/g, ' ')}"` : ''}`;
    const r = await getJSON(`${MB}/release/?query=${encodeURIComponent(q)}&fmt=json&limit=3`);
    id = (r?.releases || []).find(x => x.score >= 90)?.id;
  }
  if (!id) return { id: null, discs: [] };
  return { id, discs: await releaseTracks(id) };
}

// Résumé Open Library (souvent absent pour les éditions françaises).
export async function bookSummary(item) {
  let workKey = null;
  if (/^97[89]\d{10}$/.test(item.barcode || '')) {
    const e = await getJSON(`https://openlibrary.org/isbn/${item.barcode}.json`);
    workKey = e?.works?.[0]?.key || null;
    if (e?.description) return cleanText(typeof e.description === 'string' ? e.description : e.description.value);
  }
  if (!workKey) {
    const params = new URLSearchParams({ title: item.title, fields: 'key', limit: '1' });
    if (item.creator) params.set('author', item.creator.split(',')[0]);
    const s = await getJSON(`https://openlibrary.org/search.json?${params}`);
    workKey = s?.docs?.[0]?.key || null;
  }
  if (!workKey) return '';
  const w = await getJSON(`https://openlibrary.org${workKey}.json`);
  const d = w?.description;
  return cleanText(typeof d === 'string' ? d : d?.value || '');
}

// Les descriptions Open Library sont en Markdown : on retire la mise en forme,
// les liens et les notes de bas de texte (« ---------- Voir aussi… »).
function cleanText(t) {
  return t.replace(/\r/g, '')
    .split(/\n-{3,}/)[0]
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\d+\]:.*$/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .trim();
}

export const duration = ms => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const runtimeLabel = min => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`);

// ---------- Écoute sur YouTube ----------
// Comme pour les bandes-annonces, l'identifiant vient d'abord d'une base gratuite et sans clé :
// lien YouTube Music d'une édition MusicBrainz, sinon propriété « YouTube playlist ID » de Wikidata.
// Album entier : la playlist « Album – … » de YouTube Music (OLAK5uy_…), dans l'ordre du disque.
// L'API YouTube ne renvoie jamais ces playlists : sans elles, l'album se joue titre par titre,
// chacun cherché via le relais (secret YOUTUBE_KEY, 100 recherches par jour), de préférence
// la vidéo de la chaîne « Artiste - Topic » (version studio).

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ytSearch = (q, type) => getJSON(`${relayUrl()}/yt/search?type=${type}&q=${encodeURIComponent(q)}`).catch(() => null);
const olak = ids => ids.find(id => id.startsWith('OLAK5uy_')) || ids[0] || '';

async function groupId(item) {
  if (item.mbGroupId) return item.mbGroupId;
  if (!item.mbReleaseId) return '';
  const r = await getJSON(`${MB}/release/${item.mbReleaseId}?inc=release-groups&fmt=json`);
  return r?.['release-group']?.id || '';
}

export async function ytAlbum(item) {
  const group = await groupId(item);
  if (group) {
    const r = await getJSON(`${MB}/release?release-group=${group}&inc=url-rels&fmt=json&limit=100`);
    const links = (r?.releases || []).flatMap(x => x.relations || []).map(x => x.url?.resource || '');
    const found = olak(links.map(u => (u.match(/youtube\.com\/playlist\?list=([\w-]+)/) || [])[1]).filter(Boolean));
    if (found) return found;
    const q = `SELECT ?pl WHERE { ?a wdt:P436 "${group}" ; wdt:P4300 ?pl . }`;
    const w = await getJSON(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`).catch(() => null);
    const wd = olak((w?.results?.bindings || []).map(b => b.pl.value));
    if (wd) return wd;
  }
  return '';
}

export async function ytTrack(item, trackTitle) {
  const title = norm(trackTitle), artist = norm(item.creator);
  const list = await ytSearch(`${item.creator || ''} ${trackTitle}`.trim(), 'video');
  const unwanted = /\b(live|cover|karaoke|remix|instrumental|reaction|lyrics?)\b/;
  const score = v => {
    const t = norm(v.title), c = norm(v.channel);
    return (t.includes(title) ? 3 : 0) + (/ topic$/.test(c) ? 4 : 0) + (artist && `${t} ${c}`.includes(artist) ? 2 : 0)
      - (unwanted.test(t) && !unwanted.test(title) ? 4 : 0);
  };
  const best = [...(list || [])].sort((a, b) => score(b) - score(a))[0];
  return best && score(best) >= 3 ? best.id : '';
}

export const trackKey = norm;

// Pochette d'un CD depuis YouTube Music : la miniature d'un titre de la chaîne « Artiste - Topic »
// montre la pochette, carrée au centre. Premier titre de la playlist d'album si on la connaît
// (presque gratuit), sinon recherche (100 unités) limitée aux titres de cet album.
// Renvoie l'identifiant de la vidéo, '' si rien de sûr, null si l'on ne peut pas vérifier l'album
// (relais sans description et liste des titres inconnue) ; lève une erreur si YouTube ne répond pas.
export async function ytCoverVideo(item) {
  const album = item.yt?.album;
  if (album) {
    const first = await getJSON(`${relayUrl()}/yt/playlist?id=${album}`).catch(() => null);
    if (first?.[0]?.id) return first[0].id;
  }
  const names = new Set((item.tracks || []).flatMap(d => d.tracks).map(t => norm(t.title)));
  const bare = s => norm(String(s).replace(/[([][^)\]]*[)\]]/g, ' ')); // sans « (Deluxe) », « [Remastered] »…
  const title = bare(item.title), artist = norm(item.creator);
  // « … Titre · Artiste  Album ℗ 2013 … » : l'album est juste avant le ℗.
  const sameAlbum = d => { const m = d.match(/·([^℗]+)℗/); const a = m ? bare(m[1]) : ''; return a === title || a.endsWith(` ${title}`); };
  // v=2 : réponses avec description (le relais garde 30 jours en cache celles d'avant).
  const list = await getJSON(`${relayUrl()}/yt/search?type=video&v=2&q=${encodeURIComponent(`"Provided to YouTube" ${item.creator || ''} ${item.title}`)}`);
  if (!names.size && list?.length && list[0].description === undefined) return null;
  const hit = (list || []).find(v => {
    const c = norm(v.channel);
    if (!/ topic$/.test(c) || (artist && !c.startsWith(artist))) return false;
    // La description nomme l'album (relais à jour) ; sinon le titre doit figurer sur le disque.
    if (v.description !== undefined) return sameAlbum(v.description);
    return names.has(norm(v.title));
  });
  return hit?.id || '';
}
