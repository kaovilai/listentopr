// Paste-mode ingestion: pasted PR text instead of a GitHub URL.
// Parses raw pasted text containing prose plus unified/svn diff blocks
// into a PullRequestData so the rest of the pipeline (transcript, cache,
// TTS) treats it exactly like a fetched PR.

import type { PrFile, PullRequestData } from './types'
import {
  extractImageUrls,
  extractMermaidBlocks,
  filterGeneratedFiles,
  pseudoRefNumber,
} from './github'

/** Pastes shorter than this are never a PR worth reading aloud. */
const MIN_PASTE_LEN = 80

// ---------- Content hash ----------

function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Deterministic sha256-ish content hash of the pasted text (four FNV-1a
 * 32-bit passes over the same input with different offset bases,
 * concatenated as 32 lowercase hex chars). Used as `headSha` so the store's
 * cache/delta machinery keys pasted content like a real PR head SHA.
 */
export function contentHash(text: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x41c64357]
  return seeds.map((s) => fnv1a(text, s).toString(16).padStart(8, '0')).join('')
}

// ---------- Diff block scanning ----------

// git quotes diff paths that contain spaces or special characters
// ('diff --git "a/a b.txt" "b/a b.txt"', '--- "a/a b.txt"'), so every path
// regex has a quoted and an unquoted branch; quotes are stripped by the
// branch capture itself.
const DIFF_GIT_RE = /^diff --git (?:"a\/([^"]+)"|a\/(\S+)) (?:"b\/([^"]+)"|b\/(\S+))(?:$|\s)/
const SVN_INDEX_RE = /^Index: (.+)$/
const FROM_A_RE = /^--- (?:"a\/([^"]+)"|a\/(.+))$/
const TO_B_RE = /^\+\+\+ (?:"b\/([^"]+)"|b\/(.+))$/
const TO_DEV_NULL_RE = /^\+\+\+ \/dev\/null$/
const NEW_FILE_RE = /^new file mode/
const DELETED_FILE_RE = /^deleted file mode/
const HUNK_RE = /^@@/

interface DiffBlock {
  /** Index of the first line of the block (its file header). */
  start: number
  /** Exclusive end index (first line of the next block, or lines.length). */
  end: number
  filename: string
  status: string
}

interface OpenBlock {
  start: number
  fromA: string | null
  toB: string | null
  gitA: string | null
  gitB: string | null
  svn: string | null
  toDevNull: boolean
  status: string
  /** True once the block's first @@ hunk marker was seen; header-ish
   * lines after it are hunk content, not headers. */
  seenHunk: boolean
}

function closeBlock(blocks: DiffBlock[], open: OpenBlock | null, end: number): void {
  if (open === null) return
  let filename: string | null = null
  if (!open.toDevNull && open.toB !== null) filename = open.toB
  else if (open.fromA !== null) filename = open.fromA
  else if (open.gitA !== null) filename = open.gitA
  else if (open.gitB !== null) filename = open.gitB
  else if (open.svn !== null) filename = open.svn
  blocks.push({
    start: open.start,
    end,
    filename: filename ?? `pasted-${blocks.length}.txt`,
    status: open.status,
  })
}

/**
 * Scan pasted lines for unified-diff / svn file blocks. A block starts at
 * 'diff --git ', 'Index: ', or a '--- a/x' line immediately followed by a
 * '+++ ' line, and runs to the next block header. Filenames resolve from
 * '+++ b/path' first, then '--- a/path' (deletions, where +++ is
 * /dev/null), then the 'diff --git' paths, then the svn 'Index:' value.
 */
function findDiffBlocks(lines: string[]): DiffBlock[] {
  const blocks: DiffBlock[] = []
  let open: OpenBlock | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const next = lines[i + 1] ?? ''
    const diffGit = DIFF_GIT_RE.exec(line)
    const svnIndex = SVN_INDEX_RE.exec(line)
    const fromA = FROM_A_RE.exec(line)
    // '--- a/x' opens a block only when paired with a following '+++ '
    // line, so hunk deletions like '---- a/x' never split a block. A
    // '--- a/' line directly after a 'diff --git' header continues that
    // same block instead of starting a new one.
    const pairedFrom = fromA !== null && /^\+\+\+ /.test(next)
    // Still in the current block's header region (no hunk seen, no +++ yet,
    // metadata lines like 'index ...' may sit between the headers), so a
    // paired '--- a/' continues this block instead of splitting it.
    const inHeaderRegion =
      open !== null && !open.seenHunk && open.toB === null && !open.toDevNull
    if (diffGit !== null || svnIndex !== null || (pairedFrom && !inHeaderRegion)) {
      closeBlock(blocks, open, i)
      open = {
        start: i,
        fromA: null,
        toB: null,
        gitA: diffGit?.[1] ?? diffGit?.[2] ?? null,
        gitB: diffGit?.[3] ?? diffGit?.[4] ?? null,
        svn: svnIndex?.[1]?.trim() ?? null,
        toDevNull: false,
        status: 'modified',
        seenHunk: false,
      }
      if (fromA !== null) open.fromA = fromA[1] ?? fromA[2] ?? null
      continue
    }
    if (open !== null && !open.seenHunk) {
      if (HUNK_RE.test(line)) {
        open.seenHunk = true
      } else {
        const toB = TO_B_RE.exec(line)
        const fromACont = FROM_A_RE.exec(line)
        if (toB !== null) open.toB = toB[1] ?? toB[2] ?? null
        else if (fromACont !== null && open.fromA === null) open.fromA = fromACont[1] ?? fromACont[2] ?? null
        else if (TO_DEV_NULL_RE.test(line)) open.toDevNull = true
        else if (NEW_FILE_RE.test(line)) open.status = 'added'
        else if (DELETED_FILE_RE.test(line)) open.status = 'deleted'
      }
    }
  }
  closeBlock(blocks, open, lines.length)
  return blocks
}

