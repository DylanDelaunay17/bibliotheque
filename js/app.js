import * as store from './store.js';
import { lookupBarcode, searchTitle, cleanCode, isIsbn, isbn10to13, RELAY_DEFAULT, GENRES, KEYWORD_GENRES, filmKeywords } from './lookup.js';
import { startScan, decodeImage } from './scanner.js';
import { DISNEY_LIST, DISNEY_SOURCE } from './disney-list.js';
import * as sync from './sync.js';
import * as account from './account.js';
import { readText, parseBabelio } from './babelio.js';
import { filmDetails, cdTracks, bookSummary, duration, runtimeLabel, ytAlbum, ytTrack, trackKey } from './details.js';
import { MUSIC_GENRES, BOOK_GENRES, fetchMusicGenres, fetchBookGenres } from './genres.js';

// Films : identifiants de genre TMDB (nombres) ; CD et livres : catégories en toutes lettres.
const genreLabel = g => (typeof g === 'number' ? GENRES[g] : g);
const genreKey = g => encodeURIComponent(JSON.stringify(g));
const parseGenre = k => JSON.parse(decodeURIComponent(k));
const FILM_GENRES = Object.keys(GENRES).map(Number).sort((a, b) => GENRES[a].localeCompare(GENRES[b], 'fr'));
const genresFor = type => (isFilm(type) ? FILM_GENRES : type === 'cd' ? MUSIC_GENRES : type === 'book' ? BOOK_GENRES : []);

// ---------- Utilitaires ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = n => (Math.round(n * 100) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const today = () => new Date().toISOString().slice(0, 10);
const frDate = d => d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `le ${frDate(ts)}`;
}

const TYPES = { uhd: '4K UHD', bluray: 'Blu-ray', dvd: 'DVD', cd: 'CD', book: 'Livre' };
const TYPE_ICON = { uhd: '🎞️', bluray: '💿', dvd: '📀', cd: '🎵', book: '📖' };
const isFilm = t => t === 'uhd' || t === 'bluray' || t === 'dvd';

// Titre normalisé pour la détection de doublons : sans accents, ponctuation ni article initial.
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^(le|la|les|l|un|une|des|the|a|an) /, '').trim();
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

const FMT = { uhd: '4K', bluray: 'Blu-ray', dvd: 'DVD', cd: 'CD', book: 'Livre' };
const icon = (name, label = '') => `<svg${label ? ` aria-label="${label}"` : ' aria-hidden="true"'}><use href="#i-${name}"/></svg>`;

// Affiche : le titre en grand sert de jaquette tant que l'image manque ou ne charge pas.
function cover(item, extra = '') {
  const img = item.cover
    ? `<img src="${esc(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<div class="tile-cover"><div class="ph">${esc(item.title || TYPES[item.type] || '')}</div>${img}${extra}</div>`;
}
const coverHtml = item => cover(item);

