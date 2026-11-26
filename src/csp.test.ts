import { describe, expect, it } from 'vitest'
import {
  connectSrcValue,
  cspBypassViaProxy,
  endpointAllowedByConnectSrc,
  endpointUsable,
  styleSrcAllowsInline,
  styleSrcValue,
} from './csp'

// The CSP this app ships (index.html), with the build-time LLM origin baked
// in via VITE_LLM_ENDPOINT. style-src carries 'unsafe-inline' because mermaid
// embeds an inline <style> in every rendered diagram SVG; scripts stay strict.
const SHIPPED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self' https://api.github.com https://github.com https://*.githubusercontent.com https://api.example.com; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

const SHIPPED_CONNECT_SRC = "'self' https://api.github.com https://github.com https://*.githubusercontent.com https://api.example.com"

describe('connectSrcValue', () => {
  it('extracts the connect-src directive from a full CSP', () => {
    expect(connectSrcValue(SHIPPED_CSP)).toBe(SHIPPED_CONNECT_SRC)
  })

  it('returns null when there is no connect-src directive', () => {
    expect(connectSrcValue("default-src 'self'")).toBeNull()
  })
})

describe('styleSrcAllowsInline', () => {
  it('the shipped CSP allows inline styles (mermaid diagram <style> in SVG)', () => {
    expect(styleSrcValue(SHIPPED_CSP)).toBe("'self' 'unsafe-inline'")
    expect(styleSrcAllowsInline(SHIPPED_CSP)).toBe(true)
  })

  it('rejects a style-src without the inline exception', () => {
    expect(styleSrcAllowsInline("style-src 'self'")).toBe(false)
  })

  it('returns false when there is no style-src directive', () => {
    expect(styleSrcAllowsInline("default-src 'self'")).toBe(false)
    expect(styleSrcValue("default-src 'self'")).toBeNull()
  })
})

