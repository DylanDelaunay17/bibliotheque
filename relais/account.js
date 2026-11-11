// Comptes : retrouver sa bibliothèque sur n'importe quel appareil (Workers KV, binding ACCOUNTS).
//
// Le mot de passe ne quitte jamais le téléphone : l'appli en dérive une clé lente (PBKDF2,
// 210 000 tours) et n'envoie que cette clé. Ici on ne garde qu'une empreinte salée de la clé,
// et une empreinte de l'adresse e-mail (jamais l'adresse elle-même).
// Sans service d'e-mail gratuit, « mot de passe oublié » passe par le code de secours
// remis à la création du compte.
//
// Clés KV :
//   u:<empreinte e-mail>  compte          s:<empreinte jeton>  session (1 an)
//   d:<identifiant>       bibliothèque    f:<empreinte e-mail> essais ratés (15 min)

const SESSION_TTL = 365 * 86400;
const MAX_FAILS = 10;
const MAX_SESSIONS = 20;

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const random = n => hex(crypto.getRandomValues(new Uint8Array(n)));

// Comparaison en temps constant, pour ne rien révéler par la durée de réponse.
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const validEmail = e => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const validKey = k => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);
const validRecovery = r => typeof r === 'string' && /^[A-Z0-9]{20}$/.test(r);
const emailId = email => sha(`email:${email.trim().toLowerCase()}`);

