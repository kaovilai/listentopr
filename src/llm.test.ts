import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, LlmError, PROVIDER_DEFAULT_ENDPOINTS } from './llm'
import type { LlmConfig, LlmMessage, LlmProvider } from './types'

const config: LlmConfig = {
  endpoint: 'https://api.example.com/v1',
  apiKey: 'sk-test-secret',
  model: 'test-model',
}

const PNG_DATA_URL = 'data:image/png;base64,QUJD'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub global fetch returning a JSON payload; returns the mock for call inspection. */
function stubJson(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status })))
  vi.stubGlobal('fetch', fn)
  return fn
}

function lastCall(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  expect(mock).toHaveBeenCalled()
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit]
  return { url, init: init ?? {} }
}

function sentBody(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String(lastCall(mock).init.body)) as Record<string, unknown>
}

function providerConfig(provider: LlmProvider, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return { apiKey: 'sk-test-secret', model: 'test-model', provider, ...overrides }
}

// ---------------------------------------------------------------------------
// Existing behavior: timeout coverage
// ---------------------------------------------------------------------------

describe('chat timeout coverage', () => {
  it('timeout still aborts a stalled response body, not just the headers', async () => {
    // fetch resolves as soon as headers arrive, but the body never
    // completes on its own; only the timeout abort must end the call.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
                // never enqueue / close: body stalls forever
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    )

    await expect(
      chat(config, [{ role: 'user', text: 'hi' }], { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(LlmError)
  })

  it('a fast body read succeeds within the timeout', async () => {
    stubJson({ choices: [{ message: { content: 'ok' } }] })
    await expect(
      chat(config, [{ role: 'user', text: 'hi' }], { timeoutMs: 5_000 }),
    ).resolves.toBe('ok')
  })

  it('external abort signal cancels an in-flight request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    )
    const external = new AbortController()
    const pending = chat(config, [{ role: 'user', text: 'hi' }], { signal: external.signal })
    external.abort()
    await expect(pending).rejects.toBeInstanceOf(LlmError)
  })
})

// ---------------------------------------------------------------------------
// Provider dispatch + default endpoints
// ---------------------------------------------------------------------------

describe('PROVIDER_DEFAULT_ENDPOINTS', () => {
  it('exposes the public defaults for all four providers', () => {
    expect(PROVIDER_DEFAULT_ENDPOINTS).toEqual({
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com',
      gemini: 'https://generativelanguage.googleapis.com',
      github: 'https://models.github.ai',
    })
  })
})

describe('endpoint resolution', () => {
  it('openai: empty endpoint falls back to the public default', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('openai', { endpoint: '' }), [{ role: 'user', text: 'hi' }])
    expect(lastCall(mock).url).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('openai: missing endpoint falls back to the public default', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    const { endpoint: _omit, ...noEndpoint } = providerConfig('openai')
    await chat(noEndpoint, [{ role: 'user', text: 'hi' }])
    expect(lastCall(mock).url).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('openai: custom endpoint with trailing slash is stripped, not doubled', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('openai', { endpoint: 'https://proxy.example.com/v1/' }), [
      { role: 'user', text: 'hi' },
    ])
    expect(lastCall(mock).url).toBe('https://proxy.example.com/v1/chat/completions')
  })

  it('anthropic: empty endpoint falls back to the public default', async () => {
    const mock = stubJson({ content: [{ type: 'text', text: 'ok' }] })
    await chat(providerConfig('anthropic', { endpoint: '' }), [{ role: 'user', text: 'hi' }])
    expect(lastCall(mock).url).toBe('https://api.anthropic.com/v1/messages')
  })

  it('anthropic: bare custom endpoint gains /v1/messages', async () => {
    const mock = stubJson({ content: [{ type: 'text', text: 'ok' }] })
    await chat(providerConfig('anthropic', { endpoint: 'https://proxy.example.com' }), [
      { role: 'user', text: 'hi' },
    ])
    expect(lastCall(mock).url).toBe('https://proxy.example.com/v1/messages')
  })

  it('anthropic: endpoint already ending in /v1 gets only /messages (no double /v1)', async () => {
    const mock = stubJson({ content: [{ type: 'text', text: 'ok' }] })
    await chat(providerConfig('anthropic', { endpoint: 'https://proxy.example.com/v1' }), [
      { role: 'user', text: 'hi' },
    ])
    expect(lastCall(mock).url).toBe('https://proxy.example.com/v1/messages')
  })

  it('gemini: empty endpoint falls back to the public default', async () => {
    const mock = stubJson({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    await chat(providerConfig('gemini', { endpoint: '' }), [{ role: 'user', text: 'hi' }])
    expect(lastCall(mock).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent?key=sk-test-secret',
    )
  })

  it('gemini: endpoint already ending in /v1beta is not double-appended', async () => {
    const mock = stubJson({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    await chat(providerConfig('gemini', { endpoint: 'https://proxy.example.com/v1beta/' }), [
      { role: 'user', text: 'hi' },
    ])
    expect(lastCall(mock).url).toBe(
      'https://proxy.example.com/v1beta/models/test-model:generateContent?key=sk-test-secret',
    )
  })
})

// ---------------------------------------------------------------------------
// OpenAI adapter
// ---------------------------------------------------------------------------

describe('openai adapter', () => {
  it('posts to {base}/chat/completions with a Bearer token', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'hello' } }] })
    const result = await chat(providerConfig('openai', { endpoint: 'https://api.example.com/v1' }), [
      { role: 'system', text: 'be brief' },
      { role: 'user', text: 'hi' },
    ])
    const { url, init } = lastCall(mock)
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test-secret')
    expect(headers['Content-Type']).toBe('application/json')
    expect(result).toBe('hello')
  })

  it('maps messages verbatim (roles and plain text content) into the body', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('openai'), [
      { role: 'system', text: 'sys' },
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ])
    expect(sentBody(mock)).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    })
  })

  it('maps attached images to image_url parts after the text part', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    const messages: LlmMessage[] = [
      { role: 'user', text: 'look', images: [PNG_DATA_URL, 'https://example.com/cat.png'] },
    ]
    await chat(providerConfig('openai'), messages)
    expect(sentBody(mock)).toEqual({
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: PNG_DATA_URL } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ],
    })
  })

  it('joins an array-valued content response back into one string', async () => {
    stubJson({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
        },
      ],
    })
    await expect(chat(providerConfig('openai'), [{ role: 'user', text: 'hi' }])).resolves.toBe('ab')
  })

  it('throws LlmError when the response has no content', async () => {
    stubJson({ choices: [{ message: {} }] })
    await expect(chat(providerConfig('openai'), [{ role: 'user', text: 'hi' }])).rejects.toThrow(
      'LLM returned no message content',
    )
  })
})

