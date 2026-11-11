// Sauvegarde automatique en ligne, via le relais (Cloudflare Workers KV, gratuit).
// Chaque modification déclenche un envoi quelques secondes plus tard. Le code de
// récupération identifie la sauvegarde : il suffit pour la retrouver sur un autre téléphone.
import * as store from './store.js';
import { RELAY_DEFAULT } from './lookup.js';

const DELAY = 4000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O ni 1/I, faciles à confondre
let timer = null;
let pending = false;
let running = false;
const listeners = new Set();

const relay = () => (store.meta('relayUrl') || RELAY_DEFAULT).replace(/\/+$/, '');
const today = () => new Date().toISOString().slice(0, 10);

export function onStatus(fn) { listeners.add(fn); }
const notify = () => { for (const fn of listeners) fn(); };

export function token() { return store.meta('syncToken', ''); }
export const formatToken = t => (t || '').match(/.{1,4}/g)?.join('-') ?? '';
export const parseToken = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
}

export function status() {
  return {
    enabled: !!token() && !!relay(),
    pending,
    lastSync: store.meta('lastSync'),
    error: store.meta('lastSyncError'),
  };
}

const isEmpty = d => !d.items.length && !d.collections.length;

async function request(path, opts = {}, t = token()) {
  const res = await fetch(`${relay()}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function push() {
  clearTimeout(timer);
  timer = null;
  if (!status().enabled || running) { pending = !!status().enabled; return; }
  const data = store.dump();
  // Ne jamais écraser une sauvegarde avec une bibliothèque vide (nouveau téléphone, effacement).
  if (isEmpty(data)) { pending = false; notify(); return; }
  running = true;
  pending = false;
  notify();
  try {
    const snapshot = store.meta('lastSnapshotDay') !== today();
    await request('/backup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(snapshot ? { 'X-Snapshot': '1' } : {}) },
      body: JSON.stringify(data),
    });
    if (snapshot) await store.setMeta('lastSnapshotDay', today());
    await store.setMeta('lastSync', Date.now());
    await store.setMeta('lastSyncError', '');
  } catch (e) {
    pending = true;
    await store.setMeta('lastSyncError', navigator.onLine === false ? 'hors ligne' : e.message);
    timer = setTimeout(push, 60000); // nouvel essai dans une minute
  } finally {
    running = false;
    notify();
    if (pending && !timer) schedule();
  }
}

export function schedule() {
  if (!status().enabled || isEmpty(store.dump())) return;
  pending = true;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; push(); }, DELAY);
  notify();
}

export function fetchRemote(t = token(), day = '') {
  return request(`/backup${day ? `?day=${day}` : ''}`, {}, t);
}

export function fetchDays(t = token()) {
  return request('/backup/days', {}, t).then(d => d || []);
}

export async function useToken(t) {
  await store.setMeta('syncToken', t);
  await store.setMeta('lastSync', null);
  notify();
}

export async function init() {
  if (!token()) await store.setMeta('syncToken', newToken());
  store.onChange(name => {
    if (name === 'items' || name === 'collections' || name === 'all') schedule();
  });
  // Envoi immédiat quand l'appli passe en arrière-plan (téléphone verrouillé, autre appli).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pending) push();
  });
  window.addEventListener('online', () => { if (pending) push(); });
  // Rattrape une modification qui n'aurait pas pu partir la dernière fois.
  if (store.meta('lastSyncError') || !store.meta('lastSync')) schedule();
}
