// Service worker : garde l'app et les dernières prévisions pour un usage hors connexion (en mer !).
const SHELL_CACHE = 'voilemeteo-shell-v2';
const DATA_CACHE = 'voilemeteo-data-v1';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Prévisions : réseau d'abord, dernière version enregistrée si pas de réseau.
  if (url.hostname.endsWith('open-meteo.com')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(DATA_CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then(hit => hit || Response.error()))
    );
    return;
  }

  // Tuiles de carte : pas de mise en cache (trop volumineux).
  if (url.hostname.includes('arcgisonline.com')) return;

  // Application : réponse immédiate depuis le cache, mise à jour en arrière-plan.
  event.respondWith(
    caches.open(SHELL_CACHE).then(cache =>
      cache.match(request).then(hit => {
        const network = fetch(request)
          .then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => hit);
        return hit || network;
      })
    )
  );
});
