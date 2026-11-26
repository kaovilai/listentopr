import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, LlmError } from './llm'
import type { ChatOptions } from './llm'
import type { PrCommit } from './github'
import { buildDeltaSection, buildTranscript, createTranscriptStream, estimateTokens, IMAGE_TOKEN_ESTIMATE, resolveBudget, sanitizeLine, splitSentences } from './transcript'
import type {
  LlmConfig,
  LlmMessage,
  PrFile,
  PullRequestData,
  TranscriptBudget,
  TranscriptSection,
} from './types'

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

// ---------------------------------------------------------------------------
// createTranscriptStream
// ---------------------------------------------------------------------------

function makeStreamPr(overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    ref: { owner: 'acme', repo: 'widget', number: 9 },
    title: 'Stream PR',
    body: 'Stream body.',
    author: 'tigger',
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    files: [
      {
        filename: 'src/a.ts',
        status: 'modified',
        additions: 5,
        deletions: 1,
        patch: '@@ -1 +1 @@\n+ALPHA-HUNK',
      },
      {
        filename: 'src/b.ts',
        status: 'modified',
        additions: 5,
        deletions: 1,
        patch: '@@ -1 +1 @@\n+BETA-HUNK',
      },
    ],
    comments: [],
    reviews: [],
    imageUrls: [],
    mermaidBlocks: [],
    ...overrides,
  }
}

