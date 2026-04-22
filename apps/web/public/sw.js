// apps/web/public/sw.js
// Service Worker Kinetic — offline-first PWA avec SPA routing.

const VERSION       = 'kinetic-v1.1.0';
const STATIC_CACHE  = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Shell minimal à précacher.
// Les assets hashés (/static/*) sont cachés runtime au fur et à mesure.
const PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
];

// ─── Install ────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // addAll() est all-or-nothing. On tolère les 404 unitaires.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const resp = await fetch(url, { cache: 'reload' });
            if (resp.ok) await cache.put(url, resp);
          } catch (e) {
            console.warn('[SW] precache skipped:', url, e);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

// ─── Activate ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// ─── Fetch — routing par type ───────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Non-GET → passthrough
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ignore cross-origin (Supabase, analytics, etc.) → passthrough
  if (url.origin !== self.location.origin) return;

  // Navigations (SPA) → toujours renvoyer /index.html depuis le cache
  // (ou réseau en fallback), puis laisser le client-side router prendre le relais.
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  // Assets hashés immutables → cache first (long TTL)
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Autres assets (manifest, icons, etc.) → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

// ─── Stratégies ─────────────────────────────────────────────

async function handleNavigation(req) {
  // 1. Essayer le réseau en priorité (utilisateur online = dernière version)
  try {
    const fresh = await fetch(req);
    if (fresh.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put('/', fresh.clone()).catch(() => {});
      return fresh;
    }
  } catch {
    // offline → continue
  }
  // 2. Fallback cache '/' (l'index SPA sert toutes les routes)
  const cached = await caches.match('/', { ignoreSearch: true });
  if (cached) return cached;
  // 3. Dernière roue de secours
  const offline = await caches.match('/offline.html');
  if (offline) return offline;
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cached  = await caches.match(req);
  const network = fetch(req)
    .then((resp) => {
      if (resp.ok) {
        caches.open(cacheName).then((c) => c.put(req, resp.clone())).catch(() => {});
      }
      return resp;
    })
    .catch(() => null);
  return cached || (await network) || new Response('Offline', { status: 503 });
}

// ─── Background sync (optionnel) ────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-storage') {
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll();
        clients.forEach((c) => c.postMessage({ type: 'SYNC_REQUESTED' }));
      })(),
    );
  }
});

// ─── Push notifications ─────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* noop */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Kinetic', {
      body:  data.body  || "Ta routine t'attend !",
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag:   data.tag   || 'kinetic-reminder',
      data:  { url: data.url || '/' },
      actions: [
        { action: 'open',    title: 'Ouvrir' },
        { action: 'dismiss', title: 'Plus tard' },
      ],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || '/'));
});
