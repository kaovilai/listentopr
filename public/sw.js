// ListenToPR service worker. The app (not this file) registers it.
// Plain JS on purpose: no build step, no imports.

const VERSION = 'v2'
const SHELL_CACHE = 'listentopr-shell-' + VERSION
// Relative paths, resolved against the SW scope at install time so a scoped
// deploy (https://host/listentopr/) precaches its own shell instead of the
// site root ('/' would fetch the wrong page; '/index.html' would 404).
// theme-boot.js must be precached: it is a blocking <head> script, and a
// network miss would delay first paint for every cached visit.
const SHELL_ASSETS = [
  '.',
  './index.html',
  './theme-boot.js',
  './manifest.webmanifest',
  './icon.svg',
]

function shellUrls() {
  return SHELL_ASSETS.map((p) => new URL(p, self.registration.scope).href)
}

// Update flow: install does NOT skipWaiting — a new version waits until the
// app's update banner sends {type: 'SKIP_WAITING'} (see src/update.ts), so a
// running listening session is never swapped mid-playback. Users who never
// act still get the update when the last tab closes.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(shellUrls()))
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== SHELL_CACHE)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  // Only same-origin GETs (navigations and assets); everything else bypasses the SW.
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(staleWhileRevalidate(request))
})

// Cache-first with background update: serve cached copy immediately,
// refresh the cache from the network for next time.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)

  const refresh = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => undefined)

  if (cached) return cached
  const fresh = await refresh
  return fresh || Response.error()
}
