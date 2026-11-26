import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NonImageError,
  extractImageUrls,
  extractMermaidBlocks,
  fetchImageAsDataUrl,
  fetchPullRequest,
  filterGeneratedFiles,
  findPrUrl,
  parsePrUrl,
} from './github'
import type { PrFile } from './types'

// ---------- fetch mock helpers ----------

interface MockRes {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}

function jsonRes(body: unknown, opts: { status?: number; headers?: Record<string, string> } = {}): MockRes {
  const status = opts.status ?? 200
  const headers = opts.headers ?? {}
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
        return key === undefined ? null : (headers[key] ?? null)
      },
    },
    json: () => Promise.resolve(JSON.parse(JSON.stringify(body))),
    arrayBuffer: () => Promise.reject(new Error('not a binary response')),
  }
}

function bytesRes(bytes: Uint8Array, contentType: string): MockRes {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: () => Promise.reject(new Error('not json')),
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer as ArrayBuffer),
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- parsePrUrl ----------

describe('parsePrUrl', () => {
  it('parses a plain PR URL', () => {
    expect(parsePrUrl('https://github.com/octocat/hello/pull/42')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      number: 42,
    })
  })

  it('parses trailing slash, query, fragment, and /files suffix', () => {
    expect(parsePrUrl('https://github.com/octocat/hello/pull/42/')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      number: 42,
    })
    expect(parsePrUrl('https://github.com/octocat/hello/pull/42?diff=split')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      number: 42,
    })
    expect(parsePrUrl('https://github.com/octocat/hello/pull/42#issuecomment-1')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      number: 42,
    })
    expect(parsePrUrl('https://github.com/octocat/hello/pull/42/files?diff=unified#top')).toEqual({
      owner: 'octocat',
      repo: 'hello',
      number: 42,
    })
  })

  it('rejects non-PR, non-github, and malformed URLs', () => {
    expect(parsePrUrl('https://github.com/octocat/hello/issues/42')).toBeNull()
    expect(parsePrUrl('https://gitlab.com/octocat/hello/pull/42')).toBeNull()
    expect(parsePrUrl('github.com/octocat/hello/pull/42')).toBeNull()
    expect(parsePrUrl('https://github.com/octocat/hello/pulls/42')).toBeNull()
    expect(parsePrUrl('https://github.com/octocat/hello/pull/abc')).toBeNull()
    expect(parsePrUrl('https://github.com/octocat/hello/pull/42/commits')).toBeNull()
    expect(parsePrUrl('')).toBeNull()
  })
})

// ---------- findPrUrl ----------

describe('findPrUrl', () => {
  it('finds a PR URL embedded in shared text', () => {
    const text = 'hey check this PR https://github.com/foo/bar/pull/9/files thanks'
    expect(findPrUrl(text)).toEqual({ owner: 'foo', repo: 'bar', number: 9 })
  })

  it('returns the first of several PR URLs', () => {
    const text = 'a https://github.com/a/b/pull/1 and b https://github.com/c/d/pull/2'
    expect(findPrUrl(text)).toEqual({ owner: 'a', repo: 'b', number: 1 })
  })

  it('returns null when text has no PR URL', () => {
    expect(findPrUrl('no links here https://example.com/x')).toBeNull()
  })
})

// ---------- filterGeneratedFiles ----------

describe('filterGeneratedFiles', () => {
  const f = (filename: string): PrFile => ({ filename, status: 'modified', additions: 1, deletions: 1 })

  it('drops lockfiles, build output, minified bundles, and source maps', () => {
    const files = [
      f('package-lock.json'),
      f('yarn.lock'),
      f('pnpm-lock.yaml'),
      f('bun.lockb'),
      f('Podfile.lock'),
      f('Gemfile.lock'),
      f('poetry.lock'),
      f('Cargo.lock'),
      f('go.sum'),
      f('dist/bundle.js'),
      f('build/out.js'),
      f('assets/app.min.js'),
      f('src/app.js.map'),
      f('src/index.ts'),
      f('nested/deep/lib.rs'),
    ]
    const { kept, dropped } = filterGeneratedFiles(files)
    expect(kept.map((x) => x.filename)).toEqual(['src/index.ts', 'nested/deep/lib.rs'])
    expect(dropped).toBe(13)
  })

  it('does not drop similarly named source files', () => {
    const { kept, dropped } = filterGeneratedFiles([f('builder.ts'), f('distribution/x.ts'), f('locks.md'), f('src/min.js.ts')])
    expect(kept.map((x) => x.filename)).toEqual(['builder.ts', 'distribution/x.ts', 'locks.md', 'src/min.js.ts'])
    expect(dropped).toBe(0)
  })

  it('drops nested monorepo build directories at any depth', () => {
    const files = [
      f('packages/app/dist/bundle.js'),
      f('web/build/out.js'),
      f('a/b/c/dist/deep.css'),
      f('packages/app/src/main.ts'),
    ]
    const { kept, dropped } = filterGeneratedFiles(files)
    expect(kept.map((x) => x.filename)).toEqual(['packages/app/src/main.ts'])
    expect(dropped).toBe(3)
  })

  it('handles empty input', () => {
    expect(filterGeneratedFiles([])).toEqual({ kept: [], dropped: 0 })
  })
})

