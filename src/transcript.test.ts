import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, LlmError } from './llm'
import { buildTranscript, sanitizeLine, splitSentences } from './transcript'
import type { LlmConfig, PullRequestData } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

const config: LlmConfig = {
  endpoint: 'https://api.example.com/v1',
  apiKey: 'sk-test-secret',
  model: 'test-model',
}

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(handler)
  vi.stubGlobal('fetch', fn)
  return fn
}

function makePr(overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    ref: { owner: 'acme', repo: 'widget', number: 7 },
    title: 'Add caching layer',
    body: 'Adds a cache. See https://example.com/docs.',
    author: 'tigger',
    additions: 120,
    deletions: 30,
    changedFiles: 2,
    files: [
      {
        filename: 'src/cache.ts',
        status: 'modified',
        additions: 100,
        deletions: 10,
        patch: '@@ -12,4 +12,9 @@\n+export const cache = new Map()',
      },
      { filename: 'README.md', status: 'modified', additions: 20, deletions: 20 },
    ],
    comments: [{ author: 'reviewer1', body: 'Please add tests for eviction.' }],
    reviews: [{ author: 'reviewer2', state: 'CHANGES_REQUESTED', body: 'Race condition in get().' }],
    imageUrls: [],
    mermaidBlocks: ['graph TD\nA-->B\nB-->C'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

describe('chat', () => {
  it('posts to {endpoint}/chat/completions with bearer auth and parses content', async () => {
    const fetchMock = stubFetch(() => okResponse('hello there'))
    const result = await chat(config, [{ role: 'user', text: 'hi' }])
    expect(result).toBe('hello there')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-test-secret')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('test-model')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('joins endpoints without double slashes when the base ends with a slash', async () => {
    const fetchMock = stubFetch(() => okResponse('ok'))
    await chat(
      { ...config, endpoint: 'https://api.example.com/v1/' },
      [{ role: 'user', text: 'hi' }],
    )
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(url).not.toContain('//v1/')
  })

  it('sends vision content parts when images are present', async () => {
    const fetchMock = stubFetch(() => okResponse('ok'))
    await chat(config, [
      {
        role: 'user',
        text: 'look at this',
        images: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
      },
    ])
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
    ])
  })

  it('throws a typed error with status and sanitized body on HTTP failure', async () => {
    stubFetch(
      () =>
        new Response('{"error":"invalid key sk-test-secret provided"}', {
          status: 401,
        }),
    )
    let err: unknown
    try {
      await chat(config, [{ role: 'user', text: 'hi' }])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LlmError)
    const e = err as LlmError
    expect(e.status).toBe(401)
    expect(e.body).not.toContain('sk-test-secret')
    expect(e.body).toContain('[redacted]')
    expect(e.message).toBe('LLM request failed with status 401')
  })

  it('aborts the request after the timeout', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    await expect(
      chat(config, [{ role: 'user', text: 'hi' }], { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(LlmError)
  })

  it('throws when the response has no message content', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
    )
    await expect(chat(config, [{ role: 'user', text: 'hi' }])).rejects.toThrow(
      /no message content/,
    )
  })
})

// ---------------------------------------------------------------------------
// sanitizeLine (pure)
// ---------------------------------------------------------------------------

describe('sanitizeLine', () => {
  it('replaces raw https URLs with the domain', () => {
    expect(sanitizeLine('See https://example.com/a/b?x=1 for more.')).toBe(
      'See example.com for more.',
    )
  })

  it('replaces www URLs with the domain', () => {
    expect(sanitizeLine('Go to www.example.org now.')).toBe('Go to example.org now.')
  })

  it('keeps sentence punctuation after a URL', () => {
    expect(sanitizeLine('Docs at https://example.com. Read them.')).toBe(
      'Docs at example.com. Read them.',
    )
  })

  it('unwraps markdown links to their visible text', () => {
    expect(sanitizeLine('See [the docs](https://example.com) here.')).toBe(
      'See the docs here.',
    )
  })

  it('replaces commit SHAs', () => {
    expect(sanitizeLine('Fixed in abcdef1234567 yesterday.')).toBe(
      'Fixed in commit yesterday.',
    )
    expect(sanitizeLine('Merge 0f1e2d3 before release.')).toBe('Merge commit before release.')
    expect(sanitizeLine('Long sha abcdefabcdefabcdef is gone.')).toBe(
      'Long sha commit is gone.',
    )
  })

  it('keeps ordinary hex-letter words intact', () => {
    expect(sanitizeLine('The feedback was defaced.')).toBe('The feedback was defaced.')
    expect(sanitizeLine('Version 3.5 and 2.7 shipped.')).toBe('Version 3.5 and 2.7 shipped.')
  })

  it('strips diff hunk markers and +/- line prefixes', () => {
    expect(sanitizeLine('@@ -12,4 +12,9 @@ export function foo()')).toBe(
      'export function foo()',
    )
    expect(sanitizeLine('+added line')).toBe('added line')
    expect(sanitizeLine('-removed line')).toBe('removed line')
    expect(sanitizeLine('+++ b/src/cache.ts')).toBe('b/src/cache.ts')
  })

  it('collapses unpronounceable symbol chains but keeps short operators', () => {
    expect(sanitizeLine('if (a === b) { x &&& y }')).toBe('if (a b) { x y }')
    expect(sanitizeLine('a && b')).toBe('a && b')
  })

  it('strips markdown emphasis, backticks, and headers', () => {
    expect(sanitizeLine('## Section head')).toBe('Section head')
    expect(sanitizeLine('`code` and **bold** text')).toBe('code and bold text')
    expect(sanitizeLine('**Important**: see __notes__')).toBe('Important: see notes')
  })

  it('never returns an empty string', () => {
    expect(sanitizeLine('???')).toBe('[unpronounceable content]')
    expect(sanitizeLine('   ')).toBe('[unpronounceable content]')
    expect(sanitizeLine('`**`')).toBe('[unpronounceable content]')
  })
})

