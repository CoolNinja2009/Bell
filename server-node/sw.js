'use strict';

// Deliberately minimal. The dashboard is only meaningful with a live server,
// and its pages/API responses are authenticated and change by the minute, so
// nothing is cached: a cached /api/* response or dashboard page could show an
// outdated schedule as if it were current, or expose data after logout on a
// shared computer. The service worker exists only to (a) keep the app
// installable and (b) show a clear message instead of the browser's error
// page when the server is unreachable.

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Server unreachable</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
       color:#e2e8f0;background:radial-gradient(900px 480px at 50% -10%,rgba(16,185,129,.16),transparent 60%),#0a0f16;text-align:center}
  main{max-width:380px}
  .mark{width:56px;height:56px;margin:0 auto 20px;border-radius:16px;display:grid;place-items:center;background:linear-gradient(135deg,#34d399,#059669)}
  h1{font-size:1.25rem;margin:0 0 8px}
  p{margin:0 0 22px;color:#8b9bb0;line-height:1.55;font-size:.95rem}
  button{min-height:44px;padding:10px 22px;border:0;border-radius:10px;cursor:pointer;font-family:inherit;font-weight:600;font-size:.95rem;color:#fff;
         background:linear-gradient(135deg,#10b981,#059669)}
</style></head>
<body><main>
  <div class="mark"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>
  <h1>Can&rsquo;t reach the bell server</h1>
  <p>Check that the server is running and this device is on the school network. Bells keep ringing on schedule while this page is unavailable &mdash; the controller stores its schedule on the device.</p>
  <button onclick="location.reload()">Try again</button>
</main></body></html>`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

// Purge every cache created by earlier versions of this worker (they held
// API responses and authenticated pages).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return; // everything else: plain network

  event.respondWith(
    fetch(request).catch(() => new Response(OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    }))
  );
});
