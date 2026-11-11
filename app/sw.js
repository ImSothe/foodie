/* foodie · service worker: the app opens instantly and works with no connection.
   Every file of the app is cached at install time, as one consistent version. Requests to other
   origins (sign-in, cloud sync, food databases, AI) are never intercepted.
   The block below is written by `npm run stamp`; a test fails if it is out of date. */
/* stamp:start */
const VERSION = 'd56fa04599d2';
const SHELL = [
  "./",
  "./boot.js",
  "./core/dates.js",
  "./core/nutrition.js",
  "./css/base.css",
  "./css/components.css",
  "./css/tokens.css",
  "./data/demo.js",
  "./fonts/bricolage-grotesque-latin-wght.woff2",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./index.html",
  "./main.js",
  "./manifest.webmanifest",
  "./ui/daystrip.js",
  "./ui/dom.js",
  "./ui/icons.js",
  "./ui/meal-editor.js",
  "./ui/ring.js",
  "./ui/scan-frame.js",
  "./ui/screens/home.js",
  "./ui/screens/kit.js",
  "./ui/screens/simple.js"
];
/* stamp:end */

const CACHE = `foodie-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('foodie-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (err) {
        if (req.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        throw err;
      }
    }),
  );
});
