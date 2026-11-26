import { describe, expect, it, vi } from 'vitest'
import { isProxyActive, llmProxyFetch, validateProxyTarget } from './llmproxy'

// A service-worker container stub: 'controller' is all isProxyActive reads.
const controlled = { controller: { state: 'activated' } }
const uncontrolled = { controller: null }

const BASE = 'https://listentopr.example/'

// Typed mock so mock.calls[i] carries (url, init).
function mockFetch() {
  return vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('')))
}

/** First recorded call as a non-optional [url, init] tuple. */
function lastCall(fetchImpl: ReturnType<typeof mockFetch>): [string, RequestInit] {
  const [url, init] = fetchImpl.mock.calls[0]!
  return [url, init ?? {}]
}

describe('isProxyActive', () => {
  it('true when a service worker controls the page', () => {
    expect(isProxyActive({ serviceWorker: controlled })).toBe(true)
  })

  it('false when the container exists but no controller yet (first load)', () => {
    expect(isProxyActive({ serviceWorker: uncontrolled })).toBe(false)
  })

  it('false when serviceWorker is undefined or the dep is null', () => {
    expect(isProxyActive({ serviceWorker: undefined })).toBe(false)
    expect(isProxyActive({ serviceWorker: null })).toBe(false)
  })

  it('false in an environment with no service-worker container at all', () => {
    // Node/vitest: navigator has no serviceWorker (or no navigator).
    expect(isProxyActive()).toBe(false)
  })
})

describe('llmProxyFetch', () => {
  it('rewrites to a same-origin llm-proxy POST with marker + target headers', async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response('{"ok":true}')),
    )
    const call = llmProxyFetch({
      fetchImpl,
      serviceWorker: controlled,
      baseURI: BASE,
    })

    await call('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: '{"model":"gpt"}',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = lastCall(fetchImpl)
    expect(url).toBe('https://listentopr.example/llm-proxy')
    expect(init.method).toBe('POST')
    const headers = init.headers as Headers
    expect(headers).toBeInstanceOf(Headers)
    expect(headers.get('x-lpr-proxy')).toBe('1')
    expect(headers.get('x-lpr-target')).toBe('https://api.openai.com/v1/chat/completions')
    // Original headers survive the rewrite.
    expect(headers.get('authorization')).toBe('Bearer sk-test')
    expect(headers.get('content-type')).toBe('application/json')
    // Body forwarded verbatim.
    expect(init.body).toBe('{"model":"gpt"}')
  })

  it('resolves the proxy URL against document.baseURI (SW scope), not host root', async () => {
    const fetchImpl = mockFetch()
    const call = llmProxyFetch({
      fetchImpl,
      serviceWorker: controlled,
      baseURI: 'https://host.example/listentopr/',
    })
    await call('https://api.example.com/v1', { method: 'POST' })
    expect(lastCall(fetchImpl)[0]).toBe('https://host.example/listentopr/llm-proxy')
  })

  it('accepts a Headers instance as init.headers and adds markers to it', async () => {
    const fetchImpl = mockFetch()
    const call = llmProxyFetch({
      fetchImpl,
      serviceWorker: controlled,
      baseURI: BASE,
    })
    const original = new Headers({ authorization: 'Bearer k' })
    await call('https://api.example.com/v1', { method: 'POST', headers: original })
    const headers = lastCall(fetchImpl)[1].headers as Headers
    expect(headers.get('x-lpr-proxy')).toBe('1')
    expect(headers.get('x-lpr-target')).toBe('https://api.example.com/v1')
    expect(headers.get('authorization')).toBe('Bearer k')
  })

  it('an incoming GET still proxies, as a POST with an empty body', async () => {
    const fetchImpl = mockFetch()
    const call = llmProxyFetch({
      fetchImpl,
      serviceWorker: controlled,
      baseURI: BASE,
    })
    await call('https://api.example.com/v1/models', { method: 'GET' })
    const [url, init] = lastCall(fetchImpl)
    expect(url).toBe('https://listentopr.example/llm-proxy')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect((init.headers as Headers).get('x-lpr-target')).toBe('https://api.example.com/v1/models')
  })

  it('forwards the body unchanged when one is present', async () => {
    const fetchImpl = mockFetch()
    const call = llmProxyFetch({
      fetchImpl,
      serviceWorker: controlled,
      baseURI: BASE,
    })
    const body = JSON.stringify({ stream: true })
    await call('https://api.example.com/v1', { method: 'POST', body })
    expect(lastCall(fetchImpl)[1].body).toBe(body)
  })

  it('falls back to a direct fetch of the original URL when no controller (first load)', async () => {
    const fetchImpl = mockFetch()
    const call = llmProxyFetch({
      fetchImpl,
      serviceWorker: uncontrolled,
      baseURI: BASE,
    })
    const init = {
      method: 'POST',
      headers: { authorization: 'Bearer k' },
      body: '{"x":1}',
    }
    await call('https://api.example.com/v1', init)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, passedInit] = lastCall(fetchImpl)
    // Untouched: same URL, same init, no proxy markers injected.
    expect(url).toBe('https://api.example.com/v1')
    expect(passedInit).toBe(init)
    expect(passedInit.headers).toEqual({ authorization: 'Bearer k' })
  })

  it('falls back to a direct fetch when there is no service-worker container', async () => {
    const fetchImpl = mockFetch()
    const call = llmProxyFetch({ fetchImpl, serviceWorker: undefined, baseURI: BASE })
    await call('https://api.example.com/v1', { method: 'POST' })
    expect(lastCall(fetchImpl)[0]).toBe('https://api.example.com/v1')
  })
})

describe('validateProxyTarget (mirrors sw.js handleProxy rules)', () => {
  const selfOrigin = 'https://listentopr.example'

  it('accepts an external https target', () => {
    expect(validateProxyTarget('https://api.openai.com/v1', selfOrigin)).toEqual({ ok: true })
  })

  it('rejects non-https schemes', () => {
    const http = validateProxyTarget('http://api.openai.com/v1', selfOrigin)
    expect(http).toEqual({ ok: false, reason: 'target must be https' })
    const ftp = validateProxyTarget('ftp://api.example.com', selfOrigin)
    expect(ftp.ok).toBe(false)
  })

  it('rejects unparseable targets', () => {
    const res = validateProxyTarget('not a url', selfOrigin)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.length).toBeGreaterThan(0)
  })

  it('refuses its own origin (no loops)', () => {
    const res = validateProxyTarget('https://listentopr.example/llm-proxy', selfOrigin)
    expect(res.ok).toBe(false)
  })

  it('origin comparison is case-insensitive', () => {
    const res = validateProxyTarget('https://ListenToPR.example/anything', selfOrigin)
    expect(res.ok).toBe(false)
    expect(validateProxyTarget('https://API.Example.Com/v1', selfOrigin)).toEqual({ ok: true })
  })
})
