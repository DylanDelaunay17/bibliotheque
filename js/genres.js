import { mbSlot } from './lookup.js';

// Genres des CD (étiquettes MusicBrainz) et des livres (sujets Open Library).
// Ces bases utilisent des centaines d'étiquettes, souvent en anglais : on les regroupe en
// grandes catégories françaises. Pour les films, ce sont les genres TMDB (voir lookup.js).

// [catégorie, motif] — l'ordre compte : le premier motif qui correspond l'emporte.
const MUSIC_RULES = [
  ['Musique de film', /soundtrack|film score|\bscore\b|show tunes|musical/],
  ['Chanson française', /chanson|variété|french pop|yé-yé/],
  ['Metal', /metal/],
  ['Punk', /punk/],
  ['Hip-hop / Rap', /hip ?hop|\brap\b|trap|grime/],
  ['R&B / Soul', /r&b|rnb|soul|motown/],
  ['Funk', /funk/],
  ['Disco', /disco/],
  ['Jazz', /jazz|bop|swing|big band/],
  ['Blues', /blues/],
  ['Classique', /classical|baroque|opera|symphon|orchestral|chamber|concerto|romantic era/],
  ['Électro', /electro|house|techno|trance|dance|edm|ambient|synth|drum and bass|dubstep|idm/],
  ['Reggae', /reggae|\bska\b|\bdub\b|dancehall/],
  ['Country', /country|bluegrass|americana/],
  ['Folk', /folk|celtic|acoustic/],
  ['Rock', /rock|grunge|indie|shoegaze/],
  ['Pop', /pop/],
  ['Musiques du monde', /world|latin|salsa|bossa|african|flamenco|fado/],
  ['Enfants', /children|kids|enfant|comptine/],
];

