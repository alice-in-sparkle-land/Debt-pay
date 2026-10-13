/* Lets the page open without internet (network first, saved copy when offline; the API is never cached)
   and shows phone notifications sent by the server. */
const CACHE = 'tra-no-v2';
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
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Trả dần mỗi ngày', {
    body: m.body || '', tag: m.tag || 'tra-no', renotify: true,
    icon: 'icon-192.png', badge: 'badge-96.png', data: { url: 'tra-no.html' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) if (new URL(c.url).pathname.endsWith('/tra-no.html') && 'focus' in c) return c.focus();
    return self.clients.openWindow('tra-no.html');
  })());
});
