// CSP connect-src checks for the runtime-configured LLM endpoint.
//
// The endpoint allowlist is baked into index.html at build time
// (VITE_LLM_ENDPOINT -> __CSP_LLM_ENDPOINT__ placeholder), so a
// user-entered endpoint only works when its origin is already allowed by
// the served CSP. These helpers extract connect-src from the meta tag and
// decide whether an endpoint origin passes it.
//
// The service-worker LLM proxy (src/llmproxy.ts + public/sw.js) bypasses
// connect-src for custom endpoints once it controls the page: proxy calls
// are same-origin, and the SW forwards them outside the page CSP. Use
// endpointUsable() for the combined verdict.

import { isProxyActive, validateProxyTarget } from './llmproxy'

/** Extract a named directive's value from a full CSP string. */
function directiveValue(csp: string, name: string): string | null {
  const directives = csp.split(';')
  for (const directive of directives) {
    const parts = directive.trim().split(/\s+/)
    if (parts[0] === name) {
      return parts.slice(1).join(' ')
    }
  }
  return null
}

/** Extract the connect-src directive value from a full CSP string. */
export function connectSrcValue(csp: string): string | null {
  return directiveValue(csp, 'connect-src')
}

/** Extract the style-src directive value from a full CSP string. */
export function styleSrcValue(csp: string): string | null {
  return directiveValue(csp, 'style-src')
}

/**
 * True when style-src permits inline <style> elements. The app needs this:
 * mermaid embeds an inline <style> in every rendered diagram SVG. Scripts
 * stay strictly 'self' — this exception is styles only.
 */
export function styleSrcAllowsInline(csp: string): boolean {
  const value = styleSrcValue(csp)
  if (value === null) return false
  return value.split(/\s+/).includes("'unsafe-inline'")
}

function endpointOrigin(endpoint: string): URL | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return url
}

/** True when the token matches the endpoint host (exact or *.wildcard). */
function hostMatches(token: string, url: URL): boolean {
  // token forms: host | scheme://host | scheme://*.host (paths/ports ignored
  // for our allowlist, which only ever carries bare https origins).
  const stripped = token.replace(/\/+$/, '')
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(stripped)
  if (schemeMatch) {
    if (schemeMatch[1]!.toLowerCase() !== url.protocol.replace(':', '')) return false
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(stripped)) {
    // scheme-source like https: with no host
    return false
  }
  let host = stripped.slice(schemeMatch ? schemeMatch[0].length : 0).toLowerCase()
  if (host === '') return false
  const wildcard = host.startsWith('*.')
  if (wildcard) host = host.slice(2)
  const target = url.hostname.toLowerCase()
  if (host === '') return false
  if (wildcard) return target === host || target.endsWith('.' + host)
  return target === host
}

/**
 * True when the endpoint (a full base URL like https://api.example.com/v1)
 * is fetchable under the given connect-src token list. Empty endpoints are
 * always allowed; unparseable or non-http(s) endpoints never are.
 */
export function endpointAllowedByConnectSrc(
  endpoint: string,
  connectSrc: string,
  selfOrigin: string,
): boolean {
  if (endpoint.trim() === '') return true
  const url = endpointOrigin(endpoint.trim())
  if (url === null) return false
  const tokens = connectSrc.split(/\s+/).filter((t) => t !== '')
  for (const token of tokens) {
    if (token === '*') return true
    if (token === "'self'") {
      if (url.origin.toLowerCase() === selfOrigin.toLowerCase()) return true
      continue
    }
    if (token === 'http:' || token === 'https:') {
      if (token === url.protocol) return true
      continue
    }
    if (hostMatches(token, url)) return true
  }
  return false
}

/**
 * True when the service-worker LLM proxy covers custom endpoints: the SW
 * controls the page, so calls can be rewritten to same-origin proxy
 * requests that connect-src cannot block. False on first load (SW not yet
 * controlling) and wherever service workers are unavailable — callers then
 * need the endpoint to pass connect-src directly.
 */
export function cspBypassViaProxy(): boolean {
  return isProxyActive()
}

/** Options for endpointUsable(). */
export interface EndpointUsableOptions {
  /**
   * connect-src token list. When omitted, read from the page's CSP meta
   * tag (same lookup src/app.ts does). Pass explicitly outside a browser.
   */
  connectSrc?: string | null
  /** Page origin, used for 'self' matching. Defaults to location.origin. */
  selfOrigin?: string
  /** True when the service-worker LLM proxy is active. */
  proxyActive?: boolean
}

/** Read connect-src from the page's CSP meta tag; null when there is none. */
function pageConnectSrc(): string | null {
  if (typeof document === 'undefined') return null
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[http-equiv="Content-Security-Policy"]',
  )
  return connectSrcValue(meta?.getAttribute('content') ?? '')
}

/**
 * Combined endpoint verdict the app should gate on: true when the endpoint
 * is allowed by connect-src for direct calls OR the SW proxy is active
 * (the proxy covers custom endpoints). With the proxy active the endpoint
 * must still pass the proxy's own target rules — https only, never the
 * app's own origin — or every call would die on the SW's opaque 502
 * ("target must be https" / "refusing to proxy to own origin") after
 * burning the retry budget. Empty endpoints are always usable.
 */
export function endpointUsable(endpoint: string, options: EndpointUsableOptions = {}): boolean {
  if (options.proxyActive === true) {
    if (endpoint.trim() === '') return true
    const proxySelfOrigin =
      options.selfOrigin ?? (typeof location !== 'undefined' ? location.origin : '')
    return validateProxyTarget(endpoint.trim(), proxySelfOrigin).ok
  }
  if (endpoint.trim() === '') return true
  const connectSrc =
    options.connectSrc !== undefined ? options.connectSrc : pageConnectSrc()
  // No connect-src directive -> nothing is blocked directly.
  if (connectSrc === null || connectSrc === '') return true
  const selfOrigin =
    options.selfOrigin ?? (typeof location !== 'undefined' ? location.origin : '')
  return endpointAllowedByConnectSrc(endpoint, connectSrc, selfOrigin)
}
