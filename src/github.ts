// GitHub PR ingestion (DVC section 2).
// All network access goes through the global fetch; callers must be in a
// browser/service-worker context (tests mock fetch).

import type { PrComment, PrFile, PullRequestData, PullRequestRef, PrReview } from './types'

const API_BASE = 'https://api.github.com'

/** Max files pulled from the /files endpoint across pages. */
const MAX_FILES = 300
/** Page size used for every paginated list endpoint. */
const PAGE_SIZE = 100

// ---------- URL parsing ----------

const PR_URL_RE =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/files)?\/?(?:[?#].*)?$/i

/** Parse a canonical PR web URL. Returns null for anything else. */
export function parsePrUrl(url: string): PullRequestRef | null {
  const m = PR_URL_RE.exec(url.trim())
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null
  return { owner: m[1], repo: m[2], number: Number(m[3]) }
}

const PR_URL_SCAN_RE =
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/files)?\/?(?:[?#][^\s]*)?/gi

/** Scan arbitrary shared text (share-sheet input) for the first PR URL. */
export function findPrUrl(text: string): PullRequestRef | null {
  PR_URL_SCAN_RE.lastIndex = 0
  const m = PR_URL_SCAN_RE.exec(text)
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null
  return { owner: m[1], repo: m[2], number: Number(m[3]) }
}

const BARE_PR_URL_RE =
  /^github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/files)?\/?(?:[?#].*)?$/i

const SHORTHAND_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/

/**
 * Parse free-form user input into a PR ref. Accepts everything parsePrUrl
 * takes, plus scheme-less github.com URLs and 'owner/repo#123' shorthand.
 * Input is whitespace-trimmed; the host matches case-insensitively.
 * Returns null for anything else.
 */
export function parsePrInput(input: string): PullRequestRef | null {
  const trimmed = input.trim()
  const full = parsePrUrl(trimmed)
  if (full !== null) return full
  const bare = BARE_PR_URL_RE.exec(trimmed)
  if (bare && bare[1] !== undefined && bare[2] !== undefined && bare[3] !== undefined) {
    return { owner: bare[1], repo: bare[2], number: Number(bare[3]) }
  }
  const short = SHORTHAND_RE.exec(trimmed)
  if (short && short[1] !== undefined && short[2] !== undefined && short[3] !== undefined) {
    return { owner: short[1], repo: short[2], number: Number(short[3]) }
  }
  return null
}

// ---------- Generated-file filtering ----------

const GENERATED_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'go.sum',
])

function isGeneratedFile(filename: string): boolean {
  // Any path segment named dist/build marks build output, including nested
  // monorepo paths like packages/app/dist/bundle.js.
  const segments = filename.split('/')
  if (segments.slice(0, -1).some((seg) => seg === 'dist' || seg === 'build')) return true
  const base = segments[segments.length - 1] ?? ''
  if (GENERATED_BASENAMES.has(base)) return true
  if (base.endsWith('.lock')) return true
  if (base.endsWith('.min.js') || base.endsWith('.map')) return true
  return false
}

/**
 * Split PR files into kept / generated (lockfiles, build output, minified
 * bundles, source maps). `dropped` is the count of filtered-out files.
 */
export function filterGeneratedFiles(files: PrFile[]): { kept: PrFile[]; dropped: number } {
  const kept: PrFile[] = []
  let dropped = 0
  for (const f of files) {
    if (isGeneratedFile(f.filename)) dropped += 1
    else kept.push(f)
  }
  return { kept, dropped }
}

// ---------- Text extraction ----------

const MD_IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
const HTML_IMG_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi

/** Extract image URLs from markdown ![alt](url) and HTML <img src="...">, deduped. */
export function extractImageUrls(text: string): string[] {
  const found: Array<{ index: number; url: string }> = []
  for (const m of text.matchAll(MD_IMG_RE)) {
    if (m[1] !== undefined) found.push({ index: m.index ?? 0, url: m[1] })
  }
  for (const m of text.matchAll(HTML_IMG_RE)) {
    if (m[1] !== undefined) found.push({ index: m.index ?? 0, url: m[1] })
  }
  const urls: string[] = []
  for (const { url } of found.sort((a, b) => a.index - b.index)) {
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

const MERMAID_RE = /```mermaid\s*\n([\s\S]*?)```/g

/** Extract fenced ```mermaid block contents, each trimmed. */
export function extractMermaidBlocks(text: string): string[] {
  const blocks: string[] = []
  for (const m of text.matchAll(MERMAID_RE)) {
    if (m[1] !== undefined) blocks.push(m[1].trim())
  }
  return blocks
}

// ---------- Fetch plumbing ----------

function ghHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
}

/** Never let the token surface in a thrown message. */
function sanitizeError(err: unknown, token: string): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const msg = token !== '' && raw.includes(token) ? raw.split(token).join('[REDACTED]') : raw
  return new Error(msg)
}

async function httpError(res: Response, url: string, token: string): Promise<Error> {
  let detail = ''
  try {
    const body = (await res.json()) as { message?: unknown }
    if (body !== null && typeof body === 'object' && typeof body.message === 'string') {
      detail = body.message
    }
  } catch {
    // non-JSON error body; status alone is enough
  }
  const msg = `GitHub API request failed (${res.status}) for ${url}${detail === '' ? '' : `: ${detail}`}`
  return sanitizeError(new Error(msg), token)
}

async function ghFetchJson<T>(url: string, token: string): Promise<{ data: T; link: string | null }> {
  let res: Response
  try {
    res = await fetch(url, { headers: ghHeaders(token) })
  } catch (err) {
    throw sanitizeError(err, token)
  }
  if (!res.ok) throw await httpError(res, url, token)
  const link = res.headers.get('link')
  const data = (await res.json()) as T
  return { data, link }
}

function nextLink(link: string | null): string | null {
  if (link === null) return null
  for (const part of link.split(',')) {
    if (/rel="next"/.test(part)) {
      const m = /<([^>]+)>/.exec(part)
      if (m?.[1] !== undefined) return m[1]
    }
  }
  return null
}

function pageUrl(baseUrl: string, page: number): string {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`
}

/** Collect every page of a list endpoint, capped at `max` items. */
async function fetchAllPages<T>(baseUrl: string, token: string, max: number): Promise<T[]> {
  const out: T[] = []
  let current = pageUrl(baseUrl, 1)
  let page = 1
  while (out.length < max) {
    const { data, link } = await ghFetchJson<T[]>(current, token)
    if (!Array.isArray(data) || data.length === 0) break
    out.push(...data)
    if (out.length >= max) break
    const next = nextLink(link)
    if (next !== null) {
      current = next
      continue
    }
    if (data.length < PAGE_SIZE) break
    page += 1
    current = pageUrl(baseUrl, page)
  }
  return out.slice(0, max)
}

// ---------- GitHub API response shapes (only fields we consume) ----------

interface GhUser {
  login?: string
}
interface GhPull {
  title?: string
  body?: string
  user?: GhUser
  head?: { sha?: string }
  additions?: number
  deletions?: number
}
interface GhFile {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
}
interface GhComment {
  user?: GhUser
  body?: string
}
interface GhReview {
  user?: GhUser
  state?: string
  body?: string
}

function mapFile(f: GhFile): PrFile {
  return {
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    ...(f.patch !== undefined ? { patch: f.patch } : {}),
  }
}

// ---------- PR ingestion ----------

/**
 * Fetch a PR with its files (up to 300, generated files filtered out),
 * review comments, reviews, and issue comments. Maps everything into
 * PullRequestData, including image URLs and mermaid blocks found in the
 * body and comments. Thrown errors never contain the token.
 */
export async function fetchPullRequest(ref: PullRequestRef, token: string): Promise<PullRequestData> {
  const repoUrl = `${API_BASE}/repos/${ref.owner}/${ref.repo}`
  const prUrl = `${repoUrl}/pulls/${ref.number}`

  const prResult = await ghFetchJson<GhPull>(prUrl, token)
  const pr = prResult.data

  const [rawFiles, reviewComments, reviews, issueComments] = await Promise.all([
    fetchAllPages<GhFile>(`${prUrl}/files`, token, MAX_FILES),
    fetchAllPages<GhComment>(`${prUrl}/comments`, token, 1000),
    fetchAllPages<GhReview>(`${prUrl}/reviews`, token, 1000),
    fetchAllPages<GhComment>(`${repoUrl}/issues/${ref.number}/comments`, token, 1000),
  ])

  const { kept } = filterGeneratedFiles(rawFiles.map(mapFile))

  const comments: PrComment[] = [...reviewComments, ...issueComments].map((c) => ({
    author: c.user?.login ?? 'unknown',
    body: c.body ?? '',
  }))
  const mappedReviews: PrReview[] = reviews.map((r) => ({
    author: r.user?.login ?? 'unknown',
    state: r.state ?? '',
    body: r.body ?? '',
  }))

  const imageUrls: string[] = []
  const mermaidBlocks: string[] = []
  const texts = [pr.body ?? '', ...comments.map((c) => c.body)]
  for (const text of texts) {
    for (const u of extractImageUrls(text)) {
      if (!imageUrls.includes(u)) imageUrls.push(u)
    }
    mermaidBlocks.push(...extractMermaidBlocks(text))
  }

  return {
    ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
    title: pr.title ?? '',
    body: pr.body ?? '',
    author: pr.user?.login ?? 'unknown',
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    ...(pr.head?.sha !== undefined ? { headSha: pr.head.sha } : {}),
    changedFiles: kept.length,
    files: kept,
    comments,
    reviews: mappedReviews,
    imageUrls,
    mermaidBlocks,
  }
}

// ---------- New-commit fetching (delta listening) ----------

/** A commit on a PR branch, as consumed by the delta transcript section. */
export interface PrCommit {
  sha: string
  /** First line of the commit message. */
  message: string
  /** Committer date, ISO-8601. */
  date: string
}

interface GhCommit {
  sha: string
  commit?: { message?: string; committer?: { date?: string } }
}

/** Max commits pulled from the PR commits endpoint across pages. */
const MAX_PR_COMMITS = 250
/** Cap on commits returned by fetchNewCommits. */
const MAX_NEW_COMMITS = 50

/**
 * Fetch the PR's commits and return only those whose committer date is
 * strictly after `sinceIso` (ISO-8601 string compare), mapped to
 * {sha, message (first line), date}, capped at 50. Thrown errors never
 * contain the token.
 */
export async function fetchNewCommits(
  ref: PullRequestRef,
  sinceIso: string,
  token: string,
): Promise<PrCommit[]> {
  const commits = await fetchAllPages<GhCommit>(
    `${API_BASE}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits`,
    token,
    MAX_PR_COMMITS,
  )
  return commits
    .filter((c) => (c.commit?.committer?.date ?? '') > sinceIso)
    .slice(0, MAX_NEW_COMMITS)
    .map((c) => ({
      sha: c.sha,
      message: (c.commit?.message ?? '').split('\n')[0] ?? '',
      date: c.commit?.committer?.date ?? '',
    }))
}

// ---------- Image fetching ----------

/** Thrown when an image URL returns a non-image content type. */
export class NonImageError extends Error {
  readonly contentType: string
  constructor(contentType: string) {
    super(`fetchImageAsDataUrl: expected an image content-type, got "${contentType}"`)
    this.name = 'NonImageError'
    this.contentType = contentType
  }
}

function needsAuth(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'github.com' || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')
  } catch {
    return false
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

/**
 * Fetch an image and return it as a data: URL. Sends the Authorization
 * header only for github.com / githubusercontent.com hosts (user-attachment
 * assets need auth). Throws NonImageError on non-image content types.
 */
export async function fetchImageAsDataUrl(url: string, token: string): Promise<string> {
  const headers: Record<string, string> = { Accept: 'image/*' }
  if (token !== '' && needsAuth(url)) headers.Authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    throw sanitizeError(err, token)
  }
  if (!res.ok) throw await httpError(res, url, token)
  const contentType = (res.headers.get('content-type') ?? '').trim()
  if (!contentType.startsWith('image/')) throw new NonImageError(contentType === '' ? '(none)' : contentType)
  const buf = new Uint8Array(await res.arrayBuffer())
  return `data:${contentType};base64,${bytesToBase64(buf)}`
}