// ---------------------------------------------------------------------------
// splitSentences (pure)
// ---------------------------------------------------------------------------

describe('splitSentences', () => {
  it('splits on period, exclamation, and question boundaries', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?'])
  })

  it('keeps decimals intact', () => {
    expect(splitSentences('Pi is about 3.14 and e is 2.7.')).toEqual([
      'Pi is about 3.14 and e is 2.7.',
    ])
    expect(splitSentences('Costs rose 3.5 percent. Then fell.')).toEqual([
      'Costs rose 3.5 percent.',
      'Then fell.',
    ])
  })

  it('respects common abbreviations', () => {
    expect(splitSentences('Mr. Smith and Dr. Lee met. They left.')).toEqual([
      'Mr. Smith and Dr. Lee met.',
      'They left.',
    ])
    expect(splitSentences('E.g. this works.')).toEqual(['E.g. this works.'])
    expect(splitSentences('See fig. 3 for details. It helps.')).toEqual([
      'See fig. 3 for details.',
      'It helps.',
    ])
  })

  it('chunks sentences longer than 250 characters at comma or space boundaries', () => {
    const long = `Alpha beta gamma, ${'detail '.repeat(60)}and the final clause.`
    expect(long.length).toBeGreaterThan(250)
    const parts = splitSentences(long)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(250)
      expect(p.length).toBeGreaterThan(0)
    }
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '))
  })

  it('hard-splits unbroken runs longer than 250 characters without losing text', () => {
    const parts = splitSentences(`${'a'.repeat(600)}.`)
    expect(parts.every((p) => p.length <= 250)).toBe(true)
    expect(parts.join('')).toBe(`${'a'.repeat(600)}.`)
  })

  it('returns empty for empty or whitespace input', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildTranscript
// ---------------------------------------------------------------------------

describe('buildTranscript', () => {
  it('parses a strict JSON reply into sanitized sections in canonical order', async () => {
    const reply = JSON.stringify({
      title: 'Caching layer for widget',
      sections: [
        {
          id: 'changes',
          title: 'Key Changes',
          sentences: [
            'The cache module gained a Map.',
            'See https://example.com/patch for the diff.',
            'Fixed via abcdef1234567.',
          ],
        },
        { id: 'overview', title: 'Overview', sentences: ['This PR adds caching.'] },
      ],
    })
    stubFetch(() => okResponse(reply))
    const transcript = await buildTranscript(config, makePr())
    expect(transcript.title).toBe('Caching layer for widget')
    expect(transcript.sections.map((s) => s.id)).toEqual(['overview', 'changes'])
    const changes = transcript.sections[1]!
    expect(changes.sentences).toEqual([
      'The cache module gained a Map.',
      'See example.com for the diff.',
      'Fixed via commit.',
    ])
  })

  it('tolerates markdown-fenced JSON', async () => {
    const reply =
      '```json\n' +
      JSON.stringify({
        title: 'T',
        sections: [{ id: 'overview', title: 'Overview', sentences: ['One sentence.'] }],
      }) +
      '\n```'
    stubFetch(() => okResponse(reply))
    const transcript = await buildTranscript(config, makePr())
    expect(transcript.title).toBe('T')
    expect(transcript.sections[0]!.sentences).toEqual(['One sentence.'])
  })

  it('falls back to raw text split into sentences when the reply is not JSON', async () => {
    stubFetch(() => okResponse('This is not JSON at all. It still explains the PR.'))
    const transcript = await buildTranscript(config, makePr())
    expect(transcript.title).toBe('Add caching layer')
    expect(transcript.sections).toHaveLength(1)
    const section = transcript.sections[0]!
    expect(section.id).toBe('overview')
    expect(section.sentences).toEqual(['This is not JSON at all.', 'It still explains the PR.'])
  })

  it('attaches resolved image data URLs index-wise to the user message', async () => {
    const fetchMock = stubFetch(() => okResponse('no json'))
    const pr = makePr({ imageUrls: ['https://img.example/1.png', 'https://img.example/2.png'] })
    await buildTranscript(config, pr, { imageDataUrls: ['data:image/png;base64,ONE'] })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    const user = body.messages[1]
    expect(user.role).toBe('user')
    expect(user.content).toEqual([
      { type: 'text', text: expect.stringContaining('acme/widget#7') },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,ONE' } },
    ])
  })

  it('sends plain string user content when there are no images', async () => {
    const fetchMock = stubFetch(() => okResponse('no json'))
    await buildTranscript(config, makePr())
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(typeof body.messages[1].content).toBe('string')
  })

  it('includes mermaid source, review feedback, and a strict-JSON system prompt', async () => {
    const fetchMock = stubFetch(() => okResponse('no json'))
    await buildTranscript(config, makePr())
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain('STRICT JSON')
    const user = body.messages[1].content
    expect(user).toContain('graph TD')
    expect(user).toContain('reviewer1')
    expect(user).toContain('Race condition in get().')
    expect(user).toContain('src/cache.ts')
  })

  it('omits nothing from the request when reviews and comments are absent', async () => {
    const fetchMock = stubFetch(() => okResponse('no json'))
    const pr = makePr({ comments: [], reviews: [], mermaidBlocks: [] })
    await buildTranscript(config, pr)
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.messages[1].content).not.toContain('reviewer1')
    expect(body.messages[1].content).not.toContain('graph TD')
  })
})