// Réduit une photo de jaquette pour qu'elle tienne dans le stockage du téléphone.
function photoToDataUrl(file, max = 420) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * r);
      c.height = Math.round(img.height * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- État ----------

const state = {
  tab: 'library',
  filter: { q: '', type: '', loaned: false, ...loadFilter() },
  showFilters: false,
  wishFilter: { q: '', type: '' },
  addType: 'bluray',
  addStatus: 'owned',
  pendingBarcode: '',
  results: null,
  resultsMsg: '',
  collectionId: null,
  colFilter: 'all',
  colQ: '',
  view: loadPref('libView', 'grid'),
};

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// Filtres de la bibliothèque mémorisés sur ce téléphone (sauf la recherche texte).
const FILTER_KEYS = ['type', 'loaned', 'sort', 'col', 'decade', 'creator', 'digital', 'noCover', 'genres'];
function loadFilter() {
  try { return JSON.parse(localStorage.getItem('libFilter') || '{}'); } catch { return {}; }
}
function saveFilter(f) {
  try { localStorage.setItem('libFilter', JSON.stringify(Object.fromEntries(FILTER_KEYS.map(k => [k, f[k]])))); } catch {}
}

const items = () => store.all('items');
const owned = () => items().filter(i => i.status !== 'wish');
const wishes = () => items().filter(i => i.status === 'wish');
const collections = () => store.all('collections').sort((a, b) => a.createdAt - b.createdAt);

// ---------- Doublons ----------

function findDuplicates(cand, excludeId) {
  const n = norm(cand.title);
  const code = cand.barcode;
  return items().filter(i => i.id !== excludeId && (
    (code && i.barcode === code) || (n && norm(i.title) === n)
  )).map(i => ({ item: i, sameType: i.type === cand.type || (code && i.barcode === code) }));
}

// Clés de comparaison souples : « Cars - Quatre roues » = « Cars : Quatre roues » = « Cars »,
// « La Reine des neiges II » = « La Reine des neiges 2 ».
function matchKeys(title) {
  const roman = s => s.replace(/\b(ii|iii|iv)\b/g, r => ({ ii: '2', iii: '3', iv: '4' }[r]));
  const full = roman(norm(title));
  const main = roman(norm(String(title || '').split(/\s[-–:]\s|\s?:\s/)[0]));
  return new Set([full, main].filter(Boolean));
}

function collectionMatches(title) {
  const keys = matchKeys(title);
  if (!keys.size) return [];
  const out = [];
  for (const c of collections()) {
    for (const e of c.entries) {
      if (e.title && [...matchKeys(e.title)].some(k => keys.has(k))) out.push({ col: c, entry: e });
    }
  }
  return out;
}

// ---------- Navigation ----------

const TITLES = { library: 'Bibliothèque', wish: 'Mes souhaits', add: 'Ajouter', collection: 'Collection', more: 'Plus' };

function go(tab) {
  state.tab = tab;
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#title').textContent = TITLES[tab];
  render();
  window.scrollTo(0, 0);
}

function render() {
  const v = $('#view');
  ({ library: renderLibrary, wish: renderWish, add: renderAdd, collection: renderCollection, more: renderMore })[state.tab](v);
}

$$('.tabs button').forEach(b => b.addEventListener('click', () => (b.dataset.tab === 'scan' ? openScanner() : go(b.dataset.tab))));
$('#top-search').addEventListener('click', () => {
  if (state.tab !== 'library') go('library');
  $('#lib-q')?.focus();
});

// ---------- Bibliothèque ----------

// Onglets de format avec leur nombre d'objets ; tous les formats restent visibles, même à zéro.
function typeTabs(list, current, attr) {
  const counts = Object.fromEntries(Object.keys(TYPES).map(k => [k, list.filter(i => i.type === k).length]));
  const tabs = [['', 'Tout', list.length], ...Object.entries(TYPES).map(([k, l]) => [k, l, counts[k]])];
  return `<div class="type-tabs" role="tablist">${tabs.map(([k, l, n]) =>
    `<button role="tab" aria-selected="${current === k}" class="${current === k ? 'on' : ''}" ${attr}="${k}">${l}<span>${n}</span></button>`).join('')}</div>`;
}

function collectionRef(id) {
  for (const c of collections()) {
    const e = c.entries.find(x => x.itemId === id);
    if (e) return `N°${e.n}`;
  }
  return '';
}

function tileExtras(i, em) {
  const ref = em?.get(i.id);
  return (i.rating ? `<span class="tile-note">${i.rating}</span>` : '')
    + (i.loan ? '<span class="tile-flag">Prêté</span>' : ref ? `<span class="tile-flag">N°${ref.e.n}</span>` : '')
    + `<span class="tile-fmt fmt-${i.type}">${FMT[i.type]}</span>`;
}

function tile(i, em) {
  const sub = i.status === 'wish' && i.price ? euro(i.price) : (i.year || i.creator || '');
  return `<button class="tile ${i.type === 'cd' ? 'square' : ''}" data-open="${i.id}">
    ${cover(i, tileExtras(i, em))}
    <div class="tile-title">${esc(i.title)}</div>
    <div class="tile-sub">${esc(sub)}</div>
  </button>`;
}

function rowItem(i, em) {
  const ref = em?.get(i.id);
  const meta = [
    `<span class="fmt fmt-${i.type}">${FMT[i.type]}</span>`,
    i.year && `<span>${esc(i.year)}</span>`,
    i.creator && `<span>${esc(i.creator)}</span>`,
    ref && `<span>N°${ref.e.n}</span>`,
    i.loan && `<span>Prêté à ${esc(i.loan.to)}</span>`,
    i.rating && `<span>Note ${i.rating}/10</span>`,
    i.status === 'wish' && i.price && `<span>${euro(i.price)}</span>`,
  ].filter(Boolean).join('');
  return `<button class="row-item ${i.type === 'cd' ? 'square' : ''}" data-open="${i.id}">
    ${cover(i)}
    <div class="grow"><b>${esc(i.title)}</b><div class="row-meta">${meta}</div></div>
  </button>`;
}

const itemCard = i => tile(i);

function itemsHtml(list, em = entryMap()) {
  return state.view === 'list'
    ? `<div class="rows">${list.map(i => rowItem(i, em)).join('')}</div>`
    : `<div class="poster-grid">${list.map(i => tile(i, em)).join('')}</div>`;
}

// Objet -> numéro de collection auquel il est relié.
function entryMap() {
  const m = new Map();
  for (const c of collections()) for (const e of c.entries) if (e.itemId) m.set(e.itemId, { c, e });
  return m;
}

const decadeOf = i => (/^\d{4}$/.test(i.year || '') ? `${i.year.slice(0, 3)}0` : '');
const byTitle = (a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
const SORTS = {
  title: byTitle,
  'year-desc': (a, b) => (+b.year || 0) - (+a.year || 0) || byTitle(a, b),
  'year-asc': (a, b) => (+a.year || 9999) - (+b.year || 9999) || byTitle(a, b),
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || byTitle(a, b),
  number: null, // ordre de la collection, calculé dans filterItems
};

function filterItems(list, f) {
  const q = norm(f.q);
  const em = f.col || f.sort === 'number' ? entryMap() : null;
  const out = list
    .filter(i => !f.type || i.type === f.type)
    .filter(i => !f.loaned || i.loan)
    .filter(i => !f.digital || i.digital?.has)
    .filter(i => !f.noCover || !i.cover)
    .filter(i => !f.decade || decadeOf(i) === f.decade)
    .filter(i => !f.creator || i.creator === f.creator)
    // Plusieurs genres = tous à la fois : Comédie + Romance = comédies romantiques.
    .filter(i => !f.genres?.length || f.genres.every(g => (i.genres || []).includes(g)))
    .filter(i => {
      if (!f.col) return true;
      const ref = em.get(i.id);
      if (f.col === 'none') return !ref;
      if (f.col === 'pixar') return ref?.e.pixar;
      if (f.col === 'disney') return ref && isDisney(ref.c) && !ref.e.pixar;
      return ref?.c.id === f.col;
    })
    .filter(i => !q || norm([i.title, i.creator, i.barcode, i.notes, i.year].join(' ')).includes(q));
  if (f.sort === 'number') {
    const n = i => em.get(i.id)?.e.n ?? Infinity;
    return out.sort((a, b) => n(a) - n(b) || byTitle(a, b));
  }
  return out.sort(SORTS[f.sort] || byTitle);
}

const activeFilters = f => ['loaned', 'col', 'decade', 'creator', 'digital', 'noCover'].filter(k => f[k]).length + (f.sort && f.sort !== 'title' ? 1 : 0) + (f.genres?.length ? 1 : 0);

// Raccourcis pour les combinaisons courantes.
const GENRE_PRESETS = [
  ['Comédie romantique', [35, 10749]],
  ['Film de guerre historique', [10752, 36]],
];

function genreFilter(f, all) {
  const sel = f.genres || [];
  const pool = f.type ? all.filter(i => i.type === f.type) : all;
  const present = new Set(pool.flatMap(i => i.genres || []));
  const ids = [...new Set([...present, ...sel])].filter(genreLabel)
    .sort((a, b) => genreLabel(a).localeCompare(genreLabel(b), 'fr'));
  if (!ids.length) return '<p class="small muted">Genres : en cours de récupération…</p>';
  const showPresets = !f.type || isFilm(f.type);
  const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  return `<div><div class="small muted">Genre${sel.length > 1 ? ' (tous à la fois)' : ''}</div>
    ${showPresets ? `<div class="chips wrap">
      ${GENRE_PRESETS.map(([label, g]) => `<button class="chip ${same(sel, g) ? 'on' : ''}" data-gpreset="${g.join(',')}">★ ${label}</button>`).join('')}
    </div>` : ''}
    <div class="chips wrap">
      ${ids.map(g => `<button class="chip ${sel.includes(g) ? 'on' : ''}" data-genre="${genreKey(g)}">${esc(genreLabel(g))}</button>`).join('')}
    </div></div>`;
}

function filterPanel(f, all) {
  const decades = [...new Set(all.map(decadeOf).filter(Boolean))].sort();
  const counts = {};
  for (const i of all) if (i.creator) counts[i.creator] = (counts[i.creator] || 0) + 1;
  const creators = Object.keys(counts).filter(c => counts[c] > 1 || c === f.creator).sort((a, b) => a.localeCompare(b, 'fr'));
  const hasDisney = collections().some(isDisney);
  const others = collections().filter(c => !isDisney(c));
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;
  return `<div class="form filters">
    <h2>Filtres</h2>
    <div class="two">
      <label>Trier par<select data-f="sort">
        ${opt('title', 'Titre (A → Z)', f.sort || 'title')}
        ${opt('year-desc', 'Année (récent → ancien)', f.sort)}
        ${opt('year-asc', 'Année (ancien → récent)', f.sort)}
        ${opt('added', 'Ajout le plus récent', f.sort)}
        ${opt('rating', 'Ma note', f.sort)}
        ${hasDisney ? opt('number', 'Numéro de collection', f.sort) : ''}
      </select></label>
      <label>Décennie<select data-f="decade">
        ${opt('', 'Toutes', f.decade || '')}
        ${decades.map(d => opt(d, `Années ${d}`, f.decade)).join('')}
      </select></label>
    </div>
    ${collections().length ? `<label>Collection<select data-f="col">
      ${opt('', 'Tout', f.col || '')}
      ${hasDisney ? opt('disney', 'Disney (Grands Classiques)', f.col) + opt('pixar', 'Pixar (Grands Classiques)', f.col) : ''}
      ${others.map(c => opt(c.id, c.name, f.col)).join('')}
      ${opt('none', 'Hors collection', f.col)}
    </select></label>` : ''}
    ${creators.length ? `<label>Auteur / artiste / réalisateur<select data-f="creator">
      ${opt('', 'Tous', f.creator || '')}
      ${creators.map(c => opt(c, `${c} (${counts[c]})`, f.creator)).join('')}
    </select></label>` : ''}
    ${genreFilter(f, all)}
    <label class="toggle"><input type="checkbox" data-f="loaned" ${f.loaned ? 'checked' : ''}> Prêtés en ce moment</label>
    <label class="toggle"><input type="checkbox" data-f="digital" ${f.digital ? 'checked' : ''}> Existe aussi en fichier</label>
    <label class="toggle"><input type="checkbox" data-f="noCover" ${f.noCover ? 'checked' : ''}> Sans affiche (à compléter)</label>
    <div class="actions">
      <button class="btn ghost" id="f-reset">Tout effacer</button>
      <button class="btn primary" data-close>Voir les résultats</button>
    </div>
  </div>`;
}

function backupBanner() {
  if (!items().length) return '';
  const acc = account.current();
  if (acc?.expired) return `<button class="banner" data-goto="more">${icon('shelf')}<span>Votre session a expiré : reconnectez-vous pour synchroniser vos appareils.</span></button>`;
  if (!acc && !store.meta('accountBannerOff')) {
    return `<div class="banner">${icon('shelf')}<button class="linklike grow" data-goto="more">Créez un compte pour retrouver votre bibliothèque sur tous vos appareils.</button><button class="icon-btn" id="banner-off" aria-label="Masquer">${icon('close')}</button></div>`;
  }
  if (acc) return '';
  if (!store.meta('syncCodeSeen')) {
    return `<button class="banner" data-goto="more">${icon('file')}<span>Sauvegarde automatique activée. Notez votre code de récupération dans « Plus ».</span></button>`;
  }
  // La sauvegarde automatique fonctionne : pas besoin de rappeler l'export manuel.
  const st = sync.status();
  if (st.enabled && st.lastSync && Date.now() - st.lastSync < 7 * 864e5) return '';
  if (st.enabled && st.lastSync === null && st.pending) return '';
  const last = store.meta('lastExport');
  if (items().length < 5) return '';
  const days = last ? (Date.now() - last) / 864e5 : Infinity;
  if (days < 30) return '';
  return `<button class="banner" data-goto="more">${icon('file')}<span>${last ? `Dernière sauvegarde il y a ${Math.floor(days)} jours.` : 'Aucune sauvegarde pour le moment.'} Exportez votre bibliothèque pour ne rien perdre.</span></button>`;
}

function shelf(title, list, em, action = '') {
  if (!list.length) return '';
  return `<section class="shelf">
    <div class="shelf-head"><h2>${title}</h2>${action}</div>
    <div class="shelf-row">${list.map(i => tile(i, em)).join('')}</div>
  </section>`;
}

function renderLibrary(v) {
  const f = state.filter;
  const all = owned();
  const nf = activeFilters(f);
  v.innerHTML = `
    ${backupBanner()}
    ${typeTabs(all, f.type || '', 'data-ftype')}
    <div class="toolbar">
      <label class="searchbox">${icon('search')}<input type="search" placeholder="Titre, réalisateur, artiste, année…" value="${esc(f.q)}" id="lib-q" autocomplete="off" aria-label="Rechercher dans la bibliothèque"></label>
      <button class="tool ${nf ? 'on' : ''}" id="lib-ftoggle" aria-label="Filtres">${icon('filter')}${nf ? `<b>${nf}</b>` : ''}</button>
      <button class="tool" id="lib-view" aria-label="${state.view === 'grid' ? 'Afficher en liste' : 'Afficher en affiches'}">${icon(state.view === 'grid' ? 'list' : 'grid')}</button>
    </div>
    <div id="lib-shelves"></div>
    <p class="count" id="lib-count"></p>
    <div id="lib-list"></div>`;
  const draw = () => {
    const em = entryMap();
    const list = filterItems(all, f);
    const filtered = f.type || nf || f.q.trim();
    // Accueil façon catalogue : rayons quand on ne cherche rien de précis.
    const showShelves = !filtered && all.length >= 6;
    let shelves = '';
    if (showShelves) {
      const recent = [...all].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 12);
      const lent = all.filter(i => i.loan);
      const disney = collections().find(isDisney);
      const classics = disney ? disney.entries.filter(e => e.owned && e.itemId).map(e => store.get('items', e.itemId)).filter(Boolean) : [];
      const rated = all.filter(i => i.rating >= 8).sort((a, b) => b.rating - a.rating).slice(0, 12);
      shelves = shelf('Ajoutés récemment', recent, em)
        + shelf(`Prêtés (${lent.length})`, lent, em)
        + (disney ? shelf(`Grands Classiques ${classics.length}/${disney.entries.length}`, classics, em, '<button data-goto="collection">Voir le mur</button>') : '')
        + shelf('Mes coups de cœur', rated, em);
    }
    $('#lib-shelves').innerHTML = shelves;
    $('#lib-count').innerHTML = filtered
      ? `${list.length} résultat${list.length > 1 ? 's' : ''} sur ${all.length}`
      : showShelves ? '<span class="section-title">Toute la bibliothèque</span>' : '';
    let html = list.length ? itemsHtml(list, em) : '';
    // Recherche en magasin : signaler aussi la liste de souhaits et la collection.
    if (f.q.trim()) {
      const wl = filterItems(wishes(), { q: f.q });
      if (wl.length) html += `<h3 class="section-title">Dans mes souhaits</h3>` + itemsHtml(wl, em);
      const q = norm(f.q);
      const ce = collections().flatMap(c => c.entries.filter(e => e.title && norm(e.title).includes(q)).map(e => ({ c, e })));
      if (ce.length) {
        html += `<h3 class="section-title">Dans mes collections</h3>` + ce.map(({ c, e }) =>
          `<div class="row"><span class="num">N°${e.n}</span><span class="grow">${esc(e.title)} <span class="muted small">${esc(c.name)}</span></span>${e.owned ? '<span class="small" style="color:var(--owned);font-weight:700">Possédé</span>' : '<span class="small muted">Manquant</span>'}</div>`).join('');
      }
    }
    const noneOfType = f.type && !f.q.trim() && !nf && !all.some(i => i.type === f.type);
    $('#lib-list').innerHTML = html || (noneOfType
      ? `<div class="empty"><h2>Aucun ${f.type === 'book' ? 'livre' : f.type === 'cd' ? 'CD' : FMT[f.type]} pour l'instant</h2>Scannez le code-barres ${f.type === 'book' ? 'au dos d\'un livre (ISBN)' : 'du boîtier'} pour l'ajouter ici.<br><button class="btn primary" id="lib-first">${icon('scan')}Scanner un code-barres</button></div>`
      : all.length
      ? '<div class="empty"><h2>Aucun résultat</h2>Essayez un autre mot ou retirez des filtres.</div>'
      : `<div class="empty"><h2>Votre bibliothèque est vide</h2>Scannez un premier Blu-ray, CD ou livre : son affiche apparaîtra ici.<br><button class="btn primary" id="lib-first">${icon('scan')}Scanner un code-barres</button></div>`);
    $('#lib-first')?.addEventListener('click', openScanner);
  };
  draw();
  $('#lib-q').addEventListener('input', e => { f.q = e.target.value; draw(); });
  $('#banner-off')?.addEventListener('click', async () => { await store.setMeta('accountBannerOff', true); render(); });
  $('#lib-ftoggle').addEventListener('click', openFilters);
  $('#lib-view').addEventListener('click', () => { state.view = state.view === 'grid' ? 'list' : 'grid'; savePref('libView', state.view); render(); });
  $$('[data-ftype]', v).forEach(b => b.addEventListener('click', () => { f.type = b.dataset.ftype; saveFilter(f); render(); }));
}

// Filtres dans une fiche : la bibliothèque se met à jour derrière à chaque choix.
function openFilters() {
  const f = state.filter;
  const all = owned();
  const refresh = () => { saveFilter(f); render(); openFilters(); };
  openSheet(filterPanel(f, all), root => {
    $$('[data-f]', root).forEach(el => el.addEventListener('change', () => {
      f[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
      refresh();
    }));
    $$('[data-genre]', root).forEach(b => b.addEventListener('click', () => {
      const g = parseGenre(b.dataset.genre);
      const sel = f.genres || [];
      f.genres = sel.includes(g) ? sel.filter(x => x !== g) : [...sel, g];
      refresh();
    }));
    $$('[data-gpreset]', root).forEach(b => b.addEventListener('click', () => {
      const g = b.dataset.gpreset.split(',').map(Number);
      const cur = f.genres || [];
      f.genres = cur.length === g.length && g.every(x => cur.includes(x)) ? [] : g;
      refresh();
    }));
    $('#f-reset', root).addEventListener('click', () => {
      for (const k of FILTER_KEYS) f[k] = k === 'type' ? f.type : k === 'genres' ? [] : '';
      refresh();
    });
  });
}

// ---------- Liste de souhaits ----------

function renderWish(v) {
  const f = state.wishFilter;
  const all = wishes();
  const total = all.reduce((s, i) => s + (+i.price || 0), 0);
  v.innerHTML = `
    ${typeTabs(all, f.type || '', 'data-wtype')}
    <div class="toolbar">
      <label class="searchbox">${icon('search')}<input type="search" placeholder="Rechercher dans mes souhaits" value="${esc(f.q)}" id="w-q" aria-label="Rechercher dans mes souhaits"></label>
      <button class="tool" id="w-add" aria-label="Ajouter un souhait">${icon('plus')}</button>
    </div>
    ${all.length ? `<p class="count">${all.length} souhait${all.length > 1 ? 's' : ''}${total ? `, budget estimé ${euro(total)}` : ''}</p>` : ''}
    <div id="w-list"></div>`;
  const draw = () => {
    const list = filterItems(all, f);
    $('#w-list').innerHTML = list.length ? itemsHtml(list)
      : '<div class="empty"><h2>Aucun souhait</h2>Scannez un objet en magasin puis choisissez « Ajouter à mes souhaits » pour le retrouver ici.</div>';
  };
  draw();
  $('#w-q').addEventListener('input', e => { f.q = e.target.value; draw(); });
  $$('[data-wtype]', v).forEach(b => b.addEventListener('click', () => { f.type = b.dataset.wtype; render(); }));
  $('#w-add').addEventListener('click', () => { state.addStatus = 'wish'; go('add'); });
}

// ---------- Ajouter ----------

function renderAdd(v) {
  v.innerHTML = `
    <button class="scan-card" id="a-scan">
      <span>${icon('scan')}</span>
      <span><b>Scanner un code-barres</b><small>4K, Blu-ray, DVD, CD, livre ou QR code</small></span>
    </button>
    <div class="type-tabs" role="tablist" aria-label="Type d'objet">
      ${Object.entries(TYPES).map(([k, l]) => `<button role="tab" aria-selected="${state.addType === k}" class="${state.addType === k ? 'on' : ''}" data-atype="${k}">${l}</button>`).join('')}
    </div>
    <form id="a-form">
      <label class="searchbox">${icon('search')}<input id="a-q" type="search" placeholder="Titre ou numéro du code-barres" autocomplete="off" value="${esc(state.titleQ || '')}" aria-label="Titre ou numéro du code-barres"></label>
    </form>
    <div id="a-results"></div>
    <button class="btn block ghost" id="a-manual">${icon('edit')}Saisir à la main</button>
  `;
  $('#a-scan').addEventListener('click', openScanner);
  $$('[data-atype]', v).forEach(b => b.addEventListener('click', () => {
    state.addType = b.dataset.atype;
    render();
    if (state.titleQ?.trim()) handleTitle(state.titleQ, true);
  }));
  // Un seul champ : des chiffres = code-barres, du texte = recherche au fil de la frappe.
  const isCode = q => /^[\d\sX-]{8,17}$/i.test(q.trim()) && cleanCode(q).length >= 8;
  $('#a-form').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#a-q').value;
    if (isCode(q)) handleCode(q); else handleTitle(q);
  });
  let timer;
  $('#a-q').addEventListener('input', e => {
    clearTimeout(timer);
    const q = state.titleQ = e.target.value;
    if (isCode(q)) { if ([8, 12, 13].includes(cleanCode(q).length)) timer = setTimeout(() => handleCode(q), 600); return; }
    if (q.trim().length >= 2) timer = setTimeout(() => handleTitle(q, true), 400);
  });
  $('#a-manual').addEventListener('click', () => openConfirm({ type: state.addType, title: isCode($('#a-q').value) ? '' : $('#a-q').value.trim(), barcode: state.pendingBarcode }));
  drawResults();
}

