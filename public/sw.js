/* Lets the page open without internet. Network first (so updates show), saved copy when offline. The API is never cached. */
const CACHE = 'tra-no-v1';
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['tra-no.html'])).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 6000))]);
      if (net && net.ok) cache.put(req, net.clone());
      return net;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
