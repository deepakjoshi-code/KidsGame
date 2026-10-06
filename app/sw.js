// Wish Circle service worker: keeps the app shell on the device so the app opens offline.
// Only the files listed in SHELL are ever cached. Nothing a child makes is touched here:
// stories, photos and drawings live encrypted in IndexedDB, never in the Cache API.
// Bump VERSION whenever any shell file changes; old caches are deleted on activate.

const VERSION = "1.0.0";
const CACHE = "wish-circle-" + VERSION;

// Paths relative to the service worker scope. tests/sw-assets.test.mjs checks that this list
// matches the real runtime files under app/ exactly.
const SHELL = [
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "css/comic.css",
  "css/game.css",
  "css/print.css",
  "icons/favicon-32.png",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "js/art.js",
  "js/audio.js",
  "js/catalog.js",
  "js/comic.js",
  "js/crypto.js",
  "js/game.js",
  "js/images.js",
  "js/main.js",
  "js/screens/common.js",
  "js/screens/editor.js",
  "js/screens/parent.js",
  "js/screens/profiles.js",
  "js/screens/setup.js",
  "js/screens/shelf.js",
  "js/screens/unlock.js",
  "js/store.js",
  "js/story.js",
  "js/ui.js",
];

const scopeURL = () => self.registration.scope;
const abs = (p) => new URL(p, scopeURL()).href;
let shellSet = null;
const isShell = (href) => (shellSet ||= new Set(SHELL.map(abs))).has(href);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One by one, so a single missing file can't stop the rest from being cached.
    await Promise.all(SHELL.map(async (p) => {
      try {
        const res = await fetch(new Request(abs(p), { cache: "reload", credentials: "same-origin" }));
        if (!res.ok) throw new Error("HTTP " + res.status);
        await cache.put(abs(p), res);
      } catch (err) {
        console.warn("[sw] could not precache", p, String(err));
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("wish-circle-") && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function fromCache(href) {
  const cache = await caches.open(CACHE);
  return cache.match(href);
}

async function shellFirst(request, href) {
  const hit = await fromCache(href);
  if (hit) return hit;
  return fetch(request);
}

async function navigate(request) {
  const url = new URL(request.url);
  url.search = ""; url.hash = "";
  const index = abs("index.html");
  // The app is one page: its root and index.html come straight from the cache.
  if (url.href === scopeURL() || url.href === index) {
    const hit = await fromCache(index);
    if (hit) return hit;
  }
  try {
    return await fetch(request);
  } catch (err) {
    // Offline. Pages in the app's own folder get the cached app; deeper paths are sent to the
    // app's root, so its relative css/ and js/ links still resolve.
    const hit = await fromCache(index);
    if (!hit) throw err;
    const sameFolder = url.href.slice(0, url.href.lastIndexOf("/") + 1) === scopeURL();
    return sameFolder ? hit : Response.redirect(scopeURL(), 302);
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never handle or cache cross-origin
  if (!url.href.startsWith(scopeURL())) return;
  if (request.mode === "navigate") { event.respondWith(navigate(request)); return; }
  url.search = ""; url.hash = "";
  if (isShell(url.href)) event.respondWith(shellFirst(request, url.href));
  // Anything else goes to the network as normal and is not cached.
});