// ---------------------------------------------------------------------------
// GitHub Models adapter (OpenAI dialect over models.github.ai, PAT as Bearer)
// ---------------------------------------------------------------------------

describe('github adapter', () => {
  it('empty endpoint falls back to the GitHub Models default with the /inference path', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('github', { endpoint: '' }), [{ role: 'user', text: 'hi' }])
    expect(lastCall(mock).url).toBe('https://models.github.ai/inference/chat/completions')
  })

  it('posts to {base}/inference/chat/completions with the PAT as a Bearer token', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'hello' } }] })
    const result = await chat(
      providerConfig('github', { endpoint: 'https://models.github.ai', apiKey: 'ghp_pat-secret' }),
      [{ role: 'user', text: 'hi' }],
    )
    const { url, init } = lastCall(mock)
    expect(url).toBe('https://models.github.ai/inference/chat/completions')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ghp_pat-secret')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['x-api-key']).toBeUndefined()
    expect(result).toBe('hello')
  })

  it('endpoint already ending in /inference gets only /chat/completions (no double /inference)', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('github', { endpoint: 'https://models.github.ai/inference' }), [
      { role: 'user', text: 'hi' },
    ])
    expect(lastCall(mock).url).toBe('https://models.github.ai/inference/chat/completions')
  })

  it('endpoint with trailing slash (bare or /inference) still yields one /inference/chat/completions', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('github', { endpoint: 'https://models.github.ai/' }), [
      { role: 'user', text: 'hi' },
    ])
    expect(lastCall(mock).url).toBe('https://models.github.ai/inference/chat/completions')

    await chat(providerConfig('github', { endpoint: 'https://models.github.ai/inference/' }), [
      { role: 'user', text: 'hi' },
    ])
    expect(lastCall(mock).url).toBe('https://models.github.ai/inference/chat/completions')
  })

  it('sends the OpenAI body shape: namespaced model id verbatim, image_url parts after the text part', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    const messages: LlmMessage[] = [
      { role: 'user', text: 'look', images: [PNG_DATA_URL, 'https://example.com/cat.png'] },
    ]
    await chat(providerConfig('github', { model: 'openai/gpt-4o' }), messages)
    expect(sentBody(mock)).toEqual({
      model: 'openai/gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: PNG_DATA_URL } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ],
    })
  })

  it('image-bearing call uses visionModel; text-only call keeps the primary model', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('github', { model: 'openai/gpt-4o', visionModel: 'openai/gpt-4o-mini' }), [
      { role: 'user', text: 'look', images: [PNG_DATA_URL] },
    ])
    expect(sentBody(mock).model).toBe('openai/gpt-4o-mini')

    await chat(providerConfig('github', { model: 'openai/gpt-4o', visionModel: 'openai/gpt-4o-mini' }), [
      { role: 'user', text: 'hi' },
    ])
    expect(sentBody(mock).model).toBe('openai/gpt-4o')
  })

  it('redacts the PAT from an error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('bad token ghp_pat-secret rejected', { status: 401 }))),
    )
    const err = await chat(
      providerConfig('github', { endpoint: 'https://models.github.ai', apiKey: 'ghp_pat-secret' }),
      [{ role: 'user', text: 'hi' }],
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    const llmErr = err as LlmError
    expect(llmErr.status).toBe(401)
    expect(llmErr.body).toBe('bad token [redacted] rejected')
    expect(llmErr.message).not.toContain('ghp_pat-secret')
  })
})

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