function makeFiles(count: number, patch = 'small hunk', prefix = 'f'): PrFile[] {
  return Array.from({ length: count }, (_, i) => ({
    filename: `src/${prefix}${i}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch,
  }))
}

function sectionJson(i: number): string {
  return JSON.stringify({
    title: `Sec ${i}`,
    sentences: [`Look at https://example.com/${i} now.`],
    summary: `sum-${i}`,
  })
}

interface RecordedCall {
  messages: LlmMessage[]
  opts?: ChatOptions
}

function recordChat(
  responder: (call: RecordedCall, index: number) => string | Promise<string>,
) {
  const calls: RecordedCall[] = []
  const fn: typeof chat = (_config, messages, opts) => {
    calls.push({ messages, opts })
    return Promise.resolve(responder({ messages, opts }, calls.length - 1))
  }
  return { calls, chat: fn }
}

const defaultResponder = (_call: RecordedCall, i: number): string => sectionJson(i)

// ---------------------------------------------------------------------------
// buildDeltaSection
// ---------------------------------------------------------------------------

const DELTA_COMMITS: PrCommit[] = [
  { sha: 'new0001', message: 'fix: handle empty input', date: '2026-11-20T10:00:00Z' },
  { sha: 'new0002', message: 'feat: add delta listening', date: '2026-11-21T10:00:00Z' },
]

describe('buildDeltaSection', () => {
  it('makes one call whose prompt carries the previous summary and commit messages, not the full diff', async () => {
    const { calls, chat: fake } = recordChat(() =>
      JSON.stringify({ title: 'ignored title', sentences: ['Fresh work landed.'] }),
    )
    const pr = makePr()
    await buildDeltaSection(config, pr, DELTA_COMMITS, 'The listener already heard about the caching layer.', {
      chat: fake,
    })

    expect(calls).toHaveLength(1)
    const [system, user] = calls[0]!.messages
    expect(system!.role).toBe('system')
    expect(system!.text).toContain('already heard')
    expect(system!.text).toContain('STRICT JSON')
    expect(user!.role).toBe('user')
    // PR title + ref
    expect(user!.text).toContain('acme/widget#7')
    expect(user!.text).toContain('Add caching layer')
    // previous summary carried into the prompt
    expect(user!.text).toContain('The listener already heard about the caching layer.')
    // new commit messages carried into the prompt
    expect(user!.text).toContain('fix: handle empty input')
    expect(user!.text).toContain('feat: add delta listening')
    // no stale full diff: patches, PR body, review feedback all absent
    expect(user!.text).not.toContain('export const cache')
    expect(user!.text).not.toContain('Adds a cache')
    expect(user!.text).not.toContain('Please add tests for eviction')
    expect(user!.text).not.toContain('Race condition')
    // no images attached to a delta call
    expect(user!.images).toBeUndefined()
  })

  it('returns a whats-new section with sanitized, split sentences from a JSON reply', async () => {
    const { chat: fake } = recordChat(() =>
      JSON.stringify({
        title: 'Ignored heading',
        sentences: ['The empty input crash is fixed.', 'See https://example.com/fix for details.'],
      }),
    )
    const section = await buildDeltaSection(config, makePr(), DELTA_COMMITS, 'previous summary', {
      chat: fake,
    })
    expect(section.id).toBe('whats-new')
    expect(section.title).toBe("What's New")
    expect(section.sentences).toEqual([
      'The empty input crash is fixed.',
      'See example.com for details.',
    ])
  })

  it('narrates a non-JSON reply through the sanitize/split path', async () => {
    const { chat: fake } = recordChat(() => 'Not JSON at all. It still describes the new commits.')
    const section = await buildDeltaSection(config, makePr(), DELTA_COMMITS, 'previous summary', {
      chat: fake,
    })
    expect(section.id).toBe('whats-new')
    expect(section.title).toBe("What's New")
    expect(section.sentences).toEqual([
      'Not JSON at all.',
      'It still describes the new commits.',
    ])
  })

  it('falls back to a placeholder when the reply has no speakable content', async () => {
    const { chat: fake } = recordChat(() => '```\n!!!\n```')
    const section = await buildDeltaSection(config, makePr(), DELTA_COMMITS, 'previous summary', {
      chat: fake,
    })
    expect(section.id).toBe('whats-new')
    expect(section.sentences).toEqual(['[unpronounceable content]'])
  })
})

async function drain(stream: {
  next(): Promise<TranscriptSection | null>
}): Promise<TranscriptSection[]> {
  const sections: TranscriptSection[] = []
  for (;;) {
    const section = await stream.next()
    if (section === null) return sections
    sections.push(section)
  }
}

describe('createTranscriptStream', () => {
  it('emits sections in order with canonical ids, skipping absent ones', async () => {
    const pr = makeStreamPr({
      imageUrls: ['https://img.example/1.png', 'https://img.example/2.png'],
      mermaidBlocks: ['graph TD\nA-->B'],
      files: makeFiles(12),
      comments: [{ author: 'r1', body: 'comment body' }],
      reviews: [{ author: 'r2', state: 'APPROVED', body: 'review body' }],
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, {
      chat: fake,
      imageDataUrls: ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
    })
    expect(stream.done()).toBe(false)
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual([
      'overview',
      'architecture',
      'changes-1',
      'changes-2',
      'review-notes',
    ])
    // Reuses sanitizeLine/splitSentences: URL -> domain, title kept.
    expect(sections[0]!.title).toBe('Sec 0')
    expect(sections[0]!.sentences).toEqual(['Look at example.com now.'])
    expect(stream.done()).toBe(true)
    expect(calls).toHaveLength(5)
  })

  it('skips architecture without images/mermaid and review notes without feedback', async () => {
    const pr = makeStreamPr({ files: makeFiles(2) })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual(['overview', 'changes-1'])
    expect(calls).toHaveLength(2)
  })

  it('includes review notes but not architecture when only feedback exists', async () => {
    const pr = makeStreamPr({
      files: makeFiles(2),
      comments: [{ author: 'r1', body: 'nice work' }],
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual(['overview', 'changes-1', 'review-notes'])
    const reviewPrompt = calls[2]!.messages[1]!.text
    expect(reviewPrompt).toContain('r1')
    expect(reviewPrompt).toContain('nice work')
  })

  it('attaches images only to the architecture call', async () => {
    const pr = makeStreamPr({
      imageUrls: ['https://img.example/1.png', 'https://img.example/2.png'],
      mermaidBlocks: ['graph TD\nA-->B'],
      files: makeFiles(2),
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, {
      chat: fake,
      imageDataUrls: ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
    })
    await drain(stream)
    expect(calls[0]!.messages[1]!.images).toBeUndefined()
    expect(calls[1]!.messages[1]!.images).toEqual([
      'data:image/png;base64,ONE',
      'data:image/png;base64,TWO',
    ])
    expect(calls[2]!.messages[1]!.images).toBeUndefined()
    const archPrompt = calls[1]!.messages[1]!.text
    expect(archPrompt).toContain('graph TD')
    expect(archPrompt).toContain('image(s) from the pull request are attached')
  })

  it('batches small files up to 10 and coalesces the tiny remainder', async () => {
    const pr = makeStreamPr({ files: makeFiles(25) })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual([
      'overview',
      'changes-1',
      'changes-2',
      'changes-3',
    ])
    const batch1 = calls[1]!.messages[1]!.text
    const batch2 = calls[2]!.messages[1]!.text
    const batch3 = calls[3]!.messages[1]!.text
    expect(batch1).toContain('src/f0.ts')
    expect(batch1).toContain('src/f9.ts')
    expect(batch1).not.toContain('src/f10.ts')
    expect(batch2).toContain('src/f10.ts')
    expect(batch2).toContain('src/f19.ts')
    expect(batch2).not.toContain('src/f20.ts')
    expect(batch3).toContain('src/f20.ts')
    expect(batch3).toContain('src/f24.ts')
    expect(batch3).toContain('batch 3 of 3')
  })

  it('gives a file with an oversized patch its own batch', async () => {
    const bigPatch = `BIGHUNK ${'x'.repeat(4001)}`
    const pr = makeStreamPr({
      files: [
        ...makeFiles(3, 'alpha hunk', 'a'),
        { filename: 'src/big.ts', status: 'modified', additions: 900, deletions: 900, patch: bigPatch },
        ...makeFiles(2, 'beta hunk', 'b'),
      ],
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual([
      'overview',
      'changes-1',
      'changes-2',
      'changes-3',
    ])
    const batch1 = calls[1]!.messages[1]!.text
    const batch2 = calls[2]!.messages[1]!.text
    const batch3 = calls[3]!.messages[1]!.text
    expect(batch1).toContain('src/a0.ts')
    expect(batch1).not.toContain('BIGHUNK')
    expect(batch2).toContain('src/big.ts')
    expect(batch2).toContain('BIGHUNK')
    expect(batch2).not.toContain('src/a0.ts')
    expect(batch2).not.toContain('src/b0.ts')
    expect(batch3).toContain('src/b0.ts')
    expect(batch3).not.toContain('BIGHUNK')
  })

  it('later prompts carry rolling summaries, not full sections or repeated diffs', async () => {
    const pr = makeStreamPr({
      files: [...makeFiles(10, 'ALPHA-HUNK', 'a'), ...makeFiles(12, 'BETA-HUNK', 'b')],
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake })
    await drain(stream)
    // batches: a0-a9, b0-b9, b10-b11 -> calls: overview, changes-1..3
    const overviewPrompt = calls[0]!.messages[1]!.text
    expect(overviewPrompt).not.toContain('Context so far')
    expect(overviewPrompt).not.toContain('ALPHA-HUNK')
    expect(overviewPrompt).not.toContain('BETA-HUNK')
    const changes2Prompt = calls[2]!.messages[1]!.text
    expect(changes2Prompt).toContain('sum-0')
    expect(changes2Prompt).toContain('sum-1')
    // Not the full earlier sections...
    expect(changes2Prompt).not.toContain('Look at example.com now.')
    expect(changes2Prompt).not.toContain('https://example.com/')
    // ...and not the earlier batch's diff text.
    expect(changes2Prompt).toContain('BETA-HUNK')
    expect(changes2Prompt).toContain('src/b0.ts')
    expect(changes2Prompt).not.toContain('ALPHA-HUNK')
    expect(changes2Prompt).not.toContain('src/a0.ts')
  })

  it('derives a rolling summary when the reply omits the summary field', async () => {
    const pr = makeStreamPr({ files: makeFiles(2) })
    const { calls, chat: fake } = recordChat((_call, i) =>
      JSON.stringify({
        title: `T${i}`,
        sentences: [`Plain sentence ${i} one.`, `Plain sentence ${i} two.`],
      }),
    )
    const stream = createTranscriptStream(config, pr, { chat: fake })
    await drain(stream)
    const changesPrompt = calls[1]!.messages[1]!.text
    expect(changesPrompt).toContain('Plain sentence 0 one.')
    expect(changesPrompt).toContain('Plain sentence 0 two.')
  })

  it('prefetch is memoized and next() resolves from the memoized call', async () => {
    const pr = makeStreamPr({ files: makeFiles(2) })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake })
    expect(stream.done()).toBe(false)
    stream.prefetch()
    stream.prefetch()
    expect(calls).toHaveLength(1)
    const first = await stream.next()
    expect(first?.id).toBe('overview')
    expect(calls).toHaveLength(1) // served from the memoized promise
    stream.prefetch()
    expect(calls).toHaveLength(2)
    const second = await stream.next()
    expect(second?.id).toBe('changes-1')
    expect(calls).toHaveLength(2)
    expect(await stream.next()).toBeNull()
    expect(stream.done()).toBe(true)
  })

  it('abort cancels the in-flight call and settles a pending next() as null', async () => {
    const pr = makeStreamPr({ files: makeFiles(2) })
    const { calls, chat: fake } = recordChat(() => new Promise<string>(() => {}))
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const pending = stream.next()
    expect(calls).toHaveLength(1)
    stream.abort()
    expect(stream.done()).toBe(true)
    expect(calls[0]!.opts?.signal?.aborted).toBe(true)
    await expect(pending).resolves.toBeNull()
    await expect(stream.next()).resolves.toBeNull()
  })

  it('abort before any generation marks the stream done with no calls', async () => {
    const pr = makeStreamPr({ files: makeFiles(2) })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake })
    stream.abort()
    expect(stream.done()).toBe(true)
    await expect(stream.next()).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('prefetch then abort with no consumer leaves no unhandled rejection', async () => {
    const pr = makeStreamPr({ files: makeFiles(2) })
    const { calls, chat: fake } = recordChat(() => new Promise<string>(() => {}))
    const stream = createTranscriptStream(config, pr, { chat: fake })
    stream.prefetch()
    expect(calls).toHaveLength(1)
    stream.abort()
    // Let the microtask/macrotask queues drain: if the aborted inFlight
    // promise rejects unhandled, Node/Vitest fails the run here.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(stream.done()).toBe(true)
    await expect(stream.next()).resolves.toBeNull()
  })

  it('a failed section emits a spoken fallback and the stream continues', async () => {
    const pr = makeStreamPr({
      files: makeFiles(2),
      comments: [{ author: 'r1', body: 'nice' }],
    })
    const { calls, chat: fake } = recordChat((_call, i) => {
      if (i === 1) throw new Error('boom')
      return sectionJson(i)
    })
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const first = await stream.next()
    expect(first?.id).toBe('overview')
    const second = await stream.next()
    expect(second).toMatchObject({
      id: 'changes-1',
      title: 'Key Changes (1)',
      sentences: ['Could not summarize this part.'],
    })
    const third = await stream.next()
    expect(third?.id).toBe('review-notes')
    expect(third?.sentences).toEqual(['Look at example.com now.'])
    expect(await stream.next()).toBeNull()
    expect(calls).toHaveLength(3)
    // The fallback's summary rolls into the next call's context.
    expect(calls[2]!.messages[1]!.text).toContain('could not be summarized')
  })

  it('narrates a non-JSON reply as a section instead of failing', async () => {
    const pr = makeStreamPr({ files: makeFiles(2) })
    const { chat: fake } = recordChat(() => 'Not JSON at all. Still useful.')
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const first = await stream.next()
    expect(first).toMatchObject({
      id: 'overview',
      title: 'Overview',
      sentences: ['Not JSON at all.', 'Still useful.'],
    })
  })

  it('supports for-await iteration ending after the last section', async () => {
    const pr = makeStreamPr({ files: makeFiles(2) })
    const { chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const ids: string[] = []
    for await (const section of stream) ids.push(section.id)
    expect(ids).toEqual(['overview', 'changes-1'])
    expect(stream.done()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Context-window budgeting
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('ceil-divides length by 4', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('resolveBudget', () => {
  it('defaults to 128000 window, per-call capped at the window, singleShot off', () => {
    expect(resolveBudget()).toEqual({
      contextTokens: 128000,
      maxContextPerCall: 128000,
      singleShot: false,
    })
  })

  it('passes through an explicit singleShot flag', () => {
    expect(resolveBudget({ singleShot: true }).singleShot).toBe(true)
  })

  it('clamps contextTokens into 8000..2000000', () => {
    expect(resolveBudget({ contextTokens: 100 }).contextTokens).toBe(8000)
    expect(resolveBudget({ contextTokens: 99999999 }).contextTokens).toBe(2000000)
  })

  it('clamps maxContextPerCall into 2000..2000000', () => {
    expect(resolveBudget({ contextTokens: 99999999, maxContextPerCall: 100 }).maxContextPerCall).toBe(2000)
    expect(resolveBudget({ contextTokens: 99999999, maxContextPerCall: 99999999 }).maxContextPerCall).toBe(2000000)
  })

  it('caps maxContextPerCall at contextTokens after clamping', () => {
    expect(resolveBudget({ contextTokens: 50000, maxContextPerCall: 60000 })).toEqual({
      contextTokens: 50000,
      maxContextPerCall: 50000,
      singleShot: false,
    })
    // default window also caps the 200000 per-call default
    expect(resolveBudget({}).maxContextPerCall).toBe(128000)
  })
})

describe('createTranscriptStream with budget', () => {
  it('a fat window coalesces 40 small files into one changes call', async () => {
    const pr = makeStreamPr({ files: makeFiles(40) })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, {
      chat: fake,
      budget: { contextTokens: 2000000, maxContextPerCall: 2000000 },
    })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual(['overview', 'changes-1'])
    expect(calls).toHaveLength(2)
    const changesPrompt = calls[1]!.messages[1]!.text
    expect(changesPrompt).toContain('src/f0.ts')
    expect(changesPrompt).toContain('src/f39.ts')
    expect(changesPrompt).toContain('batch 1 of 1')
  })

  it('a tiny window shrinks batches to one file each and keeps every prompt within budget', async () => {
    const pr = makeStreamPr({ files: makeFiles(5) })
    const budget: TranscriptBudget = { contextTokens: 128000, maxContextPerCall: 2000 }
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake, budget })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual([
      'overview',
      'changes-1',
      'changes-2',
      'changes-3',
      'changes-4',
      'changes-5',
    ])
    expect(calls).toHaveLength(6)
    const firstBatch = calls[1]!.messages[1]!.text
    expect(firstBatch).toContain('src/f0.ts')
    expect(firstBatch).not.toContain('src/f1.ts')
    for (const call of calls) {
      expect(estimateTokens(call.messages[1]!.text)).toBeLessThanOrEqual(2000)
    }
  })

  it('single-shot mode generates all sections in one call when the PR fits and is opted in', async () => {
    const pr = makeStreamPr({
      files: makeFiles(3),
      comments: [{ author: 'r1', body: 'please add tests' }],
      reviews: [{ author: 'r2', state: 'APPROVED', body: 'lgtm' }],
      mermaidBlocks: ['graph TD\nA-->B'],
    })
    const reply = JSON.stringify({
      title: 'All at once',
      sections: [
        { id: 'review-notes', title: 'Review Notes', sentences: ['Reviewers asked for tests.'] },
        { id: 'changes', title: 'Key Changes', sentences: ['Three files changed.'] },
        { id: 'architecture', title: 'Architecture', sentences: ['A flows to B.'] },
        {
          id: 'overview',
          title: 'Overview',
          sentences: ['The whole PR in one call. See https://example.com/x now.'],
        },
      ],
    })
    const { calls, chat: fake } = recordChat(() => reply)
    const stream = createTranscriptStream(config, pr, {
      chat: fake,
      budget: { singleShot: true },
    })
    stream.prefetch()
    expect(calls).toHaveLength(1)
    const sections = await drain(stream)
    // overview-first ordering preserved even though the reply listed it last
    expect(sections.map((s) => s.id)).toEqual([
      'overview',
      'architecture',
      'changes',
      'review-notes',
    ])
    expect(sections[0]!.sentences).toEqual([
      'The whole PR in one call.',
      'See example.com now.',
    ])
    expect(stream.done()).toBe(true)
    expect(calls).toHaveLength(1)
    const user = calls[0]!.messages[1]!.text
    expect(user).toContain('src/f0.ts')
    expect(user).toContain('src/f2.ts')
    expect(calls[0]!.messages[0]!.text).toContain('section ids')
  })

  it('single-shot is skipped when the PR does not fit the window, falling back to batches', async () => {
    const pr = makeStreamPr({ files: makeFiles(14, 'x'.repeat(2000)) })
    const budget: TranscriptBudget = { singleShot: true, contextTokens: 8000 }
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake, budget })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual(['overview', 'changes-1', 'changes-2'])
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(estimateTokens(call.messages[1]!.text)).toBeLessThanOrEqual(8000)
    }
    // batched prompts, not one whole-PR prompt
    expect(calls[1]!.messages[1]!.text).toContain('batch 1 of 2')
  })

  it('single-shot requires opt-in: a budget without the flag still sections the stream', async () => {
    const pr = makeStreamPr({
      files: makeFiles(3),
      comments: [{ author: 'r1', body: 'nice' }],
      mermaidBlocks: ['graph TD\nA-->B'],
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake, budget: {} })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual([
      'overview',
      'architecture',
      'changes-1',
      'review-notes',
    ])
    expect(calls).toHaveLength(4)
  })

  it('truncates an over-budget lone patch with a (truncated) marker and stays within budget', async () => {
    const bigPatch = 'y'.repeat(4500)
    const pr = makeStreamPr({ files: makeFiles(4, bigPatch) })
    const budget: TranscriptBudget = { contextTokens: 128000, maxContextPerCall: 2000 }
    const { calls, chat: fake } = recordChat((_call, i) =>
      JSON.stringify({
        title: `Sec ${i}`,
        sentences: [`Sentence ${i}.`],
        summary: 'sum '.repeat(100),
      }),
    )
    const stream = createTranscriptStream(config, pr, { chat: fake, budget })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual([
      'overview',
      'changes-1',
      'changes-2',
      'changes-3',
      'changes-4',
    ])
    const changesPrompts = calls.slice(1).map((c) => c.messages[1]!.text)
    expect(changesPrompts.some((p) => p.includes('(truncated)'))).toBe(true)
    expect(changesPrompts.some((p) => p.includes('fit the context window'))).toBe(true)
    for (const call of calls) {
      expect(estimateTokens(call.messages[1]!.text)).toBeLessThanOrEqual(2000)
    }
  })

  it('binary-splits an over-budget batch instead of sending one oversized call', async () => {
    const bigPatch = `BIGPATCH-${'b'.repeat(2000)}`
    const pr = makeStreamPr({
      files: [...makeFiles(7, bigPatch, 'big'), ...makeFiles(7, 'tiny hunk', 't')],
    })
    const budget: TranscriptBudget = { contextTokens: 128000, maxContextPerCall: 6000 }
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, { chat: fake, budget })
    const sections = await drain(stream)
    // plan-time sizing put 7 files per batch; the all-big-file batch overflows
    // the per-call budget and is binary-split, so changes arrive as 3 batches.
    expect(sections.map((s) => s.id)).toEqual([
      'overview',
      'changes-1',
      'changes-2',
      'changes-3',
    ])
    expect(calls).toHaveLength(4)
    const batch1 = calls[1]!.messages[1]!.text
    const batch2 = calls[2]!.messages[1]!.text
    const batch3 = calls[3]!.messages[1]!.text
    expect(batch1).toContain('src/big0.ts')
    expect(batch1).toContain('src/big2.ts')
    expect(batch1).not.toContain('src/big3.ts')
    expect(batch2).toContain('src/big3.ts')
    expect(batch2).toContain('src/big6.ts')
    expect(batch2).not.toContain('src/t0.ts')
    expect(batch3).toContain('src/t0.ts')
    expect(batch3).toContain('src/t6.ts')
    for (const call of calls) {
      expect(estimateTokens(call.messages[1]!.text)).toBeLessThanOrEqual(6000)
    }
  })

  it('single-shot falls back to sectioned mode when image cost blows the window', async () => {
    const pr = makeStreamPr({
      imageUrls: [
        'https://img.example/1.png',
        'https://img.example/2.png',
        'https://img.example/3.png',
      ],
      files: makeFiles(2),
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, {
      chat: fake,
      imageDataUrls: [
        'data:image/png;base64,ONE',
        'data:image/png;base64,TWO',
        'data:image/png;base64,THREE',
      ],
      // 3 images * 1600 tokens = 4800 on top of the prompt does not fit 8000
      budget: { singleShot: true, contextTokens: 8000 },
    })
    const sections = await drain(stream)
    expect(sections.map((s) => s.id)).toEqual(['overview', 'architecture', 'changes-1'])
    expect(calls).toHaveLength(3)
  })

  it('drops architecture images that do not fit the per-call budget and notes they could not be loaded', async () => {
    const pr = makeStreamPr({
      imageUrls: ['https://img.example/1.png', 'https://img.example/2.png'],
      mermaidBlocks: ['graph TD\nA-->B'],
      files: makeFiles(2),
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, {
      chat: fake,
      imageDataUrls: ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
      // tiny per-call budget: 2 images * 1600 tokens cannot fit
      budget: { contextTokens: 128000, maxContextPerCall: 2000 },
    })
    await drain(stream)
    const arch = calls[1]!.messages[1]!
    expect(arch.images).toBeUndefined()
    expect(arch.text).toContain('could not be loaded')
    expect(arch.text).not.toContain('are attached')
    expect(arch.text).toContain('graph TD')
  })

  it('keeps architecture images that fit and counts their cost against the text budget', async () => {
    const pr = makeStreamPr({
      imageUrls: ['https://img.example/1.png'],
      mermaidBlocks: Array.from({ length: 10 }, () => 'g'.repeat(2000)),
      files: makeFiles(2),
    })
    const { calls, chat: fake } = recordChat(defaultResponder)
    const stream = createTranscriptStream(config, pr, {
      chat: fake,
      imageDataUrls: ['data:image/png;base64,ONE'],
      budget: { contextTokens: 128000, maxContextPerCall: 8000 },
    })
    await drain(stream)
    const arch = calls[1]!.messages[1]!
    expect(arch.images).toEqual(['data:image/png;base64,ONE'])
    expect(arch.text).toContain('(truncated)')
    const sysTokens = estimateTokens(calls[1]!.messages[0]!.text)
    expect(estimateTokens(arch.text)).toBeLessThanOrEqual(
      8000 - sysTokens - 4096 - IMAGE_TOKEN_ESTIMATE,
    )
  })
})

describe('buildDeltaSection with budget', () => {
  it('clamps the delta prompt to the per-call budget with a (truncated) marker', async () => {
    const { calls, chat: fake } = recordChat(() =>
      JSON.stringify({ title: 't', sentences: ['New stuff landed.'] }),
    )
    await buildDeltaSection(config, makePr(), DELTA_COMMITS, 'previous '.repeat(3000), {
      chat: fake,
      budget: { contextTokens: 128000, maxContextPerCall: 2000 },
    })
    expect(calls).toHaveLength(1)
    const user = calls[0]!.messages[1]!.text
    expect(user).toContain('(truncated)')
    expect(estimateTokens(user)).toBeLessThanOrEqual(2000)
  })
})

describe('buildTranscript with budget', () => {
  it('clamps the user prompt to the per-call budget with a (truncated) marker', async () => {
    const fetchMock = stubFetch(() => okResponse('no json'))
    const pr = makePr({ body: 'B'.repeat(20000) })
    await buildTranscript(config, pr, {
      budget: { contextTokens: 128000, maxContextPerCall: 2000 },
    })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    const user = body.messages[1].content
    expect(typeof user).toBe('string')
    expect(user).toContain('(truncated)')
    expect(estimateTokens(user)).toBeLessThanOrEqual(2000)
  })

  it('drops images that do not fit the per-call budget and notes they could not be loaded', async () => {
    const fetchMock = stubFetch(() => okResponse('no json'))
    const pr = makePr({
      imageUrls: ['https://img.example/1.png', 'https://img.example/2.png'],
      body: 'Adds a cache.',
    })
    await buildTranscript(config, pr, {
      imageDataUrls: ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
      // tiny per-call budget: 2 images * 1600 tokens cannot fit
      budget: { contextTokens: 128000, maxContextPerCall: 2000 },
    })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    // no image parts: plain string content again
    expect(typeof body.messages[1].content).toBe('string')
    expect(body.messages[1].content).toContain('could not be loaded')
    expect(body.messages[1].content).not.toContain('are attached')
    expect(estimateTokens(body.messages[1].content)).toBeLessThanOrEqual(2000)
  })

  it('keeps images that fit and counts their cost against the text budget', async () => {
    const fetchMock = stubFetch(() => okResponse('no json'))
    const pr = makePr({
      imageUrls: ['https://img.example/1.png', 'https://img.example/2.png'],
      body: 'B'.repeat(20000),
    })
    await buildTranscript(config, pr, {
      imageDataUrls: ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
      budget: { contextTokens: 128000, maxContextPerCall: 8500 },
    })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    const content = body.messages[1].content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toHaveLength(3)
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('(truncated)')
    expect(content.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,ONE' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,TWO' } },
    ])
    const sysTokens = estimateTokens(body.messages[0].content)
    expect(estimateTokens(content[0].text)).toBeLessThanOrEqual(
      8500 - sysTokens - 4096 - 2 * IMAGE_TOKEN_ESTIMATE,
    )
  })
})

// ---------------------------------------------------------------------------
// Section files (file-link chips)
// ---------------------------------------------------------------------------

function findChangesCall(calls: RecordedCall[]): RecordedCall {
  const call = calls.find((c) => c.messages[1]!.text.includes('Files in this batch'))
  expect(call).toBeDefined()
  return call!
}

describe('section files parsing and validation', () => {
  it('parses files from a stream section, keeping only filenames in that call input', async () => {
    const { chat: fake } = recordChat(() =>
      JSON.stringify({
        title: 'Changes',
        sentences: ['The widgets gained a helper.'],
        summary: 'helper',
        files: ['src/a.ts', 'made-up.ts', 'src/b.ts', 42, ''],
      }),
    )
    const stream = createTranscriptStream(config, makeStreamPr(), { chat: fake })
    const sections = await drain(stream)
    const changes = sections.find((s) => s.id.startsWith('changes'))!
    expect(changes.files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('filters per call: a filename from a later batch is not accepted early', async () => {
    const pr = makeStreamPr({ files: makeFiles(12) })
    const { chat: fake } = recordChat((call) => {
      if (call.messages[1]!.text.includes('batch 1 of')) {
        // second-batch filename claimed by the first batch's reply
        return JSON.stringify({
          title: 'B1',
          sentences: ['First batch.'],
          files: ['src/f0.ts', 'src/f10.ts'],
        })
      }
      return sectionJson(1)
    })
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const sections = await drain(stream)
    const firstChanges = sections.find((s) => s.id === 'changes-1')!
    expect(firstChanges.files).toEqual(['src/f0.ts'])
  })

  it('drops the files field when the model invents filenames', async () => {
    const { chat: fake } = recordChat(() =>
      JSON.stringify({
        title: 'Changes',
        sentences: ['Words were spoken.'],
        files: ['nope.ts', 'also-nope.rs'],
      }),
    )
    const stream = createTranscriptStream(config, makeStreamPr(), { chat: fake })
    const sections = await drain(stream)
    for (const s of sections) expect(s.files).toBeUndefined()
  })

  it('dedupes and caps parsed files at 8', async () => {
    const pr = makeStreamPr({ files: makeFiles(9) })
    const { chat: fake } = recordChat(() =>
      JSON.stringify({
        title: 'B',
        sentences: ['Many files changed.'],
        files: [
          'src/f0.ts', 'src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts',
          'src/f4.ts', 'src/f5.ts', 'src/f6.ts', 'src/f7.ts', 'src/f8.ts',
        ],
      }),
    )
    const stream = createTranscriptStream(config, pr, { chat: fake })
    const sections = await drain(stream)
    const changes = sections.find((s) => s.id.startsWith('changes'))!
    expect(changes.files).toEqual([
      'src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts',
      'src/f4.ts', 'src/f5.ts', 'src/f6.ts', 'src/f7.ts',
    ])
  })

  it('parses files in buildTranscript sections, filtered to the PR files', async () => {
    const reply = JSON.stringify({
      title: 'Caching layer',
      sections: [
        {
          id: 'changes',
          title: 'Key Changes',
          sentences: ['The cache module gained a Map.'],
          files: ['src/cache.ts', 'invented.ts', 'README.md'],
        },
        { id: 'overview', title: 'Overview', sentences: ['This PR adds caching.'] },
      ],
    })
    stubFetch(() => okResponse(reply))
    const transcript = await buildTranscript(config, makePr())
    const changes = transcript.sections.find((s) => s.id === 'changes')!
    expect(changes.files).toEqual(['src/cache.ts', 'README.md'])
    const overview = transcript.sections.find((s) => s.id === 'overview')!
    expect(overview.files).toBeUndefined()
  })

  it('keeps delta section files only when the filename appears in the delta prompt', async () => {
    const commits = [
      { sha: 'new0003', message: 'fix: guard src/cache.ts against empty input', date: '2026-11-22T10:00:00Z' },
    ]
    const { chat: fake } = recordChat(() =>
      JSON.stringify({
        title: 'Update',
        sentences: ['The guard landed.'],
        files: ['src/cache.ts', 'unmentioned.ts'],
      }),
    )
    const section = await buildDeltaSection(config, makePr(), commits, 'previous summary', {
      chat: fake,
    })
    expect(section.files).toEqual(['src/cache.ts'])
  })
})

// ---------------------------------------------------------------------------
// Detail mode
// ---------------------------------------------------------------------------

describe('detail mode', () => {
  it('brief keeps the intent-level instruction; detailed swaps in removals/additions with per-file counts', async () => {
    const { calls: briefCalls, chat: briefChat } = recordChat(defaultResponder)
    await drain(createTranscriptStream(config, makeStreamPr(), { chat: briefChat }))
    const { calls: detailedCalls, chat: detailedChat } = recordChat(defaultResponder)
    await drain(
      createTranscriptStream(config, makeStreamPr(), { chat: detailedChat, detail: 'detailed' }),
    )

    const brief = findChangesCall(briefCalls)
    const detailed = findChangesCall(detailedCalls)

    expect(brief.messages[0]!.text).toContain('intent and logic flow')
    expect(brief.messages[0]!.text).not.toContain('state removals and additions')
    expect(brief.messages[1]!.text).not.toContain('Per-file additions/deletions')

    expect(detailed.messages[0]!.text).toContain(
      'state removals and additions as separate statements, using the per-file +N/-M counts provided',
    )
    expect(detailed.messages[1]!.text).toContain('Per-file additions/deletions')
    expect(detailed.messages[1]!.text).toContain('src/a.ts: +5 additions, -1 deletions')
    expect(detailed.messages[1]!.text).toContain('src/b.ts: +5 additions, -1 deletions')

    // prompts genuinely differ between modes
    expect(brief.messages[0]!.text).not.toEqual(detailed.messages[0]!.text)
    expect(brief.messages[1]!.text).not.toEqual(detailed.messages[1]!.text)
  })

  it('both detail modes request files in the section JSON schema', async () => {
    const { calls: briefCalls, chat: briefChat } = recordChat(defaultResponder)
    await drain(createTranscriptStream(config, makeStreamPr(), { chat: briefChat }))
    const { calls: detailedCalls, chat: detailedChat } = recordChat(defaultResponder)
    await drain(
      createTranscriptStream(config, makeStreamPr(), { chat: detailedChat, detail: 'detailed' }),
    )
    for (const call of [...briefCalls, ...detailedCalls]) {
      expect(call.messages[0]!.text).toContain('"files": string[]')
    }
  })

  it('buildTranscript detailed: system prompt swaps the changes instruction and the user prompt carries per-file counts', async () => {
    const reply = JSON.stringify({
      title: 'T',
      sections: [{ id: 'changes', title: 'Changes', sentences: ['Sentence.'] }],
    })
    const briefFetch = stubFetch(() => okResponse(reply))
    await buildTranscript(config, makePr())
    const briefBody = JSON.parse(briefFetch.mock.calls[0]![1].body as string)

    const detailedFetch = stubFetch(() => okResponse(reply))
    await buildTranscript(config, makePr(), { detail: 'detailed' })
    const detailedBody = JSON.parse(detailedFetch.mock.calls[0]![1].body as string)

    expect(briefBody.messages[0].content).toContain('intent and logic flow')
    expect(briefBody.messages[0].content).not.toContain('state removals and additions')
    expect(detailedBody.messages[0].content).toContain(
      'state removals and additions as separate statements, using the per-file +N/-M counts provided',
    )
    expect(detailedBody.messages[1].content).toContain('Per-file additions/deletions')
    expect(detailedBody.messages[1].content).toContain('src/cache.ts: +100 additions, -10 deletions')
    expect(briefBody.messages[1].content).not.toContain('Per-file additions/deletions')
  })

  it('buildDeltaSection detailed branches the system prompt; brief stays intent-level', async () => {
    const { calls: detailedCalls, chat: detailedChat } = recordChat(() =>
      JSON.stringify({ title: 't', sentences: ['S.'] }),
    )
    await buildDeltaSection(config, makePr(), DELTA_COMMITS, 'prev', {
      chat: detailedChat,
      detail: 'detailed',
    })
    expect(detailedCalls[0]!.messages[0]!.text).toContain(
      'state removals and additions as separate statements',
    )
    expect(detailedCalls[0]!.messages[0]!.text).toContain('"files": string[]')

    const { calls: briefCalls, chat: briefChat } = recordChat(() =>
      JSON.stringify({ title: 't', sentences: ['S.'] }),
    )
    await buildDeltaSection(config, makePr(), DELTA_COMMITS, 'prev', { chat: briefChat })
    expect(briefCalls[0]!.messages[0]!.text).not.toContain('state removals and additions')
    expect(briefCalls[0]!.messages[0]!.text).toContain('"files": string[]')
  })
})