// Met à jour seulement la zone de résultats, pour ne pas effacer la saisie en cours.
function drawResults() {
  const box = $('#a-results');
  if (!box) return;
  const r = state.results;
  box.innerHTML = `
    ${state.resultsMsg ? `<p class="notice">${state.resultsMsg}</p>` : ''}
    ${r?.length ? r.map((c, i) => `<button class="result" data-pick="${i}">${cover(c)}
      <div class="grow"><b>${esc(c.title)}</b><div class="row-meta">
        <span class="fmt fmt-${c.type}">${FMT[c.type]}</span>${c.year ? `<span>${esc(c.year)}</span>` : ''}${c.creator ? `<span>${esc(c.creator)}</span>` : ''}
      </div><div class="row-meta"><span>${esc(c.source)}</span></div></div></button>`).join('') : ''}`;
  $$('[data-pick]', box).forEach(b => b.addEventListener('click', () => {
    const c = { ...r[+b.dataset.pick] };
    if (!c.barcode && state.pendingBarcode) c.barcode = state.pendingBarcode;
    openConfirm(c);
  }));
}

function setResults(results, msg = '') {
  state.results = results;
  state.resultsMsg = msg;
  if (state.tab !== 'add') go('add'); else drawResults();
}

async function handleCode(raw) {
  const text = String(raw || '').trim();
  let code = cleanCode(text);
  // QR code contenant du texte (titre, lien…) : on l'utilise comme recherche.
  if (!/^[\dX]{8,14}$/.test(code)) {
    if (text) { state.titleQ = text.slice(0, 80); setResults(null, `QR code lu : « ${esc(text.slice(0, 120))} »`); if ($('#a-q')) $('#a-q').value = state.titleQ; handleTitle(state.titleQ, true); }
    else toast('Numéro vide');
    return;
  }
  if (code.length === 10 && isIsbn(code)) code = isbn10to13(code);
  state.pendingBarcode = code;
  if (isIsbn(code)) state.addType = 'book';

  // Déjà possédé ? On le dit tout de suite (utile en magasin).
  const dup = items().filter(i => i.barcode === code);
  if (dup.length) {
    setResults(null, '');
    openItem(dup[0].id, dup[0].status === 'wish' ? 'Déjà dans vos souhaits.' : 'Vous avez déjà cet objet.');
    return;
  }

  setResults(null, `Recherche du code ${code}…`);
  try {
    const res = await lookupBarcode(code, state.addType);
    if (res.length === 1) {
      setResults(res, '');
      openConfirm({ ...res[0] });
    } else if (res.length > 1) {
      setResults(res, `Plusieurs correspondances pour ${code}. Touchez la bonne :`);
    } else {
      state.titleQ = '';
      setResults([], `Code ${code} introuvable dans les bases gratuites. Tapez les premières lettres du titre : le code sera enregistré avec.`);
      if ($('#a-q')) { $('#a-q').value = ''; $('#a-q').focus(); }
    }
  } catch (e) {
    const limit = /429/.test(e.message);
    setResults([], limit
      ? `La base de codes-barres a atteint sa limite pour aujourd'hui. Tapez le titre ci-dessous : le code ${code} sera conservé.`
      : `Service en ligne indisponible (${esc(e.message || 'réseau')}). Recherchez par titre ou saisissez à la main : le code ${code} sera conservé.`);
    if ($('#a-q')) { $('#a-q').value = ''; $('#a-q').focus(); }
  }
}

let titleSeq = 0;
async function handleTitle(q, live = false) {
  if (!q.trim()) return;
  const seq = ++titleSeq;
  const keep = state.pendingBarcode ? ` Le code ${state.pendingBarcode} sera enregistré avec.` : '';
  if (!live) setResults(null, 'Recherche…');
  try {
    const res = await searchTitle(q, state.addType);
    if (seq !== titleSeq) return; // une recherche plus récente est en cours
    setResults(res, res.length ? (keep ? keep.trim() : '') : 'Aucun résultat. Essayez un autre titre, un autre type ou la saisie à la main.');
  } catch (e) {
    if (seq !== titleSeq) return;
    setResults([], `Service en ligne indisponible (${esc(e.message || 'réseau')}). Utilisez la saisie manuelle.`);
  }
}

// ---------- Scanner ----------

let scanCtl = null;

async function openScanner() {
  const el = $('#scanner');
  el.hidden = false;
  $('#scan-hint').textContent = 'Démarrage de la caméra…';
  try {
    scanCtl = await startScan($('#scan-video'), code => { closeScanner(); handleCode(code); });
    $('#scan-hint').textContent = 'Placez le code-barres dans le cadre';
    $('#scan-torch').hidden = !scanCtl.hasTorch;
  } catch (e) {
    closeScanner();
    const msg = e.name === 'NotAllowedError' ? "Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur, ou prenez une photo / tapez le numéro." : (e.message || 'Caméra indisponible');
    setResults(null, esc(msg));
  }
}

function closeScanner() {
  scanCtl?.stop();
  scanCtl = null;
  $('#scanner').hidden = true;
}

$('#scan-close').addEventListener('click', closeScanner);
$('#scan-type').addEventListener('click', () => { closeScanner(); go('add'); $('#a-q')?.focus(); });
$('#scan-torch').addEventListener('click', async () => {
  const on = await scanCtl?.toggleTorch();
  $('#scan-torch').classList.toggle('on', !!on);
});
$('#scan-photo').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  closeScanner();
  setResults(null, 'Lecture de la photo…');
  const code = await decodeImage(file).catch(() => null);
  if (code) handleCode(code);
  else setResults(null, 'Aucun code lisible sur la photo. Rapprochez-vous, évitez les reflets, ou tapez le numéro.');
});

// ---------- Fiches (sheet) ----------

function openSheet(html, bind, { full = false } = {}) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.toggle('full', full);
  $('#sheet').hidden = false;
  $('.sheet-panel').scrollTop = 0;
  document.body.classList.add('noscroll');
  if (!history.state?.sheet) history.pushState({ sheet: true }, '');
  bind?.($('#sheet-body'));
}

function closeSheet(fromPop = false) {
  if ($('#sheet').hidden) return;
  $('#sheet').hidden = true;
  document.body.classList.remove('noscroll');
  if (!fromPop && history.state?.sheet) history.back();
}