// ---------- extractImageUrls ----------

describe('extractImageUrls', () => {
  it('extracts markdown and HTML image URLs, deduped, order preserved', () => {
    const text = [
      'before ![shot](https://a.example/1.png) mid',
      '<img src="https://b.example/2.png" alt="x">',
      "again ![dup](https://a.example/1.png) with title ![t](https://c.example/3.png \"the title\")",
      "<img alt='y' src='https://d.example/4.png'>",
      'and a plain link [not image](https://e.example/5.png)',
    ].join('\n')
    expect(extractImageUrls(text)).toEqual([
      'https://a.example/1.png',
      'https://b.example/2.png',
      'https://c.example/3.png',
      'https://d.example/4.png',
    ])
  })

  it('returns empty array when no images', () => {
    expect(extractImageUrls('just text and [a link](https://x)')).toEqual([])
  })
})

// ---------- extractMermaidBlocks ----------

describe('extractMermaidBlocks', () => {
  it('extracts fenced mermaid blocks, trimmed, non-mermaid fences ignored', () => {
    const text = [
      'intro',
      '```mermaid',
      'graph TD;',
      '  A-->B;',
      '```',
      '```ts',
      'const x = 1',
      '```',
      '```mermaid',
      '  pie',
      '```',
    ].join('\n')
    expect(extractMermaidBlocks(text)).toEqual(['graph TD;\n  A-->B;', 'pie'])
  })

  it('returns empty array when no mermaid blocks', () => {
    expect(extractMermaidBlocks('```js\nconsole.log(1)\n```')).toEqual([])
  })
})

// ---------- fetchPullRequest ----------

const TOKEN = 'ghp_testtoken123'
const REF = { owner: 'octo', repo: 'repo', number: 7 }
const FILES_Q = 'per_page=100&page=1'

function fileEntry(filename: string, patch?: string): Record<string, unknown> {
  return { filename, status: 'modified', additions: 3, deletions: 1, ...(patch !== undefined ? { patch } : {}) }
}

