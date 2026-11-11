// Relais gratuit (Cloudflare Workers) entre l'appli et deux services qui refusent
// les appels directs depuis un navigateur :
//   /upc?code=…           code-barres → produit (UPCitemdb, 100 recherches/jour)
//   /tmdb/search?query=…  recherche de films TMDB (la clé reste ici, secret TMDB_KEY)
// Les réponses sont gardées en cache 30 jours pour économiser le quota.
const ALLOWED = ['https://dylandelaunay17.github.io', 'http://localhost:8765'];

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    if (!ALLOWED.includes(origin)) return new Response('Origine non autorisée', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (req.method !== 'GET') return new Response('Méthode non autorisée', { status: 405, headers: cors });

    const url = new URL(req.url);
    let target;
    if (url.pathname === '/upc') {
      const code = url.searchParams.get('code') || '';
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
      const up = await fetch(target, { headers: { Accept: 'application/json', 'User-Agent': 'bibliotheque-physique/1.0' } });
      res = new Response(up.body, {
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

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
