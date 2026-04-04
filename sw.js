const CACHE_NAME = 'pianificatore-pasti-v4';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css'
];

// CDN assets da cachare
const CDN_ASSETS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js'
];

// Install: cache risorse statiche
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate: pulizia cache vecchie
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first per API/Firestore, cache-first per assets statici
self.addEventListener('fetch', (event) => {
  // Ignora richieste non-HTTP (es. chrome-extension://)
  if (!event.request.url.startsWith('http')) {
    return;
  }

  const url = new URL(event.request.url);

  // Non cachare richieste Firestore o API
  if (url.hostname.includes('firestore') || url.hostname.includes('googleapis') || url.pathname.includes('.netlify/functions')) {
    return;
  }

  // Cache-first per CDN assets
  if (CDN_ASSETS.some(asset => event.request.url.startsWith(asset))) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Network-first per tutto il resto
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