describe('anthropic adapter', () => {
  it('posts to {base}/v1/messages with x-api-key and anthropic-version headers', async () => {
    const mock = stubJson({ content: [{ type: 'text', text: 'hello' }] })
    const result = await chat(providerConfig('anthropic', { endpoint: 'https://api.example.com' }), [
      { role: 'user', text: 'hi' },
    ])
    const { init } = lastCall(mock)
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test-secret')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers.Authorization).toBeUndefined()
    expect(result).toBe('hello')
  })

  it('hoists system messages to a top-level system string, keeping only user/assistant in messages', async () => {
    const mock = stubJson({ content: [{ type: 'text', text: 'ok' }] })
    await chat(providerConfig('anthropic'), [
      { role: 'system', text: 'first rule' },
      { role: 'user', text: 'hello' },
      { role: 'system', text: 'second rule' },
      { role: 'assistant', text: 'hi' },
    ])
    const body = sentBody(mock)
    expect(body.system).toBe('first rule\n\nsecond rule')
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ])
    expect(body.model).toBe('test-model')
  })

  it('omits the system field entirely when there are no system messages', async () => {
    const mock = stubJson({ content: [{ type: 'text', text: 'ok' }] })
    await chat(providerConfig('anthropic'), [{ role: 'user', text: 'hello' }])
    expect(sentBody(mock).system).toBeUndefined()
  })

  it('maps data-URL images to base64 image sources with media_type and data', async () => {
    const mock = stubJson({ content: [{ type: 'text', text: 'ok' }] })
    await chat(providerConfig('anthropic'), [
      { role: 'user', text: 'look', images: [PNG_DATA_URL] },
    ])
    expect(sentBody(mock).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
          },
        ],
      },
    ])
  })

  it('joins multiple text blocks from the response content array', async () => {
    stubJson({
      content: [
        { type: 'text', text: 'part one. ' },
        { type: 'image', source: {} },
        { type: 'text', text: 'part two.' },
      ],
    })
    await expect(chat(providerConfig('anthropic'), [{ role: 'user', text: 'hi' }])).resolves.toBe(
      'part one. part two.',
    )
  })
})

// ---------------------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------------------