// Bouton « retour » d'Android : ferme la fiche ou le scanner au lieu de quitter l'appli.
window.addEventListener('popstate', () => {
  if (scanCtl) closeScanner();
  if (!history.state?.sheet) closeSheet(true);
});
$('#sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });

function typeSelect(val) {
  return `<select name="type">${Object.entries(TYPES).map(([k, l]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

function coverEditor(item) {
  return `<div class="cover-edit">
    <div id="cv" style="width:72px">${cover(item)}</div>
    <label class="btn small">${icon('camera')}Photographier la jaquette<input type="file" accept="image/*" capture="environment" id="cv-photo" hidden></label>
  </div>`;
}

function bindCover(root, item) {
  $('#cv-photo', root).addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    item.cover = await photoToDataUrl(f);
    $('#cv', root).innerHTML = cover(item);
  });
}

function dupBanner(dups) {
  if (!dups.length) return '';
  const strong = dups.some(d => d.sameType && d.item.status !== 'wish');
  return `<div class="alert ${strong ? 'danger' : ''}">
    ${strong ? '<b>Vous possédez déjà ce titre.</b>' : 'Déjà présent dans un autre format ou dans vos souhaits :'}
    <ul>${dups.map(d => `<li>${esc(d.item.title)} — ${TYPES[d.item.type]}${d.item.status === 'wish' ? ' (souhait)' : ''}</li>`).join('')}</ul>
  </div>`;
}

function openConfirm(cand) {
  const item = {
    type: cand.type || state.addType, title: cand.title || '', creator: cand.creator || '', year: cand.year || '',
    barcode: cand.barcode || '', cover: cand.cover || '', source: cand.source || 'Saisie manuelle',
    genres: cand.genres || [], tmdbId: cand.tmdbId || null,
    ...(cand.mbReleaseId ? { mbReleaseId: cand.mbReleaseId } : {}), ...(cand.mbGroupId ? { mbGroupId: cand.mbGroupId } : {}),
  };
  const manual = !cand.title;
  const dups = findDuplicates(item);
  // Un coffret « A + B » peut correspondre à plusieurs numéros.
  const cm = [...new Set(item.title.split(' + ').flatMap(collectionMatches))].filter(m => !m.entry.owned)
    .filter((m, i, all) => all.findIndex(x => x.entry === m.entry) === i);
  const wishFirst = state.addStatus === 'wish';
  openSheet(`
    <form id="cf" class="form">
      <div class="confirm-head">
        <div id="cv-head">${cover(item)}</div>
        <div class="grow">
          <h2 id="cf-title">${esc(item.title || 'Nouvel objet')}</h2>
          <div class="row-meta">${item.year ? `<span>${esc(item.year)}</span>` : ''}${item.creator ? `<span>${esc(item.creator)}</span>` : ''}<span>${esc(item.source)}</span></div>
        </div>
      </div>
      <div id="dups">${dupBanner(dups)}</div>
      <input type="hidden" name="type" value="${item.type}">
      <div class="chips" role="radiogroup" aria-label="Format">
        ${Object.entries(TYPES).map(([k, l]) => `<button type="button" role="radio" aria-checked="${item.type === k}" class="chip ${item.type === k ? 'on' : ''}" data-ctype="${k}">${l}</button>`).join('')}
      </div>
      ${cm.map((m, i) => {
        // Année éloignée de celle du classique, ou film plus récent qu'un homonyme : sans doute le remake.
        const far = m.entry.year && cand.year && !item.title.includes(' + ') && Math.abs(+cand.year - m.entry.year) > 2;
        const remake = m.col.kind === 'disney' && (m.entry.year ? far : (cand.animated === false || cand.remake));
        return `<label class="toggle"><input type="checkbox" name="col${i}" ${remake ? '' : 'checked'}> Cocher le N°${m.entry.n} de « ${esc(m.col.name)} »${remake ? ' <span class="small muted">(sans doute le remake, vérifiez)</span>' : ''}</label>`;
      }).join('')}
      <details class="more" ${manual ? 'open' : ''}>
        <summary>Modifier les informations</summary>
        <div class="form">
          ${coverEditor(item)}
          <label>Titre<input name="title" required value="${esc(item.title)}"></label>
          <label>${item.type === 'book' ? 'Auteur' : item.type === 'cd' ? 'Artiste' : isFilm(item.type) ? 'Titre original ou réalisateur' : 'Auteur'}<input name="creator" value="${esc(item.creator)}"></label>
          <div class="two">
            <label>Année<input name="year" inputmode="numeric" value="${esc(item.year)}"></label>
            <label>Code-barres<input name="barcode" inputmode="numeric" value="${esc(item.barcode)}"></label>
          </div>
          <label>Prix si souhait (€)<input name="price" inputmode="decimal"></label>
        </div>
      </details>
      <div class="stack">
        <button type="button" class="btn ${wishFirst ? '' : 'primary'} big" data-save="owned">${icon('check')}Ajouter à ma bibliothèque</button>
        <button type="button" class="btn ${wishFirst ? 'primary big' : ''}" data-save="wish">${icon('heart')}Ajouter à mes souhaits</button>
      </div>
    </form>`, root => {
    bindCover(root, item);
    const form = $('#cf', root);
    const recheck = () => {
      const fd = new FormData(form);
      $('#dups', root).innerHTML = dupBanner(findDuplicates({ title: fd.get('title'), type: fd.get('type'), barcode: cleanCode(fd.get('barcode')) }));
    };
    $$('[data-ctype]', root).forEach(b => b.addEventListener('click', () => {
      form.elements.type.value = b.dataset.ctype;
      $$('[data-ctype]', root).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      recheck();
    }));
    form.elements.title.addEventListener('input', () => { $('#cf-title', root).textContent = form.elements.title.value || 'Nouvel objet'; });
    form.elements.title.addEventListener('change', recheck);
    $('#cv-photo', root).addEventListener('change', () => setTimeout(() => { $('#cv-head', root).innerHTML = cover(item); }, 300));
    if (manual) setTimeout(() => form.elements.title.focus(), 250);
    $$('[data-save]', root).forEach(b => b.addEventListener('click', async () => {
      if (!form.elements.title.value.trim()) { $('details.more', root).open = true; form.elements.title.focus(); return; }
      const st = b.dataset.save;
      const fd = new FormData(form);
      const obj = {
        id: store.uid(), ...item,
        title: fd.get('title').trim(), creator: fd.get('creator').trim(), year: fd.get('year').trim(),
        type: fd.get('type'), barcode: cleanCode(fd.get('barcode')), status: st,
        price: st === 'wish' ? parseFloat(String(fd.get('price') || '').replace(',', '.')) || null : null,
        loan: null, loanHistory: [], digital: { has: false, location: '' }, notes: '', addedAt: Date.now(),
      };
      await store.put('items', obj);
      if (st === 'owned') {
        for (const [i, m] of cm.entries()) {
          if (fd.get(`col${i}`)) { m.entry.owned = true; m.entry.itemId = obj.id; await store.put('collections', m.col); }
        }
      }
      closeSheet();
      state.results = null; state.resultsMsg = ''; state.pendingBarcode = ''; state.titleQ = '';
      toast(st === 'wish' ? 'Ajouté à mes souhaits' : 'Ajouté à ma bibliothèque');
      fillCovers();
      render();
    }));
    form.addEventListener('submit', e => e.preventDefault());
  });
}

// Fiche d'un objet : affiche en grand, note, actions en un geste.
function openItem(id, notice = '') {
  const item = store.get('items', id);
  if (!item) return;
  item.digital ??= { has: false, location: '' };
  item.loanHistory ??= [];
  const wish = item.status === 'wish';
  const ref = entryMap().get(item.id);
  const genres = (item.genres || []).map(genreLabel).filter(Boolean);
  const facts = [
    item.loan && ['Prêté à', `${esc(item.loan.to)}, depuis le ${frDate(item.loan.since)}`],
    ref && ['Collection', `N°${ref.e.n}, ${esc(ref.c.name)}`],
    item.digital.has && ['Version numérique', esc(item.digital.location || 'Oui')],
    wish && item.price && ['Prix', euro(item.price)],
    item.barcode && ['Code-barres', esc(item.barcode)],
    ['Ajouté le', frDate(item.addedAt)],
    item.readStatus && ['Lecture', esc(item.readStatus)],
    item.publisher && ['Éditeur', esc(item.publisher)],
    item.source && ['Source', esc(item.source)],
    item.notes && ['Notes', esc(item.notes)],
  ].filter(Boolean);
  openSheet(`
    <div class="hero">
      ${item.cover ? `<div class="hero-bg" style="background-image:url('${esc(item.cover)}')"></div>` : ''}
      <div class="hero-nav">
        <button class="icon-btn" data-close aria-label="Fermer">${icon('back')}</button>
        <button class="icon-btn" id="it-edit" aria-label="Modifier">${icon('edit')}</button>
      </div>
      <div class="hero-main">
        <div class="hero-poster ${item.type === 'cd' ? 'tile square' : ''}">${cover(item)}</div>
        <div class="grow">
          <h2>${esc(item.title)}</h2>
          ${item.creator ? `<p>${esc(item.creator)}</p>` : ''}
          <div class="hero-tags"><span class="tile-fmt fmt-${item.type}">${FMT[item.type]}</span>${item.year ? `<span>${esc(item.year)}</span>` : ''}${item.details?.runtime ? `<span>${runtimeLabel(item.details.runtime)}</span>` : ''}${genres.map(g => `<span>${esc(g)}</span>`).join('')}</div>
        </div>
      </div>
    </div>
    ${notice ? `<div class="alert danger" style="margin-top:14px"><b>${esc(notice)}</b></div>` : ''}
    <div class="rating" role="group" aria-label="Ma note">
      <span class="rating-label">Ma note</span>
      <div class="rating-scale">${Array.from({ length: 10 }, (_, k) => `<button data-rate="${k + 1}" class="${item.rating >= k + 1 ? 'on' : ''}" aria-pressed="${item.rating === k + 1}">${k + 1}</button>`).join('')}</div>
    </div>
    <div class="quick">
      ${wish
        ? `<button id="it-bought">${icon('check')}Acheté</button>`
        : `<button id="it-loan" class="${item.loan ? 'on' : ''}">${icon('hand')}${item.loan ? 'Rendu' : 'Prêter'}</button>`}
      <button id="it-file" class="${item.digital.has ? 'on' : ''}">${icon('file')}Fichier</button>
      <button id="it-edit2">${icon('edit')}Modifier</button>
      <button id="it-del" class="danger">${icon('trash')}Supprimer</button>
    </div>
    <div id="it-box"></div>
    <div id="it-more" data-item="${item.id}">${detailsHtml(item)}</div>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    ${item.loanHistory.length ? `<details class="more"><summary>Prêts passés (${item.loanHistory.length})</summary><ul class="small">${item.loanHistory.map(h => `<li>${esc(h.to)}, du ${frDate(h.since)} au ${frDate(h.returned)}</li>`).join('')}</ul></details>` : ''}
  `, root => {
    const save = async msg => { await store.put('items', item); render(); openItem(item.id); if (msg) toast(msg); };
    loadDetails(item);
    // Bande-annonce : la vidéo YouTube n'est chargée qu'au toucher.
    $('#it-more', root).addEventListener('click', e => {
      const t = e.target.closest('[data-yt]');
      if (t) {
        t.outerHTML = `<div class="trailer"><iframe src="https://www.youtube-nocookie.com/embed/${t.dataset.yt}?autoplay=1&playsinline=1&rel=0" title="Bande-annonce" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
        return;
      }
      const a = e.target.closest('[data-album], [data-track]');
      if (a) { listen(item.id, a.dataset.track === undefined ? null : +a.dataset.track, root); return; }
      const m = e.target.closest('[data-more]');
      if (m) { m.previousElementSibling.classList.remove('clamp'); m.remove(); }
      if (e.target.closest('[data-retry]')) { delete item.detailsAt; loadDetails(item, true); }
    });
    $$('[data-rate]', root).forEach(b => b.addEventListener('click', () => {
      const r = +b.dataset.rate;
      item.rating = item.rating === r ? null : r;
      save(item.rating ? `Noté ${r}/10` : 'Note retirée');
    }));
    $('#it-edit', root).addEventListener('click', () => openEdit(item.id));
    $('#it-edit2', root).addEventListener('click', () => openEdit(item.id));
    $('#it-bought', root)?.addEventListener('click', () => { item.status = 'owned'; item.addedAt = Date.now(); save('Déplacé dans ma bibliothèque'); });
    $('#it-loan', root)?.addEventListener('click', () => {
      if (item.loan) {
        item.loanHistory.push({ ...item.loan, returned: today() });
        item.loan = null;
        return save('Retour enregistré');
      }
      $('#it-box', root).innerHTML = `<form class="inline" id="loan-f"><input id="loan-to" placeholder="Prêté à…" autocomplete="off" required><button class="btn dark">Prêter</button></form>`;
      $('#loan-to', root).focus();
      $('#loan-f', root).addEventListener('submit', e => {
        e.preventDefault();
        const to = $('#loan-to', root).value.trim();
        if (!to) return;
        item.loan = { to, since: today() };
        save(`Prêté à ${to}`);
      });
    });
    $('#it-file', root).addEventListener('click', () => {
      $('#it-box', root).innerHTML = `<form class="form" id="file-f">
        <label class="toggle"><input type="checkbox" name="has" ${item.digital.has ? 'checked' : ''}> Existe aussi en fichier sur l'ordinateur</label>
        <div class="inline"><input name="loc" placeholder="Emplacement, ex. Disque externe / Films" value="${esc(item.digital.location)}"><button class="btn dark">OK</button></div>
      </form>`;
      $('#file-f', root).addEventListener('submit', e => {
        e.preventDefault();
        const f = e.target.elements;
        item.digital = { has: f.has.checked || !!f.loc.value.trim(), location: f.loc.value.trim() };
        save(item.digital.has ? 'Version numérique enregistrée' : 'Version numérique retirée');
      });
    });
    $('#it-del', root).addEventListener('click', async () => {
      if (!confirm(`Supprimer « ${item.title} » ?${ref ? `\n\nLe N°${ref.e.n} sera aussi décoché dans la collection.` : ''}`)) return;
      await store.remove('items', item.id);
      for (const c of collections()) {
        let changed = false;
        for (const e of c.entries) if (e.itemId === item.id) { delete e.itemId; e.owned = false; changed = true; }
        if (changed) await store.put('collections', c);
      }
      closeSheet(); toast('Supprimé'); render();
    });
  }, { full: true });
}

// ---------- Contenu des fiches : synopsis, bande-annonce, titres ----------

const DETAILS_V = 1;
const loadingDetails = new Set();

function detailsHtml(item) {
  const sec = (title, body) => `<section class="detail-sec"><h3>${title}</h3>${body}</section>`;
  const text = t => `<p class="synopsis clamp">${esc(t)}</p>${t.length > 280 ? '<button class="linklike small more-btn" data-more>Lire la suite</button>' : ''}`;
  const fresh = (item.detailsV || 0) >= DETAILS_V;
  if (!fresh) {
    if (!isFilm(item.type) && item.type !== 'cd' && item.type !== 'book') return '';
    return `<p class="small muted loading-line">${item.type === 'cd' ? 'Recherche de la liste des titres…' : item.type === 'book' ? 'Recherche du résumé…' : 'Recherche du synopsis et de la bande-annonce…'}</p>`;
  }
  const d = item.details || {};
  let html = '';
  if (isFilm(item.type)) {
    if (d.tagline) html += `<p class="tagline">${esc(d.tagline)}</p>`;
    html += d.overview ? sec('Synopsis', text(d.overview)) : '';
    if (d.trailer) {
      html += sec('Bande-annonce', `<button class="trailer" data-yt="${esc(d.trailer.key)}" aria-label="Lire la bande-annonce" style="background-image:url('https://i.ytimg.com/vi/${esc(d.trailer.key)}/hqdefault.jpg')"><span class="play">${icon('play')}</span></button>
        <p class="small muted">${esc(d.trailer.name)}${d.trailer.lang === 'fr' ? '' : ' (en anglais)'}</p>`);
    }
    if (d.directors?.length || d.cast?.length) {
      html += sec('Distribution', `${d.directors?.length ? `<p><span class="muted">Réalisation</span> ${esc(d.directors.join(', '))}</p>` : ''}
        ${d.cast?.length ? `<div class="cast">${d.cast.map(c => `<span><b>${esc(c.name)}</b>${c.role ? `<small>${esc(c.role)}</small>` : ''}</span>`).join('')}</div>` : ''}`);
    }
    if (!html) html = `<p class="small muted">Pas de synopsis ni de bande-annonce trouvés pour ce film. <button class="linklike small" data-retry>Réessayer</button></p>`;
  } else if (item.type === 'cd') {
    const discs = item.tracks || [];
    if (discs.length) {
      const total = discs.flatMap(x => x.tracks).reduce((t, x) => t + (x.length || 0), 0);
      let k = 0; // position du titre dans l'album entier (tous disques confondus)
      html = sec(`Titres${discs.length > 1 ? ` (${discs.length} disques)` : ''}`,
        `<button class="btn dark listen" data-album>${icon('play')}Écouter l'album</button><div class="yt-slot"></div>`
        + discs.map(disc => `
        ${discs.length > 1 ? `<h4>${esc(disc.format || 'Disque')} ${disc.disc}</h4>` : ''}
        <ol class="tracks">${disc.tracks.map(t => `<li data-k="${k}"><button class="track-play" data-track="${k++}" aria-label="Écouter ${esc(t.title)}">${icon('play')}</button><span class="n">${esc(t.n)}</span><span class="grow">${esc(t.title)}</span><span class="len">${t.length ? duration(t.length) : ''}</span></li>`).join('')}</ol>`).join('')
        + (total ? `<p class="small muted">Durée totale ${duration(total)}</p>` : ''));
    } else {
      html = `<p class="small muted">Liste des titres introuvable pour ce disque. <button class="linklike small" data-retry>Réessayer</button></p>`;
    }
  } else if (item.type === 'book') {
    html = d.overview ? sec('Résumé', text(d.overview)) : '';
  }
  return html;
}

