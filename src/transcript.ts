// Transcript pipeline (DVC section 2): turn PR data into a speakable transcript.
import { chat } from './llm'
import type { PrCommit } from './github'
import type {
  LlmConfig,
  LlmMessage,
  PrFile,
  PullRequestData,
  Transcript,
  TranscriptBudget,
  TranscriptSection,
  TranscriptStream,
} from './types'

export interface BuildTranscriptOptions {
  /** Resolved data URLs mapping index-wise to pr.imageUrls. */
  imageDataUrls?: string[]
  /** Context-window budget for prompt sizing/truncation. */
  budget?: TranscriptBudget
}

// ---------------------------------------------------------------------------
// Context-window budgeting
// ---------------------------------------------------------------------------

export interface ResolvedBudget {
  contextTokens: number
  maxContextPerCall: number
  singleShot: boolean
}

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Clamp v into [lo, hi]; non-finite or missing values fall back to `fallback`. */
function clampInt(
  v: number | undefined,
  lo: number,
  hi: number,
  fallback: number,
): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

const DEFAULT_CONTEXT_TOKENS = 128000
const DEFAULT_MAX_CONTEXT_PER_CALL = 200000
const MIN_CONTEXT_TOKENS = 8000
const MAX_CONTEXT_TOKENS = 2000000
const MIN_MAX_CONTEXT_PER_CALL = 2000
const MAX_MAX_CONTEXT_PER_CALL = 2000000

/**
 * Resolve a TranscriptBudget: defaults 128000/200000/false; contextTokens
 * clamped to 8000..2000000 and maxContextPerCall to 2000..2000000; then
 * maxContextPerCall = min(maxContextPerCall, contextTokens) (applied after
 * the defaults, so the resolved default pair is 128000/128000).
 */
export function resolveBudget(budget?: TranscriptBudget): ResolvedBudget {
  const contextTokens = clampInt(
    budget?.contextTokens,
    MIN_CONTEXT_TOKENS,
    MAX_CONTEXT_TOKENS,
    DEFAULT_CONTEXT_TOKENS,
  )
  const maxContextPerCall = Math.min(
    clampInt(
      budget?.maxContextPerCall,
      MIN_MAX_CONTEXT_PER_CALL,
      MAX_MAX_CONTEXT_PER_CALL,
      DEFAULT_MAX_CONTEXT_PER_CALL,
    ),
    contextTokens,
  )
  return { contextTokens, maxContextPerCall, singleShot: budget?.singleShot ?? false }
}

/** Response tokens reserved on top of the system prompt for every call. */
const RESPONSE_ALLOWANCE = 4096
/** Floor for the user-prompt token budget so tiny windows still send a usable prompt. */
const MIN_USER_TOKENS = 512
/** Upper bound on files per batch when a budget is present. */
const MAX_FILES_PER_BATCH = 50
/** Rolling-summary tokens reserved per earlier section when sizing batches. */
const SUMMARY_TOKENS = 120

/**
 * User-prompt tokens allowed for one call: per-call budget minus the call's
 * system prompt and the response allowance, floored at MIN_USER_TOKENS.
 */
function userPromptBudget(resolved: ResolvedBudget, systemText: string): number {
  return Math.max(
    MIN_USER_TOKENS,
    resolved.maxContextPerCall - estimateTokens(systemText) - RESPONSE_ALLOWANCE,
  )
}

/**
 * Conservative per-image token cost: providers bill attached images as
 * hundreds-to-thousands of tokens each (dimension- and provider-dependent),
 * regardless of the base64 payload size.
 */
export const IMAGE_TOKEN_ESTIMATE = 1600

/** Estimated tokens the images attached to a message list add to the call. */
function imageTokens(images: string[]): number {
  return images.length * IMAGE_TOKEN_ESTIMATE
}

/**
 * Images that fit a call's user-prompt budget, plus the text budget left
 * after their estimated cost. Images are dropped (empty array, full text
 * budget back) when their cost alone would leave less than MIN_USER_TOKENS
 * of text room, so images are never attached on top of an already-maxed
 * text prompt.
 */
