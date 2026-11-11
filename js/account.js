// Compte : la même bibliothèque sur tous les appareils (téléphone, tablette, ordinateur).
// Le mot de passe ne quitte jamais l'appareil : on en dérive une clé lente (PBKDF2) et
// seule cette clé est envoyée au relais. Voir relais/account.js pour la partie serveur.
import * as store from './store.js';
import { RELAY_DEFAULT } from './lookup.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O ni 1/I, faciles à confondre
const relay = () => (store.meta('relayUrl') || RELAY_DEFAULT).replace(/\/+$/, '');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const normEmail = e => String(e || '').trim().toLowerCase();

export const formatCode = c => (c || '').match(/.{1,4}/g)?.join('-') ?? '';
export const parseCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const current = () => store.meta('account'); // { email, token } ou null
export const signedIn = () => !!current()?.token;

let applying = false; // vrai pendant l'écriture d'une fusion : ce n'est pas une modification à renvoyer
export const isApplying = () => applying;

async function deriveKey(email, password) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', iterations: 210000,
    salt: new TextEncoder().encode(`bibliotheque-physique:${normEmail(email)}`),
  }, material, 256);
  return hex(bits);
}

function newRecoveryCode() {
  return [...crypto.getRandomValues(new Uint8Array(20))].map(b => ALPHABET[b % ALPHABET.length]).join('');
}

async function api(path, { method = 'POST', body, auth = true } = {}) {
  const token = current()?.token;
  const res = await fetch(`${relay()}/account${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.conflict) return { conflict: true, ...data };
  if (!res.ok) {
    if (res.status === 401 && auth && token) await store.setMeta('account', { email: current().email, token: null, expired: true });
    const err = new Error(data.error || `Service indisponible (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function signIn(email, token) {
  await store.setMeta('account', { email: normEmail(email), token });
  await store.setMeta('accountRev', 0);
  return syncNow();
}

export async function register(email, password) {
  const key = await deriveKey(email, password);
  const recovery = newRecoveryCode();
  const { token } = await api('/register', { body: { email: normEmail(email), key, recovery }, auth: false });
  await signIn(email, token);
  return recovery;
}

export async function login(email, password) {
  const key = await deriveKey(email, password);
  const { token } = await api('/login', { body: { email: normEmail(email), key }, auth: false });
  return signIn(email, token);
}

export async function reset(email, recovery, password) {
  const key = await deriveKey(email, password);
  const { token } = await api('/reset', { body: { email: normEmail(email), recovery: parseCode(recovery), key }, auth: false });
  return signIn(email, token);
}

export async function changePassword(oldPassword, newPassword) {
  const email = current().email;
  await api('/password', { body: { old: await deriveKey(email, oldPassword), key: await deriveKey(email, newPassword) } });
}

export async function logout() {
  try { await api('/logout'); } catch { /* hors ligne : la session expirera seule */ }
  await store.setMeta('account', null);
  await store.setMeta('accountRev', 0);
}

export async function deleteAccount(password) {
  await api('/delete', { body: { key: await deriveKey(current().email, password) } });
  await store.setMeta('account', null);
  await store.setMeta('accountRev', 0);
}

// ---------- Synchronisation ----------

// Fusion objet par objet : le plus récemment modifié l'emporte ; une suppression
// postérieure à la dernière modification retire l'objet partout.
export function mergeData(a, b) {
  const deleted = { ...(b.deleted || {}) };
  for (const [id, t] of Object.entries(a.deleted || {})) deleted[id] = Math.max(deleted[id] || 0, t);
  const merge = key => {
    const map = new Map();
    for (const r of [...(b[key] || []), ...(a[key] || [])]) {
      const cur = map.get(r.id);
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) map.set(r.id, r);
    }
    return [...map.values()].filter(r => !(deleted[r.id] >= (r.updatedAt || 0)));
  };
  return { app: 'bibliotheque-physique', version: 1, exportedAt: new Date().toISOString(), items: merge('items'), collections: merge('collections'), deleted, meta: a.meta || [] };
}

// Empreinte rapide pour savoir si deux versions diffèrent.
const signature = d => ['items', 'collections'].map(k => (d[k] || []).map(r => `${r.id}:${r.updatedAt || 0}`).sort().join(',')).join('|')
  + `|${Object.keys(d.deleted || {}).length}`;

async function applyLocal(merged) {
  applying = true;
  try {
    const meta = store.all('meta').filter(m => m.id !== 'deleted');
    await store.replaceAll({ items: merged.items, collections: merged.collections, meta: [...meta, { id: 'deleted', value: merged.deleted }] });
  } finally {
    applying = false;
  }
}

async function put(data, rev) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await api('/data', { method: 'PUT', body: { rev, data } });
    if (!res.conflict) {
      await store.setMeta('accountRev', res.rev);
      return;
    }
    // Un autre appareil a écrit entre-temps : on fusionne avec sa version et on renvoie.
    const merged = mergeData(store.dump(), res.data);
    if (signature(merged) !== signature(store.dump())) await applyLocal(merged);
    data = merged;
    rev = res.rev;
  }
  throw new Error('Synchronisation impossible pour le moment, nouvel essai plus tard.');
}

// Envoi des modifications de cet appareil.
export async function push() {
  if (!signedIn()) return;
  await put(store.dump(), store.meta('accountRev', 0));
}

// Récupère la version du compte, la fusionne avec celle de l'appareil et renvoie le résultat si besoin.
// Retourne le nombre d'objets après synchronisation.
export async function syncNow() {
  if (!signedIn()) return 0;
  const { rev, data } = await api('/data', { method: 'GET' });
  const local = store.dump();
  const merged = data ? mergeData(local, data) : local;
  if (data && signature(merged) !== signature(local)) await applyLocal(merged);
  if (!data || signature(merged) !== signature(data)) await put(store.dump(), rev);
  else await store.setMeta('accountRev', rev);
  return store.all('items').length;
}