describe('fetchPullRequest', () => {
  it('fetches and maps all PR parts with auth headers, filtering generated files', async () => {
    const routes: Record<string, MockRes> = {
      'https://api.github.com/repos/octo/repo/pulls/7': jsonRes({
        title: 'Add feature',
        body: 'Fixes #1\n\n![shot](https://github.com/user-attachments/assets/a1.png)',
        user: { login: 'octocat' },
        additions: 10,
        deletions: 2,
      }),
      [`https://api.github.com/repos/octo/repo/pulls/7/files?${FILES_Q}`]: jsonRes([
        fileEntry('src/a.ts', '@@ -1 +1 @@'),
        fileEntry('package-lock.json'),
        fileEntry('src/b.ts'),
      ]),
      [`https://api.github.com/repos/octo/repo/pulls/7/comments?${FILES_Q}`]: jsonRes([
        {
          user: { login: 'r1' },
          body: 'looks good ![diagram](https://github.com/user-attachments/assets/a1.png) also ![d2](https://github.com/user-attachments/assets/d2.png)',
        },
      ]),
      [`https://api.github.com/repos/octo/repo/pulls/7/reviews?${FILES_Q}`]: jsonRes([
        { user: { login: 'rev1' }, state: 'APPROVED', body: 'LGTM' },
      ]),
      [`https://api.github.com/repos/octo/repo/issues/7/comments?${FILES_Q}`]: jsonRes([
        { user: { login: 'iss1' }, body: 'diagram:\n```mermaid\ngraph TD\n```\n' },
      ]),
    }
    fetchMock.mockImplementation((url: string) => {
      const r = routes[url]
      if (r !== undefined) return Promise.resolve(r)
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    const data = await fetchPullRequest(REF, TOKEN)

    expect(data.ref).toEqual(REF)
    expect(data.title).toBe('Add feature')
    expect(data.body).toContain('Fixes #1')
    expect(data.author).toBe('octocat')
    expect(data.additions).toBe(10)
    expect(data.deletions).toBe(2)
    // generated files filtered out, counts reflect the kept list
    expect(data.files.map((x) => x.filename)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(data.changedFiles).toBe(2)
    expect(data.files[0]?.patch).toBe('@@ -1 +1 @@')
    // review comments then issue comments, in order
    expect(data.comments).toEqual([
      {
        author: 'r1',
        body: expect.stringContaining('d2.png'),
      },
      { author: 'iss1', body: expect.stringContaining('mermaid') },
    ])
    expect(data.reviews).toEqual([{ author: 'rev1', state: 'APPROVED', body: 'LGTM' }])
    // images deduped across body + comments, body first
    expect(data.imageUrls).toEqual([
      'https://github.com/user-attachments/assets/a1.png',
      'https://github.com/user-attachments/assets/d2.png',
    ])
    expect(data.mermaidBlocks).toEqual(['graph TD'])

    // every request carried Bearer auth and the GitHub JSON Accept header
    expect(fetchMock).toHaveBeenCalledTimes(5)
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { headers: Record<string, string> }
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(init.headers.Accept).toBe('application/vnd.github+json')
    }
  })

  it('follows Link rel=next headers when paginating files', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => fileEntry(`src/f${i}.ts`))
    const page2 = Array.from({ length: 50 }, (_, i) => fileEntry(`src/g${i}.ts`))
    const filesBase = 'https://api.github.com/repos/octo/repo/pulls/7/files'
    const routes: Record<string, MockRes> = {
      'https://api.github.com/repos/octo/repo/pulls/7': jsonRes({ title: 't', body: '', user: { login: 'u' } }),
      [`${filesBase}?${FILES_Q}`]: jsonRes(page1, {
        headers: { link: `<${filesBase}?per_page=100&page=2>; rel="next", <${filesBase}?per_page=100&page=2>; rel="last"` },
      }),
      [`${filesBase}?per_page=100&page=2`]: jsonRes(page2),
      [`https://api.github.com/repos/octo/repo/pulls/7/comments?${FILES_Q}`]: jsonRes([]),
      [`https://api.github.com/repos/octo/repo/pulls/7/reviews?${FILES_Q}`]: jsonRes([]),
      [`https://api.github.com/repos/octo/repo/issues/7/comments?${FILES_Q}`]: jsonRes([]),
    }
    fetchMock.mockImplementation((url: string) => {
      const r = routes[url]
      if (r !== undefined) return Promise.resolve(r)
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    const data = await fetchPullRequest(REF, TOKEN)
    expect(data.files).toHaveLength(150)
    expect(fetchMock).toHaveBeenCalledWith(
      `${filesBase}?per_page=100&page=2`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }) }),
    )
  })

  it('falls back to a ?page= loop when no Link header is returned', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => fileEntry(`src/f${i}.ts`))
    const page2 = Array.from({ length: 30 }, (_, i) => fileEntry(`src/g${i}.ts`))
    const filesBase = 'https://api.github.com/repos/octo/repo/pulls/7/files'
    const routes: Record<string, MockRes> = {
      'https://api.github.com/repos/octo/repo/pulls/7': jsonRes({ title: 't', body: '', user: { login: 'u' } }),
      [`${filesBase}?${FILES_Q}`]: jsonRes(page1),
      [`${filesBase}?per_page=100&page=2`]: jsonRes(page2),
      [`https://api.github.com/repos/octo/repo/pulls/7/comments?${FILES_Q}`]: jsonRes([]),
      [`https://api.github.com/repos/octo/repo/pulls/7/reviews?${FILES_Q}`]: jsonRes([]),
      [`https://api.github.com/repos/octo/repo/issues/7/comments?${FILES_Q}`]: jsonRes([]),
    }
    fetchMock.mockImplementation((url: string) => {
      const r = routes[url]
      if (r !== undefined) return Promise.resolve(r)
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    const data = await fetchPullRequest(REF, TOKEN)
    expect(data.files).toHaveLength(130)
    // 1 PR + 2 file pages + 3 list endpoints
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('caps files at 300 even when more pages exist', async () => {
    const filesBase = 'https://api.github.com/repos/octo/repo/pulls/7/files'
    const full = () => Array.from({ length: 100 }, (_, i) => fileEntry(`src/p${i}.ts`))
    const routes: Record<string, MockRes> = {
      'https://api.github.com/repos/octo/repo/pulls/7': jsonRes({ title: 't', body: '', user: { login: 'u' } }),
      [`${filesBase}?${FILES_Q}`]: jsonRes(full(), {
        headers: { link: `<${filesBase}?per_page=100&page=2>; rel="next"` },
      }),
      [`${filesBase}?per_page=100&page=2`]: jsonRes(full(), {
        headers: { link: `<${filesBase}?per_page=100&page=3>; rel="next"` },
      }),
      [`${filesBase}?per_page=100&page=3`]: jsonRes(full(), {
        headers: { link: `<${filesBase}?per_page=100&page=4>; rel="next"` },
      }),
      [`https://api.github.com/repos/octo/repo/pulls/7/comments?${FILES_Q}`]: jsonRes([]),
      [`https://api.github.com/repos/octo/repo/pulls/7/reviews?${FILES_Q}`]: jsonRes([]),
      [`https://api.github.com/repos/octo/repo/issues/7/comments?${FILES_Q}`]: jsonRes([]),
    }
    fetchMock.mockImplementation((url: string) => {
      const r = routes[url]
      if (r !== undefined) return Promise.resolve(r)
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    const data = await fetchPullRequest(REF, TOKEN)
    expect(data.files).toHaveLength(300)
    expect(data.changedFiles).toBe(300)
    // page 4 never requested: 1 PR + 3 file pages + 3 list endpoints
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('throws a sanitized error on HTTP failure', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/7') {
        return Promise.resolve(jsonRes({ message: 'Not Found' }, { status: 404 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    await expect(fetchPullRequest(REF, TOKEN)).rejects.toThrow(/404/)
    await expect(fetchPullRequest(REF, TOKEN)).rejects.toThrow(/Not Found/)
  })

  it('strips the token if it leaks into a thrown error message', async () => {
    fetchMock.mockRejectedValue(new Error(`network failed while sending Bearer ${TOKEN}`))

    const err = await fetchPullRequest(REF, TOKEN).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).not.toContain(TOKEN)
    expect(msg).toContain('[REDACTED]')
  })
})

// ---------- fetchImageAsDataUrl ----------

describe('fetchImageAsDataUrl', () => {
  it('sends the auth header for github.com and returns a data URL', async () => {
    const bytes = new TextEncoder().encode('hello')
    fetchMock.mockResolvedValue(bytesRes(bytes, 'image/png'))

    const url = await fetchImageAsDataUrl('https://github.com/user-attachments/assets/abc.png', TOKEN)

    expect(url).toBe('data:image/png;base64,aGVsbG8=')
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://github.com/user-attachments/assets/abc.png')
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('sends the auth header for githubusercontent.com hosts', async () => {
    fetchMock.mockResolvedValue(bytesRes(new TextEncoder().encode('x'), 'image/jpeg'))

    await fetchImageAsDataUrl('https://raw.githubusercontent.com/o/r/main/a.jpg', TOKEN)

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('omits the auth header for non-github hosts', async () => {
    fetchMock.mockResolvedValue(bytesRes(new TextEncoder().encode('x'), 'image/gif'))

    await fetchImageAsDataUrl('https://example.com/cat.gif', TOKEN)

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('throws NonImageError for non-image content types', async () => {
    fetchMock.mockResolvedValue(bytesRes(new TextEncoder().encode('<html>'), 'text/html; charset=utf-8'))

    const err = await fetchImageAsDataUrl('https://github.com/user-attachments/assets/abc.png', TOKEN).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(NonImageError)
    expect((err as NonImageError).contentType).toBe('text/html; charset=utf-8')
    expect((err as Error).message).toContain('text/html')
  })

  it('sanitizes the token out of network errors', async () => {
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED with ${TOKEN}`))

    const err = await fetchImageAsDataUrl('https://github.com/user-attachments/assets/abc.png', TOKEN).catch(
      (e: unknown) => e,
    )
    expect((err as Error).message).not.toContain(TOKEN)
    expect((err as Error).message).toContain('[REDACTED]')
  })
})
