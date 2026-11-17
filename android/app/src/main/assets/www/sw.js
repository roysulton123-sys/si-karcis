const APP_VERSION = '1.2.3';
const CACHE_NAME = 'sikarcis-shell-v8';
const PRECACHE_URLS = [
  './',
  './index.html',
  './dashboard.html',
  './css/style.css?v=1.2.3',
  './js/app.js?v=1.2.3',
  './js/firebase-config.js',
  './assets/app-icon.png',
  './assets/app-icon-192.png',
  './assets/logo-kab-malang.png',
  './assets/logo-dispora.png',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(async () => {
        const clientList = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true
        });
        for (const client of clientList) {
          try {
            const u = new URL(client.url);
            if (u.searchParams.get('v') !== APP_VERSION && 'navigate' in client) {
              u.searchParams.set('v', APP_VERSION);
              await client.navigate(u.href);
            }
          } catch {
            // Abaikan bila client tidak mendukung navigate
          }
        }
      })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Hanya tangani aset origin aplikasi (kecuali APK), lewati API Firebase / CDN eksternal
  if (url.origin !== self.location.origin || url.pathname.endsWith('.apk')) {
    return;
  }

  // Bypass HTTP disk cache agar pembaruan web desktop selalu langsung tampil
  event.respondWith(
    fetch(url.href, { cache: 'no-store' })
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const copy = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return networkRes;
      })
      .catch(() => caches.match(req))
  );
});
