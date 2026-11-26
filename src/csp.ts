// CSP connect-src checks for the runtime-configured LLM endpoint.
//
// The endpoint allowlist is baked into index.html at build time
// (VITE_LLM_ENDPOINT -> __CSP_LLM_ENDPOINT__ placeholder), so a
// user-entered endpoint only works when its origin is already allowed by
// the served CSP. These helpers extract connect-src from the meta tag and
// decide whether an endpoint origin passes it.

/** Extract the connect-src directive value from a full CSP string. */
export function connectSrcValue(csp: string): string | null {
  const directives = csp.split(';')
  for (const directive of directives) {
    const parts = directive.trim().split(/\s+/)
    if (parts[0] === 'connect-src') {
      return parts.slice(1).join(' ')
    }
  }
  return null
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
