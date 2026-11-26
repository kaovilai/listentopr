// ListenToPR service worker. The app (not this file) registers it.
// Plain JS on purpose: no build step, no imports.

const VERSION = 'v3'
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

// ---------- LLM proxy ----------
//
// The served CSP pins connect-src at build time, so custom LLM endpoints
// are blocked for the page. This SW is not subject to the page CSP, so it
// forwards marked same-origin requests to the real https target.
//
// Client side: src/llmproxy.ts llmProxyFetch() rewrites LLM calls into
// same-origin POSTs to '<scope>llm-proxy' carrying 'x-lpr-proxy: 1' (the
// marker this handler gates on) and 'x-lpr-target: <real URL>'. The client
// always sends POST (LLM calls are POSTs; GETs proxy as POST with an empty
// body), so the marker + exact-path check below — not the method — is what
// separates proxy traffic from everything else.

const PROXY_MARKER = 'x-lpr-proxy'
const PROXY_TARGET = 'x-lpr-target'

// The proxy endpoint's pathname, resolved against the SW scope the same
// way SHELL_ASSETS are, so a scoped deploy (https://host/listentopr/)
// proxies at /listentopr/llm-proxy.
function proxyPathname() {
  return new URL('llm-proxy', self.registration.scope).pathname
}

// Target rules mirror validateProxyTarget() in src/llmproxy.ts. This file
// is plain JS with no imports, so the ~5-line rule is duplicated here on
// purpose — keep the two in sync when changing either.
async function handleProxy(event) {
  const request = event.request
  const target = request.headers.get(PROXY_TARGET)
  if (!target) return proxyError('missing x-lpr-target header')

  let targetUrl
  try {
    targetUrl = new URL(target)
  } catch {
    return proxyError('invalid target URL')
  }
  // Only https targets.
  if (targetUrl.protocol !== 'https:') return proxyError('target must be https')
  // No proxying back to our own origin (loops).
  if (targetUrl.origin === self.location.origin) {
    return proxyError('refusing to proxy to own origin (loop)')
  }

  // Forward everything except the two markers and Origin/Referer (which
  // would leak or confuse the upstream's CORS/host checks).
  const headers = new Headers()
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase()
    if (lower === PROXY_MARKER || lower === PROXY_TARGET || lower === 'origin' || lower === 'referer') {
      continue
    }
    headers.set(name, value)
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const body = hasBody ? await request.arrayBuffer() : undefined

  // The client always sends POST; forward whatever method arrived.
  // Returning the fetch promise streams the upstream Response through.
  return fetch(targetUrl.href, {
    method: request.method,
    headers,
    body,
  })
}

function proxyError(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 502,
    headers: { 'content-type': 'application/json' },
  })
}

self.addEventListener('fetch', (event) => {
  const request = event.request

  // LLM proxy: only same-origin requests carrying the marker header AND
  // hitting the exact proxy path. Requests without the marker are never
  // hijacked — they fall through to the shell logic below untouched.
  if (request.headers.get(PROXY_MARKER) === '1') {
    const url = new URL(request.url)
    if (url.origin === self.location.origin && url.pathname === proxyPathname()) {
      event.respondWith(handleProxy(event))
      return
    }
  }

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
