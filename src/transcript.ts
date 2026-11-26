// Transcript pipeline (DVC section 2): turn PR data into a speakable transcript.
import { chat } from './llm'
import type {
  LlmConfig,
  LlmMessage,
  PrFile,
  PullRequestData,
  Transcript,
  TranscriptSection,
  TranscriptStream,
} from './types'

export interface BuildTranscriptOptions {
  /** Resolved data URLs mapping index-wise to pr.imageUrls. */
  imageDataUrls?: string[]
}

// ---------------------------------------------------------------------------
// Pure text sanitization
// ---------------------------------------------------------------------------

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi

/** Raw URL -> readable anchor text: the domain when parseable, else 'link'. */
function urlAnchor(match: string): string {
  let url = match
  let tail = ''
  const peeled = /[.,;:!?)]+$/.exec(url)
  if (peeled) {
    tail = peeled[0]
    url = url.slice(0, url.length - tail.length)
  }
  try {
    const parsed = new URL(url.startsWith('www.') ? `https://${url}` : url)
    const host = parsed.hostname.replace(/^www\./, '')
    return (host || 'link') + tail
  } catch {
    return 'link' + tail
  }
}

/**
 * Pure: make one line of text speakable.
 * - markdown links/images -> visible text only
 * - raw URLs -> domain (or 'link')
 * - diff hunk markers, diff +/- line prefixes, commit SHAs -> removed
 * - unpronounceable symbol runs (>=3 punctuation chars) -> collapsed
 * - markdown emphasis, backticks, headers, blockquotes -> stripped
 * Never returns an empty string.
 */