async function loadDetails(item, force = false) {
  if (!force && (item.detailsV || 0) >= DETAILS_V) return;
  if (loadingDetails.has(item.id)) return;
  loadingDetails.add(item.id);
  const cur = store.get('items', item.id);
  try {
    if (!cur) return;
    if (isFilm(cur.type)) {
      if (!cur.tmdbId) await resolveFilm(cur);
      cur.details = cur.tmdbId ? (await filmDetails(cur.tmdbId)) || {} : {};
    } else if (cur.type === 'cd') {
      const r = await cdTracks(cur);
      cur.tracks = r.discs;
      if (r.id) cur.mbReleaseId = r.id;
    } else if (cur.type === 'book') {
      cur.details = { overview: await bookSummary(cur) };
    } else {
      return;
    }
    cur.detailsV = DETAILS_V;
    if (!store.get('items', cur.id)) return; // supprimé entre-temps
    await store.put('items', cur);
  } catch {
    // Hors ligne ou service indisponible : nouvel essai à la prochaine ouverture.
    const box = $(`#it-more[data-item="${item.id}"]`);
    if (box) box.innerHTML = '<p class="small muted">Contenu indisponible hors connexion. <button class="linklike small" data-retry>Réessayer</button></p>';
    return;
  } finally {
    loadingDetails.delete(item.id);
  }
  // Fiche toujours ouverte sur cet objet : on affiche le contenu sans tout redessiner.
  const box = $(`#it-more[data-item="${cur.id}"]`);
  if (box && !$('#sheet').hidden) {
    box.innerHTML = detailsHtml(cur);
    const tags = $('.hero-tags');
    if (cur.details?.runtime && tags && !tags.dataset.rt) {
      tags.dataset.rt = '1';
      tags.children[0].insertAdjacentHTML('afterend', `<span>${runtimeLabel(cur.details.runtime)}</span>`);
    }
  }
}

// ---------- Écoute des CD sur YouTube ----------
// Le lecteur reste visible dans la fiche (règle YouTube) et s'arrête quand on la ferme.
// Les identifiants trouvés sont gardés avec le CD : chaque recherche n'est faite qu'une fois
// (un album introuvable est recherché de nouveau au bout de 30 jours).

let ytApi = null;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return ytApi ||= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; reject(new Error('YouTube indisponible')); };
    document.head.append(s);
  });
}

async function listen(id, k, root) {
  const item = store.get('items', id);
  const slot = $('.yt-slot', root);
  if (!item || !slot) return;
  const tracks = (item.tracks || []).flatMap(d => d.tracks);
  const yt = item.yt ||= { tracks: {} };
  const track = k === null ? null : tracks[k];
  const searchLink = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${item.creator || ''} ${track ? track.title : item.title}`.trim())}`;
  slot.innerHTML = '<p class="small muted">Recherche sur YouTube…</p>';
  try {
    // Album : la playlist YouTube Music, ouverte au bon titre si l'on a touché un titre.
    if (yt.album === undefined || (!yt.album && Date.now() - (yt.at || 0) > 30 * 864e5)) {
      yt.album = await ytAlbum(item);
      yt.at = Date.now();
    }
    let play;
    if (yt.album) {
      play = { list: yt.album, index: k ?? 0 };
    } else if (track) {
      const key = trackKey(track.title);
      if (!yt.tracks[key]) yt.tracks[key] = await ytTrack(item, track.title);
      if (yt.tracks[key]) play = { video: yt.tracks[key] };
    }
    if (store.get('items', id)) await store.put('items', item);
    if (!play) {
      slot.innerHTML = `<p class="small muted">${track ? 'Titre' : 'Album'} introuvable pour l'écoute dans l'appli. <a href="${esc(searchLink)}" target="_blank" rel="noopener">Chercher sur YouTube</a></p>`;
      return;
    }
    const YT = await loadYouTube();
    slot.innerHTML = '<div class="trailer"><div></div></div>';
    const mark = i => $$('.tracks li', root).forEach(li => li.classList.toggle('playing', +li.dataset.k === i));
    new YT.Player(slot.firstChild.firstChild, {
      host: 'https://www.youtube-nocookie.com',
      playerVars: { playsinline: 1, rel: 0, autoplay: 1 },
      events: {
        onReady: e => (play.list
          ? e.target.loadPlaylist({ list: play.list, listType: 'playlist', index: play.index })
          : e.target.loadVideoById(play.video)),
        onStateChange: e => mark(play.list ? e.target.getPlaylistIndex() : k),
      },
    });
  } catch {
    slot.innerHTML = `<p class="small muted">YouTube indisponible pour le moment (connexion). <a href="${esc(searchLink)}" target="_blank" rel="noopener">Chercher sur YouTube</a></p>`;
  }
}

// Modification complète (titre, format, genres, code-barres…), depuis la fiche.
function openEdit(id) {
  const it = store.get('items', id);
  if (!it) return;
  const item = structuredClone(it);
  const wish = item.status === 'wish';
  openSheet(`
    <h2>Modifier</h2>
    <form id="itf" class="form">
      ${coverEditor(item)}
      <label>Titre<input name="title" required value="${esc(item.title)}"></label>
      <label>Auteur, artiste ou réalisateur<input name="creator" value="${esc(item.creator)}"></label>
      <div class="two">
        <label>Format${typeSelect(item.type)}</label>
        <label>Année<input name="year" inputmode="numeric" value="${esc(item.year)}"></label>
      </div>
      <label>Code-barres<input name="barcode" inputmode="numeric" value="${esc(item.barcode)}"></label>
      ${wish ? `<label>Prix estimé (€)<input name="price" inputmode="decimal" value="${item.price ?? ''}"></label>` : ''}
      ${genresFor(item.type).length ? `<fieldset>
        <legend>Genres</legend>
        <div class="chips wrap">${genresFor(item.type).map(g =>
          `<label class="chip check-chip"><input type="checkbox" name="genre" value="${genreKey(g)}" ${(item.genres || []).includes(g) ? 'checked' : ''}>${esc(genreLabel(g))}</label>`).join('')}</div>
      </fieldset>` : ''}
      <label>Notes<textarea name="notes" rows="2">${esc(item.notes)}</textarea></label>
      <div class="actions">
        <button type="button" class="btn ghost" id="itf-cancel">Annuler</button>
        <button class="btn primary">Enregistrer</button>
      </div>
    </form>`, root => {
    bindCover(root, item);
    const form = $('#itf', root);
    $('#itf-cancel', root).addEventListener('click', () => openItem(id));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      Object.assign(item, {
        title: fd.get('title').trim(), creator: fd.get('creator').trim(), year: fd.get('year').trim(),
        type: fd.get('type'), barcode: cleanCode(fd.get('barcode')), notes: fd.get('notes').trim(),
      });
      if (form.querySelector('[name=genre]')) item.genres = fd.getAll('genre').map(parseGenre);
      if (wish) item.price = parseFloat(String(fd.get('price') || '').replace(',', '.')) || null;
      await store.put('items', item);
      render();
      openItem(id);
      toast('Enregistré');
    });
  });
}

document.addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) return openItem(open.dataset.open);
  const g = e.target.closest('[data-goto]');
  if (g) go(g.dataset.goto);
});

// ---------- Collections numérotées ----------

function newCollection({ name, total, lotSize, lotPrice, perMonth, kind = '', entries }) {
  return {
    id: store.uid(), name, kind, lotSize, lotPrice, perMonth, createdAt: Date.now(),
    entries: entries || Array.from({ length: total }, (_, i) => ({ n: i + 1, title: '', owned: false })),
  };
}

const isDisney = c => c.kind === 'disney' || /disney/i.test(c.name);

const posterUrl = p => (p ? `https://image.tmdb.org/t/p/w342${p}` : '');

// Collections créées avant l'ajout des années et affiches : on les complète sans toucher aux titres modifiés.
async function enrichDisney() {
  const ref = new Map(DISNEY_LIST.map(d => [d[0], d]));
  for (const c of collections().filter(isDisney)) {
    let changed = false;
    for (const e of c.entries) {
      const d = ref.get(e.n);
      if (d && e.year === undefined && norm(d[1]) === norm(e.title)) {
        Object.assign(e, { pixar: !!d[2], year: d[3], poster: d[4] });
        changed = true;
      }
    }
    if (changed) await store.put('collections', c);
  }
}

// Un Disney coché dans la collection = un Blu-ray dans la bibliothèque.
// Lie le numéro à un objet existant de même titre, sinon crée l'objet ; le retire si on décoche.
let linking = false;
async function linkCollectionItems() {
  if (linking) return;
  linking = true;
  let created = 0;
  try {
    for (const c of collections().filter(isDisney)) {
      let changed = false;
      for (const e of c.entries) {
        const linked = e.itemId && store.get('items', e.itemId);
        if (e.owned && !linked && e.title) {
          const keys = matchKeys(e.title);
          const taken = new Set(c.entries.map(x => x.itemId).filter(Boolean));
          const match = items().find(i => isFilm(i.type) && !taken.has(i.id) && [...matchKeys(i.title)].some(k => keys.has(k)));
          if (match) {
            if (match.status === 'wish') { match.status = 'owned'; match.addedAt = Date.now(); await store.put('items', match); }
            e.itemId = match.id;
          } else {
            const obj = {
              id: store.uid(), type: 'bluray', title: e.title, creator: '', year: e.year ? String(e.year) : '', barcode: '', cover: posterUrl(e.poster),
              status: 'owned', price: null, loan: null, loanHistory: [], digital: { has: false, location: '' },
              notes: '', addedAt: Date.now(), source: `Collection ${c.name}`, fromCollection: c.id,
            };
            await store.put('items', obj);
            e.itemId = obj.id;
            created++;
          }
          changed = true;
        } else if (!e.owned && e.itemId) {
          // Décoché : on retire l'objet seulement s'il avait été créé par la collection.
          if (linked?.fromCollection && !linked.loan) await store.remove('items', e.itemId);
          delete e.itemId;
          changed = true;
        } else if (e.itemId && !linked) {
          delete e.itemId;
          changed = true;
        }
      }
      if (changed) await store.put('collections', c);
    }
  } finally {
    linking = false;
  }
  if (created) fillCovers();
  return created;
}

// Affiches des Blu-ray créés depuis la collection, cherchées en arrière-plan sur TMDB.
// Retrouve le film TMDB d'un objet (et complète affiche, année, genres manquants).
// Même titre obligatoire ; même année si on la connaît ; sinon, pour un Grand Classique,
// le plus ancien film d'animation (« Cendrillon » 1950 plutôt que 2015).
async function resolveFilm(cur) {
  const res = await searchTitle(cur.title.split(' + ')[0], cur.type);
  const keys = matchKeys(cur.title.split(' + ')[0]);
  const exact = res.filter(r => [...matchKeys(r.title)].some(k => keys.has(k)));
  const y = +cur.year;
  const best = (y && exact.find(r => Math.abs(+r.year - y) <= 1))
    || (y ? null : exact.slice().sort((a, b) => (b.animated - a.animated) || ((a.year || '9999') < (b.year || '9999') ? -1 : 1))[0])
    || (exact.length === 1 ? exact[0] : null);
  if (best) {
    cur.tmdbId = best.tmdbId;
    if (!cur.cover && best.cover) cur.cover = best.cover;
    if (!cur.year && best.year) cur.year = best.year;
    if (!cur.genres?.length) cur.genres = best.genres || [];
  }
  return best;
}

let filling = false;
const ENRICH_V = 2; // à augmenter si l'enrichissement récupère de nouvelles informations

