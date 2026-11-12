// Jarvis HUD service worker.
// Keeps the interface loading even when the internet is down (the AI itself runs on your PC).
// Only this site's own files are cached. Requests to Ollama, the Companion and other sites
// are never touched.
// Both values are filled in at build time (see vite.config.js).
const BUILD = '__BUILD_ID__';
const ENTRY = [] /* __ENTRY_ASSETS__ */;
const VERSION = `jarvis-${BUILD}`;
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', ...ENTRY];

self.addEventListener('install', (e) => {
  // Cache what is needed to open the app with no internet. Each file is added on its own,
  // so one missing file never blocks the rest.
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jarvis-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Ollama, Companion, fonts: straight to the network
  if (url.pathname.startsWith('/companion/') || url.pathname === '/sw.js') return;

  // Pages: always try the network first so a new version shows up immediately.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || Response.error()))
    );
    return;
  }

  // Built files have a content hash in their name, so a cached copy is always correct.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }))
    );
    return;
  }

  // Everything else: network, falling back to cache.
  e.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || Response.error())));
});