const BOOK_RULES = [
  ['Manga', /manga/],
  ['Bande dessinée', /comic|bande[s]? dessinée|graphic novel|\bbd\b/],
  ['Jeunesse', /juvenile|children|enfant|jeunesse|young adult|picture book/],
  ['Science-fiction', /science[ -]fiction|dystopi/],
  ['Fantasy / Contes', /fantasy|fantastique|fairy tale|conte|supernatural|paranormal/],
  ['Policier / Thriller', /detective|mystery|crime|policier|thriller|suspense|polar|espionage/],
  ['Horreur', /horror|horreur|ghost|gothic/],
  // « Romance literature », « Romance Frances » = littérature romane (roman en espagnol), pas sentimentale.
  ['Romance', /^romance$|^fiction, romance|love stor|romans d'amour/],
  ['Biographie', /biograph|memoir|mémoires/],
  ['Poésie', /poetry|poésie|poème|poems/],
  ['Théâtre', /théâtre|theater|theatre|\bplays\b/],
  ['Philosophie', /philosoph/],
  ['Cuisine', /cook|cuisine|recipe|recette|gastronom/],
  ['Voyage', /travel|voyage|guidebook/],
  ['Histoire', /histor(?!y and criticism)/],
  ['Développement personnel', /self-help|développement personnel|personal development/],
  ['Sciences', /science|physics|mathemat|biology|astronom/],
  ['Arts', /^arts?\b|art history|beaux-arts|painting|peinture|photograph/],
  ['Roman', /fiction|roman|novel|littérature|literature/],
];

export const MUSIC_GENRES = MUSIC_RULES.map(r => r[0]).sort((a, b) => a.localeCompare(b, 'fr'));
export const BOOK_GENRES = BOOK_RULES.map(r => r[0]).sort((a, b) => a.localeCompare(b, 'fr'));

// Catégories trop générales pour l'emporter sur une catégorie précise :
// « La Guerre des mondes » est d'abord de la science-fiction, même avec dix sujets « fiction ».
const GENERIC = new Set(['Roman']);

// Additionne les étiquettes par catégorie et garde les catégories dominantes (3 au plus),
// les catégories générales venant après les précises.
// Les catégories de libraires (« Fiction, science fiction, general ») sont plus fiables
// que les sujets libres (adaptations en BD, éditions scolaires…) : elles comptent triple.
const SHELF = /^(juvenile )?fiction, /;

function categorize(labels, rules, maxSpecific = 3) {
  const score = new Map();
  for (const { name, count = 1 } of labels) {
    const n = String(name || '').toLowerCase();
    const hit = rules.find(([, re]) => re.test(n));
    if (hit) score.set(hit[0], (score.get(hit[0]) || 0) + Math.max(1, count) * (SHELF.test(n) ? 3 : 1));
  }
  const sorted = [...score].sort((a, b) => b[1] - a[1]);
  const specific = sorted.filter(([k]) => !GENERIC.has(k));
  const top = specific[0]?.[1] || 0;
  const kept = specific.filter(([, v]) => v >= top / 2).slice(0, maxSpecific).map(([k]) => k);
  for (const [k] of sorted) if (GENERIC.has(k)) kept.push(k);
  return kept.slice(0, 3);
}

export const musicGenres = tags => categorize(tags || [], MUSIC_RULES);
export const bookGenres = subjects => categorize((subjects || []).map(s => ({ name: typeof s === 'string' ? s : s.name })), BOOK_RULES, 2);

const UA = { Accept: 'application/json' };
const sameTitle = (a, b) => {
  const n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return n(a) === n(b) || n(a).startsWith(n(b)) || n(b).startsWith(n(a));
};
const q = s => String(s || '').replace(/["\\]/g, ' ').trim();

// Genres d'un CD déjà enregistré : album (titre + artiste), sinon l'artiste lui-même.
export async function fetchMusicGenres(item) {
  const artist = q(item.creator);
  const query = `releasegroup:"${q(item.title)}"${artist ? ` AND artist:"${artist}"` : ''}`;
  await mbSlot();
  const r = await fetch(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=3`, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const groups = (await r.json())['release-groups'] || [];
  const g = groups.find(x => sameTitle(x.title, item.title) && x.tags?.length) || null;
  let genres = musicGenres(g?.tags);
  if (!genres.length && artist) {
    await mbSlot();
    const a = await fetch(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${artist}"`)}&fmt=json&limit=1`, { headers: UA });
    if (a.ok) genres = musicGenres((await a.json()).artists?.[0]?.tags);
  }
  return genres;
}

// Genres d'un livre déjà enregistré : par ISBN, sinon par titre (+ auteur).
export async function fetchBookGenres(item) {
  if (/^97[89]\d{10}$/.test(item.barcode || '')) {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${item.barcode}&format=json&jscmd=data`, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = (await r.json())[`ISBN:${item.barcode}`];
    const g = bookGenres(b?.subjects);
    if (g.length) return g;
  }
  const author = (item.creator || '').split(',')[0].trim();
  const lastName = author.split(/\s+/).pop()?.toLowerCase() || '';
  const byAuthor = d => lastName && (d.author_name || []).some(n => n.toLowerCase().includes(lastName));
  // 1) titre exact ; 2) recherche libre titre + auteur (titre français d'un livre classé sous
  //    son titre original, ex. « Da Vinci Code ») en exigeant alors le même auteur.
  for (const params of [
    new URLSearchParams({ title: item.title, ...(author ? { author } : {}), fields: 'title,author_name,subject', limit: '3' }),
    new URLSearchParams({ q: `${item.title} ${author}`.trim(), fields: 'title,author_name,subject', limit: '5' }),
  ]) {
    const r = await fetch(`https://openlibrary.org/search.json?${params}`, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const docs = (await r.json()).docs || [];
    const doc = docs.find(d => sameTitle(d.title, item.title) && d.subject) || docs.find(d => byAuthor(d) && d.subject);
    const g = bookGenres(doc?.subject);
    if (g.length) return g;
  }
  return [];
}