export async function account(req, url, env, cors) {
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  const kv = env.ACCOUNTS;
  const path = url.pathname.replace(/^\/account/, '');
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    const text = await req.text();
    if (text.length > 20e6) return reply({ error: 'Bibliothèque trop volumineuse.' }, 413);
    try { body = text ? JSON.parse(text) : {}; } catch { return reply({ error: 'Requête illisible.' }, 400); }
  }

  const readUser = async id => JSON.parse((await kv.get(`u:${id}`)) || 'null');
  const writeUser = (id, u) => kv.put(`u:${id}`, JSON.stringify(u));

  async function openSession(id, user) {
    const token = random(32);
    const th = await sha(`session:${token}`);
    await kv.put(`s:${th}`, JSON.stringify({ u: id, d: user.dataId }), { expirationTtl: SESSION_TTL });
    user.sessions = [...(user.sessions || []), th].slice(-MAX_SESSIONS);
    await writeUser(id, user);
    return token;
  }

  async function session() {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const th = await sha(`session:${token}`);
    const s = JSON.parse((await kv.get(`s:${th}`)) || 'null');
    return s ? { ...s, th } : null;
  }

  // Trop d'essais ratés pour une adresse : on bloque 15 minutes.
  async function tooManyFails(id) {
    return +(await kv.get(`f:${id}`) || 0) >= MAX_FAILS;
  }
  async function fail(id) {
    const n = +(await kv.get(`f:${id}`) || 0) + 1;
    await kv.put(`f:${id}`, String(n), { expirationTtl: 900 });
  }

  if (req.method === 'POST' && path === '/register') {
    const { email, key, recovery } = body;
    if (!validEmail(email)) return reply({ error: 'Adresse e-mail invalide.' }, 400);
    if (!validKey(key) || !validRecovery(recovery)) return reply({ error: 'Requête invalide.' }, 400);
    const id = await emailId(email);
    if (await readUser(id)) return reply({ error: 'Un compte existe déjà avec cette adresse. Connectez-vous.' }, 409);
    const salt = random(16), recSalt = random(16);
    const user = {
      salt, verifier: await sha(`${salt}:${key}`),
      recSalt, recVerifier: await sha(`${recSalt}:${recovery}`),
      dataId: random(16), sessions: [], createdAt: Date.now(),
    };
    return reply({ token: await openSession(id, user) });
  }

  if (req.method === 'POST' && path === '/login') {
    const { email, key } = body;
    if (!validEmail(email) || !validKey(key)) return reply({ error: 'Adresse ou mot de passe incorrect.' }, 401);
    const id = await emailId(email);
    if (await tooManyFails(id)) return reply({ error: 'Trop d’essais. Réessayez dans 15 minutes.' }, 429);
    const user = await readUser(id);
    if (!user || !same(user.verifier, await sha(`${user.salt}:${key}`))) {
      await fail(id);
      return reply({ error: 'Adresse ou mot de passe incorrect.' }, 401);
    }
    return reply({ token: await openSession(id, user) });
  }

  // Mot de passe oublié : le code de secours permet d'en choisir un nouveau.
  if (req.method === 'POST' && path === '/reset') {
    const { email, recovery, key } = body;
    if (!validEmail(email) || !validRecovery(recovery) || !validKey(key)) return reply({ error: 'Adresse ou code de secours incorrect.' }, 401);
    const id = await emailId(email);
    if (await tooManyFails(id)) return reply({ error: 'Trop d’essais. Réessayez dans 15 minutes.' }, 429);
    const user = await readUser(id);
    if (!user || !same(user.recVerifier, await sha(`${user.recSalt}:${recovery}`))) {
      await fail(id);
      return reply({ error: 'Adresse ou code de secours incorrect.' }, 401);
    }
    // Nouveau mot de passe : les autres appareils devront se reconnecter.
    for (const th of user.sessions || []) await kv.delete(`s:${th}`);
    user.sessions = [];
    user.salt = random(16);
    user.verifier = await sha(`${user.salt}:${key}`);
    return reply({ token: await openSession(id, user) });
  }

  const s = await session();
  if (!s) return reply({ error: 'Session expirée. Reconnectez-vous.' }, 401);

  if (path === '/data' && req.method === 'GET') {
    const d = JSON.parse((await kv.get(`d:${s.d}`)) || 'null');
    return reply(d || { rev: 0, data: null });
  }

  // Envoi : refusé si un autre appareil a écrit entre-temps (l'appli fusionne et renvoie).
  if (path === '/data' && req.method === 'PUT') {
    const { rev, data } = body;
    if (!Number.isInteger(rev) || data?.app !== 'bibliotheque-physique' || !Array.isArray(data.items)) {
      return reply({ error: 'Bibliothèque illisible.' }, 400);
    }
    const cur = JSON.parse((await kv.get(`d:${s.d}`)) || 'null');
    if (cur && cur.rev !== rev) return reply({ conflict: true, rev: cur.rev, data: cur.data }, 409);
    const next = { rev: (cur?.rev || 0) + 1, savedAt: Date.now(), data };
    await kv.put(`d:${s.d}`, JSON.stringify(next));
    return reply({ rev: next.rev, savedAt: next.savedAt });
  }

  if (req.method === 'POST' && path === '/logout') {
    await kv.delete(`s:${s.th}`);
    return reply({ ok: true });
  }

  if (req.method === 'POST' && path === '/password') {
    const { old, key } = body;
    const user = await readUser(s.u);
    if (!user || !validKey(old) || !validKey(key) || !same(user.verifier, await sha(`${user.salt}:${old}`))) {
      return reply({ error: 'Mot de passe actuel incorrect.' }, 401);
    }
    user.salt = random(16);
    user.verifier = await sha(`${user.salt}:${key}`);
    await writeUser(s.u, user);
    return reply({ ok: true });
  }

  if (req.method === 'POST' && path === '/delete') {
    const user = await readUser(s.u);
    if (!user || !validKey(body.key) || !same(user.verifier, await sha(`${user.salt}:${body.key}`))) {
      return reply({ error: 'Mot de passe incorrect.' }, 401);
    }
    for (const th of user.sessions || []) await kv.delete(`s:${th}`);
    await kv.delete(`d:${user.dataId}`);
    await kv.delete(`u:${s.u}`);
    return reply({ ok: true });
  }

  return reply({ error: 'Introuvable.' }, 404);
}