export function sanitizeLine(text: string): string {
  let out = text
  // Markdown images and links: keep the visible text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Raw URLs.
  out = out.replace(URL_RE, urlAnchor)
  // Diff hunk markers.
  out = out.replace(/@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/g, ' ')
  // Commit SHAs: 7-40 word-bounded hex chars that look like a hash
  // (contain a digit, or are long pure-hex). Ordinary hex-letter words
  // like 'feedback' or 'defaced' survive.
  out = out.replace(/\b[0-9a-fA-F]{7,40}\b/g, (m) =>
    /\d/.test(m) || m.length >= 12 ? 'commit' : m,
  )
  // Diff +/- prefixes at line start (also +++/--- file markers).
  out = out.replace(/^[+-]+/gm, '')
  // Markdown: headers, blockquotes, emphasis runs, backticks, list bullets.
  // Runs before symbol-chain collapse so '**bold**:' keeps its colon.
  out = out.replace(/^#{1,6}[ \t]*/gm, '')
  out = out.replace(/^>[ \t]?/gm, '')
  out = out.replace(/[*_]{2,}/g, '')
  out = out.replace(/\*/g, '')
  out = out.replace(/`/g, '')
  // Unpronounceable symbol chains: >=3 punctuation chars in a row.
  out = out.replace(/[!@#$%^&*()_+{}[\]|\\:;<>,.?/=-]{3,}/g, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  return out || '[unpronounceable content]'
}

// ---------------------------------------------------------------------------
// Pure sentence splitting
// ---------------------------------------------------------------------------

const MAX_SENTENCE_LENGTH = 250

const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'St', 'Mt',
  'vs', 'etc', 'e.g', 'i.e', 'Fig', 'Figs', 'Inc', 'Ltd', 'Co', 'Corp',
  'approx', 'Vol',
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ABBREV_RE = new RegExp(`(?:${ABBREVIATIONS.map(escapeRe).join('|')})$`, 'i')

/** Split an over-long sentence at comma/semicolon/space boundaries into <=250-char chunks. */
function chunkLong(sentence: string): string[] {
  if (sentence.length <= MAX_SENTENCE_LENGTH) return [sentence]
  const chunks: string[] = []
  let rest = sentence
  while (rest.length > MAX_SENTENCE_LENGTH) {
    const window = rest.slice(0, MAX_SENTENCE_LENGTH)
    let cut = -1
    for (let i = window.length - 1; i >= 0; i--) {
      const ch = window[i]
      if (ch === ',' || ch === ';') {
        cut = i
        break
      }
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ')
      if (space > 0) cut = space
    }
    if (cut < 0) cut = window.length - 1
    chunks.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1)
  }
  const tail = rest.trim()
  if (tail) chunks.push(tail)
  return chunks.filter((c) => c.length > 0)
}

/**
 * Pure: split text into speakable sentences.
 * Splits on . ! ? followed by whitespace/end, respecting decimals (3.5)
 * and common abbreviations (Mr., Dr., e.g.). Sentences longer than 250
 * characters are chunked at comma/semicolon/space boundaries (iOS utterance limit).
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const sentences: string[] = []
  let start = 0
  const re = /([.!?])\s/g
  let m: RegExpExecArray | null
  while ((m = re.exec(normalized)) !== null) {
    const punctIndex = m.index
    const before = normalized.slice(Math.max(0, punctIndex - 8), punctIndex)
    if (ABBREV_RE.test(before)) continue
    const sentence = normalized.slice(start, punctIndex + 1).trim()
    if (sentence) sentences.push(sentence)
    start = punctIndex + m[0].length
  }
  const tail = normalized.slice(start).trim()
  if (tail) sentences.push(tail)
  return sentences.flatMap((s) => chunkLong(s))
}

// ---------------------------------------------------------------------------
// Transcript build
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are a senior software engineer explaining a pull request aloud to a colleague who is listening, not reading.',
  'Respond with STRICT JSON only: no markdown fences, no prose outside the JSON.',
  'JSON shape: {"title": string, "sections": [{"id": string, "title": string, "sentences": string[]}]}.',
  'Use these section ids, in this exact order: "overview", "architecture", "changes", "review-notes".',
  'overview: what this pull request does and why, in plain language.',
  'architecture: how the change fits the system; describe every mermaid diagram and attached image in plain English, covering what the nodes or components are and how they connect.',
  'changes: walk through the code changes by intent and logic flow; never quote code verbatim.',
  'review-notes: weave the reviewer comments and review feedback into a coherent narrative.',
  'Omit the review-notes section entirely when there is no review feedback.',
  'Every sentence must be self-contained and natural when read aloud by text-to-speech.',
].join('\n')

const SECTION_ORDER = ['overview', 'architecture', 'changes', 'review-notes']

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`
}

function buildUserPrompt(pr: PullRequestData, imageCount: number): string {
  const lines: string[] = []
  lines.push(`Pull request: ${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`)
  lines.push(`Title: ${pr.title}`)
  lines.push(`Author: ${pr.author}`)
  lines.push(
    `Size: ${pr.changedFiles} files changed, ${pr.additions} additions, ${pr.deletions} deletions.`,
  )
  lines.push('', '## Description', truncate(pr.body || '(no description)', 6000))
  lines.push('', '## Changed files')
  for (const f of pr.files.slice(0, 40)) {
    lines.push(`- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    if (f.patch) lines.push(truncate(f.patch, 1200))
  }
  if (pr.mermaidBlocks.length > 0) {
    lines.push(
      '',
      '## Mermaid diagrams (describe each in plain English: nodes, edges, overall structure)',
    )
    pr.mermaidBlocks.forEach((block, i) => {
      lines.push(`Diagram ${i + 1}:`, truncate(block, 2000))
    })
  }
  if (pr.comments.length > 0 || pr.reviews.length > 0) {
    lines.push('', '## Review comments and reviews (weave into review notes)')
    for (const c of pr.comments) lines.push(`- ${c.author}: ${truncate(c.body, 800)}`)
    for (const r of pr.reviews) lines.push(`- ${r.author} (${r.state}): ${truncate(r.body, 800)}`)
  }
  if (imageCount > 0) {
    lines.push('', `${imageCount} image(s) from the pull request are attached to this message.`)
  }
  return lines.join('\n')
}

/** Tolerant JSON extraction: direct parse, markdown-fenced, or outermost braces. */
function extractJsonObject(raw: string): unknown {
  let text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fenced && fenced[1]) text = fenced[1].trim()
  try {
    return JSON.parse(text)
  } catch {
    // fall through
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1))
    } catch {
      // fall through
    }
  }
  return undefined
}

interface RawTranscript {
  title: string
  sections: Array<{ id: string; title: string; sentences: string[] }>
}

function isValidTranscriptShape(v: unknown): v is RawTranscript {
  if (typeof v !== 'object' || v === null) return false
  const t = v as { title?: unknown; sections?: unknown }
  if (typeof t.title !== 'string' || t.title.trim() === '') return false
  if (!Array.isArray(t.sections) || t.sections.length === 0) return false
  return t.sections.every((s) => {
    if (typeof s !== 'object' || s === null) return false
    const sec = s as { id?: unknown; title?: unknown; sentences?: unknown }
    return (
      typeof sec.id === 'string' &&
      sec.id.trim() !== '' &&
      typeof sec.title === 'string' &&
      Array.isArray(sec.sentences) &&
      sec.sentences.every((x) => typeof x === 'string')
    )
  })
}

/** Enforce canonical section order; unknown ids keep their relative order after known ones. */
function orderSections(sections: TranscriptSection[]): TranscriptSection[] {
  const rank = new Map(SECTION_ORDER.map((id, i) => [id, i] as const))
  return [...sections].sort((a, b) => {
    const ra = rank.get(a.id) ?? SECTION_ORDER.length
    const rb = rank.get(b.id) ?? SECTION_ORDER.length
    return ra === rb ? 0 : ra - rb
  })
}

function materializeTranscript(raw: string, pr: PullRequestData): Transcript {
  const parsed = extractJsonObject(raw)
  if (isValidTranscriptShape(parsed)) {
    const sections = parsed.sections
      .map((s): TranscriptSection | null => {
        const sentences = s.sentences
          .flatMap((sentence) => splitSentences(sanitizeLine(sentence)))
          .filter((sentence) => sentence.length > 0)
        const title = sanitizeLine(s.title)
        if (!title || sentences.length === 0) return null
        return { id: s.id, title, sentences }
      })
      .filter((s): s is TranscriptSection => s !== null)
    if (sections.length > 0) {
      return {
        title: sanitizeLine(parsed.title) || sanitizeLine(pr.title),
        sections: orderSections(sections),
      }
    }
  }
  // Fallback: treat the raw reply as narrated text.
  const sentences = splitSentences(sanitizeLine(raw)).filter((s) => s.length > 0)
  return {
    title: sanitizeLine(pr.title),
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        sentences: sentences.length > 0 ? sentences : ['[unpronounceable content]'],
      },
    ],
  }
}

/**
 * Build a speakable transcript for a PR via the LLM.
 * Images: opts.imageDataUrls map index-wise to pr.imageUrls (caller pre-resolves).
 */
export async function buildTranscript(
  config: LlmConfig,
  pr: PullRequestData,
  opts: BuildTranscriptOptions = {},
): Promise<Transcript> {
  const imageDataUrls = opts.imageDataUrls ?? []
  const images: string[] = []
  for (let i = 0; i < pr.imageUrls.length; i++) {
    const dataUrl = imageDataUrls[i]
    if (typeof dataUrl === 'string' && dataUrl.length > 0) images.push(dataUrl)
  }
  const messages: LlmMessage[] = [
    { role: 'system', text: SYSTEM_PROMPT },
    {
      role: 'user',
      text: buildUserPrompt(pr, images.length),
      images: images.length > 0 ? images : undefined,
    },
  ]
  const raw = await chat(config, messages)
  return materializeTranscript(raw, pr)
}

// ---------------------------------------------------------------------------
// Streaming transcript
// ---------------------------------------------------------------------------

export interface TranscriptStreamOptions {
  /** Resolved data URLs mapping index-wise to pr.imageUrls. */
  imageDataUrls?: string[]
  /** Injectable chat fn (tests). Defaults to the real LLM client. */
  chat?: typeof chat
}

/** TranscriptStream plus the next() cursor callers drive directly. */
export interface TranscriptStreamHandle extends TranscriptStream {
  /** Await + return the next section, or null once done/aborted. */
  next(): Promise<TranscriptSection | null>
}

type SectionSpec =
  | { kind: 'overview' }
  | { kind: 'architecture' }
  | { kind: 'changes'; batch: number; files: PrFile[] }
  | { kind: 'review-notes' }

interface Generated {
  section: TranscriptSection
  /** Short recap carried into later calls' prompts (rolling context). */
  summary: string
}

const BIG_PATCH_CHARS = 4000
const FILES_PER_BATCH = 10

/**
 * Split files into LLM batches: small files coalesce up to FILES_PER_BATCH;
 * a file whose patch exceeds BIG_PATCH_CHARS gets a batch of its own.
 */
function batchFiles(files: PrFile[]): PrFile[][] {
  const batches: PrFile[][] = []
  let current: PrFile[] = []
  const flush = (): void => {
    if (current.length > 0) {
      batches.push(current)
      current = []
    }
  }
  for (const f of files) {
    if ((f.patch?.length ?? 0) > BIG_PATCH_CHARS) {
      flush()
      batches.push([f])
    } else {
      current.push(f)
      if (current.length >= FILES_PER_BATCH) flush()
    }
  }
  flush()
  return batches
}

function sectionId(spec: SectionSpec): string {
  switch (spec.kind) {
    case 'overview':
      return 'overview'
    case 'architecture':
      return 'architecture'
    case 'changes':
      return `changes-${spec.batch}`
    case 'review-notes':
      return 'review-notes'
  }
}

function sectionTitle(spec: SectionSpec): string {
  switch (spec.kind) {
    case 'overview':
      return 'Overview'
    case 'architecture':
      return 'Architecture and Diagrams'
    case 'changes':
      return `Key Changes (${spec.batch})`
    case 'review-notes':
      return 'Review Notes'
  }
}

const STREAM_SYSTEM_BASE = [
  'You are a senior software engineer explaining a pull request aloud to a colleague who is listening, not reading.',
  'Respond with STRICT JSON only: no markdown fences, no prose outside the JSON.',
  'JSON shape: {"title": string, "sentences": string[], "summary": string}.',
  'title: a short heading for this section.',
  'sentences: the spoken content of this section; never quote code verbatim.',
  'summary: a recap of this section in two to three sentences, used as context for later sections.',
  'Every sentence must be self-contained and natural when read aloud by text-to-speech.',
].join('\n')

const STREAM_SECTION_INSTRUCTIONS: Record<SectionSpec['kind'], string> = {
  overview:
    'This section is the overview: what this pull request does and why, in plain language.',
  architecture:
    'This section covers architecture and diagrams: describe every mermaid diagram and attached image in plain English, covering what the nodes or components are and how they connect.',
  changes:
    'This section covers one batch of code changes: walk through these files by intent and logic flow.',
  'review-notes':
    'This section covers review feedback: weave the reviewer comments and reviews into a coherent narrative.',
}

function prHeader(pr: PullRequestData): string {
  return [
    `Pull request: ${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`,
    `Title: ${pr.title}`,
    `Author: ${pr.author}`,
    `Size: ${pr.changedFiles} files changed, ${pr.additions} additions, ${pr.deletions} deletions.`,
  ].join('\n')
}

function contextBlock(summaries: string[]): string {
  if (summaries.length === 0) return ''
  return [
    '',
    '## Context so far (summaries of earlier sections; do not repeat their content)',
    ...summaries.map((s) => `- ${s}`),
  ].join('\n')
}

function overviewUserPrompt(pr: PullRequestData): string {
  const lines: string[] = [
    prHeader(pr),
    '',
    '## Description',
    truncate(pr.body || '(no description)', 6000),
  ]
  if (pr.comments.length > 0) {
    lines.push('', '## Comments')
    for (const c of pr.comments) lines.push(`- ${c.author}: ${truncate(c.body, 800)}`)
  }
  return lines.join('\n')
}

function architectureUserPrompt(
  pr: PullRequestData,
  attachedImages: number,
  context: string,
): string {
  const lines: string[] = [prHeader(pr), context]
  if (pr.mermaidBlocks.length > 0) {
    lines.push(
      '',
      '## Mermaid diagrams (describe each in plain English: nodes, edges, overall structure)',
    )
    pr.mermaidBlocks.forEach((block, i) => {
      lines.push(`Diagram ${i + 1}:`, truncate(block, 2000))
    })
  }
  if (attachedImages > 0) {
    lines.push('', `${attachedImages} image(s) from the pull request are attached to this message.`)
  } else if (pr.imageUrls.length > 0) {
    lines.push('', `${pr.imageUrls.length} image(s) were referenced but could not be loaded.`)
  }
  return lines.join('\n')
}

function changesUserPrompt(
  pr: PullRequestData,
  spec: Extract<SectionSpec, { kind: 'changes' }>,
  totalBatches: number,
  context: string,
): string {
  const lines: string[] = [
    prHeader(pr),
    context,
    '',
    `## Files in this batch (batch ${spec.batch} of ${totalBatches})`,
  ]
  for (const f of spec.files) {
    lines.push(`- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    if (f.patch) lines.push(truncate(f.patch, 1200))
  }
  return lines.join('\n')
}

function reviewUserPrompt(pr: PullRequestData, context: string): string {
  const lines: string[] = [
    prHeader(pr),
    context,
    '',
    '## Review comments and reviews (weave into review notes)',
  ]
  for (const c of pr.comments) lines.push(`- ${c.author}: ${truncate(c.body, 800)}`)
  for (const r of pr.reviews) lines.push(`- ${r.author} (${r.state}): ${truncate(r.body, 800)}`)
  return lines.join('\n')
}

interface RawStreamSection {
  title: string
  sentences: string[]
  summary?: string
}

function isValidStreamSection(v: unknown): v is RawStreamSection {
  if (typeof v !== 'object' || v === null) return false
  const s = v as { title?: unknown; sentences?: unknown }
  return (
    typeof s.title === 'string' &&
    s.title.trim() !== '' &&
    Array.isArray(s.sentences) &&
    s.sentences.every((x) => typeof x === 'string')
  )
}

function deriveSummary(sentences: string[]): string {
  return truncate(sentences.slice(0, 2).join(' '), 300)
}

/**
 * Lazily-generated transcript: one LLM call per section, in order, each call
 * carrying only short summaries of the sections before it. Sections:
 * overview; architecture (only with images/mermaid); Key Changes batches
 * (changes-1, changes-2, ...); review notes (only with feedback).
 * A failed section call emits a spoken fallback instead of killing the stream.
 */
export function createTranscriptStream(
  config: LlmConfig,
  pr: PullRequestData,
  opts: TranscriptStreamOptions = {},
): TranscriptStreamHandle {
  const chatFn = opts.chat ?? chat
  const imageDataUrls = opts.imageDataUrls ?? []
  const images: string[] = []
  for (let i = 0; i < pr.imageUrls.length; i++) {
    const dataUrl = imageDataUrls[i]
    if (typeof dataUrl === 'string' && dataUrl.length > 0) images.push(dataUrl)
  }

  const batches = batchFiles(pr.files)
  const plan: SectionSpec[] = [{ kind: 'overview' }]
  if (pr.imageUrls.length > 0 || pr.mermaidBlocks.length > 0) {
    plan.push({ kind: 'architecture' })
  }
  batches.forEach((files, i) => plan.push({ kind: 'changes', batch: i + 1, files }))
  if (pr.comments.length > 0 || pr.reviews.length > 0) {
    plan.push({ kind: 'review-notes' })
  }

  const ABORT = new Error('transcript stream aborted')
  const controller = new AbortController()
  let rejectAbort: ((reason: Error) => void) | null = null
  const abortSignal = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  // The rejection is always observed via Promise.race; silence it so an
  // unused abort never surfaces as an unhandled rejection.
  abortSignal.catch(() => {})

  let aborted = false
  let cursor = 0
  let inFlight: Promise<Generated> | null = null
  let pendingNext: Promise<TranscriptSection | null> | null = null
  const summaries: string[] = []

  function buildMessages(spec: SectionSpec): LlmMessage[] {
    const context = contextBlock(summaries)
    let user: string
    switch (spec.kind) {
      case 'overview':
        user = overviewUserPrompt(pr)
        break
      case 'architecture':
        user = architectureUserPrompt(pr, images.length, context)
        break
      case 'changes':
        user = changesUserPrompt(pr, spec, batches.length, context)
        break
      case 'review-notes':
        user = reviewUserPrompt(pr, context)
        break
    }
    return [
      {
        role: 'system',
        text: `${STREAM_SYSTEM_BASE}\n${STREAM_SECTION_INSTRUCTIONS[spec.kind]}`,
      },
      {
        role: 'user',
        text: user,
        images: spec.kind === 'architecture' && images.length > 0 ? images : undefined,
      },
    ]
  }

  function fallbackGenerated(spec: SectionSpec): Generated {
    return {
      section: {
        id: sectionId(spec),
        title: sectionTitle(spec),
        sentences: ['Could not summarize this part.'],
      },
      summary: 'This part could not be summarized.',
    }
  }

  async function generateSection(spec: SectionSpec): Promise<Generated> {
    const id = sectionId(spec)
    let raw: string | null = null
    try {
      raw = await Promise.race([
        chatFn(config, buildMessages(spec), { signal: controller.signal }),
        abortSignal,
      ])
    } catch {
      if (aborted) throw ABORT
      raw = null
    }
    if (raw !== null) {
      const parsed = extractJsonObject(raw)
      if (parsed !== undefined && isValidStreamSection(parsed)) {
        const sentences = parsed.sentences
          .flatMap((sentence) => splitSentences(sanitizeLine(sentence)))
          .filter((sentence) => sentence.length > 0)
        const title = sanitizeLine(parsed.title)
        if (title && sentences.length > 0) {
          const summary =
            typeof parsed.summary === 'string' && parsed.summary.trim() !== ''
              ? truncate(parsed.summary.trim(), 400)
              : deriveSummary(sentences)
          return { section: { id, title, sentences }, summary }
        }
      } else if (parsed === undefined) {
        // No JSON at all: narrate the raw reply, like buildTranscript.
        const sentences = splitSentences(sanitizeLine(raw)).filter((s) => s.length > 0)
        if (sentences.length > 0) {
          return {
            section: { id, title: sectionTitle(spec), sentences },
            summary: deriveSummary(sentences),
          }
        }
      }
    }
    return fallbackGenerated(spec)
  }

  async function doNext(): Promise<TranscriptSection | null> {
    if (aborted || cursor >= plan.length) return null
    const spec = plan[cursor]!
    if (inFlight === null) inFlight = generateSection(spec)
    let generated: Generated
    try {
      generated = await inFlight
    } catch {
      // Only the abort sentinel rejects; a failed call became a fallback.
      inFlight = null
      return null
    }
    inFlight = null
    cursor++
    summaries.push(`${generated.section.title}: ${generated.summary}`)
    return generated.section
  }

  function next(): Promise<TranscriptSection | null> {
    // Concurrent next() calls queue up instead of duplicating a section.
    if (pendingNext !== null) return pendingNext
    pendingNext = doNext().finally(() => {
      pendingNext = null
    })
    return pendingNext
  }

  const stream: TranscriptStreamHandle = {
    next,

    prefetch(): void {
      if (aborted || cursor >= plan.length || inFlight !== null || pendingNext !== null) return
      inFlight = generateSection(plan[cursor]!)
      // abort() rejects this via the sentinel; without a handler a consumer
      // that prefetches and aborts before next() hits an unhandled rejection.
      // The catch only marks it handled: doNext's await still sees the abort.
      inFlight.catch(() => {})
    },

    done(): boolean {
      return aborted || cursor >= plan.length
    },

    abort(): void {
      if (aborted) return
      aborted = true
      controller.abort()
      rejectAbort?.(ABORT)
    },

    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<TranscriptSection>> => {
          const value = await next()
          return value === null ? { done: true, value: undefined } : { done: false, value }
        },
      }
    },
  }
  return stream
}
