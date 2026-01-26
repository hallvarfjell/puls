
/* sw.js – HR app (offline-first) */

const CACHE_VERSION = "hr-offline-v1.2.0";
const CACHE_NAME = `cache-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sw.js",

  "./icons/favicon/favicon-96x96.png",
  "./icons/favicon/favicon.svg",
  "./icons/favicon/favicon.ico",
  "./icons/favicon/apple-touch-icon.png",
  "./icons/favicon/site.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match("./index.html");
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        cache.put("./index.html", fresh.clone());
        return fresh;
      } catch {
        return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })());
    return;
  }

  if (!sameOrigin) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
  })());
});