async function fillCovers() {
  if (filling) return;
  filling = true;
  let done = 0;
  try {
    // Films ajoutés avant les genres, sans affiche, ou pas encore passés par les mots-clés TMDB.
    for (const it of items().filter(i => (isFilm(i.type) || i.type === 'cd' || i.type === 'book') && (i.enrichV || 0) < ENRICH_V)) {
      try {
        const cur = store.get('items', it.id);
        if (!cur) continue;
        if (!isFilm(cur.type)) {
          // CD : MusicBrainz (1 requête par seconde) ; livres : Open Library.
          if (!cur.genres?.length) cur.genres = cur.type === 'cd' ? await fetchMusicGenres(cur) : await fetchBookGenres(cur);
          cur.enrichV = ENRICH_V;
          if (!store.get('items', cur.id)) continue; // supprimé pendant la recherche
          await store.put('items', cur);
          if (++done % 5 === 0 && state.tab === 'library' && !$('#sheet:not([hidden])')) render();
          await new Promise(r => setTimeout(r, cur.type === 'cd' ? 1100 : 200));
          continue;
        }
        if (!cur.tmdbId) await resolveFilm(cur);
        cur.genres ??= [];
        if (cur.tmdbId) {
          const kw = await filmKeywords(cur.tmdbId);
          for (const g of KEYWORD_GENRES) if (kw.includes(g) && !cur.genres.includes(g)) cur.genres.push(g);
        }
        cur.enrichV = ENRICH_V;
        if (!store.get('items', cur.id)) continue; // supprimé pendant la recherche
        await store.put('items', cur);
        if (++done % 5 === 0 && state.tab === 'library' && !$('#sheet:not([hidden])')) render();
      } catch { /* hors ligne : nouvel essai au prochain démarrage */ break; }
      await new Promise(r => setTimeout(r, 200));
    }
  } finally {
    filling = false;
    if (done && state.tab === 'library' && !$('#sheet:not([hidden])')) render();
  }
}

// Remplit les titres depuis la liste officielle, sans toucher aux cases cochées.
function applyDisneyList(c) {
  let added = 0;
  for (const [n, title, pixar, year, poster] of DISNEY_LIST) {
    let e = c.entries.find(x => x.n === n);
    if (!e) { e = { n, title: '', owned: false }; c.entries.push(e); added++; }
    Object.assign(e, { title, pixar: !!pixar, year, poster });
  }
  c.entries.sort((a, b) => a.n - b.n);
  c.kind = 'disney';
  return added;
}

function colStats(c) {
  const total = c.entries.length;
  const have = c.entries.filter(e => e.owned).length;
  const left = total - have;
  const unit = c.lotPrice / c.lotSize;
  const months = c.perMonth > 0 ? Math.ceil(left / c.perMonth) : Infinity;
  const end = new Date();
  end.setMonth(end.getMonth() + (Number.isFinite(months) ? months : 0));
  return { total, have, left, unit, budget: left * unit, months, lots: Math.ceil(left / c.lotSize), end };
}

// "1-5, 8, 12" -> [1,2,3,4,5,8,12]
function parseNumbers(s) {
  const out = new Set();
  for (const part of String(s).split(/[,;\s]+/)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b) && n - a < 1000; n++) out.add(n);
  }
  return [...out];
}

// Toucher une affiche du mur la coche ou la décoche (et ajoute ou retire le Blu-ray de la bibliothèque).
// Un seul écouteur pour toute l'appli : le mur est redessiné à chaque changement.
$('#view').addEventListener('click', async e => {
  const b = e.target.closest('[data-own]');
  if (!b || state.tab !== 'collection') return;
  const c = collections().find(x => x.id === state.collectionId);
  const entry = c?.entries.find(x => x.n === +b.dataset.own);
  if (!entry) return;
  entry.owned = !entry.owned;
  navigator.vibrate?.(15);
  await store.put('collections', c);
  await linkCollectionItems();
  render(); // recalcule compteur, budget et mois
  toast(entry.owned ? `N°${entry.n} possédé${isDisney(c) ? ', ajouté à la bibliothèque' : ''}` : `N°${entry.n} retiré`);
});

function wallTile(e) {
  return `<button class="wall-tile ${e.owned ? 'owned' : ''}" data-own="${e.n}" aria-pressed="${e.owned}" aria-label="N°${e.n} ${esc(e.title)}, ${e.owned ? 'possédé' : 'manquant'}">
    ${cover({ title: e.title || `N°${e.n}`, cover: posterUrl(e.poster) }, `<span class="no">${e.n}</span><span class="mark">${icon(e.owned ? 'check' : 'plus')}</span>`)}
    <div class="t">${esc(e.title || '')}</div>
  </button>`;
}

