// Client side of the service-worker LLM proxy.
//
// The served CSP pins connect-src at build time, so a custom user endpoint
// is normally blocked. When the service worker controls the page, this
// module rewrites LLM fetches into same-origin POSTs to '<scope>llm-proxy'
// carrying the real target in headers; public/sw.js intercepts those and
// forwards them (its fetches are not subject to the page CSP). On first
// load, before the SW controls the page, calls fall back to direct fetch —
// the default endpoints are CSP-allowed anyway.

/** Injectable bits so tests can run without a real browser. */
export interface LlmProxyDeps {
  /** Fetch implementation the returned function uses. Defaults to global fetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  /** Service-worker container to inspect. Defaults to navigator.serviceWorker. */
  serviceWorker?: { controller: unknown } | null
  /** Base used to resolve the same-origin proxy URL. Defaults to document.baseURI. */
  baseURI?: string
}

/**
 * True when a service worker controls the page (so proxy fetches will be
 * intercepted). False on first load, in non-SW browsers, and outside the
 * browser.
 */
export function isProxyActive(deps: LlmProxyDeps = {}): boolean {
  const container =
    deps.serviceWorker !== undefined
      ? deps.serviceWorker
      : typeof navigator !== 'undefined'
        ? (navigator as { serviceWorker?: { controller: unknown } }).serviceWorker
        : undefined
  if (container === null || container === undefined) return false
  return container.controller !== null && container.controller !== undefined
}

/**
 * Create a fetch-like function for LLM calls. When the proxy is active it
 * rewrites each call into a same-origin POST to 'llm-proxy' (resolved
 * against document.baseURI, i.e. the SW scope) with:
 *   - x-lpr-proxy: 1        (marker the SW gates on)
 *   - x-lpr-target: <url>   (the real endpoint)
 * All other headers and the body are forwarded. LLM calls are POSTs; an
 * incoming GET still proxies, as a POST with an empty body. When no service
 * worker controls the page, calls go straight to the original URL unchanged.
 */
export function llmProxyFetch(
  deps: LlmProxyDeps = {},
): (url: string, init: RequestInit) => Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (!isProxyActive(deps)) return doFetch(url, init)

    const base =
      deps.baseURI ??
      (typeof document !== 'undefined'
        ? document.baseURI
        : typeof location !== 'undefined'
          ? location.href
          : undefined)
    // No base to resolve the proxy URL against — nothing we can do but
    // attempt the direct call and let the CSP speak.
    if (base === undefined) return doFetch(url, init)

    const proxyUrl = new URL('llm-proxy', base).href
    const headers = new Headers(init.headers ?? {})
    headers.set('x-lpr-proxy', '1')
    headers.set('x-lpr-target', url)
    return doFetch(proxyUrl, {
      ...init,
      method: 'POST',
      headers,
      body: init.body,
    })
  }
}

export type ProxyTargetValidation = { ok: true } | { ok: false; reason: string }

/**
 * Pure mirror of the target rules the service worker enforces in
 * public/sw.js handleProxy(): only https targets, never the app's own
 * origin (no proxy loops). sw.js is plain JS and cannot import this — the
 * rules there are a deliberate duplicate; keep the two in sync.
 */
export function validateProxyTarget(target: string, selfOrigin: string): ProxyTargetValidation {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return { ok: false, reason: 'invalid target URL' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'target must be https' }
  }
  if (url.origin.toLowerCase() === selfOrigin.toLowerCase()) {
    return { ok: false, reason: 'refusing to proxy to own origin (loop)' }
  }
  return { ok: true }
}
