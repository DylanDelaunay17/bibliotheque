import * as store from './store.js';
import { lookupBarcode, searchTitle, cleanCode, isIsbn, isbn10to13 } from './lookup.js';
import { startScan, decodeImage } from './scanner.js';

// ---------- Utilitaires ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = n => (Math.round(n * 100) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const today = () => new Date().toISOString().slice(0, 10);
const frDate = d => d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

const TYPES = { bluray: 'Blu-ray', dvd: 'DVD', cd: 'CD', book: 'Livre' };
const TYPE_ICON = { bluray: '💿', dvd: '📀', cd: '🎵', book: '📖' };

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

function coverHtml(item, cls = 'cover') {
  const ph = `<div class="${cls} ph">${TYPE_ICON[item.type] || '•'}</div>`;
  if (!item.cover) return ph;
  return `<img class="${cls}" src="${esc(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"
    onerror="this.outerHTML='${ph.replace(/"/g, '&quot;')}'">`;
}

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
  filter: { q: '', type: '', loaned: false },
  wishFilter: { q: '', type: '' },
  addType: 'bluray',
  addStatus: 'owned',
  pendingBarcode: '',
  results: null,
  resultsMsg: '',
  collectionId: null,
  colFilter: 'missing',
  colQ: '',
};

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

function collectionMatches(title) {
  const n = norm(title);
  if (!n) return [];
  const out = [];
  for (const c of collections()) {
    for (const e of c.entries) if (e.title && norm(e.title) === n) out.push({ col: c, entry: e });
  }
  return out;
}

// ---------- Navigation ----------

const TITLES = { library: 'Bibliothèque', wish: 'Liste de souhaits', add: 'Ajouter', collection: 'Collection', more: 'Plus' };

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

