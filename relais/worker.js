// Relais gratuit (Cloudflare Workers) entre l'appli et des services qui refusent
// les appels directs depuis un navigateur :
//   /dvdfr?code=…         code-barres → édition française (recherche publique DVDFr.com)
//   /upc?code=…           code-barres → produit (UPCitemdb, 100 recherches/jour, éditions UK/DE surtout)
//   /tmdb/search?query=…  recherche de films TMDB (la clé reste ici, secret TMDB_KEY)
//   /tmdb/keywords?id=…   mots-clés d'un film TMDB (pour repérer les comédies musicales)
//   /tmdb/movie?id=…      fiche d'un film : synopsis, durée, réalisation, acteurs, bandes-annonces
//   /backup               sauvegarde par code de récupération (Workers KV, binding BACKUPS)
//   /account/…            comptes et synchronisation entre appareils (voir account.js)
// Les réponses sont gardées en cache 30 jours : un code n'est demandé qu'une fois.
import { account } from './account.js';

const ALLOWED = ['https://dylandelaunay17.github.io', 'http://localhost:8765'];
const UA = 'bibliotheque-physique/1.0 (usage personnel)';

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    if (!ALLOWED.includes(origin)) return new Response('Origine non autorisée', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, PUT, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Snapshot', 'Access-Control-Max-Age': '86400' } });
    }
    const url = new URL(req.url);
    if (url.pathname.startsWith('/backup')) return backup(req, url, env, cors);
    if (url.pathname.startsWith('/account/')) return account(req, url, env, cors);
    if (req.method !== 'GET') return new Response('Méthode non autorisée', { status: 405, headers: cors });

    const code = url.searchParams.get('code') || '';
    let target, transform;
    if (url.pathname === '/dvdfr') {
      if (!/^\d{8,14}$/.test(code)) return json({ error: 'code invalide' }, 400, cors);
      target = `https://www.dvdfr.com/listeliv.php?base=dvd&mots_recherche=${code}`;
      transform = html => JSON.stringify(parseDvdfr(html, code));
    } else if (url.pathname === '/upc') {
      if (!/^\d{8,14}$/.test(code)) return json({ error: 'code invalide' }, 400, cors);
      target = `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`;
    } else if (url.pathname === '/tmdb/search') {
      const query = (url.searchParams.get('query') || '').slice(0, 200);
      if (!query) return json({ error: 'recherche vide' }, 400, cors);
      if (!env.TMDB_KEY) return json({ error: 'clé TMDB absente' }, 503, cors);
      target = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&language=fr-FR&region=FR&include_adult=false&api_key=${env.TMDB_KEY}`;
    } else if (url.pathname === '/tmdb/keywords') {
      const id = url.searchParams.get('id') || '';
      if (!/^\d{1,9}$/.test(id)) return json({ error: 'identifiant invalide' }, 400, cors);
      if (!env.TMDB_KEY) return json({ error: 'clé TMDB absente' }, 503, cors);
      target = `https://api.themoviedb.org/3/movie/${id}/keywords?api_key=${env.TMDB_KEY}`;
    } else if (url.pathname === '/tmdb/movie') {
      const id = url.searchParams.get('id') || '';
      if (!/^\d{1,9}$/.test(id)) return json({ error: 'identifiant invalide' }, 400, cors);
      if (!env.TMDB_KEY) return json({ error: 'clé TMDB absente' }, 503, cors);
      target = `https://api.themoviedb.org/3/movie/${id}?language=fr-FR&append_to_response=videos,credits&include_video_language=fr,en,null&api_key=${env.TMDB_KEY}`;
      transform = text => JSON.stringify(compactMovie(JSON.parse(text)));
    } else {
      return json({ error: 'introuvable' }, 404, cors);
    }

    const cacheKey = new Request(url.toString());
    let res = await caches.default.match(cacheKey);
    if (!res) {
      // UPCitemdb limite par adresse IP, et les adresses Cloudflare sont partagées :
      // en cas de 429, un nouvel essai part souvent d'une autre adresse.
      let up;
      for (let i = 0; i < 4; i++) {
        up = await fetch(target, { headers: { Accept: transform ? 'text/html' : 'application/json', 'User-Agent': UA } });
        if (up.status !== 429) break;
        await new Promise(r => setTimeout(r, 300 * (i + 1)));
      }
      const body = transform && up.ok ? transform(await up.text()) : up.body;
      res = new Response(body, {
        status: up.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=2592000' },
      });
      if (up.ok) ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

// Sauvegardes : la clé de stockage est l'empreinte SHA-256 du code de récupération,
// le code lui-même n'est jamais enregistré. Une copie par jour est gardée 60 jours.
async function backup(req, url, env, cors) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[A-Z0-9]{20,64}$/.test(token)) return json({ error: 'code invalide' }, 401, cors);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bibliotheque:${token}`));
  const id = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const noStore = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (req.method === 'GET' && url.pathname === '/backup/days') {
    const list = await env.BACKUPS.list({ prefix: `s:${id}:` });
    return new Response(JSON.stringify(list.keys.map(k => k.name.slice(-10)).sort().reverse()), { headers: noStore });
  }
  if (req.method === 'GET') {
    const day = url.searchParams.get('day');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'date invalide' }, 400, cors);
    const v = await env.BACKUPS.get(day ? `s:${id}:${day}` : `b:${id}`);
    return v ? new Response(v, { headers: noStore }) : json({ error: 'aucune sauvegarde' }, 404, cors);
  }
  if (req.method === 'PUT') {
    const body = await req.text();
    if (body.length > 20e6) return json({ error: 'sauvegarde trop grosse' }, 413, cors);
    let data;
    try { data = JSON.parse(body); } catch { return json({ error: 'JSON invalide' }, 400, cors); }
    if (data?.app !== 'bibliotheque-physique' || !Array.isArray(data.items)) return json({ error: 'format inconnu' }, 400, cors);
    await env.BACKUPS.put(`b:${id}`, body);
    if (req.headers.get('X-Snapshot') === '1') {
      await env.BACKUPS.put(`s:${id}:${new Date().toISOString().slice(0, 10)}`, body, { expirationTtl: 60 * 86400 });
    }
    return json({ ok: true, savedAt: Date.now() }, 200, cors);
  }
  return json({ error: 'méthode non autorisée' }, 405, cors);
}

// Fiche TMDB réduite à ce que l'appli affiche (la réponse complète pèse des dizaines de Ko).
function compactMovie(m) {
  const videos = (m.videos?.results || [])
    .filter(v => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type))
    .map(v => ({ key: v.key, name: v.name, lang: v.iso_639_1, type: v.type, official: !!v.official }));
  return {
    id: m.id,
    title: m.title,
    overview: m.overview || '',
    tagline: m.tagline || '',
    runtime: m.runtime || null,
    release: m.release_date || '',
    directors: (m.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name),
    cast: (m.credits?.cast || []).slice(0, 8).map(c => ({ name: c.name, role: c.character || '' })),
    videos,
  };
}

// Page de résultats DVDFr : chaque fiche est un lien /dvd/<EAN>-<titre>/ dont les textes
// successifs sont « Titre (année) », le format (« 4K Ultra HD », « Blu-ray », « DVD »…) et le prix.
function parseDvdfr(html, code) {
  const texts = [];
  const re = new RegExp(`<a[^>]+href="/dvd/${code}-[^"]*"[^>]*>([\\s\\S]*?)</a>`, 'g');
  for (const m of html.matchAll(re)) {
    const t = decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t) texts.push(t);
  }
  if (!texts.length) return { found: false };
  const format = texts.find(t => /^(4K|Blu-ray|DVD|UHD|HD DVD)/i.test(t)) || '';
  return { found: true, title: texts[0], format };
}

function decode(s) {
  return s.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp|#039);/gi, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()];
  });
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
