// Relais gratuit (Cloudflare Workers) entre l'appli et des services qui refusent
// les appels directs depuis un navigateur :
//   /dvdfr?code=…         code-barres → édition française (recherche publique DVDFr.com)
//   /upc?code=…           code-barres → produit (UPCitemdb, 100 recherches/jour, éditions UK/DE surtout)
//   /tmdb/search?query=…  recherche de films TMDB (la clé reste ici, secret TMDB_KEY)
// Les réponses sont gardées en cache 30 jours : un code n'est demandé qu'une fois.
const ALLOWED = ['https://dylandelaunay17.github.io', 'http://localhost:8765'];
const UA = 'bibliotheque-physique/1.0 (usage personnel)';

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    if (!ALLOWED.includes(origin)) return new Response('Origine non autorisée', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (req.method !== 'GET') return new Response('Méthode non autorisée', { status: 405, headers: cors });

    const url = new URL(req.url);
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
