self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());

// Optional: cache shell (kept tiny to avoid stale BLE logic)
const CACHE = 'atovio-shell-v1';
const ASSETS = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;        // don’t intercept BLE or POSTs
  e.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