/** Build the PrFile for one diff block: patch from the @@ marker (or the
 * block's first line when there is none) to the next file header, with
 * additions/deletions counted from +/- hunk lines. */
function blockToFile(lines: string[], block: DiffBlock): PrFile {
  let patchStart = block.start
  for (let i = block.start; i < block.end; i++) {
    if (HUNK_RE.test(lines[i] ?? '')) {
      patchStart = i
      break
    }
  }
  const patchLines = lines.slice(patchStart, block.end)
  let additions = 0
  let deletions = 0
  for (const l of patchLines) {
    if (l.startsWith('+') && !l.startsWith('+++')) additions += 1
    else if (l.startsWith('-') && !l.startsWith('---')) deletions += 1
  }
  return {
    filename: block.filename,
    status: block.status,
    additions,
    deletions,
    patch: patchLines.join('\n'),
  }
}

// ---------- Paste parsing ----------

const HEADING_RE = /^#{1,6}\s+/

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Parse pasted PR text into PullRequestData. Returns null when the text is
 * too short (< 80 chars) or has no recognizable structure (no diff blocks,
 * no markdown heading, and fewer than 3 non-empty lines).
 *
 * - title: first markdown heading, else the first non-empty line (100 chars max)
 * - files: one PrFile per unified/svn diff block, generated files filtered,
 *   patch = hunk lines from the @@ marker to the next file header
 * - body: all prose outside diff blocks
 * - imageUrls / mermaidBlocks: extracted from the prose
 * - ref is {owner:'pasted', repo:'content', number:pseudoRefNumber(hash)} —
 *   a number unique to the pasted content, so resume positions and listen
 *   history never bleed between two different pastes; headSha is
 *   contentHash(text) so the store cache keys pasted content
 */
export function parsePastedContent(text: string): PullRequestData | null {
  if (text.trim().length < MIN_PASTE_LEN) return null

  const lines = text.split('\n')
  const blocks = findDiffBlocks(lines)

  const nonEmptyCount = lines.filter((l) => l.trim() !== '').length
  const hasHeading = lines.some((l) => HEADING_RE.test(l))
  if (blocks.length === 0 && !hasHeading && nonEmptyCount < 3) return null

  // Prose = every line outside a diff block, boundary blank lines dropped.
  const inBlock = new Set<number>()
  for (const b of blocks) {
    for (let i = b.start; i < b.end; i++) inBlock.add(i)
  }
  const proseLines = lines.filter((_, i) => !inBlock.has(i))
  const body = proseLines.join('\n').replace(/^\s+|\s+$/g, '')

  // Title: first markdown heading line, else first non-empty line.
  let title = ''
  for (const l of lines) {
    if (HEADING_RE.test(l)) {
      title = l.replace(HEADING_RE, '').trim()
      break
    }
  }
  if (title === '') {
    const first = lines.find((l) => l.trim() !== '') ?? ''
    title = first.trim()
  }
  title = truncate(title, 100)

  const files = blocks.map((b) => blockToFile(lines, b))
  const { kept } = filterGeneratedFiles(files)
  const additions = kept.reduce((n, f) => n + f.additions, 0)
  const deletions = kept.reduce((n, f) => n + f.deletions, 0)

  const hash = contentHash(text)
  return {
    ref: { owner: 'pasted', repo: 'content', number: pseudoRefNumber(`paste:${hash}`) },
    title,
    body,
    author: 'pasted',
    headSha: hash,
    additions,
    deletions,
    changedFiles: kept.length,
    files: kept,
    comments: [],
    reviews: [],
    imageUrls: extractImageUrls(body),
    mermaidBlocks: extractMermaidBlocks(body),
  }
}