describe('endpointAllowedByConnectSrc', () => {
  const selfOrigin = 'https://listentopr.example'

  it('allows the baked LLM origin, with or without a path', () => {
    expect(endpointAllowedByConnectSrc('https://api.example.com', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(true)
    expect(endpointAllowedByConnectSrc('https://api.example.com/v1', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(true)
  })

  it('allows same-origin endpoints via self', () => {
    expect(endpointAllowedByConnectSrc('https://listentopr.example/api', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(true)
    expect(endpointAllowedByConnectSrc('https://other.example/api', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(false)
  })

  it('allows GitHub hosts and wildcard subdomains', () => {
    expect(endpointAllowedByConnectSrc('https://api.github.com', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(true)
    expect(
      endpointAllowedByConnectSrc('https://avatars.githubusercontent.com', SHIPPED_CONNECT_SRC, selfOrigin),
    ).toBe(true)
    expect(endpointAllowedByConnectSrc('https://github.com', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(true)
  })

  it('rejects an endpoint origin absent from connect-src', () => {
    expect(endpointAllowedByConnectSrc('https://api.openai.com/v1', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(false)
    expect(endpointAllowedByConnectSrc('https://api.example.com.evil.io', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(false)
  })

  it('scheme-source and wildcard tokens allow broadly', () => {
    expect(endpointAllowedByConnectSrc('https://any.host/v1', 'https:', selfOrigin)).toBe(true)
    expect(endpointAllowedByConnectSrc('http://any.host/v1', 'https:', selfOrigin)).toBe(false)
    expect(endpointAllowedByConnectSrc('https://any.host/v1', '*', selfOrigin)).toBe(true)
  })

  it('empty endpoint is always allowed; garbage never is', () => {
    expect(endpointAllowedByConnectSrc('', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(true)
    expect(endpointAllowedByConnectSrc('   ', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(true)
    expect(endpointAllowedByConnectSrc('not a url', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(false)
    expect(endpointAllowedByConnectSrc('ftp://api.example.com', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(false)
  })

  it('host matching is case-insensitive', () => {
    expect(endpointAllowedByConnectSrc('https://API.Example.Com/v1', SHIPPED_CONNECT_SRC, selfOrigin)).toBe(true)
  })
})

describe('endpointUsable', () => {
  const selfOrigin = 'https://listentopr.example'

  it('true when connect-src allows the endpoint and the proxy is inactive', () => {
    expect(
      endpointUsable('https://api.example.com/v1', {
        connectSrc: SHIPPED_CONNECT_SRC,
        selfOrigin,
        proxyActive: false,
      }),
    ).toBe(true)
  })

  it('false when connect-src blocks the endpoint and the proxy is inactive', () => {
    expect(
      endpointUsable('https://api.openai.com/v1', {
        connectSrc: SHIPPED_CONNECT_SRC,
        selfOrigin,
        proxyActive: false,
      }),
    ).toBe(false)
    // Omitted proxyActive behaves like inactive.
    expect(
      endpointUsable('https://api.openai.com/v1', {
        connectSrc: SHIPPED_CONNECT_SRC,
        selfOrigin,
      }),
    ).toBe(false)
  })

  it('true when the proxy is active even though connect-src blocks the endpoint', () => {
    expect(
      endpointUsable('https://api.openai.com/v1', {
        connectSrc: SHIPPED_CONNECT_SRC,
        selfOrigin,
        proxyActive: true,
      }),
    ).toBe(true)
  })

  it('true when connect-src allows and the proxy is also active', () => {
    expect(
      endpointUsable('https://api.example.com/v1', {
        connectSrc: SHIPPED_CONNECT_SRC,
        selfOrigin,
        proxyActive: true,
      }),
    ).toBe(true)
  })

  it('false when the proxy is active but the endpoint is not https', () => {
    // The SW proxy only forwards https targets; without this check the
    // endpoint saves fine and every LLM call dies on the SW's opaque 502.
    expect(
      endpointUsable('http://api.example.com/v1', {
        connectSrc: SHIPPED_CONNECT_SRC,
        selfOrigin,
        proxyActive: true,
      }),
    ).toBe(false)
  })

  it('false when the proxy is active but the endpoint is the app\'s own origin', () => {
    expect(
      endpointUsable(`${selfOrigin}/llm`, {
        connectSrc: SHIPPED_CONNECT_SRC,
        selfOrigin,
        proxyActive: true,
      }),
    ).toBe(false)
  })

  it('false when the proxy is active and the endpoint is an unparseable URL', () => {
    expect(
      endpointUsable('not a url', {
        connectSrc: SHIPPED_CONNECT_SRC,
        selfOrigin,
        proxyActive: true,
      }),
    ).toBe(false)
  })

  it('empty endpoints are always usable', () => {
    expect(endpointUsable('', { connectSrc: SHIPPED_CONNECT_SRC, selfOrigin })).toBe(true)
    expect(endpointUsable('   ', { connectSrc: SHIPPED_CONNECT_SRC, selfOrigin })).toBe(true)
    expect(endpointUsable('', { connectSrc: SHIPPED_CONNECT_SRC, selfOrigin, proxyActive: false })).toBe(true)
  })

  it('a missing or empty connect-src blocks nothing directly', () => {
    expect(
      endpointUsable('https://anywhere.example/v1', { connectSrc: null, selfOrigin }),
    ).toBe(true)
    expect(
      endpointUsable('https://anywhere.example/v1', { connectSrc: '', selfOrigin }),
    ).toBe(true)
  })

  it('matches the old direct-call verdict for the same inputs', () => {
    for (const endpoint of [
      'https://api.example.com',
      'https://api.example.com/v1',
      'https://listentopr.example/api',
      'https://api.github.com',
      'https://api.openai.com/v1',
      'https://api.example.com.evil.io',
      'ftp://api.example.com',
    ]) {
      expect(
        endpointUsable(endpoint, { connectSrc: SHIPPED_CONNECT_SRC, selfOrigin, proxyActive: false }),
      ).toBe(endpointAllowedByConnectSrc(endpoint, SHIPPED_CONNECT_SRC, selfOrigin))
    }
  })
})

describe('cspBypassViaProxy', () => {
  it('false without a controlling service worker (no SW in node)', () => {
    expect(cspBypassViaProxy()).toBe(false)
  })
})
