import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_TTL_MS,
  CatalogError,
  createCatalogCache,
  fetchModelCatalog,
  groupByPublisher,
  isCacheFresh,
  type CatalogModel,
  type CatalogStorage,
} from './modelcatalog'

// ---------- helpers ----------

const TOKEN = 'ghp_testtoken123'

function rawModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    publisher: 'openai',
    registry: 'github',
    summary: 'Small fast model',
    html_url: 'https://github.com/marketplace/models/openai/gpt-5-mini',
    version: '1.0.0',
    capabilities: [],
    limits: { max_input_tokens: 128000, max_output_tokens: 16384 },
    rate_limit_tier: 'low',
    supported_input_modalities: ['text'],
    supported_output_modalities: ['text'],
    tags: [],
    ...overrides,
  }
}

function jsonRes(body: unknown, opts: { status?: number } = {}): Response {
  const status = opts.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function fakeStorage(): CatalogStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

function sampleModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    publisher: 'openai',
    summary: 'Small fast model',
    vision: false,
    maxInputTokens: 128000,
    rateLimitTier: 'low',
    ...overrides,
  }
}

// ---------- fetchModelCatalog ----------

describe('fetchModelCatalog', () => {
  it('sends Bearer, Accept, and X-GitHub-Api-Version headers', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes([]))
    await fetchModelCatalog(TOKEN, { fetchFn })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> }
    ]
    expect(url).toBe('https://models.github.ai/catalog/models')
    expect(init.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect(init.headers['Accept']).toBe('application/vnd.github+json')
    expect(init.headers['X-GitHub-Api-Version']).toBe('2026-03-10')
  })

  it('maps vision flag, maxInputTokens, and rateLimitTier', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonRes([rawModel({ supported_input_modalities: ['text', 'image'] })]))
    const models = await fetchModelCatalog(TOKEN, { fetchFn })
    expect(models).toEqual([
      {
        id: 'openai/gpt-5-mini',
        name: 'GPT-5 Mini',
        publisher: 'openai',
        summary: 'Small fast model',
        vision: true,
        maxInputTokens: 128000,
        rateLimitTier: 'low',
      },
    ])
  })

  it('falls back to null for missing max_input_tokens and rate_limit_tier', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonRes([rawModel({ limits: {}, rate_limit_tier: undefined })]))
    const models = await fetchModelCatalog(TOKEN, { fetchFn })
    expect(models[0]?.maxInputTokens).toBeNull()
    expect(models[0]?.rateLimitTier).toBeNull()
  })

  it('skips models whose supported_output_modalities lacks text', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonRes([
        rawModel({ id: 'a/text', supported_output_modalities: ['text'] }),
        rawModel({ id: 'b/embed', supported_output_modalities: ['embedding'] }),
        rawModel({ id: 'c/image', supported_output_modalities: ['image'] }),
        rawModel({ id: 'd/none', supported_output_modalities: undefined }),
      ])
    )
    const models = await fetchModelCatalog(TOKEN, { fetchFn })
    expect(models.map((m) => m.id)).toEqual(['a/text'])
  })

  it('throws CatalogError on 401 with sanitized body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonRes({ message: `bad credentials for ${TOKEN}` }, { status: 401 })
    )
    const err = await fetchModelCatalog(TOKEN, { fetchFn }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CatalogError)
    const ce = err as CatalogError
    expect(ce.status).toBe(401)
    expect(ce.body).not.toContain(TOKEN)
    expect(ce.body).toContain('[REDACTED]')
    expect(ce.message).not.toContain(TOKEN)
  })

  it('throws CatalogError on 403 with sanitized body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonRes(`forbidden token=${TOKEN}`, { status: 403 })
    )
    const err = await fetchModelCatalog(TOKEN, { fetchFn }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CatalogError)
    const ce = err as CatalogError
    expect(ce.status).toBe(403)
    expect(ce.body).not.toContain(TOKEN)
    expect(ce.body).toContain('[REDACTED]')
  })

  it('throws CatalogError("no token") for an empty token without fetching', async () => {
    const fetchFn = vi.fn()
    const err = await fetchModelCatalog('', { fetchFn }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CatalogError)
    expect((err as CatalogError).message).toBe('no token')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('wraps a fetch TypeError failure as CatalogError with the message', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const err = await fetchModelCatalog(TOKEN, { fetchFn }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CatalogError)
    const ce = err as CatalogError
    expect(ce.status).toBe(0)
    expect(ce.message).toBe('fetch failed')
  })

  it('redacts the token from a network error message', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError(`network down near ${TOKEN}`))
    const err = await fetchModelCatalog(TOKEN, { fetchFn }).catch((e: unknown) => e)
    expect((err as CatalogError).message).not.toContain(TOKEN)
  })

  it('throws CatalogError when the response body is not an array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ error: 'nope' }))
    const err = await fetchModelCatalog(TOKEN, { fetchFn }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CatalogError)
    expect((err as CatalogError).message).toBe('catalog response is not an array')
  })
})