$$('.tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));

// ---------- Bibliothèque ----------

function typeChips(current, attr) {
  return `<div class="chips">
    <button class="chip ${!current ? 'on' : ''}" ${attr}="">Tous</button>
    ${Object.entries(TYPES).map(([k, l]) => `<button class="chip ${current === k ? 'on' : ''}" ${attr}="${k}">${l}</button>`).join('')}
  </div>`;
}

function itemCard(i) {
  const badges = [];
  if (i.loan) badges.push(`<span class="badge warn">Prêté à ${esc(i.loan.to)}</span>`);
  if (i.digital?.has) badges.push('<span class="badge">Fichier</span>');
  if (i.status === 'wish' && i.price) badges.push(`<span class="badge">${euro(i.price)}</span>`);
  return `<button class="card" data-open="${i.id}">
    ${coverHtml(i)}
    <div class="card-body">
      <div class="card-title">${esc(i.title)}</div>
      <div class="card-sub">${esc([i.creator, i.year].filter(Boolean).join(' · '))}</div>
      <div class="badges"><span class="badge type-${i.type}">${TYPES[i.type]}</span>${badges.join('')}</div>
    </div>
  </button>`;
}

function filterItems(list, f) {
  const q = norm(f.q);
  return list
    .filter(i => !f.type || i.type === f.type)
    .filter(i => !f.loaned || i.loan)
    .filter(i => !q || norm([i.title, i.creator, i.barcode, i.notes].join(' ')).includes(q))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
}

function backupBanner() {
  const last = store.meta('lastExport');
  if (items().length < 5) return '';
  const days = last ? (Date.now() - last) / 864e5 : Infinity;
  if (days < 30) return '';
  return `<button class="banner" data-goto="more">💾 ${last ? `Dernière sauvegarde il y a ${Math.floor(days)} jours.` : 'Aucune sauvegarde pour le moment.'} Exportez votre bibliothèque pour ne rien perdre.</button>`;
}

function renderLibrary(v) {
  const f = state.filter;
  const all = owned();
  const counts = Object.keys(TYPES).map(k => `${all.filter(i => i.type === k).length} ${TYPES[k]}`).join(' · ');
  v.innerHTML = `
    ${backupBanner()}
    <input class="search" type="search" placeholder="Rechercher titre, auteur, code…" value="${esc(f.q)}" id="lib-q" autocomplete="off">
    ${typeChips(f.type, 'data-ftype')}
    <label class="toggle"><input type="checkbox" id="lib-loaned" ${f.loaned ? 'checked' : ''}> Seulement les objets prêtés</label>
    <p class="muted small">${all.length} objet${all.length > 1 ? 's' : ''} · ${counts}</p>
    <div id="lib-list" class="list"></div>`;
  const draw = () => {
    const list = filterItems(all, f);
    let html = list.map(itemCard).join('');
    // Recherche en magasin : signaler aussi la liste de souhaits et la collection.
    if (f.q.trim()) {
      const wl = filterItems(wishes(), { q: f.q });
      if (wl.length) html += `<h3 class="section">Dans la liste de souhaits</h3>` + wl.map(itemCard).join('');
      const q = norm(f.q);
      const ce = collections().flatMap(c => c.entries.filter(e => e.title && norm(e.title).includes(q)).map(e => ({ c, e })));
      if (ce.length) {
        html += `<h3 class="section">Dans vos collections</h3>` + ce.map(({ c, e }) =>
          `<div class="row"><span class="num">N°${e.n}</span><span class="grow">${esc(e.title)} <span class="muted small">— ${esc(c.name)}</span></span>${e.owned ? '<span class="badge ok">Possédé</span>' : '<span class="badge">Manquant</span>'}</div>`).join('');
      }
    }
    $('#lib-list').innerHTML = html || `<div class="empty">${all.length ? 'Aucun résultat.' : 'Votre bibliothèque est vide.<br><button class="btn primary" data-goto="add">＋ Ajouter un premier objet</button>'}</div>`;
  };
  draw();
  $('#lib-q').addEventListener('input', e => { f.q = e.target.value; draw(); });
  $('#lib-loaned').addEventListener('change', e => { f.loaned = e.target.checked; draw(); });
  $$('[data-ftype]', v).forEach(b => b.addEventListener('click', () => { f.type = b.dataset.ftype; render(); }));
}

// ---------- Liste de souhaits ----------

function renderWish(v) {
  const f = state.wishFilter;
  const all = wishes();
  const total = all.reduce((s, i) => s + (+i.price || 0), 0);
  v.innerHTML = `
    <input class="search" type="search" placeholder="Rechercher dans mes souhaits…" value="${esc(f.q)}" id="w-q">
    ${typeChips(f.type, 'data-wtype')}
    <p class="muted small">${all.length} souhait${all.length > 1 ? 's' : ''}${total ? ` · budget estimé ${euro(total)}` : ''}</p>
    <div id="w-list" class="list"></div>
    <button class="btn block" id="w-add">＋ Ajouter un souhait</button>`;
  const draw = () => {
    const list = filterItems(all, f);
    $('#w-list').innerHTML = list.map(itemCard).join('') || '<div class="empty">Rien dans la liste de souhaits.</div>';
  };
  draw();
  $('#w-q').addEventListener('input', e => { f.q = e.target.value; draw(); });
  $$('[data-wtype]', v).forEach(b => b.addEventListener('click', () => { f.type = b.dataset.wtype; render(); }));
  $('#w-add').addEventListener('click', () => { state.addStatus = 'wish'; go('add'); });
}

// ---------- Ajouter ----------

function renderAdd(v) {
  const r = state.results;
  v.innerHTML = `
    <button class="btn primary block big" id="a-scan">▥ Scanner un code-barres ou QR</button>

    <div class="seg" role="group" aria-label="Ajouter à">
      <button class="${state.addStatus === 'owned' ? 'on' : ''}" data-status="owned">Je le possède</button>
      <button class="${state.addStatus === 'wish' ? 'on' : ''}" data-status="wish">Je le veux</button>
    </div>

    <h3 class="section">Type d'objet</h3>
    <div class="chips">${Object.entries(TYPES).map(([k, l]) => `<button class="chip ${state.addType === k ? 'on' : ''}" data-atype="${k}">${TYPE_ICON[k]} ${l}</button>`).join('')}</div>

    <h3 class="section">Saisir le numéro du code-barres</h3>
    <form class="inline" id="a-code-form">
      <input id="a-code" inputmode="numeric" placeholder="EAN, UPC ou ISBN" value="${esc(state.pendingBarcode)}" autocomplete="off">
      <button class="btn">Chercher</button>
    </form>

    <h3 class="section">Ou rechercher par titre</h3>
    <form class="inline" id="a-title-form">
      <input id="a-title" type="search" placeholder="Titre (et artiste/auteur)" autocomplete="off">
      <button class="btn">Chercher</button>
    </form>

    <div id="a-results">
      ${state.resultsMsg ? `<p class="notice">${state.resultsMsg}</p>` : ''}
      ${r ? (r.length ? `<div class="list">${r.map((c, i) => `<button class="card" data-pick="${i}">${coverHtml(c)}<div class="card-body"><div class="card-title">${esc(c.title)}</div><div class="card-sub">${esc([c.creator, c.year].filter(Boolean).join(' · '))}</div><div class="badges"><span class="badge type-${c.type}">${TYPES[c.type]}</span><span class="badge">${esc(c.source)}</span></div></div></button>`).join('')}</div>` : '') : ''}
    </div>

    <button class="btn block ghost" id="a-manual">✎ Saisie entièrement manuelle</button>
  `;
  $('#a-scan').addEventListener('click', openScanner);
  $$('[data-status]', v).forEach(b => b.addEventListener('click', () => { state.addStatus = b.dataset.status; render(); }));
  $$('[data-atype]', v).forEach(b => b.addEventListener('click', () => { state.addType = b.dataset.atype; render(); }));
  $('#a-code-form').addEventListener('submit', e => { e.preventDefault(); handleCode($('#a-code').value); });
  $('#a-title-form').addEventListener('submit', e => { e.preventDefault(); handleTitle($('#a-title').value); });
  $('#a-manual').addEventListener('click', () => openConfirm({ type: state.addType, title: $('#a-title').value.trim(), barcode: state.pendingBarcode }));
  $$('[data-pick]', v).forEach(b => b.addEventListener('click', () => {
    const c = { ...r[+b.dataset.pick] };
    if (!c.barcode && state.pendingBarcode) c.barcode = state.pendingBarcode;
    if (c.type !== 'book' && c.type !== 'cd') c.type = state.addType;
    openConfirm(c);
  }));
}

function setResults(results, msg = '') {
  state.results = results;
  state.resultsMsg = msg;
  if (state.tab !== 'add') go('add'); else render();
}

async function handleCode(raw) {
  const text = String(raw || '').trim();
  let code = cleanCode(text);
  // QR code contenant du texte (titre, lien…) : on l'utilise comme recherche.
  if (!/^[\dX]{8,14}$/.test(code)) {
    if (text) { setResults(null, `QR code lu : « ${esc(text.slice(0, 120))} »`); $('#a-title').value = text.slice(0, 80); }
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
    openItem(dup[0].id, `⚠️ Vous avez déjà cet objet${dup[0].status === 'wish' ? ' dans votre liste de souhaits' : ''} !`);
    return;
  }

  setResults(null, `Recherche du code ${code}…`);
  try {
    const res = await lookupBarcode(code, state.addType);
    if (res.length === 1) {
      setResults(res, '');
      openConfirm({ ...res[0] });
    } else if (res.length > 1) {
      setResults(res, `Plusieurs éditions trouvées pour ${code}. Choisissez la bonne :`);
    } else {
      const film = state.addType === 'bluray' || state.addType === 'dvd';
      setResults([], `Code ${code} non trouvé dans les bases gratuites${film ? ' (normal pour la plupart des films)' : ''}. Tapez le titre ci-dessous : le code sera conservé.`);
      $('#a-title').focus();
    }
  } catch (e) {
    setResults([], `Service en ligne indisponible (${esc(e.message || 'réseau')}). Recherchez par titre ou utilisez la saisie manuelle : le code ${code} sera conservé.`);
  }
}

async function handleTitle(q) {
  if (!q.trim()) return;
  setResults(null, 'Recherche…');
  try {
    const res = await searchTitle(q, state.addType);
    setResults(res, res.length ? `${res.length} résultat${res.length > 1 ? 's' : ''}. Touchez le bon :` : 'Aucun résultat. Essayez un autre titre ou la saisie manuelle.');
  } catch (e) {
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

function openSheet(html, bind) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
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
$('#sheet').addEventListener('click', e => { if (e.target.matches('[data-close]')) closeSheet(); });

function typeSelect(val) {
  return `<select name="type">${Object.entries(TYPES).map(([k, l]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

function coverEditor(item) {
  return `<div class="cover-edit">
    <div class="cover-big" id="cv">${coverHtml(item, 'cover-img')}</div>
    <label class="btn small">📷 Photo de la jaquette<input type="file" accept="image/*" capture="environment" id="cv-photo" hidden></label>
  </div>`;
}

function bindCover(root, item) {
  $('#cv-photo', root).addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    item.cover = await photoToDataUrl(f);
    $('#cv', root).innerHTML = coverHtml(item, 'cover-img');
  });
}

function dupBanner(dups) {
  if (!dups.length) return '';
  const strong = dups.some(d => d.sameType && d.item.status !== 'wish');
  return `<div class="alert ${strong ? 'danger' : ''}">
    ${strong ? '⚠️ <b>Doublon : vous possédez déjà ce titre.</b>' : 'ℹ️ Titre déjà présent dans un autre format ou dans vos souhaits :'}
    <ul>${dups.map(d => `<li>${esc(d.item.title)} — ${TYPES[d.item.type]}${d.item.status === 'wish' ? ' (souhait)' : ''}</li>`).join('')}</ul>
  </div>`;
}

function openConfirm(cand) {
  const item = {
    type: cand.type || state.addType, title: cand.title || '', creator: cand.creator || '', year: cand.year || '',
    barcode: cand.barcode || '', cover: cand.cover || '', source: cand.source || 'Saisie manuelle',
  };
  const status = state.addStatus;
  const dups = findDuplicates(item);
  const cm = collectionMatches(item.title).filter(m => !m.entry.owned);
  openSheet(`
    <h2>${cand.title ? 'Est-ce le bon objet ?' : 'Nouvel objet'}</h2>
    <div id="dups">${dupBanner(dups)}</div>
    ${coverEditor(item)}
    <form id="cf" class="form">
      <label>Titre<input name="title" required value="${esc(item.title)}"></label>
      <label>${item.type === 'book' ? 'Auteur' : item.type === 'cd' ? 'Artiste' : 'Réalisateur / studio'}<input name="creator" value="${esc(item.creator)}"></label>
      <div class="two">
        <label>Type${typeSelect(item.type)}</label>
        <label>Année<input name="year" inputmode="numeric" value="${esc(item.year)}"></label>
      </div>
      <label>Code-barres<input name="barcode" inputmode="numeric" value="${esc(item.barcode)}"></label>
      <div class="seg">
        <button type="button" class="${status === 'owned' ? 'on' : ''}" data-st="owned">Je le possède</button>
        <button type="button" class="${status === 'wish' ? 'on' : ''}" data-st="wish">Liste de souhaits</button>
      </div>
      <label class="wish-only" ${status === 'wish' ? '' : 'hidden'}>Prix estimé (€)<input name="price" inputmode="decimal"></label>
      ${cm.map((m, i) => `<label class="toggle"><input type="checkbox" name="col${i}" checked> Cocher N°${m.entry.n} dans « ${esc(m.col.name)} »</label>`).join('')}
      <p class="muted small">Source : ${esc(item.source)}</p>
      <div class="actions">
        <button type="button" class="btn ghost" data-close>Annuler</button>
        <button class="btn primary">Enregistrer</button>
      </div>
    </form>`, root => {
    bindCover(root, item);
    let st = status;
    $$('[data-st]', root).forEach(b => b.addEventListener('click', () => {
      st = b.dataset.st;
      $$('[data-st]', root).forEach(x => x.classList.toggle('on', x === b));
      $('.wish-only', root).hidden = st !== 'wish';
    }));
    const form = $('#cf', root);
    const recheck = () => {
      const fd = new FormData(form);
      $('#dups', root).innerHTML = dupBanner(findDuplicates({ title: fd.get('title'), type: fd.get('type'), barcode: cleanCode(fd.get('barcode')) }));
    };
    form.elements.title.addEventListener('change', recheck);
    form.elements.type.addEventListener('change', recheck);
    form.addEventListener('submit', async e => {
      e.preventDefault();
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
      state.results = null; state.resultsMsg = ''; state.pendingBarcode = '';
      toast(st === 'wish' ? 'Ajouté à la liste de souhaits' : 'Ajouté à la bibliothèque');
      render();
    });
  });
}

function openItem(id, notice = '') {
  const it = store.get('items', id);
  if (!it) return;
  const item = structuredClone(it);
  item.digital ??= { has: false, location: '' };
  item.loanHistory ??= [];
  const wish = item.status === 'wish';
  openSheet(`
    ${notice ? `<div class="alert danger"><b>${esc(notice)}</b></div>` : ''}
    ${coverEditor(item)}
    <form id="itf" class="form">
      <label>Titre<input name="title" required value="${esc(item.title)}"></label>
      <label>Auteur / artiste / réalisateur<input name="creator" value="${esc(item.creator)}"></label>
      <div class="two">
        <label>Type${typeSelect(item.type)}</label>
        <label>Année<input name="year" inputmode="numeric" value="${esc(item.year)}"></label>
      </div>
      <label>Code-barres<input name="barcode" inputmode="numeric" value="${esc(item.barcode)}"></label>
      ${wish ? `<label>Prix estimé (€)<input name="price" inputmode="decimal" value="${item.price ?? ''}"></label>` : ''}

      ${wish ? '' : `
      <fieldset>
        <legend>Prêt</legend>
        ${item.loan ? `<p>Prêté à <b>${esc(item.loan.to)}</b> depuis le ${frDate(item.loan.since)}.</p>
          <button type="button" class="btn" id="it-return">✓ Il m'a été rendu</button>`
        : `<div class="inline"><input id="it-loan" placeholder="Nom de l'emprunteur"><button type="button" class="btn" id="it-lend">Prêter</button></div>`}
        ${item.loanHistory.length ? `<details><summary class="small muted">Historique (${item.loanHistory.length})</summary><ul class="small">${item.loanHistory.map(h => `<li>${esc(h.to)} : ${frDate(h.since)} → ${frDate(h.returned)}</li>`).join('')}</ul></details>` : ''}
      </fieldset>`}

      <fieldset>
        <legend>Version numérique</legend>
        <label class="toggle"><input type="checkbox" name="dhas" ${item.digital.has ? 'checked' : ''}> Existe aussi en fichier sur l'ordinateur</label>
        <label>Emplacement<input name="dloc" placeholder="ex. Disque externe / Films / Disney" value="${esc(item.digital.location)}"></label>
      </fieldset>

      <label>Notes<textarea name="notes" rows="2">${esc(item.notes)}</textarea></label>
      <p class="muted small">Ajouté le ${frDate(item.addedAt)}${item.source ? ` · ${esc(item.source)}` : ''}</p>
      <div class="actions">
        <button type="button" class="btn danger ghost" id="it-del">Supprimer</button>
        ${wish ? '<button type="button" class="btn" id="it-bought">✓ Acheté</button>' : ''}
        <button class="btn primary">Enregistrer</button>
      </div>
    </form>`, root => {
    bindCover(root, item);
    const form = $('#itf', root);
    const collect = () => {
      const fd = new FormData(form);
      Object.assign(item, {
        title: fd.get('title').trim(), creator: fd.get('creator').trim(), year: fd.get('year').trim(),
        type: fd.get('type'), barcode: cleanCode(fd.get('barcode')), notes: fd.get('notes').trim(),
        digital: { has: !!fd.get('dhas'), location: fd.get('dloc').trim() },
      });
      if (wish) item.price = parseFloat(String(fd.get('price') || '').replace(',', '.')) || null;
    };
    const save = async msg => { collect(); await store.put('items', item); closeSheet(); toast(msg); render(); };
    form.addEventListener('submit', e => { e.preventDefault(); save('Enregistré'); });
    $('#it-lend', root)?.addEventListener('click', () => {
      const to = $('#it-loan', root).value.trim();
      if (!to) return $('#it-loan', root).focus();
      item.loan = { to, since: today() };
      save(`Prêté à ${to}`);
    });
    $('#it-return', root)?.addEventListener('click', () => {
      item.loanHistory.push({ ...item.loan, returned: today() });
      item.loan = null;
      save('Retour enregistré');
    });
    $('#it-bought', root)?.addEventListener('click', () => { item.status = 'owned'; item.addedAt = Date.now(); save('Déplacé dans la bibliothèque'); });
    $('#it-del', root).addEventListener('click', async () => {
      if (!confirm(`Supprimer « ${item.title} » ?`)) return;
      await store.remove('items', item.id);
      for (const c of collections()) {
        let changed = false;
        for (const e of c.entries) if (e.itemId === item.id) { delete e.itemId; changed = true; }
        if (changed) await store.put('collections', c);
      }
      closeSheet(); toast('Supprimé'); render();
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

function newCollection({ name, total, lotSize, lotPrice, perMonth }) {
  return {
    id: store.uid(), name, lotSize, lotPrice, perMonth, createdAt: Date.now(),
    entries: Array.from({ length: total }, (_, i) => ({ n: i + 1, title: '', owned: false })),
  };
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

function renderCollection(v) {
  const cols = collections();
  if (!cols.length) {
    v.innerHTML = `
      <div class="panel">
        <h2>Collection Disney & Pixar</h2>
        <p>Collection numérotée officielle Disney France : 138 numéros, achat par lots de 4 Blu-ray pour 30 €, 4 par mois.</p>
        <p class="muted small">Vous pourrez ensuite cocher vos titres possédés, saisir les titres de chaque numéro et ajouter des numéros quand Disney en sort de nouveaux.</p>
        <button class="btn primary block" id="c-disney">Créer cette collection</button>
      </div>
      <button class="btn block ghost" id="c-new">＋ Créer une autre collection</button>`;
    $('#c-disney').addEventListener('click', async () => {
      const c = newCollection({ name: 'Disney & Pixar', total: 138, lotSize: 4, lotPrice: 30, perMonth: 4 });
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

  v.innerHTML = `
    ${cols.length > 1 ? `<select id="c-pick" class="pick">${cols.map(x => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
    <div class="panel stats">
      <div class="stats-head"><h2>${esc(c.name)}</h2><button class="btn small ghost" id="c-edit">Réglages</button></div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <p class="big-num">${s.have} <span>/ ${s.total} possédés</span></p>
      <div class="grid">
        <div><b>${s.left}</b><span>à acheter</span></div>
        <div><b>${euro(s.budget)}</b><span>budget restant</span></div>
        <div><b>${Number.isFinite(s.months) ? s.months : '—'}</b><span>mois restants</span></div>
        <div><b>${s.lots}</b><span>lots de ${c.lotSize}</span></div>
      </div>
      <p class="muted small">${c.lotSize} pour ${euro(c.lotPrice)} soit ${euro(s.unit)} pièce · ${c.perMonth} par mois · ${endTxt}</p>
      ${next.length && s.left ? `<p class="small"><b>Prochain lot :</b> ${next.map(e => `N°${e.n}${e.title ? ` ${esc(e.title)}` : ''}`).join(', ')}</p>` : ''}
    </div>

    <div class="tools">
      <button class="btn small" id="c-bulk">✓ Cocher des numéros</button>
      <button class="btn small" id="c-paste">☰ Coller les titres</button>
      <button class="btn small" id="c-extend">＋ Nouveaux numéros</button>
    </div>

    <input class="search" type="search" id="c-q" placeholder="Chercher un titre ou un numéro…" value="${esc(state.colQ)}">
    <div class="seg">
      ${[['missing', `Manquants (${s.left})`], ['owned', `Possédés (${s.have})`], ['all', 'Tous']].map(([k, l]) => `<button class="${state.colFilter === k ? 'on' : ''}" data-cf="${k}">${l}</button>`).join('')}
    </div>
    <div id="c-list" class="entries"></div>`;

  const draw = () => {
    const q = norm(state.colQ);
    const list = c.entries.filter(e =>
      (state.colFilter === 'all' || (state.colFilter === 'owned') === e.owned) &&
      (!q || String(e.n) === state.colQ.trim() || norm(e.title).includes(q)));
    $('#c-list').innerHTML = list.map(e => `
      <div class="entry ${e.owned ? 'is-owned' : ''}">
        <label class="check"><input type="checkbox" data-own="${e.n}" ${e.owned ? 'checked' : ''}><span></span></label>
        <span class="num">N°${e.n}</span>
        <button class="grow linklike" data-etitle="${e.n}">${e.title ? esc(e.title) : '<span class="muted">Titre à saisir</span>'}</button>
      </div>`).join('') || '<div class="empty">Rien ici.</div>';
  };
  draw();

  $('#c-pick')?.addEventListener('change', e => { state.collectionId = e.target.value; render(); });
  $('#c-edit').addEventListener('click', () => editCollection(c));
  $('#c-q').addEventListener('input', e => { state.colQ = e.target.value; draw(); });
  $$('[data-cf]', v).forEach(b => b.addEventListener('click', () => { state.colFilter = b.dataset.cf; render(); }));

  $('#c-list').addEventListener('change', async e => {
    const n = e.target.dataset.own;
    if (!n) return;
    const entry = c.entries.find(x => x.n === +n);
    entry.owned = e.target.checked;
    await store.put('collections', c);
    render(); // recalcule compteur, budget et mois
  });
  $('#c-list').addEventListener('click', e => {
    const b = e.target.closest('[data-etitle]');
    if (!b) return;
    const entry = c.entries.find(x => x.n === +b.dataset.etitle);
    const t = prompt(`Titre du N°${entry.n}`, entry.title);
    if (t === null) return;
    entry.title = t.trim();
    store.put('collections', c).then(render);
  });

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
  v.innerHTML = `
    <div class="panel">
      <h2>Prêts en cours (${loans.length})</h2>
      ${loans.length ? loans.map(i => {
        const days = Math.floor((Date.now() - new Date(i.loan.since)) / 864e5);
        return `<div class="row"><button class="grow linklike" data-open="${i.id}"><b>${esc(i.title)}</b><br><span class="small muted">${TYPES[i.type]} · ${esc(i.loan.to)} · depuis ${days} j</span></button><button class="btn small" data-ret="${i.id}">Rendu</button></div>`;
      }).join('') : '<p class="muted">Aucun objet prêté.</p>'}
    </div>

    <div class="panel">
      <h2>Sauvegarde</h2>
      <p class="small">Les données restent sur ce téléphone. Exportez régulièrement (dans Fichiers, Drive, par mail…) pour ne rien perdre.</p>
      <p class="muted small">Dernière sauvegarde : ${last ? frDate(last) : 'jamais'}</p>
      <div class="tools">
        <button class="btn primary" id="m-json">Exporter (JSON complet)</button>
        <button class="btn" id="m-csv">Exporter (CSV tableur)</button>
        <label class="btn">Importer une sauvegarde<input type="file" accept=".json,application/json" id="m-import" hidden></label>
      </div>
    </div>

    <div class="panel">
      <h2>Films : affiches et recherche (facultatif)</h2>
      <p class="small">Sans réglage, les films sont cherchés sur Wikipédia. Pour de meilleurs résultats, créez une clé gratuite sur themoviedb.org (compte gratuit, sans carte bancaire) et collez la « clé d'API (v3) » ici.</p>
      <form class="inline" id="m-tmdb"><input name="k" placeholder="Clé TMDB v3" value="${esc(store.meta('tmdbKey', ''))}" autocomplete="off"><button class="btn">OK</button></form>
    </div>

    ${standalone ? '' : `<div class="panel">
      <h2>Installer sur l'écran d'accueil</h2>
      <p class="small"><b>iPhone (Safari)</b> : bouton Partager ⎋ puis « Sur l'écran d'accueil ».<br><b>Android (Chrome)</b> : menu ⋮ puis « Installer l'application » ou « Ajouter à l'écran d'accueil ».</p>
    </div>`}

    <div class="panel">
      <h2>À propos</h2>
      <p class="small muted">100 % gratuit, sans compte. Données : Open Library (livres), MusicBrainz et Cover Art Archive (CD), Wikipédia / TMDB (films). Scan : détecteur natif du navigateur ou ZXing (open source).</p>
      <button class="btn small danger ghost" id="m-wipe">Tout effacer</button>
    </div>`;

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
  $('#m-tmdb').addEventListener('submit', async e => {
    e.preventDefault();
    await store.setMeta('tmdbKey', e.target.elements.k.value.trim());
    toast('Clé enregistrée');
  });
  $('#m-wipe').addEventListener('click', async () => {
    if (!confirm('Effacer TOUTE la bibliothèque de ce téléphone ? Pensez à exporter avant.')) return;
    if (!confirm('Vraiment ? Cette action est définitive.')) return;
    await store.replaceAll({});
    toast('Données effacées'); render();
  });
}

// ---------- Démarrage ----------

(async () => {
  try {
    await store.init();
  } catch (e) {
    $('#view').innerHTML = `<div class="alert danger">Stockage local indisponible (${esc(e.message)}). En navigation privée, les données ne peuvent pas être enregistrées.</div>`;
    return;
  }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
