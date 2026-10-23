/* ClipDrop · Service Worker
   - App shell precacheado (funciona offline tras la primera visita)
   - Navegación: red primero, con respaldo offline
   - Mismo origen + CDNs conocidos: stale-while-revalidate
   Sube VERSION en cada despliegue para limpiar cachés antiguas. */
const VERSION = 'clipdrop-pwa-v6';
const SHELL = VERSION + '-shell';
const RUNTIME = VERSION + '-runtime';
const SHELL_FILES = ['./', './index.html', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com',
  'fonts.gstatic.com', 'images.unsplash.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;   // proxy del backend si se sirve bajo el mismo origen: nunca se cachea

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('./index.html', copy)); }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // JS y CSS de la app: red primero (no mezclar un index.html nuevo con un app.js viejo); la caché solo responde sin conexión
  if (url.origin === location.origin && /\/(app\.js|css\/tailwind\.css)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(RUNTIME).then((c) => c.put(req, copy)); } return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (url.origin === location.origin || CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.status === 200 || res.type === 'opaque') cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached || Response.error());
        return cached || network;
      })
    );
  }
});
