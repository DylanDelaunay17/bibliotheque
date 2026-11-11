// Recherches dans des bases en ligne gratuites (sans compte ni carte bancaire).
//  - Livres : Open Library (ISBN + titre)
//  - CD / musique : MusicBrainz + Cover Art Archive (code-barres + titre)
//  - Films : codes-barres via UPCitemdb, titres français et affiches via TMDB.
//    Ces deux services refusent les appels directs depuis un navigateur : ils passent par
//    notre relais gratuit Cloudflare (dossier relais/). Sans relais : Wikipédia, titre uniquement.
import { meta } from './store.js';

// Adresse du relais déployé (modifiable dans « Plus »).
export const RELAY_DEFAULT = 'https://bibliotheque-relais.bibliotheque-relais.workers.dev';
const relay = () => (meta('relayUrl') || RELAY_DEFAULT).replace(/\/+$/, '');
const FILM_TYPES = ['uhd', 'bluray', 'dvd'];

const TIMEOUT = 9000;

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;
const year = s => (String(s || '').match(/\b(1[89]\d\d|20\d\d)\b/) || [])[1] || '';

// ---------- Codes-barres ----------

export function cleanCode(raw) {
  return String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

export function isIsbn(code) {
  return (/^97[89]\d{10}$/.test(code)) || (/^\d{9}[\dX]$/.test(code) && isbn10Valid(code));
}

function isbn10Valid(c) {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (c[i] === 'X' ? 10 : +c[i]) * (10 - i);
  return sum % 11 === 0;
}

export function isbn10to13(c) {
  const base = '978' + c.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +base[i] * (i % 2 ? 3 : 1);
  return base + ((10 - (sum % 10)) % 10);
}

// Clé de contrôle EAN-8 / UPC-A / EAN-13 : écarte les lectures erronées du scanner.
export function eanValid(code) {
  if (!/^(\d{8}|\d{12}|\d{13})$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

export async function lookupBarcode(code, type) {
  if (code.length === 10 && isIsbn(code)) code = isbn10to13(code);
  if (isIsbn(code) || type === 'book') {
    const r = await bookByIsbn(code);
    if (r.length || type === 'book') return r;
  }
  // Les CD (et quelques DVD/Blu-ray musicaux) sont dans MusicBrainz, les films dans UPCitemdb.
  const film = FILM_TYPES.includes(type);
  const sources = film ? [filmByBarcode, musicByBarcode] : [musicByBarcode, filmByBarcode];
  let lastError;
  for (const src of sources) {
    try {
      const r = await src(code, type);
      if (r.length) return r;
    } catch (e) { lastError = e; }
  }
  if (lastError) throw lastError;
  return [];
}

// Format déduit du libellé du produit : « 4K Ultra HD + Blu-ray » → 4K, etc.
function filmFormat(text) {
  if (/\b(4k|uhd|ultra[\s-]?hd)\b/i.test(text)) return 'uhd';
  if (/blu[\s-]?ray/i.test(text)) return 'bluray';
  if (/\bdvd\b/i.test(text)) return 'dvd';
  return '';
}

// « Ratatouille - 2 Disc Collector's Edition - Walt Disney & Pixar Region 2 Dvd » → « Ratatouille »
export function cleanProductTitle(t) {
  return String(t || '')
    .replace(/[([{].*?[)\]}]/g, ' ')
    .split(/\s[-–|:]\s/)[0]
    .replace(/\b(4k|uhd|ultra[\s-]?hd|blu[\s-]?ray( disc)?|bluray|dvd|steelbook|import|region \d|r\d|walt disney|disney|pixar|édition|edition|collector'?s?|\d+ discs?)\b/gi, ' ')
    .replace(/[+/,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function filmByBarcode(code, type) {
  if (!relay()) return [];
  const data = await getJSON(`${relay()}/upc?code=${code}`);
  const p = data?.items?.[0];
  if (!p) return [];
  // Le titre du produit est plus fiable que sa description (qui cite parfois d'autres éditions).
  const format = filmFormat(p.title) || filmFormat(p.description) || (FILM_TYPES.includes(type) ? type : 'bluray');
  const clean = cleanProductTitle(p.title);
  let films = [];
  try { films = clean ? await filmsByTitle(clean, format) : []; } catch {}
  if (films.length) {
    return films.slice(0, 4).map(f => ({ ...f, barcode: code, source: `${f.source} (code : UPCitemdb)` }));
  }
  return [{
    type: format,
    title: clean || p.title,
    creator: p.brand || '',
    year: '',
    cover: (p.images || [])[0] || '',
    barcode: code,
    source: 'UPCitemdb',
  }];
}

async function bookByIsbn(isbn) {
  const data = await getJSON(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  const b = data?.[`ISBN:${isbn}`];
  if (b) {
    return [{
      type: 'book',
      title: b.title + (b.subtitle ? ` – ${b.subtitle}` : ''),
      creator: (b.authors || []).map(a => a.name).join(', '),
      year: year(b.publish_date),
      publisher: (b.publishers || []).map(p => p.name).join(', '),
      cover: b.cover?.medium || b.cover?.large || '',
      barcode: isbn,
      source: 'Open Library',
    }];
  }
  const s = await getJSON(`https://openlibrary.org/search.json?isbn=${isbn}&limit=3&fields=title,author_name,first_publish_year,cover_i`);
  return (s?.docs || []).map(d => bookDoc(d, isbn));
}

function bookDoc(d, isbn = '') {
  return {
    type: 'book',
    title: d.title,
    creator: (d.author_name || []).join(', '),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
    barcode: isbn || (d.isbn || []).find(i => /^97[89]/.test(i)) || '',
    source: 'Open Library',
  };
}

const credit = ac => (ac || []).map(a => a.name + (a.joinphrase || '')).join('').trim();

function mediaType(media) {
  const f = (media || []).map(m => m.format || '').join(' ');
  if (/blu-ray/i.test(f)) return 'bluray';
  if (/dvd/i.test(f)) return 'dvd';
  return 'cd';
}

async function musicByBarcode(code) {
  const data = await getJSON(`https://musicbrainz.org/ws/2/release/?query=barcode:${code}&fmt=json&limit=5`);
  return (data?.releases || []).filter(r => r.score >= 90).map(r => ({
    type: mediaType(r.media),
    title: r.title,
    creator: credit(r['artist-credit']),
    year: year(r.date),
    cover: `https://coverartarchive.org/release/${r.id}/front-250`,
    barcode: code,
    source: 'MusicBrainz',
  }));
}

// ---------- Recherche par titre ----------

export async function searchTitle(q, type) {
  q = q.trim();
  if (!q) return [];
  if (type === 'book') return booksByTitle(q);
  if (type === 'cd') return musicByTitle(q);
  return filmsByTitle(q, type);
}

async function booksByTitle(q) {
  const data = await getJSON(`https://openlibrary.org/search.json?q=${enc(q)}&limit=12&fields=title,author_name,first_publish_year,cover_i,isbn`);
  return (data?.docs || []).map(d => bookDoc(d));
}

async function musicByTitle(q) {
  const data = await getJSON(`https://musicbrainz.org/ws/2/release-group/?query=${enc(q)}&fmt=json&limit=12`);
  return (data?.['release-groups'] || []).map(g => ({
    type: 'cd',
    title: g.title,
    creator: credit(g['artist-credit']),
    year: year(g['first-release-date']),
    cover: `https://coverartarchive.org/release-group/${g.id}/front-250`,
    barcode: '',
    source: 'MusicBrainz',
  }));
}

function tmdbResults(data, type) {
  return (data?.results || []).slice(0, 12).map(m => ({
    type,
    title: m.title,
    creator: m.original_title !== m.title ? m.original_title : '',
    year: year(m.release_date),
    cover: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : '',
    barcode: '',
    source: 'TMDB',
  }));
}

async function filmsByTitle(q, type) {
  // 1) TMDB via le relais, 2) TMDB avec une clé personnelle, 3) Wikipédia.
  const key = meta('tmdbKey');
  const urls = [];
  if (relay()) urls.push(`${relay()}/tmdb/search?query=${enc(q)}`);
  if (key) urls.push(`https://api.themoviedb.org/3/search/movie?query=${enc(q)}&language=fr-FR&region=FR&include_adult=false&api_key=${enc(key)}`);
  for (const url of urls) {
    try {
      const data = await getJSON(url);
      if (data?.results?.length) return tmdbResults(data, type);
    } catch { /* relais ou clé indisponible : source suivante */ }
  }
  const search = `${q} hastemplate:"Infobox Cinéma (film)"`;
  const data = await getJSON(`https://fr.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${enc(search)}&gsrlimit=12&prop=pageimages|description&piprop=thumbnail&pithumbsize=342&format=json&formatversion=2&origin=*`);
  return (data?.query?.pages || [])
    .sort((a, b) => a.index - b.index)
    .map(p => ({
      type,
      title: p.title.replace(/\s*\((film|film d'animation|téléfilm)[^)]*\)$/i, ''),
      creator: (String(p.description || '').match(/(?:réalisé par|\bde) ([^,]+?)(?:,| et sorti| sorti|$)/) || [])[1] || '',
      year: year(p.description),
      cover: p.thumbnail?.source || '',
      barcode: '',
      source: 'Wikipédia',
    }));
}
