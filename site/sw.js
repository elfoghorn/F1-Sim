/* F1 SIM offline helper: keeps the app's own files so it opens instantly and survives a patchy signal.
   It never touches Supabase or any other site, so campaign data is always live. */
const CACHE = 'f1sim-1.3.0';
const SHELL = ['./', './index.html', './app.js', './bridge.js', './config.js', './manifest.webmanifest', './icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  /* The site's own server routes (the Discord relay) are always live and never kept. */
  if (u.pathname.startsWith('/api/')) return;
  /* Network first: always the newest version when online; the saved copy when not. */
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
