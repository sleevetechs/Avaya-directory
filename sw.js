/* Compass Directory PWA service worker */
const CACHE_VERSION = 'compass-dir-v1';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/login',
  '/login.html',
  '/admin',
  '/admin.html',
  '/superadmin',
  '/superadmin.html',
  '/app.js',
  '/logo.png',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/register-sw.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res && res.ok) await cache.put(url, res);
          } catch (err) {
            console.warn('[sw] precache skip', url, err && err.message);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isCdnAsset(url) {
  return (
    url.hostname === 'cdn.tailwindcss.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com' ||
    url.hostname === 'cdnjs.cloudflare.com'
  );
}

function isApiGet(url, request) {
  return isSameOrigin(url) && request.method === 'GET' && url.pathname.startsWith('/api/');
}

function isNavigation(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept') && request.headers.get('accept').includes('text/html'));
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const key = typeof request === 'string' ? request : request.url;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(key, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }
  const fresh = await networkPromise;
  if (fresh) return fresh;
  throw new Error('Network and cache miss');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Let browser handle non-GET-like chrome extensions etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Directory JSON APIs: network-first so online always prefers server; offline falls back to SW cache
  if (isApiGet(url, request) && (
    url.pathname === '/api/employees' ||
    url.pathname === '/api/directory-tree' ||
    url.pathname === '/api/access/check'
  )) {
    event.respondWith(
      networkFirst(request, RUNTIME_CACHE).catch(() =>
        new Response(JSON.stringify({ offline: true, error: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Do not cache other /api/* (login, admin mutations)
  if (isSameOrigin(url) && url.pathname.startsWith('/api/')) return;

  if (isNavigation(request) && isSameOrigin(url)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(request, fresh.clone()).catch(() => {});
            // Also refresh index/login aliases
            if (url.pathname === '/' || url.pathname === '/index.html') {
              cache.put('/', fresh.clone()).catch(() => {});
              cache.put('/index.html', fresh.clone()).catch(() => {});
            }
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match(request)) ||
            (await cache.match(url.pathname)) ||
            (await cache.match('/index.html')) ||
            (await cache.match('/')) ||
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          );
        }
      })()
    );
    return;
  }

  if (isCdnAsset(url)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE).catch(() => fetch(request)));
    return;
  }

  if (isSameOrigin(url)) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE).catch(() => fetch(request)));
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