function fitImages(
  resolved: ResolvedBudget,
  systemText: string,
  images: string[],
): { images: string[]; textBudget: number } {
  const base = userPromptBudget(resolved, systemText)
  if (images.length === 0) return { images, textBudget: base }
  const cost = imageTokens(images)
  if (base - cost < MIN_USER_TOKENS) return { images: [], textBudget: base }
  return { images, textBudget: base - cost }
}

/** Hard cap a prompt to a token budget, appending a '(truncated)' marker when cut. */
function clampPromptToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const keep = Math.max(0, (maxTokens - 4) * 4)
  return `${text.slice(0, keep)}\n(truncated)`
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

function buildUserPrompt(
  pr: PullRequestData,
  imageCount: number,
  maxFiles = 40,
): string {
  const lines: string[] = []
  lines.push(`Pull request: ${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`)
  lines.push(`Title: ${pr.title}`)
  lines.push(`Author: ${pr.author}`)
  lines.push(
    `Size: ${pr.changedFiles} files changed, ${pr.additions} additions, ${pr.deletions} deletions.`,
  )
  lines.push('', '## Description', truncate(pr.body || '(no description)', 6000))
  lines.push('', '## Changed files')
  for (const f of pr.files.slice(0, maxFiles)) {
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
 * Budget: when present, the user prompt is clamped to the per-call budget.
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
  let attached = images
  let userText = buildUserPrompt(pr, attached.length)
  if (opts.budget !== undefined) {
    // Image cost counts against the user-prompt budget: kept images shrink
    // the text budget; images that cannot fit are dropped and the prompt
    // says they could not be loaded.
    const fit = fitImages(resolveBudget(opts.budget), SYSTEM_PROMPT, images)
    attached = fit.images
    userText = buildUserPrompt(pr, attached.length)
    if (attached.length === 0 && pr.imageUrls.length > 0) {
      userText += `\n${pr.imageUrls.length} image(s) were referenced but could not be loaded.`
    }
    userText = clampPromptToTokens(userText, fit.textBudget)
  }
  const messages: LlmMessage[] = [
    { role: 'system', text: SYSTEM_PROMPT },
    {
      role: 'user',
      text: userText,
      images: attached.length > 0 ? attached : undefined,
    },
  ]
  const raw = await chat(config, messages)
  return materializeTranscript(raw, pr)
}

// ---------------------------------------------------------------------------
// Delta section (what's new since a previously heard summary)
// ---------------------------------------------------------------------------

export interface DeltaSectionOptions {
  /** Injectable chat fn (tests). Defaults to the real LLM client. */
  chat?: typeof chat
  /** Context-window budget: clamps the delta prompt to the per-call budget. */
  budget?: TranscriptBudget
}

const DELTA_SYSTEM_PROMPT = [
  'You are a senior software engineer speaking aloud to a colleague who is listening, not reading.',
  'The listener already heard a summary of this pull request earlier; the previously heard summary is provided.',
  'They now want ONLY what changed since that summary, not a repeat of the whole pull request.',
  'Respond with STRICT JSON only: no markdown fences, no prose outside the JSON.',
  'JSON shape: {"title": string, "sentences": string[]}.',
  'title: a short heading for this update.',
  'sentences: the spoken content; never quote code verbatim.',
  'Every sentence must be self-contained and natural when read aloud by text-to-speech.',
].join('\n')

function deltaUserPrompt(
  pr: PullRequestData,
  newCommits: PrCommit[],
  previousSummary: string,
): string {
  const lines: string[] = [
    prHeader(pr),
    '',
    '## Previously heard summary (do not repeat its content)',
    truncate(previousSummary || '(none)', 4000),
    '',
    '## New commits since that summary (explain what these change)',
  ]
  for (const c of newCommits) {
    lines.push(`- ${truncate(c.message, 400)} (committed ${c.date})`)
  }
  return lines.join('\n')
}

/**
 * Build the "What's New" section for a listener who already heard a summary
 * of this PR: one LLM call covering only the commits pushed since. Uses the
 * same sanitizeLine/splitSentences path as the other builders, and tolerates
 * non-JSON replies by narrating the raw text.
 */
export async function buildDeltaSection(
  config: LlmConfig,
  pr: PullRequestData,
  newCommits: PrCommit[],
  previousSummary: string,
  opts: DeltaSectionOptions = {},
): Promise<TranscriptSection> {
  const chatFn = opts.chat ?? chat
  let userText = deltaUserPrompt(pr, newCommits, previousSummary)
  if (opts.budget !== undefined) {
    userText = clampPromptToTokens(
      userText,
      userPromptBudget(resolveBudget(opts.budget), DELTA_SYSTEM_PROMPT),
    )
  }
  const messages: LlmMessage[] = [
    { role: 'system', text: DELTA_SYSTEM_PROMPT },
    { role: 'user', text: userText },
  ]
  const raw = await chatFn(config, messages)
  const parsed = extractJsonObject(raw)
  if (parsed !== undefined && isValidStreamSection(parsed)) {
    const sentences = parsed.sentences
      .flatMap((sentence) => splitSentences(sanitizeLine(sentence)))
      .filter((sentence) => sentence.length > 0)
    if (sentences.length > 0) {
      return { id: 'whats-new', title: "What's New", sentences }
    }
  }
  // Fallback: treat the raw reply as narrated text.
  const sentences = splitSentences(sanitizeLine(raw)).filter((s) => s.length > 0)
  return {
    id: 'whats-new',
    title: "What's New",
    sentences: sentences.length > 0 ? sentences : ['[unpronounceable content]'],
  }
}

// ---------------------------------------------------------------------------
// Streaming transcript
// ---------------------------------------------------------------------------

export interface TranscriptStreamOptions {
  /** Resolved data URLs mapping index-wise to pr.imageUrls. */
  imageDataUrls?: string[]
  /** Injectable chat fn (tests). Defaults to the real LLM client. */
  chat?: typeof chat
  /** Context-window budget: batch sizing, overflow pre-checks, single-shot. */
  budget?: TranscriptBudget
}

/** TranscriptStream plus the next() cursor callers drive directly. */
export interface TranscriptStreamHandle extends TranscriptStream {
  /** Await + return the next section, or null once done/aborted. */
  next(): Promise<TranscriptSection | null>
}

type SectionSpec =
  | { kind: 'overview' }
  | { kind: 'architecture' }
  | { kind: 'changes'; files: PrFile[] }
  | { kind: 'review-notes' }
  | { kind: 'single-shot' }

interface Generated {
  section: TranscriptSection
  /** Short recap carried into later calls' prompts (rolling context). */
  summary: string
}

const BIG_PATCH_CHARS = 4000
const FILES_PER_BATCH = 10

/**
 * Split files into LLM batches: small files coalesce up to perBatch;
 * a file whose patch exceeds BIG_PATCH_CHARS gets a batch of its own.
 */
function batchFiles(files: PrFile[], perBatch: number = FILES_PER_BATCH): PrFile[][] {
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
      if (current.length >= perBatch) flush()
    }
  }
  flush()
  return batches
}

