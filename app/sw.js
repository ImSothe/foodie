/* foodie · service worker: the app opens instantly and works with no connection.
   Every file of the app is cached at install time, as one consistent version. Requests to other
   origins (sign-in, cloud sync, food databases, AI) are never intercepted.
   The block below is written by `npm run stamp`; a test fails if it is out of date. */
/* stamp:start */
const VERSION = 'e2c1a2b98c91';
const SHELL = [
  "./",
  "./boot.js",
  "./core/cloudmap.js",
  "./core/dates.js",
  "./core/goals.js",
  "./core/merge.js",
  "./core/nutrition.js",
  "./core/off.js",
  "./core/progress.js",
  "./core/router.js",
  "./core/schema.js",
  "./core/search.js",
  "./core/serving.js",
  "./core/vision.js",
  "./css/base.css",
  "./css/components.css",
  "./css/tokens.css",
  "./data/camera.js",
  "./data/cloud.js",
  "./data/firebase-config.js",
  "./data/foods.es.json",
  "./data/image.js",
  "./data/off-client.js",
  "./data/scanner.js",
  "./data/store.js",
  "./data/vision.js",
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
  "./ui/fields.js",
  "./ui/grams-control.js",
  "./ui/icons.js",
  "./ui/meal-editor.js",
  "./ui/meal-parts.js",
  "./ui/ring.js",
  "./ui/scan-frame.js",
  "./ui/screens/add-food.js",
  "./ui/screens/camera.js",
  "./ui/screens/cloud-card.js",
  "./ui/screens/home.js",
  "./ui/screens/kit.js",
  "./ui/screens/onboarding.js",
  "./ui/screens/photo.js",
  "./ui/screens/product.js",
  "./ui/screens/progress.js",
  "./ui/screens/saved.js",
  "./ui/screens/settings.js",
  "./vendor/firebase.js"
];
const LAZY = [
  "./vendor/lazy/barcode-detector.js",
  "./vendor/lazy/zxing_reader.wasm"
];
/* stamp:end */

const CACHE = `foodie-${VERSION}`;
// SHELL is cached at install; LAZY files (big, optional) are cached the first time they are fetched. Both are files of this app.
const SHELL_URLS = new Set([...SHELL, ...LAZY].map((url) => new URL(url, self.location).href));
const inShell = (url) => { const u = new URL(url); u.search = ''; u.hash = ''; return SHELL_URLS.has(u.href); };

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// GitHub Pages serves every project of the account from the same origin, so cache storage is shared
// with other apps: only caches named "foodie-…" are ours to delete.
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
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // If another app on this origin wiped our cache, put the file back so offline keeps working.
      if (res.ok && inShell(req.url)) e.waitUntil(cache.put(req, res.clone()));
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
