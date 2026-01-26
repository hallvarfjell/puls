
/* sw.js – HR app (GitHub Pages-friendly) */

const CACHE_VERSION = "hr-v1.0.0";
const PRECACHE = `precache-${CACHE_VERSION}`;
const RUNTIME = `runtime-${CACHE_VERSION}`;

// App-shell + favicon-pakken din (relative paths for GitHub Pages)
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sw.js",

  // Favicon pack
  "./icons/favicon/favicon-96x96.png",
  "./icons/favicon/favicon.svg",
  "./icons/favicon/favicon.ico",
  "./icons/favicon/apple-touch-icon.png",
  "./icons/favicon/site.webmanifest"
];

// Install: cache app shell
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    await cache.addAll(PRECACHE_URLS);
    self.skipWaiting();
  })());
});

// Activate: cleanup old caches
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => ![PRECACHE, RUNTIME].includes(k))
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Helpers
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  const cache = await caches.open(RUNTIME);
  cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then((fresh) => {
    cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => cached);

  return cached || fetchPromise;
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const fresh = await fetch(request);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

// Fetch strategy
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Navigations: serve app shell (index.html) cache-first
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      // Always return cached index.html when available
      const cached = await caches.match("./index.html");
      if (cached) return cached;

      // Fallback: try network, then cache it
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(PRECACHE);
        cache.put("./index.html", fresh.clone());
        return fresh;
      } catch {
        // Last resort: try cached root
        return caches.match("./");
      }
    })());
    return;
  }

  // Same-origin assets: stale-while-revalidate (fast)
  if (sameOrigin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Cross-origin (CDN): network-first (avoid stale/opaque lock-in)
  event.respondWith(networkFirst(req));
});
