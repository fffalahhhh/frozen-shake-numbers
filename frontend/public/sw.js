// Frozen Shake service worker.
// - App shell (index.html + hashed /assets/*) is precached so the app opens offline.
// - API GETs are network-first with a cache fallback, so previously loaded
//   records stay viewable offline. Writes are never cached: the page queues
//   them (src/sync.ts) and replays them when back online.
const SHELL = 'fs-shell-v1'
const API = 'fs-api'
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL)
    await cache.addAll(SHELL_URLS)
    // Precache the hashed bundles referenced by index.html.
    const html = await (await cache.match('/')).text()
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
    await cache.addAll(assets)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== API) await caches.delete(key)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin) return

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, API))
  } else if (req.mode === 'navigate') {
    // SPA: every route is index.html.
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) caches.open(SHELL).then((c) => c.put('/', res.clone()))
      return res
    }).catch(async () => (await caches.match('/')) || Response.error()))
  } else {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && url.pathname.startsWith('/assets/')) {
        const copy = res.clone()
        caches.open(SHELL).then((c) => c.put(req, copy))
      }
      return res
    })))
  }
})

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req)
    if (res.ok) {
      const copy = res.clone()
      caches.open(cacheName).then((c) => c.put(req, copy))
    }
    return res
  } catch (err) {
    const hit = await caches.match(req)
    if (hit) {
      const headers = new Headers(hit.headers)
      headers.set('X-From-Cache', '1')
      return new Response(hit.body, { status: hit.status, headers })
    }
    throw err
  }
}