// ---------- groupByPublisher ----------

describe('groupByPublisher', () => {
  it('groups by publisher, sorted by publisher then model id', () => {
    const groups = groupByPublisher([
      sampleModel({ id: 'meta/llama-4', publisher: 'meta' }),
      sampleModel({ id: 'openai/gpt-5', publisher: 'openai' }),
      sampleModel({ id: 'meta/llama-3', publisher: 'meta' }),
      sampleModel({ id: 'openai/gpt-4.1', publisher: 'openai' }),
      sampleModel({ id: 'deepseek/deepseek-v3', publisher: 'deepseek' }),
    ])
    expect(groups.map((g) => g.publisher)).toEqual(['deepseek', 'meta', 'openai'])
    expect(groups[1]?.models.map((m) => m.id)).toEqual(['meta/llama-3', 'meta/llama-4'])
    expect(groups[2]?.models.map((m) => m.id)).toEqual(['openai/gpt-4.1', 'openai/gpt-5'])
  })

  it('does not mutate the input array order', () => {
    const input = [
      sampleModel({ id: 'b', publisher: 'x' }),
      sampleModel({ id: 'a', publisher: 'x' }),
    ]
    groupByPublisher(input)
    expect(input.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('returns an empty array for no models', () => {
    expect(groupByPublisher([])).toEqual([])
  })
})

// ---------- isCacheFresh ----------

describe('isCacheFresh', () => {
  it('is fresh before the TTL and stale after', () => {
    const now = 1_000_000
    expect(isCacheFresh(now - CATALOG_TTL_MS + 1, now)).toBe(true)
    expect(isCacheFresh(now - CATALOG_TTL_MS, now)).toBe(false)
    expect(isCacheFresh(now - CATALOG_TTL_MS - 1, now)).toBe(false)
  })
})

// ---------- createCatalogCache ----------

describe('createCatalogCache', () => {
  it('round-trips models written and read back', () => {
    const storage = fakeStorage()
    const cache = createCatalogCache(storage)
    const models = [sampleModel({ vision: true, maxInputTokens: null })]
    cache.write(models)
    const read = cache.read()
    expect(read).not.toBeNull()
    expect(read?.models).toEqual(models)
    expect(read?.fetchedAt).toBeGreaterThan(0)
    // stored under the expected key as JSON
    expect(storage.data.has('listentopr.gh-models')).toBe(true)
  })

  it('returns null when nothing is stored', () => {
    const cache = createCatalogCache(fakeStorage())
    expect(cache.read()).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    const storage = fakeStorage()
    storage.setItem('listentopr.gh-models', '{not json')
    expect(createCatalogCache(storage).read()).toBeNull()
  })

  it('returns null on a non-object or wrong-shape record', () => {
    const storage = fakeStorage()
    storage.setItem('listentopr.gh-models', '"just a string"')
    expect(createCatalogCache(storage).read()).toBeNull()
    storage.setItem('listentopr.gh-models', JSON.stringify({ models: 'nope' }))
    expect(createCatalogCache(storage).read()).toBeNull()
    storage.setItem(
      'listentopr.gh-models',
      JSON.stringify({ models: [{ id: 42 }], fetchedAt: Date.now() })
    )
    expect(createCatalogCache(storage).read()).toBeNull()
  })

  it('returns null when the entry is expired', () => {
    const storage = fakeStorage()
    storage.setItem(
      'listentopr.gh-models',
      JSON.stringify({ models: [sampleModel()], fetchedAt: Date.now() - CATALOG_TTL_MS - 1 })
    )
    expect(createCatalogCache(storage).read()).toBeNull()
  })

  it('still reads at exactly the fresh boundary minus one ms', () => {
    const storage = fakeStorage()
    storage.setItem(
      'listentopr.gh-models',
      JSON.stringify({
        models: [sampleModel()],
        fetchedAt: Date.now() - CATALOG_TTL_MS + 10,
      })
    )
    expect(createCatalogCache(storage).read()).not.toBeNull()
  })
})
