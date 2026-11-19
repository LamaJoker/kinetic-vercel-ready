// apps/web/public/sw.js
// Service Worker Kinetic — offline-first PWA avec SPA routing.

// __SW_BUILD__ is replaced at build time by the Vite injectSwVersion plugin
// with a unique timestamp, guaranteeing a new cache name on every deployment.
const VERSION       = '__SW_BUILD__';
const STATIC_CACHE  = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
// Assets hashés (/static/*) : noms uniques et immuables → cache PARTAGÉ entre
// versions. Un onglet encore ouvert sur l'ancienne version peut ainsi toujours
// charger ses chunks après un déploiement (sinon : 404 → index.html → erreur MIME).
const ASSETS_CACHE  = 'kinetic-assets-v1';
const ASSETS_MAX_ENTRIES = 250;
// Schémas d'exercices (/exercises/*.svg) : cache PERSISTANT entre versions
// (pas vidé à l'activation) pour que « Comment exécuter » marche hors ligne
// même juste après une mise à jour. Tous précachés à l'installation (~30
// petits SVG), rafraîchis ensuite en arrière-plan (stale-while-revalidate).
const EXERCISES_CACHE = 'kinetic-exercises-v1';
// __SW_EXERCISES__ : noms séparés par des virgules, injectés au build (vite.config.ts).
const EXERCISE_LIST = '__SW_EXERCISES__';
const EXERCISE_URLS = EXERCISE_LIST.startsWith('__')
  ? []
  : EXERCISE_LIST.split(',').filter(Boolean).map((n) => `/exercises/${n}.svg`);

// Shell minimal à précacher.
// Les assets hashés (/static/*) sont cachés runtime au fur et à mesure.
const PRECACHE_URLS = [
  '/',
  '/index.html',
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
      // Schémas : nouvelle copie à chaque version (non bloquant si l'un manque).
      const exercises = await caches.open(EXERCISES_CACHE);
      await Promise.all(
        EXERCISE_URLS.map(async (url) => {
          try {
            const resp = await fetch(url, { cache: 'reload' });
            if (isSvgResponse(resp)) await exercises.put(url, resp);
          } catch {
            /* hors ligne pendant l'installation : mis en cache au premier usage */
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
          .filter(
            (k) =>
              k !== STATIC_CACHE &&
              k !== RUNTIME_CACHE &&
              k !== ASSETS_CACHE &&
              k !== EXERCISES_CACHE,
          )
          .map((k) => caches.delete(k)),
      );
      await trimCache(ASSETS_CACHE, ASSETS_MAX_ENTRIES);
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
    event.respondWith(cacheFirst(req, ASSETS_CACHE));
    return;
  }

  // Schémas d'exercices → cache persistant, stale-while-revalidate
  if (url.pathname.startsWith('/exercises/') && url.pathname.endsWith('.svg')) {
    event.respondWith(exerciseSvg(req));
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
    // Ne jamais mettre en cache un fallback HTML servi à la place d'un asset
    // (rewrite SPA sur un chunk disparu) : il empoisonnerait le cache.
    const type = resp.headers.get('content-type') || '';
    if (resp.ok && !type.includes('text/html')) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

function isSvgResponse(resp) {
  // Jamais la page de repli HTML (réécriture SPA) à la place d'un schéma.
  const type = (resp && resp.headers.get('content-type')) || '';
  return !!resp && resp.ok && !type.includes('text/html');
}

async function exerciseSvg(req) {
  const cache = await caches.open(EXERCISES_CACHE);
  // ignoreSearch : « ?v=… » éventuel ne doit pas rater la copie hors ligne.
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((resp) => {
      if (isSvgResponse(resp)) cache.put(req, resp.clone()).catch(() => {});
      return resp;
    })
    .catch(() => null);
  if (cached) return cached;
  return (await network) || new Response('Offline', { status: 503 });
}

async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const excess = keys.length - maxEntries;
    for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
  } catch {
    /* noop */
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
