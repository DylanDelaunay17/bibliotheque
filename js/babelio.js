// Import d'un export Babelio (Mes livres → Exporter) : fichier CSV séparé par des
// points-virgules, encodé en Windows-1252, colonnes ISBN;Titre;Auteur;Editeur;
// Date de publication;Date d`entrée dans Babelio;Statut;Note.

// Lit le fichier en UTF-8 si possible, sinon en Windows-1252 (cas des exports Babelio).
export async function readText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

// CSV avec guillemets (les titres peuvent contenir des points-virgules).
function parseCsv(text, sep = ';') {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

// Babelio écrit « Nom Prénom » : « Dumas Alexandre » → « Alexandre Dumas »,
// « Le Guin Ursula K. » → « Ursula K. Le Guin ».
const PARTICLES = ['de', 'du', 'des', 'le', 'la', 'van', 'von', 'der', 'den', 'di', 'da', 'del', 'dos', 'mac', 'mc', 'saint'];
export function babelioAuthor(name) {
  const t = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (t.length < 2) return t.join(' ');
  let n = 1;
  while (n < t.length - 1 && PARTICLES.includes(t[n - 1].toLowerCase())) n++;
  return [...t.slice(n), ...t.slice(0, n)].join(' ');
}

// Retourne les livres prêts à enregistrer, ou lève une erreur si ce n'est pas un export Babelio.
export function parseBabelio(text) {
  const [head, ...lines] = parseCsv(text.replace(/^﻿/, ''));
  const col = name => head.findIndex(h => h.trim().toLowerCase().startsWith(name));
  const c = { isbn: col('isbn'), title: col('titre'), author: col('auteur'), publisher: col('editeur'), date: col('date de publication'), added: head.findIndex(h => /entr/i.test(h)), status: col('statut'), note: col('note') };
  if (c.isbn < 0 || c.title < 0 || c.author < 0) throw new Error("Ce fichier ne ressemble pas à un export Babelio (colonnes ISBN, Titre, Auteur introuvables).");
  return lines.map(r => {
    const get = k => (c[k] >= 0 ? String(r[c[k]] ?? '').trim() : '');
    const isbn = get('isbn').replace(/[^0-9X]/gi, '');
    const valid = /^97[89]\d{10}$/.test(isbn);
    const year = (get('date').match(/^(\d{4})/) || [])[1];
    const note = parseFloat(get('note').replace(',', '.')) || 0;
    const added = Date.parse(get('added').replace(' ', 'T'));
    return {
      type: 'book',
      title: get('title'),
      creator: babelioAuthor(get('author')),
      publisher: get('publisher'),
      year: year && year !== '0000' ? year : '',
      barcode: valid ? isbn : '',
      // Affiche Open Library par ISBN ; « default=false » renvoie une erreur si elle n'existe pas.
      cover: valid ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false` : '',
      readStatus: get('status').replace(/^A lire$/i, 'À lire'),
      rating: note > 0 ? Math.round(note * 2) : null, // Babelio note sur 5
      addedAt: Number.isFinite(added) ? added : Date.now(),
      source: 'Babelio',
    };
  }).filter(b => b.title);
}
