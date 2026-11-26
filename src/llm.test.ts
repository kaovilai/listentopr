import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, LlmError } from './llm'
import type { LlmConfig } from './types'

const config: LlmConfig = {
  endpoint: 'https://api.example.com/v1',
  apiKey: 'sk-test-secret',
  model: 'test-model',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
          }),
        ),
      ),
    )
    await expect(
      chat(config, [{ role: 'user', text: 'hi' }], { timeoutMs: 5_000 }),
    ).resolves.toBe('ok')
  })
})