function renderCollection(v) {
  const cols = collections();
  if (!cols.length) {
    v.innerHTML = `
      <div class="col-head"><h2>Les Grands Classiques Disney et Pixar</h2></div>
      <p>La collection numérotée de Disney France : ${DISNEY_LIST.length} films, de « ${esc(DISNEY_LIST[0][1])} » à « ${esc(DISNEY_LIST.at(-1)[1])} », avec leurs affiches. Il ne reste qu'à toucher ceux que vous possédez.</p>
      <div class="shelf-row" style="margin-bottom:16px">${DISNEY_LIST.slice(-8).reverse().map(d => `<div class="tile">${cover({ title: d[1], cover: posterUrl(d[4]) })}</div>`).join('')}</div>
      <button class="btn primary block big" id="c-disney">Créer ma collection Disney</button>
      <button class="btn block ghost" id="c-new">${icon('plus')}Créer une autre collection</button>`;
    $('#c-disney').addEventListener('click', async () => {
      const c = newCollection({ name: 'Disney & Pixar', kind: 'disney', lotSize: 4, lotPrice: 30, perMonth: 4, entries: [] });
      applyDisneyList(c);
      await store.put('collections', c);
      state.collectionId = c.id;
      render();
      toast('Collection créée : cochez vos titres possédés');
    });
    $('#c-new').addEventListener('click', () => editCollection());
    return;
  }
  let c = cols.find(x => x.id === state.collectionId) || cols[0];
  state.collectionId = c.id;
  const s = colStats(c);
  const pct = s.total ? Math.round((s.have / s.total) * 100) : 0;
  const next = c.entries.filter(e => !e.owned).slice(0, c.lotSize);
  const endTxt = s.left === 0 ? 'Collection complète 🎉' : Number.isFinite(s.months) ? `fin estimée ${s.end.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}` : '';

  const endLabel = s.left === 0 ? 'complète' : Number.isFinite(s.months) ? `fin ${s.end.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })}` : '';
  v.innerHTML = `
    ${cols.length > 1 ? `<select id="c-pick" class="pick" style="margin-top:14px" aria-label="Collection">${cols.map(x => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
    <div class="col-head"><h2>${esc(c.name)}</h2></div>
    <div class="col-score"><b>${s.have}</b><span>sur ${s.total} possédés</span></div>
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
    <div class="col-stats">
      <div><b>${s.left}</b><span>à acheter</span></div>
      <div><b>${euro(s.budget)}</b><span>budget restant</span></div>
      <div><b>${Number.isFinite(s.months) ? `${s.months} mois` : '—'}</b><span>${endLabel}</span></div>
    </div>
    <p class="small muted">${c.lotSize} pour ${euro(c.lotPrice)}, soit ${euro(s.unit)} pièce, ${c.perMonth} par mois.</p>
    ${next.length && s.left ? `<section class="shelf">
      <div class="shelf-head"><h2>Prochain lot</h2></div>
      <div class="shelf-row">${next.map(e => wallTile(e)).join('')}</div>
    </section>` : ''}
    <div class="chips">
      <button class="chip" id="c-bulk">Cocher par numéros</button>
      ${isDisney(c) ? '<button class="chip" id="c-official">Mettre à jour la liste</button>' : ''}
      <button class="chip" id="c-extend">Nouveaux numéros</button>
      <button class="chip" id="c-paste">Modifier les titres</button>
      <button class="chip" id="c-edit">Réglages</button>
    </div>
    <div class="toolbar">
      <label class="searchbox">${icon('search')}<input type="search" id="c-q" placeholder="Titre ou numéro" value="${esc(state.colQ)}" aria-label="Chercher dans la collection"></label>
    </div>
    <div class="seg">
      ${[['all', `Tous (${s.total})`], ['missing', `Manquants (${s.left})`], ['owned', `Possédés (${s.have})`]].map(([k, l]) => `<button class="${state.colFilter === k ? 'on' : ''}" data-cf="${k}">${l}</button>`).join('')}
    </div>
    <div id="c-list" class="wall"></div>`;

  const draw = () => {
    const q = norm(state.colQ);
    const list = c.entries.filter(e =>
      (state.colFilter === 'all' || (state.colFilter === 'owned') === e.owned) &&
      (!q || String(e.n) === state.colQ.trim() || norm(e.title).includes(q)));
    $('#c-list').innerHTML = list.map(e => wallTile(e)).join('') || '<div class="empty" style="grid-column:1/-1">Aucun numéro ici.</div>';
  };
  draw();

  $('#c-pick')?.addEventListener('change', e => { state.collectionId = e.target.value; render(); });
  $('#c-edit').addEventListener('click', () => editCollection(c));
  $('#c-q').addEventListener('input', e => { state.colQ = e.target.value; draw(); });
  $$('[data-cf]', v).forEach(b => b.addEventListener('click', () => { state.colFilter = b.dataset.cf; render(); }));

  $('#c-bulk').addEventListener('click', () => openSheet(`
    <h2>Cocher des numéros possédés</h2>
    <p class="muted small">Exemple : <code>1-5, 8, 12, 20-22</code></p>
    <form id="bf" class="form">
      <input name="nums" inputmode="text" placeholder="1-5, 8, 12" required>
      <div class="seg"><button type="button" class="on" data-m="1">Possédés</button><button type="button" data-m="0">Non possédés</button></div>
      <div class="actions"><button type="button" class="btn ghost" data-close>Annuler</button><button class="btn primary">Appliquer</button></div>
    </form>`, root => {
    let mark = true;
    $$('[data-m]', root).forEach(b => b.addEventListener('click', () => { mark = b.dataset.m === '1'; $$('[data-m]', root).forEach(x => x.classList.toggle('on', x === b)); }));
    $('#bf', root).addEventListener('submit', async e => {
      e.preventDefault();
      const nums = parseNumbers(e.target.elements.nums.value);
      let k = 0;
      for (const en of c.entries) if (nums.includes(en.n)) { en.owned = mark; k++; }
      await store.put('collections', c);
      await linkCollectionItems();
      closeSheet(); toast(`${k} numéro${k > 1 ? 's' : ''} mis à jour`); render();
    });
  }));

  $('#c-paste').addEventListener('click', () => openSheet(`
    <h2>Coller la liste des titres</h2>
    <p class="muted small">Un titre par ligne, dans l'ordre des numéros à partir de N°1. Vous pouvez aussi écrire <code>12;Le Roi Lion</code> pour viser un numéro précis. Les lignes en trop créent de nouveaux numéros.</p>
    <form id="pf" class="form">
      <textarea name="list" rows="10" placeholder="Blanche-Neige et les Sept Nains&#10;Pinocchio&#10;…">${esc(c.entries.map(e => e.title).join('\n').replace(/\n+$/, ''))}</textarea>
      <div class="actions"><button type="button" class="btn ghost" data-close>Annuler</button><button class="btn primary">Enregistrer</button></div>
    </form>`, root => {
    $('#pf', root).addEventListener('submit', async e => {
      e.preventDefault();
      const lines = e.target.elements.list.value.split('\n');
      let n = 0;
      for (const raw of lines) {
        const line = raw.trim();
        const m = line.match(/^(?:n°\s*)?(\d+)\s*[;:.)\t-]\s*(.+)$/i);
        n = m ? +m[1] : n + 1;
        const title = m ? m[2].trim() : line;
        if (!m && !line) continue;
        let en = c.entries.find(x => x.n === n);
        if (!en) { en = { n, title: '', owned: false }; c.entries.push(en); }
        en.title = title;
      }
      c.entries.sort((a, b) => a.n - b.n);
      await store.put('collections', c);
      closeSheet(); toast('Titres enregistrés'); render();
    });
  }));

  $('#c-official')?.addEventListener('click', async () => {
    if (!confirm(`Remplir les titres avec la liste officielle (${DISNEY_LIST.length} numéros, source : ${DISNEY_SOURCE}) ?\n\nVos cases cochées sont conservées ; les titres saisis à la main sont remplacés.`)) return;
    const added = applyDisneyList(c);
    await store.put('collections', c);
    await linkCollectionItems();
    toast(`Liste officielle appliquée${added ? ` (+${added} numéros)` : ''}`); render();
  });

  $('#c-extend').addEventListener('click', async () => {
    const k = parseInt(prompt('Combien de nouveaux numéros Disney a-t-il ajoutés ?', '1'), 10);
    if (!(k > 0)) return;
    const max = Math.max(0, ...c.entries.map(e => e.n));
    for (let i = 1; i <= k; i++) c.entries.push({ n: max + i, title: '', owned: false });
    await store.put('collections', c);
    toast(`Collection portée à ${c.entries.length} numéros`); render();
  });
}

function editCollection(c) {
  const isNew = !c;
  c ??= { name: '', lotSize: 1, lotPrice: 10, perMonth: 1, entries: [] };
  openSheet(`
    <h2>${isNew ? 'Nouvelle collection' : 'Réglages de la collection'}</h2>
    <form id="ef" class="form">
      <label>Nom<input name="name" required value="${esc(c.name)}"></label>
      ${isNew ? '<label>Nombre de numéros<input name="total" inputmode="numeric" required value="10"></label>' : `<p class="muted small">${c.entries.length} numéros (utilisez « Nouveaux numéros » pour en ajouter).</p>`}
      <div class="two">
        <label>Articles par lot<input name="lotSize" inputmode="numeric" required value="${c.lotSize}"></label>
        <label>Prix du lot (€)<input name="lotPrice" inputmode="decimal" required value="${c.lotPrice}"></label>
      </div>
      <label>Articles achetés par mois<input name="perMonth" inputmode="numeric" required value="${c.perMonth}"></label>
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="btn danger ghost" id="ef-del">Supprimer</button>'}
        <button class="btn primary">Enregistrer</button>
      </div>
    </form>`, root => {
    $('#ef', root).addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target.elements;
      const num = x => Math.max(0, parseFloat(String(x).replace(',', '.')) || 0);
      const vals = { name: f.name.value.trim(), lotSize: Math.max(1, num(f.lotSize.value)), lotPrice: num(f.lotPrice.value), perMonth: num(f.perMonth.value) };
      const col = isNew ? newCollection({ ...vals, total: Math.max(1, Math.min(2000, num(f.total.value))) }) : Object.assign(c, vals);
      await store.put('collections', col);
      state.collectionId = col.id;
      closeSheet(); render();
    });
    $('#ef-del', root)?.addEventListener('click', async () => {
      if (!confirm(`Supprimer la collection « ${c.name} » ? (les objets de la bibliothèque sont conservés)`)) return;
      await store.remove('collections', c.id);
      state.collectionId = null;
      closeSheet(); render();
    });
  });
}

// ---------- Plus : prêts, sauvegarde, réglages ----------

function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function itemsCsv() {
  const head = ['type', 'titre', 'auteur_artiste', 'annee', 'code_barres', 'statut', 'prix_souhait', 'prete_a', 'prete_depuis', 'version_numerique', 'emplacement_fichier', 'notes', 'ajoute_le'];
  const rows = items().map(i => [TYPES[i.type], i.title, i.creator, i.year, i.barcode, i.status === 'wish' ? 'souhait' : 'possédé', i.price ?? '',
    i.loan?.to ?? '', i.loan?.since ?? '', i.digital?.has ? 'oui' : '', i.digital?.location ?? '', i.notes, new Date(i.addedAt).toISOString().slice(0, 10)]);
  for (const c of collections()) for (const e of c.entries) {
    rows.push([`Collection ${c.name}`, `N°${e.n} ${e.title}`.trim(), '', '', '', e.owned ? 'possédé' : 'manquant', '', '', '', '', '', '', '']);
  }
  // Point-virgule + BOM : s'ouvre directement dans Excel en français.
  return '﻿' + [head, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n');
}

async function saveFile(name, content, mime) {
  const file = new File([content], name, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}

function renderMore(v) {
  const loans = owned().filter(i => i.loan).sort((a, b) => a.loan.since.localeCompare(b.loan.since));
  const last = store.meta('lastExport');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const acc = account.current();
  v.innerHTML = `
    <div class="panel">
      <h2>Mon compte</h2>
      ${acc?.token ? `
        <p>Connecté avec <b>${esc(acc.email)}</b>. Votre bibliothèque est la même sur tous les appareils où vous vous connectez.</p>
        <p class="small" id="sync-status">${syncStatusText()}</p>
        <div class="tools">
          <button class="btn small" id="acc-sync">Synchroniser maintenant</button>
          <button class="btn small" id="acc-pass">Changer le mot de passe</button>
          <button class="btn small" id="acc-out">Se déconnecter</button>
        </div>
        <button class="btn small ghost danger" id="acc-del">Supprimer mon compte</button>`
      : acc?.expired ? `
        <div class="alert danger">Session expirée pour <b>${esc(acc.email)}</b>. Reconnectez-vous pour reprendre la synchronisation.</div>
        <button class="btn primary block" data-auth="login">Se reconnecter</button>`
      : `
        <p>Créez un compte pour retrouver votre bibliothèque sur votre téléphone, une tablette ou un ordinateur. Tout se synchronise tout seul.</p>
        <div class="stack">
          <button class="btn primary big" data-auth="register">Créer un compte</button>
          <button class="btn" data-auth="login">J'ai déjà un compte</button>
        </div>`}
    </div>

    <div class="panel">
      <h2>Prêts en cours (${loans.length})</h2>
      ${loans.length ? loans.map(i => {
        const days = Math.floor((Date.now() - new Date(i.loan.since)) / 864e5);
        return `<div class="row"><button class="grow linklike" data-open="${i.id}"><b>${esc(i.title)}</b><br><span class="small muted">${TYPES[i.type]} · ${esc(i.loan.to)} · depuis ${days} j</span></button><button class="btn small" data-ret="${i.id}">Rendu</button></div>`;
      }).join('') : '<p class="muted">Aucun objet prêté.</p>'}
    </div>

    <${acc?.token ? 'details' : 'div'} class="panel">
      ${acc?.token ? '<summary><b>Code de récupération (sans compte)</b></summary>' : '<h2>Sauvegarde automatique</h2>'}
      ${acc?.token ? '<p class="small muted">Votre compte assure déjà la sauvegarde. Ce code reste utilisable pour restaurer une copie journalière.</p>' : `<p class="small" id="sync-status">${syncStatusText()}</p>`}
      <p class="small">Votre <b>code de récupération</b> : notez-le (photo, carnet, gestionnaire de mots de passe). Il permet de retrouver toute la bibliothèque sur un nouveau téléphone. Gardez-le pour vous.</p>
      <div class="code-box"><code id="sync-code">${esc(sync.formatToken(sync.token()))}</code><button class="btn small" id="sync-copy">Copier</button></div>
      <div class="tools">
        <button class="btn small" id="sync-now">Sauvegarder maintenant</button>
        <button class="btn small" id="sync-restore">Restaurer une sauvegarde…</button>
      </div>
    </${acc?.token ? 'details' : 'div'}>

    <div class="panel">
      <h2>Export manuel</h2>
      <p class="small">Une copie en fichier en plus (Fichiers, Drive, mail…), ou un tableau CSV pour Excel.</p>
      <p class="muted small">Dernier export : ${last ? frDate(last) : 'jamais'}</p>
      <div class="tools">
        <button class="btn primary" id="m-json">Exporter (JSON complet)</button>
        <button class="btn" id="m-csv">Exporter (CSV tableur)</button>
        <label class="btn">Importer une sauvegarde<input type="file" accept=".json,application/json" id="m-import" hidden></label>
        <label class="btn">Importer depuis Babelio<input type="file" accept=".csv,text/csv,text/comma-separated-values" id="m-babelio" hidden></label>
      </div>
    </div>

    <details class="panel">
      <summary><b>Réglages avancés (films)</b></summary>
      <p class="small">Les codes-barres de films et les affiches passent par le relais gratuit de l'appli${RELAY_DEFAULT ? '' : ' (pas encore configuré : recherche sur Wikipédia)'}. Ne changez ces champs que si vous savez pourquoi.</p>
      <form class="form" id="m-adv">
        <label>Adresse du relais<input name="relay" placeholder="${esc(RELAY_DEFAULT || 'https://…workers.dev')}" value="${esc(store.meta('relayUrl', ''))}" autocomplete="off"></label>
        <label>Clé TMDB personnelle (facultatif)<input name="k" placeholder="Clé TMDB v3" value="${esc(store.meta('tmdbKey', ''))}" autocomplete="off"></label>
        <button class="btn">Enregistrer</button>
      </form>
    </details>

    ${standalone ? '' : `<div class="panel">
      <h2>Installer sur l'écran d'accueil</h2>
      <p class="small"><b>iPhone (Safari)</b> : bouton Partager (le carré avec une flèche) puis « Sur l'écran d'accueil ».<br><b>Android (Chrome)</b> : menu à trois points puis « Installer l'application ».</p>
    </div>`}

    <div class="panel">
      <h2>À propos</h2>
      <p class="small muted">100 % gratuit, sans compte. Données : Open Library (livres), MusicBrainz et Cover Art Archive (CD), DVDFr, UPCitemdb et TMDB (films, « This product uses the TMDB API but is not endorsed or certified by TMDB »), Wikipédia. Scan : détecteur natif du navigateur ou ZXing (open source).</p>
      <button class="btn small danger ghost" id="m-wipe">Tout effacer</button>
    </div>`;

  store.setMeta('syncCodeSeen', true);
  $$('[data-auth]', v).forEach(b => b.addEventListener('click', () => openAuth(b.dataset.auth)));
  $('#acc-sync')?.addEventListener('click', async () => {
    const n = await sync.pull(true);
    toast(n === null ? `Échec : ${sync.status().error || 'réseau'}` : `Synchronisé : ${n} objet${n > 1 ? 's' : ''}`);
    render();
  });
  $('#acc-pass')?.addEventListener('click', openPasswordChange);
  $('#acc-out')?.addEventListener('click', async () => {
    if (!confirm('Se déconnecter ? Votre bibliothèque reste sur cet appareil et sur votre compte.')) return;
    await account.logout();
    toast('Déconnecté'); render();
  });
  $('#acc-del')?.addEventListener('click', openAccountDelete);
  $('#sync-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(sync.formatToken(sync.token())); toast('Code copié'); }
    catch { toast('Copie impossible : recopiez le code à la main'); }
  });
  $('#sync-now').addEventListener('click', async () => {
    if (!items().length && !collections().length) return toast('Bibliothèque vide : rien à sauvegarder');
    await sync.push();
    toast(sync.status().error ? `Échec : ${sync.status().error}` : 'Sauvegardé');
  });
  $('#sync-restore').addEventListener('click', openRestore);

  $$('[data-ret]', v).forEach(b => b.addEventListener('click', async () => {
    const i = store.get('items', b.dataset.ret);
    i.loanHistory = [...(i.loanHistory || []), { ...i.loan, returned: today() }];
    i.loan = null;
    await store.put('items', i);
    toast('Retour enregistré'); render();
  }));
  const stamp = new Date().toISOString().slice(0, 10);
  $('#m-json').addEventListener('click', async () => {
    if (await saveFile(`bibliotheque-${stamp}.json`, JSON.stringify(store.dump(), null, 1), 'application/json')) {
      await store.setMeta('lastExport', Date.now()); render();
    }
  });
  $('#m-csv').addEventListener('click', () => saveFile(`bibliotheque-${stamp}.csv`, itemsCsv(), 'text/csv'));
  // Export Babelio (Mes livres → Exporter) : ajoute les livres absents de la bibliothèque.
  $('#m-babelio').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let books;
    try { books = parseBabelio(await readText(file)); } catch (err) { return toast(err.message, 5000); }
    const isDup = b => findDuplicates(b).some(d => d.item.type === 'book' || (b.barcode && d.item.barcode === b.barcode));
    const fresh = books.filter(b => !isDup(b));
    if (!fresh.length) return toast(`Les ${books.length} livres de ce fichier sont déjà dans votre bibliothèque`);
    const known = books.length - fresh.length;
    if (!confirm(`${books.length} livres dans l'export Babelio.\n${fresh.length} à ajouter${known ? `, ${known} déjà présents (ignorés)` : ''}.\n\nLes ajouter à votre bibliothèque ?`)) return;
    toast(`Ajout de ${fresh.length} livres…`, 10000);
    for (const b of fresh) {
      await store.put('items', {
        id: store.uid(), ...b, status: 'owned', genres: [], price: null,
        loan: null, loanHistory: [], digital: { has: false, location: '' }, notes: '',
      });
    }
    toast(`${fresh.length} livres ajoutés. Les genres arrivent en arrière-plan.`, 4000);
    state.filter.type = 'book';
    go('library');
    fillCovers();
  });

  $('#m-import').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { return toast('Fichier illisible'); }
    if (data?.app !== 'bibliotheque-physique' || !Array.isArray(data.items)) return toast("Ce n'est pas une sauvegarde de cette appli");
    const replace = confirm(`Sauvegarde du ${frDate(data.exportedAt)} : ${data.items.length} objets, ${data.collections?.length || 0} collection(s).\n\nOK = REMPLACER les données actuelles\nAnnuler = FUSIONNER avec les données actuelles`);
    if (replace) {
      const key = store.meta('tmdbKey');
      await store.replaceAll(data);
      await linkCollectionItems();
      if (key) await store.setMeta('tmdbKey', key);
    } else {
      for (const s of ['items', 'collections']) {
        for (const r of data[s] || []) {
          const cur = store.get(s, r.id);
          if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) await store.put(s, r);
        }
      }
    }
    toast('Import terminé'); render();
  });
  $('#m-adv').addEventListener('submit', async e => {
    e.preventDefault();
    await store.setMeta('relayUrl', e.target.elements.relay.value.trim());
    await store.setMeta('tmdbKey', e.target.elements.k.value.trim());
    toast('Réglages enregistrés');
  });
  $('#m-wipe').addEventListener('click', async () => {
    if (!confirm('Effacer TOUTE la bibliothèque de ce téléphone ? Pensez à exporter avant.')) return;
    if (!confirm('Vraiment ? Cette action est définitive.')) return;
    await store.replaceAll({});
    toast('Données effacées'); render();
  });
}

