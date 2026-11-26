import { describe, expect, it } from 'vitest'
import { connectSrcValue, endpointAllowedByConnectSrc } from './csp'

// The CSP this app ships (index.html), with the build-time LLM origin baked
// in via VITE_LLM_ENDPOINT.
const SHIPPED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
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
