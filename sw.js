const CACHE_NAME = 'sikarcis-shell-v3';
const PRECACHE_URLS = [
  './',
  './index.html',
  './dashboard.html',
  './css/style.css',
  './js/app.js',
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
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Jangan cache koneksi real-time Firebase / Google APIs atau unduhan file APK
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebaseapp.com') ||
    url.pathname.endsWith('.apk')
  ) {
    return;
  }

  // Gunakan Network-First agar kode & tampilan selalu mutakhir dan sinkron dengan Cloud
  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200 && url.origin === self.location.origin) {
          const copy = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return networkRes;
      })
      .catch(() => caches.match(req))
  );
});
