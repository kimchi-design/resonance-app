/* =====================================================================
   Resonance service worker (P-17).

   Goal: make the app installable and fast on repeat loads, with a
   graceful offline *shell* — NOT full offline function (a recognition
   app can't reach the mic→AudD pipeline without a network).

   Strategy, deliberately simple to avoid the classic Vite/PWA traps:

   1. Versioned cache + cleanup on activate. Bump CACHE to invalidate
      every old asset in one move — no stale hashed JS lingering across
      deploys while the app is under active iteration.

   2. /api/* is NEVER cached (network-only / pass-through). A cached
      AudD or ReccoBeats response served for a *different* song would be
      wrong; recognition must always hit the live proxy.

   3. Navigation requests → network-first, fall back to the cached app
      shell ('/') when offline so a launched-from-home-screen install
      still opens to the home stage without a network.

   4. Same-origin static assets (Vite's hashed JS/CSS, icons, manifest)
      → cache-first with runtime population. Hashed filenames are
      immutable, so once cached they're safe to serve from cache.

   5. Cross-origin (Google Fonts, ReccoBeats, iTunes, etc.) → pass
      through untouched. Not our cache to manage.
   ===================================================================== */

const CACHE = 'resonance-v1';
const APP_SHELL = '/';

// On install, pre-cache the app shell so the very first offline launch
// after install has something to render. skipWaiting so a new SW version
// takes over promptly instead of waiting for every tab to close.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(APP_SHELL))
      .catch(() => {}) // first install offline — fine, runtime cache fills in later
      .then(() => self.skipWaiting())
  );
});

// On activate, drop every cache that isn't the current version, then
// claim open clients so the new SW controls them without a reload.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET. POST/PUT (none today, but defensively) pass through.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin → don't intercept. Let the browser handle fonts,
  // ReccoBeats, iTunes, Spotify deep links, etc.
  if (url.origin !== self.location.origin) return;

  // /api/* → network-only. Never serve a cached recognition/recs response.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests → network-first with offline app-shell fallback.
  //
  // Every successful navigation also REFRESHES the cached shell. install
  // runs once per SW version, so without this the offline fallback would
  // be frozen at the HTML captured on first install — and after a deploy
  // that HTML references hashed asset filenames that no longer exist,
  // making the offline launch render a broken shell rather than a stale
  // one. Rewriting the shell on each online navigation keeps the offline
  // fallback in step with the assets actually sitting in the cache.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(APP_SHELL, copy));
          }
          return response;
        })
        .catch(() => caches.match(APP_SHELL).then((cached) => cached || Response.error()))
    );
    return;
  }

  // Same-origin static assets → cache-first, populate cache on miss.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Only cache complete, basic (same-origin) 200 responses.
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        // Offline and not in cache. `cached` is provably undefined here
        // (the hit already returned above), and resolving respondWith to
        // undefined throws a TypeError instead of failing cleanly — so
        // hand back an explicit network error.
        .catch(() => Response.error());
    })
  );
});