function syncStatusText() {
  const st = sync.status();
  if (!st.enabled) return 'Désactivée : relais non configuré.';
  if (st.error && st.pending) return `Dernière modification pas encore envoyée (${esc(st.error)}). Nouvel essai automatique.${st.lastSync ? ` Synchronisation précédente ${ago(st.lastSync)}.` : ''}`;
  if (st.error && st.account) return `Synchronisation en attente (${esc(st.error)}).`;
  if (st.pending) return 'Modification en cours d\'envoi…';
  if (st.lastSync) return st.account ? `À jour, synchronisé ${ago(st.lastSync)}.` : `À jour : dernière sauvegarde ${ago(st.lastSync)}. Une copie de chaque jour est aussi gardée 60 jours.`;
  return st.account ? 'À jour.' : 'Activée. La première sauvegarde partira dès le premier ajout.';
}

// ---------- Compte ----------

const passwordField = (name, label, auto) => `<label>${label}
  <span class="pw"><input name="${name}" type="password" autocomplete="${auto}" required minlength="${auto === 'current-password' ? 1 : 8}">
  <button type="button" class="linklike small" data-show>Afficher</button></span></label>`;

function bindPasswordToggles(root) {
  $$('[data-show]', root).forEach(b => b.addEventListener('click', () => {
    const input = b.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
    b.textContent = input.type === 'password' ? 'Afficher' : 'Masquer';
  }));
}

// Pendant le calcul de la clé (une fraction de seconde) et l'échange avec le serveur.
async function busy(form, label, fn) {
  const btn = $('button.primary', form);
  const before = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  const err = $('.form-error', form);
  err.hidden = true;
  try { return await fn(); }
  catch (e) { err.textContent = e.message; err.hidden = false; return undefined; }
  finally { btn.disabled = false; btn.textContent = before; }
}

function openAuth(mode = 'register') {
  const email = account.current()?.email || '';
  const views = {
    register: {
      title: 'Créer un compte',
      intro: 'Votre bibliothèque actuelle sera enregistrée sur ce compte, puis retrouvée sur chaque appareil où vous vous connectez.',
      fields: `<label>Adresse e-mail<input name="email" type="email" autocomplete="email" required value="${esc(email)}"></label>
        ${passwordField('password', 'Mot de passe (8 caractères minimum)', 'new-password')}
        ${passwordField('confirm', 'Confirmer le mot de passe', 'new-password')}`,
      submit: 'Créer mon compte',
      links: '<button type="button" class="linklike small" data-auth="login">J\'ai déjà un compte</button>',
    },
    login: {
      title: 'Se connecter',
      intro: 'Votre bibliothèque en ligne sera fusionnée avec celle de cet appareil : rien n\'est perdu.',
      fields: `<label>Adresse e-mail<input name="email" type="email" autocomplete="email" required value="${esc(email)}"></label>
        ${passwordField('password', 'Mot de passe', 'current-password')}`,
      submit: 'Se connecter',
      links: '<button type="button" class="linklike small" data-auth="reset">Mot de passe oublié ?</button><button type="button" class="linklike small" data-auth="register">Créer un compte</button>',
    },
    reset: {
      title: 'Mot de passe oublié',
      intro: 'Saisissez le code de secours reçu à la création du compte, puis choisissez un nouveau mot de passe. Vos autres appareils devront se reconnecter.',
      fields: `<label>Adresse e-mail<input name="email" type="email" autocomplete="email" required value="${esc(email)}"></label>
        <label>Code de secours<input name="recovery" autocomplete="off" autocapitalize="characters" required placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"></label>
        ${passwordField('password', 'Nouveau mot de passe (8 caractères minimum)', 'new-password')}`,
      submit: 'Changer le mot de passe',
      links: '<button type="button" class="linklike small" data-auth="login">Retour à la connexion</button>',
    },
  };
  const view = views[mode];
  openSheet(`
    <h2>${view.title}</h2>
    <p class="small muted">${view.intro}</p>
    <form class="form" id="auth-f" novalidate>
      ${view.fields}
      <p class="alert danger form-error" hidden></p>
      <button class="btn primary big">${view.submit}</button>
      <div class="tools" style="justify-content:space-between">${view.links}</div>
    </form>`, root => {
    bindPasswordToggles(root);
    $$('[data-auth]', root).forEach(b => b.addEventListener('click', () => openAuth(b.dataset.auth)));
    const form = $('#auth-f', root);
    setTimeout(() => (form.elements.email.value ? form.elements.password : form.elements.email).focus(), 250);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const f = form.elements;
      const err = $('.form-error', form);
      const show = msg => { err.textContent = msg; err.hidden = false; };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) return show('Adresse e-mail invalide.');
      if (mode !== 'login' && f.password.value.length < 8) return show('Le mot de passe doit faire au moins 8 caractères.');
      if (mode === 'register' && f.password.value !== f.confirm.value) return show('Les deux mots de passe ne correspondent pas.');
      if (mode === 'reset' && account.parseCode(f.recovery.value).length !== 20) return show('Le code de secours compte 20 caractères.');
      if (mode === 'register') {
        const code = await busy(form, 'Création…', () => account.register(f.email.value, f.password.value));
        if (code) showRecovery(code);
      } else if (mode === 'login') {
        const n = await busy(form, 'Connexion…', () => account.login(f.email.value, f.password.value));
        if (n !== undefined) { closeSheet(); await linkCollectionItems(); render(); toast(`Connecté : ${n} objet${n > 1 ? 's' : ''} dans votre bibliothèque`); fillCovers(); }
      } else {
        const n = await busy(form, 'Modification…', () => account.reset(f.email.value, f.recovery.value, f.password.value));
        if (n !== undefined) { closeSheet(); render(); toast('Mot de passe changé, vous êtes connecté'); }
      }
    });
  });
}

// Le code de secours n'est affiché qu'une fois : on demande de confirmer qu'il est noté.
function showRecovery(code) {
  openSheet(`
    <h2>Notez votre code de secours</h2>
    <p>Il remplace « mot de passe oublié » : sans lui, un mot de passe perdu ne peut pas être récupéré. Il ne sera plus affiché.</p>
    <div class="code-box"><code>${esc(account.formatCode(code))}</code><button class="btn small" id="rc-copy">Copier</button></div>
    <p class="small muted">Gardez-le dans un gestionnaire de mots de passe, en photo ou sur papier.</p>
    <label class="toggle"><input type="checkbox" id="rc-ok"> J'ai noté ce code</label>
    <button class="btn primary block big" id="rc-done" disabled>Terminer</button>`, root => {
    $('#rc-copy', root).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(account.formatCode(code)); toast('Code copié'); } catch { toast('Copie impossible : recopiez le code à la main'); }
    });
    $('#rc-ok', root).addEventListener('change', e => { $('#rc-done', root).disabled = !e.target.checked; });
    $('#rc-done', root).addEventListener('click', () => { closeSheet(); render(); toast('Compte créé : votre bibliothèque est synchronisée'); });
  });
}

function openPasswordChange() {
  openSheet(`
    <h2>Changer le mot de passe</h2>
    <form class="form" id="pw-f" novalidate>
      ${passwordField('old', 'Mot de passe actuel', 'current-password')}
      ${passwordField('password', 'Nouveau mot de passe (8 caractères minimum)', 'new-password')}
      <p class="alert danger form-error" hidden></p>
      <button class="btn primary big">Changer le mot de passe</button>
    </form>`, root => {
    bindPasswordToggles(root);
    const form = $('#pw-f', root);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (form.elements.password.value.length < 8) { const err = $('.form-error', form); err.textContent = 'Le nouveau mot de passe doit faire au moins 8 caractères.'; err.hidden = false; return; }
      const ok = await busy(form, 'Modification…', () => account.changePassword(form.elements.old.value, form.elements.password.value).then(() => true));
      if (ok) { closeSheet(); toast('Mot de passe changé'); }
    });
  });
}

function openAccountDelete() {
  openSheet(`
    <h2>Supprimer mon compte</h2>
    <p>Le compte et la bibliothèque en ligne seront effacés. La bibliothèque reste sur cet appareil, mais ne sera plus synchronisée.</p>
    <form class="form" id="del-f" novalidate>
      ${passwordField('password', 'Mot de passe', 'current-password')}
      <p class="alert danger form-error" hidden></p>
      <button class="btn primary big" style="background:var(--danger);border-color:var(--danger);color:#fff">Supprimer définitivement</button>
    </form>`, root => {
    bindPasswordToggles(root);
    const form = $('#del-f', root);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const ok = await busy(form, 'Suppression…', () => account.deleteAccount(form.elements.password.value).then(() => true));
      if (ok) { closeSheet(); render(); toast('Compte supprimé'); }
    });
  });
}

function openRestore() {
  openSheet(`
    <h2>Restaurer une sauvegarde</h2>
    <p class="small">Pour un nouveau téléphone, saisissez le code de récupération de l'ancien. Pour revenir en arrière, choisissez un jour.</p>
    <form id="rf" class="form">
      <label>Code de récupération<input name="code" autocomplete="off" autocapitalize="characters" value="${esc(sync.formatToken(sync.token()))}"></label>
      <button class="btn">Chercher</button>
    </form>
    <div id="rf-res"></div>`, root => {
    const res = $('#rf-res', root);
    $('#rf', root).addEventListener('submit', async e => {
      e.preventDefault();
      const code = sync.parseToken(e.target.elements.code.value);
      if (code.length < 20) return toast('Code incomplet');
      res.innerHTML = '<p class="notice">Recherche…</p>';
      try {
        const [latest, days] = await Promise.all([sync.fetchRemote(code), sync.fetchDays(code)]);
        if (!latest) { res.innerHTML = '<p class="notice">Aucune sauvegarde pour ce code.</p>'; return; }
        const label = d => `${frDate(d.exportedAt)} · ${d.items.length} objet${d.items.length > 1 ? 's' : ''}`;
        res.innerHTML = `
          <div class="row"><span class="grow"><b>Dernière sauvegarde</b><br><span class="small muted">${label(latest)}</span></span><button class="btn small primary" data-day="">Restaurer</button></div>
          ${days.map(d => `<div class="row"><span class="grow">Copie du ${frDate(d)}</span><button class="btn small" data-day="${d}">Restaurer</button></div>`).join('')}`;
        $$('[data-day]', res).forEach(b => b.addEventListener('click', async () => {
          const data = b.dataset.day ? await sync.fetchRemote(code, b.dataset.day) : latest;
          if (!data) return toast('Copie introuvable');
          if (!confirm(`Remplacer la bibliothèque de ce téléphone par cette sauvegarde (${label(data)}) ?`)) return;
          if (code !== sync.token()) await sync.useToken(code);
          await store.replaceAll(data);
          await linkCollectionItems();
      await linkCollectionItems();
          closeSheet(); toast('Bibliothèque restaurée'); render();
        }));
      } catch (err) {
        res.innerHTML = `<p class="notice">Service indisponible (${esc(err.message)}). Réessayez plus tard.</p>`;
      }
    });
  });
}

sync.onStatus(() => {
  const el = $('#sync-status');
  if (el) el.innerHTML = syncStatusText();
});

// ---------- Démarrage ----------

(async () => {
  try {
    await store.init();
  } catch (e) {
    $('#view').innerHTML = `<div class="alert danger">Stockage local indisponible (${esc(e.message)}). En navigation privée, les données ne peuvent pas être enregistrées.</div>`;
    return;
  }
  await sync.init();
  await enrichDisney();
  await linkCollectionItems();
  render();
  fillCovers();
  // Changements venus d'un autre appareil : on redessine (sauf pendant une saisie dans une fiche).
  store.onChange(name => { if (name === 'all' && account.isApplying() && $('#sheet').hidden) render(); });
  sync.pull(true).then(n => { if (n !== null) { linkCollectionItems(); render(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