/** Tokens one file contributes to a changes prompt (line + 1200-char-capped patch). */
function filePromptTokens(f: PrFile): number {
  const line = `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`
  return estimateTokens(line) + (f.patch ? estimateTokens(truncate(f.patch, 1200)) : 0)
}

/**
 * Budget-aware files-per-batch:
 * clamp(floor((maxContextPerCall - overhead - summaryCarry) / avgBatchFileTokens), 1, 50),
 * where overhead is the changes-call system prompt + response allowance and
 * summaryCarry reserves SUMMARY_TOKENS per section expected before the last batch.
 */
function filesPerBatchFor(files: PrFile[], resolved: ResolvedBudget): number {
  if (files.length === 0) return FILES_PER_BATCH
  const overhead = estimateTokens(systemTextForChanges()) + RESPONSE_ALLOWANCE
  const expectedBatches = Math.max(1, Math.ceil(files.length / FILES_PER_BATCH))
  const summaryCarry = SUMMARY_TOKENS * (2 + expectedBatches)
  const avg = Math.max(
    1,
    files.reduce((sum, f) => sum + filePromptTokens(f), 0) / files.length,
  )
  const room = resolved.maxContextPerCall - overhead - summaryCarry
  return Math.min(MAX_FILES_PER_BATCH, Math.max(1, Math.floor(room / avg)))
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

const STREAM_SECTION_INSTRUCTIONS: Record<
  Exclude<SectionSpec['kind'], 'single-shot'>,
  string
> = {
  overview:
    'This section is the overview: what this pull request does and why, in plain language.',
  architecture:
    'This section covers architecture and diagrams: describe every mermaid diagram and attached image in plain English, covering what the nodes or components are and how they connect.',
  changes:
    'This section covers one batch of code changes: walk through these files by intent and logic flow.',
  'review-notes':
    'This section covers review feedback: weave the reviewer comments and reviews into a coherent narrative.',
}

/** System prompt text for a section spec; single-shot reuses the full-transcript prompt. */
function systemTextFor(spec: SectionSpec): string {
  if (spec.kind === 'single-shot') return SYSTEM_PROMPT
  return `${STREAM_SYSTEM_BASE}\n${STREAM_SECTION_INSTRUCTIONS[spec.kind]}`
}

function systemTextForChanges(): string {
  return systemTextFor({ kind: 'changes', files: [] })
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
  files: PrFile[],
  batch: number,
  totalBatches: number,
  context: string,
  tokenBudget?: number,
): string {
  const lines: string[] = [
    prHeader(pr),
    context,
    '',
    `## Files in this batch (batch ${batch} of ${totalBatches})`,
  ]
  for (const f of files) {
    lines.push(`- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
  }
  if (tokenBudget === undefined) {
    for (const f of files) {
      if (f.patch) lines.push(truncate(f.patch, 1200))
    }
  } else {
    // Overflow control: fit patches into the token budget; a single file
    // whose patch does not fit gets truncated with a '(truncated)' marker
    // the note below tells the model about. The 32-token slack covers the
    // join separators and the note line itself.
    const effectiveBudget = tokenBudget - 32
    let truncated = false
    for (const f of files) {
      if (!f.patch) continue
      const used = estimateTokens(lines.join('\n'))
      const capped = truncate(f.patch, 1200)
      const cost = estimateTokens(capped)
      if (used + cost <= effectiveBudget) {
        lines.push(capped)
        continue
      }
      const remaining = effectiveBudget - used
      if (remaining >= 16) {
        const chars = (remaining - 4) * 4
        lines.push(`${f.patch.slice(0, Math.min(f.patch.length, 1200, chars))}\n(truncated)`)
      } else {
        lines.push('(patch omitted to fit the context window)')
      }
      truncated = true
    }
    if (truncated) {
      lines.push(
        '',
        'Note: patches marked (truncated) or omitted were cut to fit the context window; cover only the visible part.',
      )
    }
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
 *
 * Budget: without opts.budget the batching is the fixed default (10 files
 * per batch, oversized patches isolated). With opts.budget, batch sizes come
 * from the window (fat windows get fat batches, small windows shrink), every
 * call is pre-checked against the per-call budget (over-large batches are
 * binary-split, oversized single patches truncated with a '(truncated)'
 * marker), and budget.singleShot collapses the whole PR into one call when
 * everything fits the model's context window.
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

  const resolved = opts.budget !== undefined ? resolveBudget(opts.budget) : null

  // Single-shot mode: opted in AND the whole PR (description, comments,
  // reviews, every file patch, diagrams, images note) plus the prompt
  // overhead fits the window. Otherwise fall back to sectioned batches.
  function buildSingleShotMessages(): LlmMessage[] {
    return [
      { role: 'system', text: SYSTEM_PROMPT },
      {
        role: 'user',
        text: buildUserPrompt(pr, images.length, pr.files.length),
        images: images.length > 0 ? images : undefined,
      },
    ]
  }
  function singleShotFits(messages: LlmMessage[], budget: ResolvedBudget): boolean {
    // Every attached image bills as tokens too; count them so an
    // image-bearing single shot falls back to sectioned mode when the
    // images alone would blow the window.
    const imageCount = messages.reduce((sum, m) => sum + (m.images?.length ?? 0), 0)
    const input =
      estimateTokens(messages[0]!.text) +
      estimateTokens(messages[1]!.text) +
      imageCount * IMAGE_TOKEN_ESTIMATE +
      RESPONSE_ALLOWANCE
    return input <= budget.contextTokens && input <= budget.maxContextPerCall
  }
  const singleShotMessages =
    resolved !== null && resolved.singleShot
      ? (() => {
          const messages = buildSingleShotMessages()
          return singleShotFits(messages, resolved) ? messages : null
        })()
      : null

  const batches = batchFiles(
    pr.files,
    resolved === null ? FILES_PER_BATCH : filesPerBatchFor(pr.files, resolved),
  )
  const plan: SectionSpec[] =
    singleShotMessages !== null
      ? [{ kind: 'single-shot' }]
      : [
          { kind: 'overview' as const },
          ...(pr.imageUrls.length > 0 || pr.mermaidBlocks.length > 0
            ? [{ kind: 'architecture' as const }]
            : []),
          ...batches.map((files) => ({ kind: 'changes' as const, files })),
          ...(pr.comments.length > 0 || pr.reviews.length > 0
            ? [{ kind: 'review-notes' as const }]
            : []),
        ]

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
  // Sections after the first, emitted by a single-shot generation.
  const singleShotQueue: TranscriptSection[] = []

  /** Live numbering of a changes spec: 1-based index and current total. */
  function changesNumbering(spec: Extract<SectionSpec, { kind: 'changes' }>): {
    batch: number
    total: number
  } {
    let total = 0
    let batch = 0
    for (const s of plan) {
      if (s.kind !== 'changes') continue
      total++
      if (s === spec) batch = total
    }
    return { batch, total }
  }

  function sectionLabel(spec: SectionSpec): { id: string; title: string } {
    switch (spec.kind) {
      case 'overview':
        return { id: 'overview', title: 'Overview' }
      case 'architecture':
        return { id: 'architecture', title: 'Architecture and Diagrams' }
      case 'changes': {
        const { batch } = changesNumbering(spec)
        return { id: `changes-${batch}`, title: `Key Changes (${batch})` }
      }
      case 'review-notes':
        return { id: 'review-notes', title: 'Review Notes' }
      case 'single-shot':
        return { id: 'overview', title: 'Overview' }
    }
  }

  function buildMessages(spec: SectionSpec): LlmMessage[] {
    if (spec.kind === 'single-shot') return singleShotMessages!
    const context = contextBlock(summaries)
    const sys = systemTextFor(spec)
    // Images attach only to architecture calls, and (under a budget) only
    // when their estimated token cost fits the per-call room; otherwise they
    // are dropped and the prompt notes they could not be loaded.
    const wants = spec.kind === 'architecture' ? images : []
    const fit =
      resolved !== null
        ? fitImages(resolved, sys, wants)
        : { images: wants, textBudget: 0 }
    const attached = fit.images
    let user: string
    switch (spec.kind) {
      case 'overview':
        user = overviewUserPrompt(pr)
        break
      case 'architecture':
        user = architectureUserPrompt(pr, attached.length, context)
        break
      case 'changes': {
        let { batch, total } = changesNumbering(spec)
        if (resolved === null) {
          user = changesUserPrompt(pr, spec.files, batch, total, context)
        } else {
          // Overflow pre-check: while the batch's prompt exceeds the
          // per-call budget, binary-split the file list and queue the rest
          // as a follow-up batch. A lone over-budget file falls through to
          // the token-budgeted prompt builder, which truncates its patch.
          const usable = userPromptBudget(resolved, sys)
          while (spec.files.length > 1) {
            const probe = changesUserPrompt(pr, spec.files, batch, total, context)
            if (estimateTokens(probe) <= usable) break
            const mid = Math.floor(spec.files.length / 2)
            const rest = spec.files.slice(mid)
            spec.files = spec.files.slice(0, mid)
            plan.splice(plan.indexOf(spec) + 1, 0, { kind: 'changes', files: rest })
            total = changesNumbering(spec).total
          }
          user = changesUserPrompt(pr, spec.files, batch, total, context, usable)
        }
        break
      }
      case 'review-notes':
        user = reviewUserPrompt(pr, context)
        break
    }
    // Final overflow pre-check for every budgeted call: never send an
    // over-budget user prompt. The budget already excludes the estimated
    // cost of any attached images.
    if (resolved !== null) {
      user = clampPromptToTokens(user, fit.textBudget)
    }
    return [
      { role: 'system', text: sys },
      {
        role: 'user',
        text: user,
        images: attached.length > 0 ? attached : undefined,
      },
    ]
  }

  function fallbackGenerated(spec: SectionSpec): Generated {
    const { id, title } = sectionLabel(spec)
    return {
      section: {
        id,
        title,
        sentences: ['Could not summarize this part.'],
      },
      summary: 'This part could not be summarized.',
    }
  }

  async function generateSection(spec: SectionSpec): Promise<Generated> {
    const { id, title } = sectionLabel(spec)
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
    if (spec.kind === 'single-shot') {
      // One generation for the whole PR: materialize every section and
      // queue all but the first (overview stays first via orderSections).
      if (raw !== null) {
        const transcript = materializeTranscript(raw, pr)
        if (transcript.sections.length > 0) {
          singleShotQueue.push(...transcript.sections.slice(1))
          return { section: transcript.sections[0]!, summary: '' }
        }
      }
      return fallbackGenerated(spec)
    }
    if (raw !== null) {
      const parsed = extractJsonObject(raw)
      if (parsed !== undefined && isValidStreamSection(parsed)) {
        const sentences = parsed.sentences
          .flatMap((sentence) => splitSentences(sanitizeLine(sentence)))
          .filter((sentence) => sentence.length > 0)
        const cleanTitle = sanitizeLine(parsed.title)
        if (cleanTitle && sentences.length > 0) {
          const summary =
            typeof parsed.summary === 'string' && parsed.summary.trim() !== ''
              ? truncate(parsed.summary.trim(), 400)
              : deriveSummary(sentences)
          return { section: { id, title: cleanTitle, sentences }, summary }
        }
      } else if (parsed === undefined) {
        // No JSON at all: narrate the raw reply, like buildTranscript.
        const sentences = splitSentences(sanitizeLine(raw)).filter((s) => s.length > 0)
        if (sentences.length > 0) {
          return {
            section: { id, title, sentences },
            summary: deriveSummary(sentences),
          }
        }
      }
    }
    return fallbackGenerated(spec)
  }

  async function doNext(): Promise<TranscriptSection | null> {
    if (aborted) return null
    if (singleShotQueue.length > 0) {
      cursor++
      return singleShotQueue.shift()!
    }
    if (cursor >= plan.length) return null
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
      if (
        aborted ||
        singleShotQueue.length > 0 ||
        cursor >= plan.length ||
        inFlight !== null ||
        pendingNext !== null
      )
        return
      inFlight = generateSection(plan[cursor]!)
      // abort() rejects this via the sentinel; without a handler a consumer
      // that prefetches and aborts before next() hits an unhandled rejection.
      // The catch only marks it handled: doNext's await still sees the abort.
      inFlight.catch(() => {})
    },

    done(): boolean {
      return aborted || (singleShotQueue.length === 0 && cursor >= plan.length)
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
