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
