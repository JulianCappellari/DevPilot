// Service worker de DevPilot: cachea sólo el shell estático para poder abrir la app sin conexión.
// Nunca toca /api/: los datos, sesiones y eventos SSE no se cachean (RF-031, RN-013).
const CACHE = "devpilot-shell-v4";
const SHELL = ["/", "/styles.css", "/app.js", "/ui/icons.js", "/ui/motion.js", "/ui/theme-init.js", "/vendor/motion.js",
  "/fonts/inter-latin-wght-normal.woff2", "/fonts/jetbrains-mono-latin-wght-normal.woff2",
  "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())),
  );
});
