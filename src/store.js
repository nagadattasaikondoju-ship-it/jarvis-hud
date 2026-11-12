// Tiny IndexedDB key-value store for chats, projects, files and memory.
// Everything lives only in this browser on this computer.
const DB = 'jarvis-hud';
const STORE = 'kv';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

// Memory fallback when IndexedDB is unavailable (private windows, previews).
const mem = new Map();
let ok = typeof indexedDB !== 'undefined';

export async function get(key, fallback = null) {
  if (!ok) return mem.has(key) ? mem.get(key) : fallback;
  try {
    const v = await tx('readonly', (s) => s.get(key));
    return v === undefined ? fallback : v;
  } catch {
    ok = false;
    return mem.has(key) ? mem.get(key) : fallback;
  }
}

export async function set(key, value) {
  if (!ok) { mem.set(key, value); return; }
  try { await tx('readwrite', (s) => s.put(value, key)); } catch { ok = false; mem.set(key, value); }
}

export async function del(key) {
  if (!ok) { mem.delete(key); return; }
  try { await tx('readwrite', (s) => s.delete(key)); } catch { mem.delete(key); }
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