describe('gemini adapter', () => {
  it('posts to models/{model}:generateContent with the key as a query param, not a header', async () => {
    const mock = stubJson({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] })
    const result = await chat(providerConfig('gemini', { endpoint: 'https://api.example.com' }), [
      { role: 'user', text: 'hi' },
    ])
    const { url, init } = lastCall(mock)
    expect(url).toBe(
      'https://api.example.com/v1beta/models/test-model:generateContent?key=sk-test-secret',
    )
    const headers = init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
    expect(result).toBe('hello')
  })

  it('moves the system message to systemInstruction.parts and maps roles to user/model', async () => {
    const mock = stubJson({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    await chat(providerConfig('gemini'), [
      { role: 'system', text: 'be brief' },
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ])
    expect(sentBody(mock)).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
      ],
      systemInstruction: { parts: [{ text: 'be brief' }] },
    })
  })

  it('omits systemInstruction when there is no system message', async () => {
    const mock = stubJson({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    await chat(providerConfig('gemini'), [{ role: 'user', text: 'hello' }])
    expect(sentBody(mock).systemInstruction).toBeUndefined()
  })

  it('maps data-URL images to inline_data parts with mime_type and data', async () => {
    const mock = stubJson({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    await chat(providerConfig('gemini'), [{ role: 'user', text: 'look', images: [PNG_DATA_URL] }])
    expect(sentBody(mock).contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'look' },
          { inline_data: { mime_type: 'image/png', data: 'QUJD' } },
        ],
      },
    ])
  })

  it('joins all text parts from candidates[0].content.parts', async () => {
    stubJson({
      candidates: [{ content: { parts: [{ text: 'a' }, { inline_data: {} }, { text: 'b' }] } }],
    })
    await expect(chat(providerConfig('gemini'), [{ role: 'user', text: 'hi' }])).resolves.toBe('ab')
  })
})

// ---------------------------------------------------------------------------
// Vision model routing
// ---------------------------------------------------------------------------

describe('visionModel routing', () => {
  const vision = { visionModel: 'vision-model' }

  it('openai: image-bearing call uses visionModel', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('openai', vision), [
      { role: 'user', text: 'look', images: [PNG_DATA_URL] },
    ])
    expect(sentBody(mock).model).toBe('vision-model')
  })

  it('anthropic: image-bearing call uses visionModel', async () => {
    const mock = stubJson({ content: [{ type: 'text', text: 'ok' }] })
    await chat(providerConfig('anthropic', vision), [
      { role: 'user', text: 'look', images: [PNG_DATA_URL] },
    ])
    expect(sentBody(mock).model).toBe('vision-model')
  })

  it('gemini: image-bearing call uses visionModel (in the URL path)', async () => {
    const mock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
          status: 200,
        }),
      ),
    )
    vi.stubGlobal('fetch', mock)
    await chat(providerConfig('gemini', vision), [
      { role: 'user', text: 'look', images: [PNG_DATA_URL] },
    ])
    expect(lastCall(mock).url).toContain('/models/vision-model:generateContent')
  })

  it('text-only call keeps using the primary model even when visionModel is set', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('openai', vision), [{ role: 'user', text: 'hi' }])
    expect(sentBody(mock).model).toBe('test-model')
  })

  it('image call without a configured visionModel falls back to the primary model', async () => {
    const mock = stubJson({ choices: [{ message: { content: 'ok' } }] })
    await chat(providerConfig('openai'), [{ role: 'user', text: 'look', images: [PNG_DATA_URL] }])
    expect(sentBody(mock).model).toBe('test-model')
  })
})

// ---------------------------------------------------------------------------
// Errors and redaction
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('redacts the API key from an error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('bad key sk-test-secret rejected', { status: 401 }))),
    )
    const err = await chat(providerConfig('openai'), [{ role: 'user', text: 'hi' }]).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LlmError)
    const llmErr = err as LlmError
    expect(llmErr.status).toBe(401)
    expect(llmErr.body).toBe('bad key [redacted] rejected')
    expect(llmErr.body).not.toContain('sk-test-secret')
    expect(llmErr.message).not.toContain('sk-test-secret')
  })

  it('redacts the API key from a gemini URL leaked in a transport error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED https://x?key=sk-test-secret'))),
    )
    const err = await chat(providerConfig('gemini'), [{ role: 'user', text: 'hi' }]).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LlmError)
    expect((err as Error).message).not.toContain('sk-test-secret')
    expect((err as Error).message).toContain('[redacted]')
  })

  it('throws LlmError on non-JSON success responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>oops</html>', { status: 200 }))),
    )
    await expect(chat(providerConfig('anthropic'), [{ role: 'user', text: 'hi' }])).rejects.toThrow(
      'LLM response was not valid JSON',
    )
  })
})
