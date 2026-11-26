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

// ---------- Extended URL ingestion (blob/raw/commit/compare) ----------

/** A file addressed by repo + git ref + path (blob/raw URLs). */
export interface GitFileTarget {
  owner: string
  repo: string
  ref: string
  path: string
}

/** Everything the input box accepts, tagged by kind. */
export type GitTarget =
  | { kind: 'pr'; ref: PullRequestRef }
  | { kind: 'file'; file: GitFileTarget }
  | { kind: 'compare'; compare: { owner: string; repo: string; base: string; head: string } }
  | { kind: 'commit'; commit: { owner: string; repo: string; sha: string } }

const BLOB_URL_RE =
  /^(?:https:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|raw)\/([^/?#]+)\/([^?#]+)/i
const RAW_HOST_URL_RE =
  /^(?:https:\/\/)?raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([^/?#]+)\/([^?#]+)/i
const COMMIT_URL_RE = /^(?:https:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})/i
// Two-dot (base..head) and three-dot (base...head) compare syntax are both
// valid GitHub URLs; both are accepted and normalized to the three-dot
// merge-base compare the API call uses.
const COMPARE_URL_RE =
  /^(?:https:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/compare\/([^/?#]+?)\.{2,3}([^/?#]+)/i

function cleanPath(p: string): string {
  return p.replace(/\/+$/, '')
}

/**
 * Parse free-form input into any GitHub target: PR URLs/shorthand (kind
 * 'pr'), blob/raw file URLs (kind 'file'), commit URLs (kind 'commit'),
 * and compare URLs (kind 'compare'). Host matches case-insensitively and
 * the scheme is optional. Returns null for anything else.
 */
export function parseGitTarget(input: string): GitTarget | null {
  const trimmed = input.trim()
  const pr = parsePrInput(trimmed)
  if (pr !== null) return { kind: 'pr', ref: pr }
  const compare = COMPARE_URL_RE.exec(trimmed)
  if (compare && compare[1] !== undefined && compare[2] !== undefined && compare[3] !== undefined && compare[4] !== undefined) {
    return { kind: 'compare', compare: { owner: compare[1], repo: compare[2], base: compare[3], head: compare[4] } }
  }
  const commit = COMMIT_URL_RE.exec(trimmed)
  if (commit && commit[1] !== undefined && commit[2] !== undefined && commit[3] !== undefined) {
    return { kind: 'commit', commit: { owner: commit[1], repo: commit[2], sha: commit[3] } }
  }
  const blob = BLOB_URL_RE.exec(trimmed)
  if (blob && blob[1] !== undefined && blob[2] !== undefined && blob[3] !== undefined && blob[4] !== undefined) {
    const path = cleanPath(blob[4])
    if (path !== '') return { kind: 'file', file: { owner: blob[1], repo: blob[2], ref: blob[3], path } }
  }
  const raw = RAW_HOST_URL_RE.exec(trimmed)
  if (raw && raw[1] !== undefined && raw[2] !== undefined && raw[3] !== undefined && raw[4] !== undefined) {
    const path = cleanPath(raw[4])
    if (path !== '') return { kind: 'file', file: { owner: raw[1], repo: raw[2], ref: raw[3], path } }
  }
  return null
}

// ---------- Pseudo-PR refs ----------

/**
 * Pseudo numbers start here: real PR numbers never reach this range, so a
 * pseudo ref can never be mistaken for (or collide with) a real PR in the
 * same repo. Consumers that branch on "is this a real PR" check against
 * this floor (see fileChipHref in app.ts).
 */
export const PSEUDO_REF_FLOOR = 1_000_000_000

/**
 * Deterministic pseudo-PR number for non-PR targets (file / commit /
 * compare / pasted text), derived from a seed unique to the target. The
 * store keys resume positions, listen history and the queue by
 * owner/repo#number alone, so every distinct pseudo-target needs its own
 * number: two different files (or pastes, or compares) in one repo must
 * not share a resume position or listen timestamp.
 */
export function pseudoRefNumber(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return PSEUDO_REF_FLOOR + (h % 900_000_000)
}

/** Pseudo ref for a blob/raw file target; unique per repo+ref+path. */
function filePseudoRef(t: GitFileTarget): PullRequestRef {
  return { owner: t.owner, repo: t.repo, number: pseudoRefNumber(`file:${t.ref}:${t.path}`) }
}

/**
 * The ref a routed input should be keyed under in the store: real PRs use
 * their own ref; file/commit/compare targets get a deterministic pseudo ref
 * so their resume/listen/cache records stay separate from each other and
 * from real PRs in the same repo.
 */
export function pseudoTargetRef(target: GitTarget): PullRequestRef {
  if (target.kind === 'pr') return target.ref
  if (target.kind === 'file') return filePseudoRef(target.file)
  if (target.kind === 'commit') {
    return {
      owner: target.commit.owner,
      repo: target.commit.repo,
      number: pseudoRefNumber(`commit:${target.commit.sha}`),
    }
  }
  return {
    owner: target.compare.owner,
    repo: target.compare.repo,
    number: pseudoRefNumber(`compare:${target.compare.base}...${target.compare.head}`),
  }
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
  // An EMPTY bearer is worse than no header: GitHub answers it with a
  // misleading 401 "Bad credentials" instead of "Requires authentication".
  // No token = unauthenticated request (works for public PRs, 60 req/h).
  if (token === '') return { Accept: 'application/vnd.github+json' }
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
  let msg = `GitHub API request failed (${res.status}) for ${url}${detail === '' ? '' : `: ${detail}`}`
  if (res.status === 401) {
    // Distinguish "no token sent" from "token sent but rejected" so the
    // user gets an actionable message instead of a bare "Bad credentials".
    msg =
      token === ''
        ? `GitHub requires a token for this request (${url}). Public repos also work without one — if this repo is private, add a PAT in Settings.`
        : `GitHub rejected the saved token (401, ${detail || 'Bad credentials'}). Re-check it and re-save in Settings — a token saved under one unlock method (PIN vs biometrics) cannot be read after unlocking with another.`
  }
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
  changed_files?: number
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
    // Raw count before generated-file filtering, for the big-PR honesty note.
    ...(pr.changed_files !== undefined ? { rawChangedFiles: pr.changed_files } : {}),
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

// ---------- File / commit / compare ingestion ----------

interface GhCommitDetail {
  sha?: string
  commit?: { message?: string }
  author?: GhUser
  stats?: { additions?: number; deletions?: number }
  files?: GhFile[]
}

interface GhCompare {
  merge_base_commit?: { sha?: string }
  commits?: Array<{ sha?: string; author?: GhUser }>
  files?: GhFile[]
}

/**
 * Fetch the content of a single file addressed by a GitFileTarget (blob /
 * raw / raw.githubusercontent URL). Tries the public raw URL first; on a
 * 404/401 with a token saved, falls back to the API contents endpoint
 * (Accept: application/vnd.github.raw), which also serves private repos.
 * The token is optional everywhere — empty means unauthenticated.
 *
 * The content is exposed twice, by design, so the transcript pipeline can
 * batch it like a patch: body = 'File content:\n' + content, and
 * files[0].patch = the raw content itself (additions/deletions are 0 —
 * there is no diff).
 */
export async function fetchFileContent(t: GitFileTarget, token: string): Promise<PullRequestData> {
  const rawUrl = `https://raw.githubusercontent.com/${t.owner}/${t.repo}/${t.ref}/${t.path}`
  const headers: Record<string, string> = {}
  if (token !== '') headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(rawUrl, { headers })
  } catch (err) {
    throw sanitizeError(err, token)
  }
  let content: string | null = null
  if (res.ok) {
    content = await res.text()
  } else if (res.status !== 404 && res.status !== 401) {
    throw await httpError(res, rawUrl, token)
  } else if (token === '') {
    throw await httpError(res, rawUrl, token)
  } else {
    const apiUrl = `${API_BASE}/repos/${t.owner}/${t.repo}/contents/${t.path}?ref=${encodeURIComponent(t.ref)}`
    let ares: Response
    try {
      ares = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' },
      })
    } catch (err) {
      throw sanitizeError(err, token)
    }
    if (!ares.ok) throw await httpError(ares, apiUrl, token)
    content = await ares.text()
  }

  const body = `File content:\n${content}`
  const basename = t.path.split('/').pop() ?? t.path
  return {
    // Pseudo ref unique to this repo+ref+path: resume positions and listen
    // history are keyed by the ref, so two different files must not share one.
    ref: filePseudoRef(t),
    title: basename,
    body,
    author: t.owner,
    additions: 0,
    deletions: 0,
    changedFiles: 1,
    files: [{ filename: t.path, status: 'added', additions: 0, deletions: 0, patch: content }],
    comments: [],
    reviews: [],
    imageUrls: extractImageUrls(body),
    mermaidBlocks: extractMermaidBlocks(body),
  }
}

/**
 * Fetch a single commit's files and map them into PullRequestData:
 * title = first line of the commit message, author = commit author login,
 * headSha = commit sha, files filtered like PR files. Token optional.
 */
export async function fetchCommit(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<PullRequestData> {
  const { data } = await ghFetchJson<GhCommitDetail>(
    `${API_BASE}/repos/${owner}/${repo}/commits/${sha}`,
    token,
  )
  const { kept } = filterGeneratedFiles((data.files ?? []).map(mapFile))
  const message = data.commit?.message ?? ''
  return {
    // Pseudo ref unique to this commit: resume positions and listen history
    // are keyed by the ref, so two commits must not share one.
    ref: { owner, repo, number: pseudoRefNumber(`commit:${sha}`) },
    title: message.split('\n')[0] ?? '',
    body: message,
    author: data.author?.login ?? 'unknown',
    additions: data.stats?.additions ?? 0,
    deletions: data.stats?.deletions ?? 0,
    headSha: data.sha ?? sha,
    changedFiles: kept.length,
    files: kept,
    comments: [],
    reviews: [],
    imageUrls: extractImageUrls(message),
    mermaidBlocks: extractMermaidBlocks(message),
  }
}

/**
 * Fetch a compare (base...head) and map it into PullRequestData:
 * title = '{base}...{head}', files with patches filtered like PR files,
 * additions/deletions summed from the kept files. headSha combines the
 * merge-base sha with the head commit sha: the merge base alone is shared
 * by every compare into the same base, so keying the transcript cache on
 * it would collide two different ranges; combining both sides makes the
 * key unique to the range and refresh it when either side moves. Token
 * optional.
 */
export async function fetchCompare(
  owner: string,
  repo: string,
  base: string,
  head: string,
  token: string,
): Promise<PullRequestData> {
  const { data } = await ghFetchJson<GhCompare>(
    `${API_BASE}/repos/${owner}/${repo}/compare/${base}...${head}`,
    token,
  )
  const { kept } = filterGeneratedFiles((data.files ?? []).map(mapFile))
  const commits = data.commits ?? []
  const last = commits.length > 0 ? commits[commits.length - 1] : undefined
  const lastAuthor = last?.author?.login
  const additions = kept.reduce((n, f) => n + f.additions, 0)
  const deletions = kept.reduce((n, f) => n + f.deletions, 0)
  const body = `Comparing ${base}...${head} (${commits.length} commits)`
  return {
    // Pseudo ref unique to this base...head range: resume positions and
    // listen history are keyed by the ref, so two ranges must not share one.
    ref: { owner, repo, number: pseudoRefNumber(`compare:${base}...${head}`) },
    title: `${base}...${head}`,
    body,
    author: lastAuthor ?? 'unknown',
    additions,
    deletions,
    headSha: `${data.merge_base_commit?.sha ?? base}..${last?.sha ?? head}`,
    changedFiles: kept.length,
    files: kept,
    comments: [],
    reviews: [],
    imageUrls: extractImageUrls(body),
    mermaidBlocks: extractMermaidBlocks(body),
  }
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
