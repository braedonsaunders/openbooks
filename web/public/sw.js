/* Only the public offline document is cached. Records, API responses and
 * mutations always use the network; writes are never queued or replayed. */
const OFFLINE_CACHE_PREFIX = 'openbooks-offline-';
// Increment the version when the offline document changes so installations refresh it.
const OFFLINE_CACHE = `${OFFLINE_CACHE_PREFIX}v1`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload', credentials: 'omit' }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(OFFLINE_CACHE_PREFIX) && key !== OFFLINE_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.mode !== 'navigate' || url.origin !== self.location.origin) return;
  // Direct API navigations include downloads and authentication callbacks.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    try {
      // Never substitute stale documents for the current server/session state.
      return await fetch(request, { cache: 'no-store' });
    } catch {
      const cache = await caches.open(OFFLINE_CACHE);
      const offline = await cache.match(OFFLINE_URL);
      return offline ?? new Response('OpenBooks requires a connection. Reconnect and try again.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  })());
});
