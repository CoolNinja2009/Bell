'use strict';

const CACHE_NAME = 'relay-ctrl-v2';
const APP_SHELL = ['/login'];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for static, network-first for /api/
self.addEventListener('fetch', (event) => {
  const { method, url } = event.request;
  const { pathname } = new URL(url);

  // Never cache mutations
  if (method !== 'GET') return;

  // API requests: network-first (don't serve stale data)
  if (pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // The dashboard HTML contains its control logic.  Serving a cached copy
  // can leave it displaying an old active-profile calculation after the
  // server is updated.  Always prefer the server for pages; only fall back
  // to the cache when offline.
  if (event.request.mode === 'navigate' || pathname === '/' || pathname === '/login') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Versioned/static assets may use the offline cache.
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_err) {
    // Offline and not cached — the cached match above already handled
    // the case where we have it cached, so this is genuinely unreachable.
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_err) {
    const cached = await caches.match(request);
    return cached || new Response('{"error":"offline"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
