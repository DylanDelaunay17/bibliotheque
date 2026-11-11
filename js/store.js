// Stockage local (IndexedDB) avec cache mémoire. Aucune donnée ne quitte le téléphone.
const DB_NAME = 'bibliotheque';
const DB_VERSION = 1;
const STORES = ['items', 'collections', 'meta'];

let db;
const cache = { items: new Map(), collections: new Map(), meta: new Map() };
const listeners = new Set();

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) {
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    fn(t.objectStore(store));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function init() {
  db = await open();
  for (const s of STORES) {
    await new Promise((resolve, reject) => {
      const req = db.transaction(s).objectStore(s).getAll();
      req.onsuccess = () => { for (const r of req.result) cache[s].set(r.id, r); resolve(); };
      req.onerror = () => reject(req.error);
    });
  }
  // Demande au navigateur de ne pas effacer les données en cas de manque de place.
  try { await navigator.storage?.persist?.(); } catch {}
}

export function onChange(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) fn(); }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function all(store) { return [...cache[store].values()]; }
export function get(store, id) { return cache[store].get(id); }

export async function put(store, obj) {
  obj.updatedAt = Date.now();
  cache[store].set(obj.id, obj);
  await tx(store, 'readwrite', s => s.put(obj));
  emit();
  return obj;
}

export async function remove(store, id) {
  cache[store].delete(id);
  await tx(store, 'readwrite', s => s.delete(id));
  emit();
}

export async function replaceAll(data) {
  for (const s of STORES) {
    cache[s].clear();
    await tx(s, 'readwrite', st => st.clear());
    for (const r of data[s] || []) {
      cache[s].set(r.id, r);
    }
    await tx(s, 'readwrite', st => { for (const r of data[s] || []) st.put(r); });
  }
  emit();
}

export function meta(key, fallback = null) { return cache.meta.get(key)?.value ?? fallback; }
export function setMeta(key, value) { return put('meta', { id: key, value }); }

export function dump() {
  return {
    app: 'bibliotheque-physique',
    version: 1,
    exportedAt: new Date().toISOString(),
    items: all('items'),
    collections: all('collections'),
    meta: all('meta').filter(m => m.id !== 'tmdbKey'),
  };
}
