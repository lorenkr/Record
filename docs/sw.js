// Offline shell: the app opens even without network (Spotify itself still needs it).
// Network first, so a new version shows up on the next launch.
const CACHE = 'vinyl-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    if (res.ok) caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
