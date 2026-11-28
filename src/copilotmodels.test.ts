import { describe, expect, it, vi } from 'vitest'
import {
  COPILOT_MODELS_TTL_MS,
  CopilotModelsError,
  createCopilotModelsCache,
  fetchCopilotModels,
  isCopilotCacheFresh,
  type CopilotModel,
  type CopilotModelsStorage,
} from './copilotmodels'

// ---------- helpers ----------

const TOKEN = 'gho_testtoken123'

function rawModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    vendor: 'openai',
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

function fakeStorage(): CopilotModelsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

function sampleModel(overrides: Partial<CopilotModel> = {}): CopilotModel {
  return {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    vision: null,
    ...overrides,
  }
}

// ---------- fetchCopilotModels ----------

describe('fetchCopilotModels', () => {
  it('GETs /models with Bearer token and Copilot-Integration-Id headers', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonRes([rawModel()])))
    const models = await fetchCopilotModels(TOKEN, { fetchFn })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/models')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat')
    expect(models).toEqual([{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vision: null }])
  })

  it('keeps entries whose supported_endpoints includes chat/completions', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonRes([
          rawModel({ id: 'a', supported_endpoints: ['/completions', 'chat/completions'] }),
          rawModel({ id: 'b', supported_endpoints: ['/embeddings'] }),
          rawModel({ id: 'c', supported_endpoints: [] }),
        ]),
      ),
    )
    const models = await fetchCopilotModels(TOKEN, { fetchFn })
    expect(models.map((m) => m.id)).toEqual(['a'])
  })

  it('keeps entries lacking supported_endpoints (assumed capable)', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonRes([rawModel({ id: 'a' }), rawModel({ id: 'b', supported_endpoints: null })])),
    )
    const models = await fetchCopilotModels(TOKEN, { fetchFn })
    expect(models.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('drops entries without string id/name', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonRes([rawModel({ id: 42 }), rawModel({ name: null }), rawModel({ id: 'ok' })])),
    )
    const models = await fetchCopilotModels(TOKEN, { fetchFn })
    expect(models.map((m) => m.id)).toEqual(['ok'])
  })

  it('passes vision through when supported_input_modalities is present, null otherwise', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonRes([
          rawModel({ id: 'v', supported_input_modalities: ['text', 'image'] }),
          rawModel({ id: 't', supported_input_modalities: ['text'] }),
          rawModel({ id: 'u' }),
        ]),
      ),
    )
    const models = await fetchCopilotModels(TOKEN, { fetchFn })
    expect(models).toEqual([
      { id: 'v', name: 'GPT-5.6 Luna', vision: true },
      { id: 't', name: 'GPT-5.6 Luna', vision: false },
      { id: 'u', name: 'GPT-5.6 Luna', vision: null },
    ])
  })

  it('throws on an empty token', async () => {
    await expect(fetchCopilotModels('')).rejects.toBeInstanceOf(CopilotModelsError)
  })

  it('redacts the token from a non-2xx error body', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonRes(`bad token ${TOKEN} rejected`, { status: 401 })),
    )
    const err = await fetchCopilotModels(TOKEN, { fetchFn }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CopilotModelsError)
    const e = err as CopilotModelsError
    expect(e.status).toBe(401)
    expect(e.body).toBe('bad token [REDACTED] rejected')
    expect(e.message).not.toContain(TOKEN)
  })

  it('redacts the token from a network error message', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error(`connect failed for ${TOKEN}`)))
    const err = await fetchCopilotModels(TOKEN, { fetchFn }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CopilotModelsError)
    expect((err as Error).message).not.toContain(TOKEN)
    expect((err as Error).message).toContain('[REDACTED]')
  })

  it('throws on a non-array response body', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonRes({ data: [] })))
    await expect(fetchCopilotModels(TOKEN, { fetchFn })).rejects.toThrow(
      'model list response is not an array',
    )
  })

  it('throws on a non-JSON success response', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonRes('<html>oops</html>')))
    await expect(fetchCopilotModels(TOKEN, { fetchFn })).rejects.toBeInstanceOf(CopilotModelsError)
  })
})

// ---------- isCopilotCacheFresh ----------

describe('isCopilotCacheFresh', () => {
  it('is fresh before the TTL and stale after', () => {
    const now = 1_000_000
    expect(isCopilotCacheFresh(now - COPILOT_MODELS_TTL_MS + 1, now)).toBe(true)
    expect(isCopilotCacheFresh(now - COPILOT_MODELS_TTL_MS, now)).toBe(false)
    expect(isCopilotCacheFresh(now - COPILOT_MODELS_TTL_MS - 1, now)).toBe(false)
  })
})

// ---------- createCopilotModelsCache ----------

describe('createCopilotModelsCache', () => {
  it('round-trips models written and read back', () => {
    const storage = fakeStorage()
    const cache = createCopilotModelsCache(storage)
    const models = [sampleModel({ vision: true }), sampleModel({ id: 'claude-haiku-4.5', vision: null })]
    cache.write(models)
    const read = cache.read()
    expect(read).not.toBeNull()
    expect(read?.models).toEqual(models)
    expect(read?.fetchedAt).toBeGreaterThan(0)
    // stored under the expected key as JSON
    expect(storage.data.has('listentopr.copilot-models')).toBe(true)
  })

  it('returns null when nothing is stored', () => {
    expect(createCopilotModelsCache(fakeStorage()).read()).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    const storage = fakeStorage()
    storage.setItem('listentopr.copilot-models', '{not json')
    expect(createCopilotModelsCache(storage).read()).toBeNull()
  })

  it('returns null on a non-object or wrong-shape record', () => {
    const storage = fakeStorage()
    storage.setItem('listentopr.copilot-models', '"just a string"')
    expect(createCopilotModelsCache(storage).read()).toBeNull()
    storage.setItem('listentopr.copilot-models', JSON.stringify({ models: 'nope' }))
    expect(createCopilotModelsCache(storage).read()).toBeNull()
    storage.setItem(
      'listentopr.copilot-models',
      JSON.stringify({ models: [{ id: 42 }], fetchedAt: Date.now() }),
    )
    expect(createCopilotModelsCache(storage).read()).toBeNull()
    storage.setItem(
      'listentopr.copilot-models',
      JSON.stringify({ models: [{ id: 'a', name: 'A', vision: 'yes' }], fetchedAt: Date.now() }),
    )
    expect(createCopilotModelsCache(storage).read()).toBeNull()
  })

  it('returns null when the entry is expired', () => {
    const storage = fakeStorage()
    storage.setItem(
      'listentopr.copilot-models',
      JSON.stringify({ models: [sampleModel()], fetchedAt: Date.now() - COPILOT_MODELS_TTL_MS - 1 }),
    )
    expect(createCopilotModelsCache(storage).read()).toBeNull()
  })

  it('still reads just inside the fresh boundary', () => {
    const storage = fakeStorage()
    storage.setItem(
      'listentopr.copilot-models',
      JSON.stringify({
        models: [sampleModel()],
        fetchedAt: Date.now() - COPILOT_MODELS_TTL_MS + 10,
      }),
    )
    expect(createCopilotModelsCache(storage).read()).not.toBeNull()
  })
})
