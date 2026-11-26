// ListenToPR app shell. Plain DOM, CSP-safe: no inline scripts, no inline
// style attributes; all styling comes from styles.css classes.
// contract says class KeyVault; sibling currently exports it as Vault
import { Vault as KeyVault, isPrfSupported } from './vault'
import {
  parsePrInput,
  findPrUrl,
  parseGitTarget,
  pseudoTargetRef,
  PSEUDO_REF_FLOOR,
  fetchPullRequest,
  fetchNewCommits,
  fetchImageAsDataUrl,
  fetchFileContent,
  fetchCommit,
  fetchCompare,
  type GitFileTarget,
} from './github'
import { parsePastedContent } from './paste'
import { withRetry, retryableHttpError, actionableLlmError } from './retry'
import { llmProxyFetch, isProxyActive, validateProxyTarget } from './llmproxy'
import {
  createTranscriptStream,
  sanitizeLine,
  buildDeltaSection,
  type TranscriptStreamHandle,
} from './transcript'
import { chat } from './llm'
import { createTtsController, listVoices } from './tts'
import { createWakeLockController, shouldShowWakeLockFallback } from './wakelock'
import { createUpdateController, type UpdateController } from './update'
import { connectSrcValue, endpointAllowedByConnectSrc, endpointUsable } from './csp'
import { createStore } from './store'
import { createMediaSessionController, type MediaSessionController } from './mediasession'
import { createKeyboardController, type KeyboardController } from './keyboard'
import { createSleepTimer, type SleepTimer } from './sleeptimer'
import {
  createThemeController,
  type ResolvedTheme,
  type ThemeController,
  type ThemeMode,
} from './theme'
import {
  createDiagramRenderer,
  type DiagramRenderAllEntry,
  type DiagramRenderer,
} from './diagrams'
import type {
  LlmConfig,
  LlmMessage,
  LlmProvider,
  PullRequestData,
  PullRequestRef,
  SecretId,
  Transcript,
  TranscriptBudget,
  TranscriptDetail,
  TranscriptSection,
  TtsState,
} from './types'

// ---------- small DOM helpers ----------

function el<T extends keyof HTMLElementTagNameMap>(
  tag: T,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[T] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function labeledInput(
  labelText: string,
  type: 'text' | 'password',
  value = '',
): { wrap: HTMLDivElement; input: HTMLInputElement } {
  const wrap = el('div', 'field')
  const label = el('label', 'field-label', labelText)
  const input = el('input', 'field-input')
  input.type = type
  input.autocomplete = 'off'
  input.value = value
  label.appendChild(input)
  wrap.appendChild(label)
  return { wrap, input }
}

// ---------- localStorage helpers (private mode safe) ----------

const KEYS = {
  vaultReady: 'listentopr.vault-ready',
  provider: 'listentopr.llm-provider',
  endpoint: 'listentopr.llm-endpoint',
  model: 'listentopr.llm-model',
  visionModel: 'listentopr.llm-vision-model',
  context: 'listentopr.llm-context',
  detail: 'listentopr.detail',
  prefs: 'listentopr.tts-prefs',
  wlDismissed: 'listentopr.wl-banner-dismissed',
} as const

const PROVIDERS: readonly LlmProvider[] = ['openai', 'anthropic', 'gemini']

const PROVIDER_NAMES: ReadonlyArray<readonly [LlmProvider, string]> = [
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['gemini', 'Gemini'],
]

/** Persisted provider choice; 'openai' when unset or invalid. */
export function readProvider(): LlmProvider {
  const v = lsGet(KEYS.provider)
  return PROVIDERS.includes(v as LlmProvider) ? (v as LlmProvider) : 'openai'
}

/** Persisted context budget; empty when unset or corrupt. */
export function readContextBudget(): TranscriptBudget {
  return parseContextSettings(lsGet(KEYS.context))
}

function writeContextSettings(settings: TranscriptBudget): void {
  lsSet(KEYS.context, JSON.stringify(settings))
}

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // storage unavailable (private mode) — non-secret prefs just don't persist
  }
}

function lsRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// ---------- app state ----------

let root: HTMLElement | null = null
let vault: KeyVault
let tts: ReturnType<typeof createTtsController>
let wakeLock: ReturnType<typeof createWakeLockController>
/** Non-secret IndexedDB store: transcript cache, resume, queue, history. */
let store: ReturnType<typeof createStore> | null = null
let keyboard: KeyboardController | null = null
let mediaSession: MediaSessionController | null = null
let sleepTimer: SleepTimer | null = null
let theme: ThemeController | null = null
let diagrams: DiagramRenderer | null = null
/** Resolved theme last pushed to the diagram renderer (skip no-op re-renders). */
let lastDiagramTheme: ResolvedTheme | null = null
/** Diagrams-section view state for the load in flight (see DiagramsView). */
const diagramsView = createDiagramsView()

let statusEl: HTMLElement | null = null
const offlineBanner = el('div', 'banner banner-offline', 'Offline — check connection')
offlineBanner.hidden = true
offlineBanner.setAttribute('role', 'status')
offlineBanner.setAttribute('aria-live', 'polite')

const updateBanner = el('div', 'banner banner-warn', 'New version available')
updateBanner.hidden = true
updateBanner.setAttribute('role', 'status')
updateBanner.setAttribute('aria-live', 'polite')
{
  const reloadBtn = el('button', 'btn btn-small', 'Reload')
  reloadBtn.type = 'button'
  reloadBtn.addEventListener('click', () => {
    if (updateCtrl) updateCtrl.reload()
  })
  const dismissBtn = el('button', 'btn btn-small', 'Dismiss')
  dismissBtn.type = 'button'
  dismissBtn.addEventListener('click', () => {
    updateBanner.hidden = true
  })
  updateBanner.appendChild(reloadBtn)
  updateBanner.appendChild(dismissBtn)
}
let updateCtrl: UpdateController | null = null

const hiddenBanner = el(
  'div',
  'banner banner-warn',
  'Playback pauses when this tab is hidden — keep it open',
)
hiddenBanner.hidden = true
hiddenBanner.setAttribute('role', 'status')
hiddenBanner.setAttribute('aria-live', 'polite')

// main-view element refs (reassigned on each render)
let listenBtn: HTMLButtonElement | null = null
let loadingEl: HTMLElement | null = null
let transcriptEl: HTMLElement | null = null
let controlsEl: HTMLElement | null = null
let playBtn: HTMLButtonElement | null = null
let pauseBtn: HTMLButtonElement | null = null
let stopBtn: HTMLButtonElement | null = null
let voiceSelect: HTMLSelectElement | null = null
let pendingAutoStartUrl: string | null = null

// convenience-feature element refs (reassigned on each render)
let scrubberRange: HTMLInputElement | null = null
let scrubberTime: HTMLElement | null = null
/** True while the user is dragging the scrubber (pointer down). */
let scrubbing = false
let tocEl: HTMLDetailsElement | null = null
let tocListEl: HTMLOListElement | null = null
let queueListEl: HTMLElement | null = null
let actionsEl: HTMLElement | null = null
let sleepLabelEl: HTMLElement | null = null
let sleepTickId: number | null = null

/** The PR currently loaded (or loading) into the player. */
let currentRef: PullRequestRef | null = null
let currentHeadSha: string | null = null
let currentTitle = ''
/**
 * True while the vault is the session-only ephemeral one (first run before
 * the user opts into "Remember for next time").
 */
let vaultEphemeral = false
/** File target behind the current load, for blob file-chip links. */
let currentFileTarget: GitFileTarget | null = null
/** One-time-per-session hint that a custom endpoint goes via the SW proxy. */
let proxyHintShown = false
/** True between "playback started" and natural stop/finish. */
let playbackActive = false
/** Timestamp of the last throttled resume-position write. */
let lastResumeWriteAt = 0

const RATE_OPTIONS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0]
const PITCH_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
const SLEEP_PRESETS_MIN = [0, 10, 20, 30, 60]

// ---------- status / errors ----------

function setStatus(message: string, kind: 'error' | 'info' = 'error'): void {
  if (!statusEl) return
  statusEl.textContent = message
  statusEl.className = `banner banner-${kind}`
  statusEl.hidden = false
}

function clearStatus(): void {
  if (!statusEl) return
  statusEl.textContent = ''
  statusEl.hidden = true
}

/** Never log or display raw secret values; messages from our own modules only. */
function sanitizeError(err: unknown): string {
  let msg: string
  if (err instanceof Error) msg = err.message
  else if (typeof err === 'string') msg = err
  else msg = 'Something went wrong'
  msg = msg.replace(/\s+/g, ' ').trim()
  if (msg.length > 200) msg = msg.slice(0, 200) + '…'
  return msg || 'Something went wrong'
}

function showOfflineBanner(): void {
  offlineBanner.hidden = false
}

// ---------- pure helpers (exported for tests) ----------

/** Minimum gap between throttled resume-position writes. */
export const RESUME_WRITE_INTERVAL_MS = 2000

/** True when at least `RESUME_WRITE_INTERVAL_MS` elapsed since the last write. */
export function shouldWriteResume(lastWriteAt: number, now: number): boolean {
  return now - lastWriteAt >= RESUME_WRITE_INTERVAL_MS
}

/**
 * What the sleep timer should do at expiry for the current player state.
 * A pending stream hold needs a full stop: nothing is speaking (pause is a
 * no-op) and the hold pipeline would restart audio when the next section
 * arrives.
 */
export function sleepExpireAction(
  state: TtsState,
  holdPending: boolean,
): 'pause' | 'stop' | 'none' {
  if (state.playing && !state.paused) return 'pause'
  if (holdPending) return 'stop'
  return 'none'
}

/**
 * True when the PR head moved past the latest cached transcript and a
 * "What's New" delta section should be generated for the returning listener.
 */
export function shouldBuildDelta(
  latestCachedSha: string | null,
  currentHeadSha: string | null | undefined,
): boolean {
  if (!latestCachedSha || !currentHeadSha) return false
  return latestCachedSha !== currentHeadSha
}

/** Map a scrubber ratio (0..1) onto a sentence queue index. */
export function seekIndexFromRatio(ratio: number, totalSentences: number): number {
  if (!Number.isFinite(ratio) || totalSentences <= 0) return 0
  const r = Math.min(1, Math.max(0, ratio))
  return Math.min(totalSentences - 1, Math.floor(r * totalSentences))
}

/** Seconds as "m:ss" (clamped at zero, non-finite treated as zero). */
export function formatTime(seconds: number): string {
  const s = !Number.isFinite(seconds) || seconds < 0 ? 0 : Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Human label for a flat resume index: "section 2, sentence 3" (1-based). */
export function describeResumePosition(
  sections: TranscriptSection[],
  sentenceIndex: number,
): string {
  let remaining = sentenceIndex
  for (const section of sections) {
    const n = section.sentences.length
    if (remaining < n) {
      const si = sections.indexOf(section)
      return `section ${si + 1}, sentence ${remaining + 1}`
    }
    remaining -= n
  }
  return `sentence ${sentenceIndex + 1}`
}

/** Short "previously heard" summary for the delta prompt: first two sentences. */
export function summarizeTranscript(t: Transcript): string {
  const sentences = t.sections.flatMap((s) => s.sentences).slice(0, 2)
  return sentences.join(' ')
}

/** Plain-text rendering of a transcript (copy / download / share). */
export function transcriptToText(title: string, sections: TranscriptSection[]): string {
  const parts: string[] = [title, '']
  for (const s of sections) {
    parts.push(`## ${s.title}`)
    parts.push(s.sentences.join(' '))
    parts.push('')
  }
  return parts.join('\n').trim() + '\n'
}

// ---------- input routing (url vs paste vs garbage) ----------

export type InputRoute =
  | { kind: 'pr'; ref: PullRequestRef }
  | { kind: 'file'; file: GitFileTarget }
  | { kind: 'commit'; commit: { owner: string; repo: string; sha: string } }
  | { kind: 'compare'; compare: { owner: string; repo: string; base: string; head: string } }
  | { kind: 'paste'; text: string }
  | { kind: 'error'; message: string }

/**
 * Decide how the input box content should be loaded: any GitHub target
 * (PR, blob/raw file, commit, compare) goes through its fetcher; multiline
 * or long free text is offered to the paste parser; anything else is a
 * clear error. Single-line short garbage never reaches the paste parser.
 */
export function routeInput(input: string): InputRoute {
  const trimmed = input.trim()
  const target = parseGitTarget(trimmed)
  if (target !== null) {
    if (target.kind === 'pr') return { kind: 'pr', ref: target.ref }
    if (target.kind === 'file') return { kind: 'file', file: target.file }
    if (target.kind === 'commit') return { kind: 'commit', commit: target.commit }
    return { kind: 'compare', compare: target.compare }
  }
  if (trimmed.includes('\n') || trimmed.length >= 80) {
    return { kind: 'paste', text: trimmed }
  }
  return {
    kind: 'error',
    message:
      'Enter a GitHub pull request, file, commit or compare URL — or paste PR text (description and diff).',
  }
}

// ---------- detail setting ----------

/** Parse the persisted detail setting ('listentopr.detail'); 'brief' unless exactly 'detailed'. */
export function parseDetailSetting(raw: string | null): TranscriptDetail {
  return raw === 'detailed' ? 'detailed' : 'brief'
}

function readDetail(): TranscriptDetail {
  return parseDetailSetting(lsGet(KEYS.detail))
}

// ---------- big-PR honesty ----------

/**
 * Status note when generated files were filtered out of a PR fetch:
 * "Showing N of M changed files (lockfiles/generated skipped)". Null when
 * nothing was skipped or the source does not report a raw count.
 */
export function bigPrStatus(pr: PullRequestData): string | null {
  if (pr.rawChangedFiles === undefined) return null
  if (pr.rawChangedFiles <= pr.changedFiles) return null
  return `Showing ${pr.changedFiles} of ${pr.rawChangedFiles} changed files (lockfiles/generated skipped)`
}

// ---------- file chips ----------

/**
 * Link target for a section's file chip: the PR's Files tab for real PRs,
 * the blob URL for file-target loads, nothing otherwise (pasted text and
 * commit/compare pseudo-PRs have no per-file GitHub home worth linking).
 * Pseudo-PR refs carry numbers at or above PSEUDO_REF_FLOOR and never link
 * to a PR page.
 */
export function fileChipHref(
  ref: PullRequestRef | null,
  fileTarget: GitFileTarget | null,
  path: string,
): string | null {
  if (fileTarget !== null) {
    const encoded = path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return `https://github.com/${fileTarget.owner}/${fileTarget.repo}/blob/${encodeURIComponent(fileTarget.ref)}/${encoded}`
  }
  if (ref !== null && ref.number > 0 && ref.number < PSEUDO_REF_FLOOR) {
    return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}/files`
  }
  return null
}

// ---------- LLM retry status ----------

/** Status line while an LLM call backs off: "Retrying in 2s…". */
export function retryStatusMessage(delayMs: number): string {
  const seconds = Math.max(1, Math.round(delayMs / 1000))
  return `Retrying in ${seconds}s…`
}

/**
 * The chat call every load uses: wrapped in withRetry (retryable HTTP
 * errors only), routed through the service-worker proxy fetch when one
 * controls the page, and surfacing an actionable message when the final
 * attempt fails. `observe` sees each call's messages (single-shot tracking).
 */
function makeChatFn(observe?: (messages: LlmMessage[]) => void): typeof chat {
  const proxyFetch = llmProxyFetch()
  const routedFetch = (url: string, init?: RequestInit): Promise<Response> =>
    proxyFetch(url, init ?? {})
  let retried = false
  return (config, messages, opts) => {
    observe?.(messages)
    return withRetry(
      () => chat(config, messages, { ...opts, fetch: routedFetch }),
      {
        retryOn: retryableHttpError,
        onRetry: (_attempt, delayMs) => {
          retried = true
          setStatus(retryStatusMessage(delayMs), 'info')
        },
      },
    ).then(
      (text) => {
        if (retried) setStatus('Connection recovered — continuing.', 'info')
        return text
      },
      (err) => {
        setStatus(actionableLlmError(err))
        throw err
      },
    )
  }
}

// ---------- demo transcript (Try a sample) ----------

/**
 * Bookmarklet shipped in the main view: on any GitHub PR page it hops to
 * ListenToPR with the PR URL preloaded (the ?pr= share-target route).
 */
export const BOOKMARKLET_HREF =
  "javascript:location.href='https://github.tig.pw/listentopr/?pr='+encodeURIComponent(location.href)"

/**
 * Copy the bookmarklet URL to the clipboard; returns the status line for
 * the chip click. The page's own CSP (script-src 'self') blocks
 * javascript: navigation, so clicking the chip on the app page can never
 * run the bookmarklet — copying it (or dragging the chip to the bookmarks
 * bar, which the href still serves) is the only working interaction.
 * Exported for tests.
 */
export async function copyBookmarklet(): Promise<string> {
  try {
    await navigator.clipboard.writeText(BOOKMARKLET_HREF)
    return 'Bookmarklet copied — paste it as a new bookmark, then click it on any GitHub pull request page.'
  } catch {
    return 'Cannot copy the bookmarklet here — drag the chip to your bookmarks bar instead.'
  }
}

export const DEMO_REF: PullRequestRef = { owner: 'demo', repo: 'sample', number: 0 }

/** Mermaid blocks shipped with the demo, so diagrams render offline. */
export const DEMO_MERMAID_BLOCKS: readonly string[] = [
  'flowchart TD\n' +
    '  Load[Load pull request] --> Cache{Cache hit?}\n' +
    '  Cache -- yes --> Play[Play transcript]\n' +
    '  Cache -- no --> Gen[Generate sections]\n' +
    '  Gen --> Stream[Stream to speech]\n' +
    '  Stream --> Play',
]

/**
 * Bundled sample transcript: a fictional PR narrated in four sections, no
 * network or keys needed. Instant TTS on a fresh install.
 */
export const DEMO_TRANSCRIPT: Transcript = {
  title: 'Add retry engine and streaming sections to the summarizer',
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      sentences: [
        'This pull request makes the transcript generator resilient and fast to start.',
        'A new retry engine wraps every model call with exponential backoff and jitter.',
        'Sections now stream out as they are generated, so speech starts after the first one instead of waiting for the whole transcript.',
        'Nothing changes for callers that ignore the new options.',
      ],
    },
    {
      id: 'architecture',
      title: 'Architecture',
      sentences: [
        'The loader first checks the local cache keyed by the head commit.',
        'On a miss, sections are generated one batch at a time and appended to the speech queue.',
        'A prefetch window keeps generation ahead of playback by about four sentences.',
        'The whole flow looks like this.',
      ],
      files: ['src/transcript.ts'],
    },
    {
      id: 'changes',
      title: 'Changes',
      sentences: [
        'The retry helper lives in its own module with an injectable sleep for tests.',
        'It retries timeout, rate limit, and server error statuses, and gives up on anything else.',
        'The stream factory now accepts a detail level for brief or per-file narration.',
        'Lockfiles and generated files are filtered before batching, so narration stays on real code.',
      ],
      files: ['src/retry.ts', 'src/transcript.ts', 'src/github.ts'],
    },
    {
      id: 'review-notes',
      title: 'Review notes',
      sentences: [
        'Reviewers asked for a cap on backoff, which landed at fifteen seconds.',
        'The queue holds playback while the next section generates, and resumes without repeating a sentence.',
        'All new behavior is covered by unit tests with the network mocked.',
      ],
    },
  ],
}

// ---------- context-budget settings ----------

/**
 * Parse the persisted context-budget settings ('listentopr.llm-context',
 * JSON {contextTokens, maxContextPerCall, singleShot}). Tolerates corrupt
 * input by omission: only finite numbers greater than zero survive, and
 * singleShot only when exactly true. Anything else is dropped, so a damaged
 * record degrades to engine defaults rather than breaking a load.
 */
export function parseContextSettings(raw: string | null): TranscriptBudget {
  if (raw === null || raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const o = parsed as Record<string, unknown>
  const out: TranscriptBudget = {}
  if (
    typeof o.contextTokens === 'number' &&
    Number.isFinite(o.contextTokens) &&
    o.contextTokens > 0
  ) {
    out.contextTokens = o.contextTokens
  }
  if (
    typeof o.maxContextPerCall === 'number' &&
    Number.isFinite(o.maxContextPerCall) &&
    o.maxContextPerCall > 0
  ) {
    out.maxContextPerCall = o.maxContextPerCall
  }
  if (o.singleShot === true) out.singleShot = true
  return out
}

/** Free-text token count: finite and > 0, else null (empty input = unset). */
export function parseContextTokens(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * True when a stream chat call carries the whole-PR single-shot prompt: only
 * that prompt includes the '## Changed files' block (sectioned calls say
 * '## Files in this batch'; overview/review calls list no files at all).
 */
export function isSingleShotMessages(messages: LlmMessage[]): boolean {
  return messages.some(
    (m) => m.role === 'user' && m.text.includes('## Changed files'),
  )
}

/** Status line after the first streamed section (resume note wins). */
export function initialStreamStatus(
  resumeMsg: string | null,
  singlePass: boolean,
): string | null {
  if (resumeMsg !== null) return resumeMsg
  return singlePass ? 'Generating in a single pass.' : null
}

// ---------- CSP endpoint validation ----------
// connect-src is baked at build time, so a Settings endpoint whose origin is
// not already allowed would be CSP-blocked at fetch time and surface as a
// misleading "offline" TypeError. Validate up front instead.

function llmEndpointAllowed(endpoint: string): boolean {
  if (endpoint.trim() === '') return true
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[http-equiv="Content-Security-Policy"]',
  )
  const csp = meta?.getAttribute('content') ?? ''
  const src = connectSrcValue(csp)
  if (src === null || src === '') return true // no connect-src -> nothing blocked
  return endpointAllowedByConnectSrc(endpoint, src, window.location.origin)
}

const CSP_ENDPOINT_MSG =
  'LLM endpoint is not allowed by this build\'s Content-Security-Policy. ' +
  'Rebuild with VITE_LLM_ENDPOINT set to that origin, or use an allowed endpoint.'

/** The SW proxy rejects non-https targets and its own origin with an opaque
 * 502; surface the real cause at save time instead. */
const PROXY_TARGET_MSG =
  'The service-worker proxy only forwards https endpoints on other origins. ' +
  'Use an https endpoint outside this site.'

// ---------- theme ----------

/** Header toggle cycles auto -> light -> dark -> auto. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === 'auto') return 'light'
  if (mode === 'light') return 'dark'
  return 'auto'
}

/** Short button caption for a theme mode. */
export function themeModeLabel(mode: ThemeMode): string {
  if (mode === 'auto') return 'Auto'
  if (mode === 'light') return 'Light'
  return 'Dark'
}

/** Accessible button label; auto additionally says it follows the system. */
export function themeModeAria(mode: ThemeMode): string {
  return mode === 'auto'
    ? 'Theme: Auto (follows system)'
    : `Theme: ${themeModeLabel(mode)}`
}

// ---------- diagrams ----------

/**
 * True when the spoken section is the one that describes the PR's mermaid
 * diagrams (the transcript's architecture section). Diagram cards highlight
 * while it plays.
 */
export function diagramSectionSpoken(section: TranscriptSection | undefined): boolean {
  if (!section) return false
  return section.id === 'architecture' || /diagram|architecture/i.test(section.title)
}

// ---------- vault adapters ----------
// The integration contract (boolean unlocks, sync getSecret, isPrfSupported
// method) and the current vault.ts signatures (void unlocks that throw,
// async getSecret, module-level isPrfSupported) differ slightly. These
// adapters accept either shape so both work.

async function vaultUnlockPin(
  pin: string,
): Promise<{ ok: boolean; err?: string }> {
  try {
    const r = await (vault.unlockWithPin(pin) as unknown as boolean | void)
    return { ok: r !== false }
  } catch (err) {
    return { ok: false, err: sanitizeError(err) }
  }
}

async function vaultUnlockPrf(): Promise<{ ok: boolean; err?: string }> {
  try {
    const r = await (vault.unlockWithPrf() as unknown as boolean | void)
    return { ok: r !== false }
  } catch (err) {
    return { ok: false, err: sanitizeError(err) }
  }
}

function vaultPrfSupported(): boolean {
  const v = vault as unknown as { isPrfSupported?: () => boolean }
  if (typeof v.isPrfSupported === 'function') return v.isPrfSupported()
  return isPrfSupported()
}

async function vaultGetSecret(id: SecretId): Promise<string | null> {
  try {
    const raw = (
      vault as unknown as {
        getSecret: (i: SecretId) => string | null | Promise<string | null>
      }
    ).getSecret(id)
    const val = raw instanceof Promise ? await raw : raw
    return val ?? null
  } catch {
    return null
  }
}

function hideOfflineBanner(): void {
  if (window.navigator.onLine) offlineBanner.hidden = true
}

// ---------- view scaffolding ----------

function resetRoot(): void {
  if (!root) return
  root.textContent = ''
  root.appendChild(offlineBanner)
  root.appendChild(updateBanner)
  root.appendChild(hiddenBanner)
  statusEl = null
}

function makeStatusEl(): HTMLElement {
  const s = el('div', 'banner banner-error')
  s.hidden = true
  s.setAttribute('role', 'status')
  s.setAttribute('aria-live', 'polite')
  statusEl = s
  return s
}

// ---------- locked view ----------
// First run has no gate: the vault starts ephemeral and the main view shows
// immediately (see init). Only a persistent vault with saved records locks.

/**
 * Status for a PRF-only vault reached through the PIN path. When this
 * screen offers no biometric unlock at all (no WebAuthn PRF in this
 * browser, or the credential lives on another device), pointing at the
 * biometric unlock would be a dead end — the locked view carries a
 * "Wipe vault and start fresh" escape hatch for exactly that case.
 * Exported for tests.
 */
export function pinOnlyVaultMessage(prfSupported: boolean): string {
  return prfSupported
    ? 'This vault was set up with biometrics only — use the biometric unlock.'
    : 'This vault was set up with biometrics only, and biometric unlock is unavailable here (different browser, device, or credentials). Use "Wipe vault and start fresh" below to reset.'
}

/**
 * Dead-end recovery for unlock failures. The localStorage vault-ready flag
 * and the IndexedDB records can disagree (wipe that failed halfway, a
 * biometric bootstrap that never persisted a secret, stale cached shell
 * from an older deploy). Detect the mismatch and drop back to a fresh
 * ephemeral session instead of stranding the user on the locked screen.
 * Returns true when handled.
 */
function handleUnlockDeadEnd(err: string): boolean {
  if (/not set up/i.test(err)) {
    lsRemove(KEYS.vaultReady)
    startEphemeralSession()
    setStatus('Vault has no saved keys — starting a fresh session.')
    return true
  }
  if (/not protected with a PIN/i.test(err)) {
    setStatus(pinOnlyVaultMessage(vaultPrfSupported()))
    return true
  }
  return false
}

/**
 * Destructive reset shared by the Settings "Wipe All Keys" button and the
 * locked view's escape hatch: wipe the vault, drop the settings keys, and
 * drop into a fresh ephemeral session. The non-secret store (transcripts,
 * queue, history) is deliberately NOT wiped here: it holds no key material.
 */
async function wipeVaultAndStartFresh(): Promise<void> {
  await vault.wipeAll()
  lsRemove(KEYS.vaultReady)
  lsRemove(KEYS.provider)
  lsRemove(KEYS.endpoint)
  lsRemove(KEYS.model)
  lsRemove(KEYS.visionModel)
  lsRemove(KEYS.context)
  lsRemove(KEYS.detail)
  lsRemove(KEYS.prefs)
  // Fresh session: no gate, ephemeral vault, main view.
  startEphemeralSession()
}

/** Swap in a fresh ephemeral vault (no gate, session-only secrets) and show the main view. */
function startEphemeralSession(): void {
  vault = new KeyVault({ mode: 'ephemeral' })
  vaultEphemeral = true
  vault.onLock(() => {
    showLocked()
  })
  showMain()
}

function showLocked(): void {
  resetRoot()
  if (!root) return
  // stop playback and drop transcript (and any in-flight stream) on lock
  abortActiveStream()
  playbackActive = false
  try {
    tts.stop()
  } catch {
    // ignore
  }
  const card = el('div', 'card')
  card.appendChild(el('h1', 'app-title', 'ListenToPR'))

  if (vaultEphemeral) {
    // An ephemeral vault has no re-unlock path: lock() dropped its in-memory
    // secrets. A reload starts a fresh session.
    card.appendChild(
      el(
        'p',
        'muted',
        'Session vault locked — secrets saved for this session were dropped. Reload to start fresh.',
      ),
    )
    const reload = el('button', 'btn btn-primary', 'Reload')
    reload.type = 'button'
    reload.addEventListener('click', () => {
      try {
        window.location.reload()
      } catch {
        // ignore — reload unavailable (tests)
      }
    })
    card.appendChild(reload)
    card.appendChild(makeStatusEl())
    root.appendChild(card)
    return
  }

  card.appendChild(el('p', 'muted', 'Vault locked. Enter your PIN to continue.'))

  // Biometric unlock comes first when the environment supports PRF.
  if (vaultPrfSupported()) {
    const bio = el('button', 'btn btn-secondary', 'Unlock with biometrics')
    bio.type = 'button'
    bio.addEventListener('click', () => {
      void (async () => {
        bio.disabled = true
        const { ok, err } = await vaultUnlockPrf()
        if (ok) {
          showMain()
        } else if (err !== undefined && handleUnlockDeadEnd(err)) {
          return
        } else {
          setStatus(err ?? 'Biometric unlock failed. Use your PIN.')
          bio.disabled = false
        }
      })()
    })
    card.appendChild(bio)
  }

  const pin = labeledInput('PIN', 'password')
  const btn = el('button', 'btn btn-primary', 'Unlock')
  btn.type = 'button'

  async function submit(): Promise<void> {
    btn.disabled = true
    const { ok, err } = await vaultUnlockPin(pin.input.value)
    pin.input.value = ''
    if (ok) {
      showMain()
    } else if (err !== undefined && handleUnlockDeadEnd(err)) {
      return
    } else {
      setStatus(err ?? 'Wrong PIN.')
      btn.disabled = false
    }
  }

  btn.addEventListener('click', () => {
    void submit()
  })
  pin.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })
  card.appendChild(pin.wrap)
  card.appendChild(btn)

  // Escape hatch: a PRF-only vault opened where that credential does not
  // exist (different browser or device, no WebAuthn PRF at all) has no
  // working unlock on this screen. Offer the destructive reset here
  // instead of a permanent lockout.
  const wipeBtn = el('button', 'btn btn-danger', 'Wipe vault and start fresh')
  wipeBtn.type = 'button'
  wipeBtn.addEventListener('click', () => {
    if (!window.confirm('Wipe all stored keys? This cannot be undone.')) return
    void (async () => {
      wipeBtn.disabled = true
      try {
        await wipeVaultAndStartFresh()
      } catch (err) {
        setStatus(sanitizeError(err))
        wipeBtn.disabled = false
      }
    })()
  })
  card.appendChild(wipeBtn)

  card.appendChild(makeStatusEl())
  root.appendChild(card)
}

// ---------- settings panel ----------

/** Current voiceschanged handler for the settings voice preview, so a re-render replaces the previous one. */
let voicePreviewHandler: (() => void) | null = null

/** Speak "This is how I sound." with a voice, at the current rate and pitch. */
function speakVoicePreview(voiceName: string): void {
  try {
    const w = window as unknown as {
      speechSynthesis?: { cancel(): void; speak(u: unknown): void }
      SpeechSynthesisUtterance?: new (text: string) => {
        voice?: unknown
        rate?: number
        pitch?: number
      }
    }
    const Ctor = w.SpeechSynthesisUtterance
    if (!w.speechSynthesis || !Ctor) return
    const utter = new Ctor('This is how I sound.')
    const voice = listVoices().find((v) => v.name === voiceName)
    if (voice) utter.voice = voice
    const prefs = tts.getPrefs()
    utter.rate = prefs.rate
    utter.pitch = prefs.pitch
    w.speechSynthesis.cancel()
    w.speechSynthesis.speak(utter)
  } catch {
    // preview is best-effort
  }
}

function buildSettingsPanel(): HTMLDivElement {
  const panel = el('div', 'settings-panel')
  panel.hidden = true
  panel.appendChild(el('h2', 'panel-title', 'Settings'))

  const pat = labeledInput('GitHub personal access token', 'password')

  const providerWrap = el('div', 'field')
  const providerLabel = el('label', 'field-label', 'LLM provider')
  const providerSelect = el('select', 'select')
  PROVIDER_NAMES.forEach(([value, name]) => {
    const opt = el('option', undefined, name)
    opt.value = value
    providerSelect.appendChild(opt)
  })
  providerSelect.value = readProvider()
  providerLabel.appendChild(providerSelect)
  providerWrap.appendChild(providerLabel)

  const endpoint = labeledInput(
    'LLM endpoint (empty = provider default)',
    'text',
    lsGet(KEYS.endpoint) ?? '',
  )
  const model = labeledInput('LLM model', 'text', lsGet(KEYS.model) ?? '')
  const visionModel = labeledInput(
    'Vision model (optional, used when the PR has images)',
    'text',
    lsGet(KEYS.visionModel) ?? '',
  )
  const apiKey = labeledInput('LLM API key', 'password')

  // Advanced: context-budget knobs (persisted non-secret in localStorage).
  const savedBudget = readContextBudget()
  const contextWindow = labeledInput(
    'Context window (tokens)',
    'text',
    savedBudget.contextTokens !== undefined ? String(savedBudget.contextTokens) : '',
  )
  contextWindow.input.placeholder = '128000'
  contextWindow.input.inputMode = 'numeric'
  const maxPerCall = labeledInput(
    'Max per call (tokens)',
    'text',
    savedBudget.maxContextPerCall !== undefined ? String(savedBudget.maxContextPerCall) : '',
  )
  maxPerCall.input.placeholder = '200000'
  maxPerCall.input.inputMode = 'numeric'
  const singleWrap = el('div', 'field')
  const singleLabel = el('label', 'field-label', 'Single-shot when it fits')
  const singleShotBox = el('input')
  singleShotBox.type = 'checkbox'
  singleShotBox.checked = savedBudget.singleShot === true
  singleLabel.appendChild(singleShotBox)
  singleWrap.appendChild(singleLabel)

  // Detail toggle: brief (intent-level) vs detailed (per-file +/-) narration.
  const detailWrap = el('div', 'field')
  const detailLabel = el('label', 'field-label', 'Detailed change narration')
  const detailBox = el('input')
  detailBox.type = 'checkbox'
  detailBox.checked = readDetail() === 'detailed'
  detailLabel.appendChild(detailBox)
  detailWrap.appendChild(detailLabel)

  const autoLock = el(
    'p',
    'muted autolock-indicator',
    'Vault unlocked — it locks automatically after idle.',
  )
  const syncAutoLockText = (): void => {
    autoLock.textContent = vaultEphemeral
      ? 'Session vault — secrets stay in memory and drop when this tab closes.'
      : 'Vault unlocked — it locks automatically after idle.'
  }
  syncAutoLockText()

  // "Remember for next time": migrate the ephemeral vault to a persistent
  // one. PRF (biometric prompt) first when supported, else PIN twice-entry.
  const rememberWrap = el('div', 'remember-wrap')
  if (vaultEphemeral) {
    rememberWrap.appendChild(
      el(
        'p',
        'muted',
        'Secrets are saved for this session only. Remember them for next time?',
      ),
    )
    const rememberDone = (): void => {
      vaultEphemeral = false
      rememberWrap.hidden = true
      syncAutoLockText()
    }
    const pinForm = el('div', 'field-group')
    pinForm.hidden = true
    const pin1 = labeledInput('New PIN (at least 4 characters)', 'password')
    const pin2 = labeledInput('Confirm PIN', 'password')
    const pinSave = el('button', 'btn btn-primary', 'Save on this device')
    pinSave.type = 'button'
    const submitPin = (): void => {
      void (async () => {
        const p = pin1.input.value
        if (p.length < 4) {
          setStatus('PIN must be at least 4 characters.')
          return
        }
        if (p !== pin2.input.value) {
          setStatus('PINs do not match.')
          return
        }
        pinSave.disabled = true
        try {
          await vault.persistToPin(p)
          lsSet(KEYS.vaultReady, '1')
          pin1.input.value = ''
          pin2.input.value = ''
          rememberDone()
          setStatus('Saved on this device — next launch asks for your PIN.', 'info')
        } catch (err) {
          setStatus(sanitizeError(err))
          pinSave.disabled = false
        }
      })()
    }
    pinSave.addEventListener('click', submitPin)
    pin2.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPin()
    })
    pinForm.appendChild(pin1.wrap)
    pinForm.appendChild(pin2.wrap)
    pinForm.appendChild(pinSave)

    if (vaultPrfSupported()) {
      const bio = el('button', 'btn btn-secondary', 'Remember with biometrics')
      bio.type = 'button'
      bio.addEventListener('click', () => {
        void (async () => {
          bio.disabled = true
          try {
            await vault.persistToPrf() // may prompt biometrics once
            lsSet(KEYS.vaultReady, '1')
            rememberDone()
            setStatus(
              'Saved on this device — next launch unlocks with biometrics.',
              'info',
            )
          } catch (err) {
            setStatus(sanitizeError(err))
            bio.disabled = false
          }
        })()
      })
      rememberWrap.appendChild(bio)
      const usePin = el('button', 'btn btn-small', 'Use a PIN instead')
      usePin.type = 'button'
      usePin.addEventListener('click', () => {
        pinForm.hidden = false
        usePin.hidden = true
      })
      rememberWrap.appendChild(usePin)
    } else {
      pinForm.hidden = false
    }
    rememberWrap.appendChild(pinForm)
  }

  // Voice preview: a play button per available system voice.
  const voicePreview = el('details', 'voice-preview')
  voicePreview.appendChild(el('summary', undefined, 'Voice preview'))
  const voicePreviewList = el('div', 'voice-preview-list')
  voicePreview.appendChild(voicePreviewList)
  const fillVoicePreview = (): void => {
    voicePreviewList.textContent = ''
    const voices = listVoices()
    if (voices.length === 0) {
      voicePreviewList.appendChild(
        el('p', 'muted', 'No voices yet — they load asynchronously in this browser.'),
      )
      return
    }
    for (const v of voices) {
      const row = el('div', 'voice-preview-row')
      row.appendChild(el('span', 'voice-preview-name', `${v.name} (${v.lang ?? ''})`))
      const play = el('button', 'btn btn-small', 'Play')
      play.type = 'button'
      play.setAttribute('aria-label', `Preview voice ${v.name}`)
      play.addEventListener('click', () => speakVoicePreview(v.name))
      row.appendChild(play)
      voicePreviewList.appendChild(row)
    }
  }
  fillVoicePreview()
  {
    const synth = (
      window as unknown as {
        speechSynthesis?: {
          addEventListener?: (type: string, cb: () => void) => void
          removeEventListener?: (type: string, cb: () => void) => void
        }
      }
    ).speechSynthesis
    if (voicePreviewHandler && synth?.removeEventListener) {
      synth.removeEventListener('voiceschanged', voicePreviewHandler)
    }
    voicePreviewHandler = fillVoicePreview
    synth?.addEventListener?.('voiceschanged', voicePreviewHandler)
  }

  const save = el('button', 'btn btn-primary', 'Save settings')
  save.type = 'button'
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true
      try {
        const epVal = endpoint.input.value.trim()
        let viaProxyHint = false
        if (epVal !== '') {
          const proxyActive = isProxyActive()
          if (!endpointUsable(epVal, { proxyActive })) {
            // With the proxy active the rejection is the SW's own target
            // rule (https-only, never this origin), not connect-src.
            setStatus(
              proxyActive && !validateProxyTarget(epVal, window.location.origin).ok
                ? PROXY_TARGET_MSG
                : CSP_ENDPOINT_MSG,
            )
            return
          }
          // The SW proxy is what makes a CSP-disallowed endpoint work: say
          // so once instead of the old hard block.
          if (proxyActive && !llmEndpointAllowed(epVal) && !proxyHintShown) {
            proxyHintShown = true
            viaProxyHint = true
          }
        }
        const patVal = pat.input.value.trim()
        if (patVal) {
          // Shape check: catches truncated pastes. Warn, still save —
          // formats evolve and we do not want to block valid new prefixes.
          if (!/^(ghp_|gho_|ghu_|ghs_|github_pat_|[0-9a-fA-F]{40})/.test(patVal)) {
            setStatus(
              'Heads up: that token does not look like a GitHub PAT (expected ghp_…, github_pat_…, gho_… or a 40-char classic token). Saved anyway.',
            )
          }
          await vault.putSecret('github-token', patVal)
          pat.input.value = ''
        }
        const keyVal = apiKey.input.value.trim()
        if (keyVal) {
          await vault.putSecret('llm-api-key', keyVal)
          apiKey.input.value = ''
        }
        lsSet(KEYS.provider, providerSelect.value)
        lsSet(KEYS.endpoint, endpoint.input.value.trim())
        lsSet(KEYS.model, model.input.value.trim())
        lsSet(KEYS.visionModel, visionModel.input.value.trim())
        const ctxRaw = contextWindow.input.value.trim()
        const perCallRaw = maxPerCall.input.value.trim()
        const ctxVal = parseContextTokens(ctxRaw)
        const perCallVal = parseContextTokens(perCallRaw)
        if ((ctxRaw !== '' && ctxVal === null) || (perCallRaw !== '' && perCallVal === null)) {
          setStatus('Context settings must be numbers greater than zero.')
          return
        }
        writeContextSettings({
          ...(ctxVal !== null ? { contextTokens: ctxVal } : {}),
          ...(perCallVal !== null ? { maxContextPerCall: perCallVal } : {}),
          singleShot: singleShotBox.checked,
        })
        lsSet(KEYS.detail, detailBox.checked ? 'detailed' : 'brief')
        setStatus(
          viaProxyHint
            ? 'Settings saved — custom endpoint routed via service worker.'
            : vaultEphemeral
              ? 'Saved for this session'
              : 'Settings saved.',
          'info',
        )
      } catch (err) {
        setStatus(sanitizeError(err))
      } finally {
        save.disabled = false
      }
    })()
  })

  const wipe = el('button', 'btn btn-danger', 'Wipe All Keys')
  wipe.type = 'button'
  wipe.addEventListener('click', () => {
    if (!window.confirm('Wipe all stored keys? This cannot be undone.')) return
    void (async () => {
      wipe.disabled = true
      try {
        await wipeVaultAndStartFresh()
      } catch (err) {
        setStatus(sanitizeError(err))
        wipe.disabled = false
      }
    })()
  })

  panel.appendChild(pat.wrap)
  panel.appendChild(providerWrap)
  panel.appendChild(endpoint.wrap)
  panel.appendChild(model.wrap)
  panel.appendChild(visionModel.wrap)
  panel.appendChild(apiKey.wrap)
  panel.appendChild(rememberWrap)
  panel.appendChild(el('h3', 'panel-advanced-title', 'Advanced'))
  panel.appendChild(
    el('p', 'muted', 'Context budget for transcript generation; empty fields use the defaults.'),
  )
  panel.appendChild(contextWindow.wrap)
  panel.appendChild(maxPerCall.wrap)
  panel.appendChild(singleWrap)
  panel.appendChild(detailWrap)
  panel.appendChild(save)
  panel.appendChild(voicePreview)

  panel.appendChild(autoLock)
  panel.appendChild(wipe)
  return panel
}

// ---------- transcript + controls ----------

function setActiveSentence(si: number, i: number): void {
  if (!transcriptEl) return
  const prev = transcriptEl.querySelector('.sentence.active')
  if (prev) {
    prev.classList.remove('active')
    prev.removeAttribute('aria-current')
  }
  const span = transcriptEl.querySelector(
    `.sentence[data-si="${Number(si)}"][data-i="${Number(i)}"]`,
  )
  if (span) {
    span.classList.add('active')
    span.setAttribute('aria-current', 'true')
    // Smooth scroll only when the user has not asked for reduced motion.
    let reduced = false
    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      reduced = false
    }
    span.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }
  updateDiagramHighlight(si)
}

function clearActiveSentence(): void {
  if (!transcriptEl) return
  const prev = transcriptEl.querySelector('.sentence.active')
  if (prev) {
    prev.classList.remove('active')
    prev.removeAttribute('aria-current')
  }
  clearDiagramHighlight()
}

/** Highlight diagram cards while the diagram-describing section is spoken. */
function updateDiagramHighlight(sectionIndex: number): void {
  const active = diagramSectionSpoken(streamSections[sectionIndex])
  for (const card of diagramsView.cards()) {
    card.classList.toggle('diagram-active', active)
  }
}

function clearDiagramHighlight(): void {
  for (const card of diagramsView.cards()) card.classList.remove('diagram-active')
}

function updateControlStates(state: TtsState): void {
  if (playBtn) {
    playBtn.textContent = state.paused ? 'Resume' : 'Play'
    // While holding for the next section the player stays visually busy.
    playBtn.disabled = (state.playing && !state.paused) || streamHolding
  }
  if (pauseBtn) pauseBtn.disabled = !(state.playing && !state.paused)
  if (stopBtn) stopBtn.disabled = !(state.playing || state.paused) && !streamHolding
}

/** Human scrubber label ("0:45 of 3:10") for a position ratio of the total. */
export function scrubberTimeLabel(ratio: number, totalSeconds: number): string {
  const r = Math.min(1, Math.max(0, ratio))
  return `${formatTime(r * totalSeconds)} of ${formatTime(totalSeconds)}`
}

/** Scrubber time label; reflects the pending (dragging) value while scrubbing. */
function updateScrubber(): void {
  if (!scrubberRange || !scrubberTime) return
  const p = tts.getProgress()
  const max = Math.max(1, p.totalSentences - 1)
  if (!scrubbing) {
    scrubberRange.max = String(max)
    scrubberRange.value = String(Math.min(p.sentenceIndex, max))
  }
  const denom = Math.max(1, Number(scrubberRange.max))
  const v = Number(scrubberRange.value)
  const ratio = Math.min(1, Math.max(0, v / denom))
  const label = scrubberTimeLabel(ratio, p.totalEstimatedSeconds)
  scrubberTime.textContent = label
  // Screen readers hear the time context, not a bare "12 of 40" index.
  scrubberRange.setAttribute('aria-valuetext', label)
}

/** Throttled resume-position persistence while playing. */
function maybeSaveResume(): void {
  if (!store || !currentRef) return
  const now = Date.now()
  if (!shouldWriteResume(lastResumeWriteAt, now)) return
  lastResumeWriteAt = now
  void store.setResume(currentRef, tts.getProgress().sentenceIndex)
}

/** Seek to a saved resume position; returns the status line or null. */
async function applyResume(ref: PullRequestRef): Promise<string | null> {
  if (!store) return null
  let saved: number | null = null
  try {
    saved = await store.getResume(ref)
  } catch {
    saved = null
  }
  if (saved === null || saved <= 0) return null
  tts.seekTo(saved)
  return `Resumed at ${describeResumePosition(streamSections, saved)}`
}

/** Natural end of playback: clear resume, advance the queue. */
function onNaturalEnd(): void {
  playbackActive = false
  const ref = currentRef
  if (!ref) return
  if (store) void store.clearResume(ref)
  if (!store) return
  const myToken = loadToken
  void (async () => {
    const next = await store!.dequeue()
    if (!next) return
    if (myToken !== loadToken) return
    setStatus(`Up next: ${next.title}`, 'info')
    await startLoadRef(next.ref, true)
  })()
}

function onTtsChange(state: TtsState): void {
  if (state.playing || state.paused) {
    setActiveSentence(state.sectionIndex, state.sentenceIndex)
  } else {
    clearActiveSentence()
  }
  updateControlStates(state)
  if (state.playing && !state.paused) {
    void wakeLock
      .acquire()
      .then(() => undefined)
      .catch(() => undefined)
  } else {
    wakeLock.release()
  }
  // Convenience wiring: scrubber, resume autosave, OS media session.
  updateScrubber()
  if (state.playing && !state.paused) {
    maybeSaveResume()
    if (mediaSession && mediaSession.available()) {
      mediaSession.updatePositionState(tts.getProgress())
    }
  } else if (!state.paused && playbackActive) {
    // Speech stopped mid-load: a natural finish only when the stream has no
    // more content coming (otherwise the hold logic below takes over).
    const s = stream
    const moreComing = s !== null && streamStarted && !s.done()
    if (!moreComing) {
      const p = tts.getProgress()
      if (p.totalSentences > 0 && p.sentenceIndex >= p.totalSentences - 1) {
        onNaturalEnd()
      }
    }
  }
  // Streaming pipeline: prefetch ahead of speech, hold at the ready edge.
  const s = stream
  if (s === null || streamResuming) return
  if (state.playing && !state.paused) {
    advanceStream(s, state)
    return
  }
  if (
    streamHoldNeeded(state, {
      active: true,
      started: streamStarted,
      done: s.done(),
    })
  ) {
    streamHolding = true
    streamHoldFlatIndex = flatSentenceCursor(
      streamSections,
      state.sectionIndex,
      state.sentenceIndex,
    )
    setStatus('Generating next section…', 'info')
    updateControlStates(state)
    s.prefetch()
    consumeNextStreamSection(s)
  }
}

/** Stop speech and cancel any in-flight transcript stream. */
function stopPlayback(): void {
  const wasHolding = streamHolding
  playbackActive = false
  abortActiveStream()
  tts.stop()
  if (wasHolding) clearStatus()
}

// ---------- streaming transcript ----------

/** Speech asks the stream for the next section this many sentences early. */
export const PREFETCH_SENTENCES_LEFT = 4

export interface StreamHoldInfo {
  /** A transcript stream is attached. */
  active: boolean
  /** Playback was started for the current stream. */
  started: boolean
  /** The stream has emitted every section. */
  done: boolean
}

/**
 * True when speech is inside the last PREFETCH_SENTENCES_LEFT sentences of
 * the last ready section (or past them): time to generate the next section.
 */
export function shouldPrefetchNow(
  state: TtsState,
  sections: TranscriptSection[],
): boolean {
  if (!state.playing || state.paused) return false
  const last = sections[sections.length - 1]
  if (!last) return false
  if (state.sectionIndex < sections.length - 1) return false
  return last.sentences.length - state.sentenceIndex <= PREFETCH_SENTENCES_LEFT
}

/** True when playback ran out of ready content while the stream has more. */
export function streamHoldNeeded(state: TtsState, info: StreamHoldInfo): boolean {
  return info.active && info.started && info.done === false && !state.playing && !state.paused
}

let stream: TranscriptStreamHandle | null = null
let streamSections: TranscriptSection[] = []
/** Playback was started for the current stream (first section played). */
let streamStarted = false
/** Speech ended at the end of ready content while more sections are coming. */
let streamHolding = false
/**
 * Flat queue cursor (sentence count before the current one) captured when the
 * hold began. Resume must land past it, wherever the cursor drifted since.
 */
let streamHoldFlatIndex: number | null = null
/** Guards against duplicate next() consumers for one stream. */
let streamConsume: Promise<void> | null = null
/** Suppresses hold detection while resuming into freshly appended content. */
let streamResuming = false
/** Bumped whenever the active stream is aborted; invalidates in-flight loads. */
let loadToken = 0

// ---------- diagrams section view ----------

/**
 * Diagrams-section view state for one load. Rendered entries can finish
 * before the transcript title builds their container (a cached mermaid
 * import resolves in microtasks; the load pipeline awaits macrotasks like
 * vault/IDB reads): those entries are parked and flushed when the container
 * is built, so no load loses its diagrams to a lost race.
 */
export interface DiagramsView {
  /** True when the current load has mermaid blocks to show. */
  hasBlocks(): boolean
  /** Record the current load's mermaid blocks (the container is built later). */
  setBlocks(blocks: string[]): void
  /** Build the collapsible section rendered under the transcript title. */
  buildContainer(): HTMLElement
  /** Fill the container, or park the entries until buildContainer runs. */
  deliver(entries: DiagramRenderAllEntry[]): void
  /** Card elements of the current load, in block order. */
  cards(): HTMLElement[]
  /** Drop all state (new load / abort) so stale renders cannot repopulate. */
  reset(): void
}

export function createDiagramsView(): DiagramsView {
  let blocks: string[] = []
  let cards: HTMLElement[] = []
  let body: HTMLElement | null = null
  /** Entries delivered before the container existed, waiting for it. */
  let parked: DiagramRenderAllEntry[] | null = null

  function fill(target: HTMLElement, entries: DiagramRenderAllEntry[]): void {
    target.textContent = ''
    cards = []
    entries.forEach((entry, i) => {
      const card = el('figure', 'diagram-card')
      card.appendChild(el('figcaption', 'diagram-caption', `Diagram ${i + 1}`))
      if (entry.result) {
        card.appendChild(entry.result.element)
      } else {
        card.appendChild(el('p', 'diagram-error', 'Diagram could not be rendered'))
        card.appendChild(el('pre', 'diagram-source', entry.block))
      }
      target.appendChild(card)
      cards.push(card)
    })
  }

  return {
    hasBlocks: () => blocks.length > 0,
    setBlocks(next) {
      blocks = next
    },
    buildContainer() {
      const details = el('details', 'diagrams')
      details.appendChild(el('summary', 'diagrams-summary', 'Diagrams'))
      const target = el('div', 'diagrams-body')
      details.appendChild(target)
      body = target
      cards = []
      if (parked !== null) {
        fill(target, parked)
        parked = null
      }
      return details
    },
    deliver(entries) {
      if (body !== null) fill(body, entries)
      else parked = entries
    },
    cards: () => cards,
    reset() {
      blocks = []
      cards = []
      body = null
      parked = null
    },
  }
}

function abortActiveStream(): void {
  loadToken++
  if (stream !== null) {
    stream.abort()
    stream = null
  }
  streamSections = []
  streamStarted = false
  streamHolding = false
  streamHoldFlatIndex = null
  // Diagrams belong to the aborted load: drop cards and their handles so a
  // stale renderAll cannot repopulate the view (loadToken guard below) and
  // theme rerenders no longer touch discarded elements.
  diagramsView.reset()
  if (diagrams) diagrams.release()
}

function renderStreamTitle(title: string): void {
  if (!transcriptEl) return
  transcriptEl.textContent = ''
  transcriptEl.appendChild(el('h2', 'transcript-title', title))
  if (diagramsView.hasBlocks()) {
    transcriptEl.appendChild(diagramsView.buildContainer())
  }
  transcriptEl.hidden = false
  if (actionsEl) actionsEl.hidden = false
}

/**
 * Render one card per mermaid block into the current load's Diagrams section.
 * Cached handles live in the renderer (theme rerender swaps elements in
 * place); a superseded load (loadToken moved) discards the result. When the
 * section container does not exist yet, the entries are parked inside the
 * view and flushed when renderStreamTitle builds it.
 */
async function renderDiagramCards(blocks: string[], myLoad: number): Promise<void> {
  diagramsView.setBlocks(blocks)
  if (blocks.length === 0 || !diagrams) return
  if (theme) {
    const resolved = theme.getResolved()
    lastDiagramTheme = resolved
    await diagrams.setTheme(resolved)
  }
  const entries = await diagrams.renderAll(blocks)
  if (myLoad !== loadToken) return // superseded by a newer load or abort
  diagramsView.deliver(entries)
}

/** Append one section to the transcript view; indices match the tts queue. */
function appendSectionToView(section: TranscriptSection): void {
  if (!transcriptEl) return
  const si = streamSections.length
  const sec = el('section', 't-section')
  sec.appendChild(el('h3', 't-section-title', section.title))
  const wrap = el('p', 't-sentences')
  section.sentences.forEach((sentence, i) => {
    const span = el('span', 'sentence', sentence)
    span.dataset.si = String(si)
    span.dataset.i = String(i)
    span.tabIndex = 0
    const seekHere = () => {
      setActiveSentence(si, i)
      tts.seekTo(flatSentenceCursor(streamSections, si, i))
    }
    span.addEventListener('click', seekHere)
    span.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        seekHere()
      }
    })
    wrap.appendChild(span)
    wrap.appendChild(document.createTextNode(' '))
  })
  sec.appendChild(wrap)
  // File chips: the files this section narrates, linked to GitHub when the
  // load has a sensible target (PR files tab / file-target blob).
  const files = section.files ?? []
  if (files.length > 0) {
    const chips = el('div', 'file-chips')
    for (const path of files) {
      const href = fileChipHref(currentRef, currentFileTarget, path)
      let chip: HTMLElement
      if (href !== null) {
        const a = el('a', 'file-chip', path)
        a.href = href
        a.target = '_blank'
        a.rel = 'noopener'
        chip = a
      } else {
        chip = el('span', 'file-chip', path)
      }
      chips.appendChild(chip)
    }
    sec.appendChild(chips)
  }
  transcriptEl.appendChild(sec)
}

function appendStreamSection(section: TranscriptSection): void {
  // render before push: appendSectionToView numbers by streamSections.length
  appendSectionToView(section)
  streamSections.push(section)
  tts.appendSections([section])
  renderToc()
}

/** Flat queue position of (sectionIndex, sentenceIndex) within sections. */
export function flatSentenceCursor(
  sections: TranscriptSection[],
  sectionIndex: number,
  sentenceIndex: number,
): number {
  let flat = 0
  for (let s = 0; s < sectionIndex && s < sections.length; s++) {
    flat += sections[s]!.sentences.length
  }
  return flat + sentenceIndex
}

/**
 * Forward steps needed on resume so playback starts at the first sentence
 * appended after the hold began. The cursor may have moved back through the
 * prev buttons during the hold, so the distance is measured from where the
 * cursor is now, not assumed to be one step.
 */
export function resumeSkipCount(holdFlatIndex: number, currentFlatIndex: number): number {
  return Math.max(1, holdFlatIndex - currentFlatIndex + 1)
}

/** Move to the first sentence appended after a natural end, then play. */
function resumeStreamPlayback(): void {
  streamResuming = true
  try {
    // A natural finish leaves the cursor on the last spoken sentence; jump to
    // the first newly appended one so it is not repeated. If the user moved
    // the cursor back during the hold, skip the full distance forward.
    const holdFlatIndex = streamHoldFlatIndex
    streamHoldFlatIndex = null
    if (holdFlatIndex === null) {
      tts.skip(1)
    } else {
      const now = tts.state()
      const steps = resumeSkipCount(
        holdFlatIndex,
        flatSentenceCursor(streamSections, now.sectionIndex, now.sentenceIndex),
      )
      for (let n = 0; n < steps; n++) tts.skip(1)
    }
    tts.play()
  } finally {
    streamResuming = false
  }
}

/** Pull the next section (sharing any prefetched call) and append it. */
function consumeNextStreamSection(s: TranscriptStreamHandle): void {
  if (streamConsume !== null) return
  streamConsume = (async () => {
    let section: TranscriptSection | null = null
    try {
      section = await s.next()
    } catch {
      section = null
    }
    if (stream !== s) return
    if (section === null) {
      // Stream finished while speech waited on it: settle the hold state.
      if (streamHolding) {
        streamHolding = false
        clearStatus()
        updateControlStates(tts.state())
      }
      // Fully generated transcript: cache it for instant reload next time.
      if (
        streamStarted && store && currentRef && currentHeadSha &&
        streamSections.length > 0
      ) {
        void store.putTranscript(currentRef, currentHeadSha, {
          title: currentTitle,
          sections: streamSections,
        })
      }
      return
    }
    appendStreamSection(section)
    if (streamHolding) {
      streamHolding = false
      clearStatus()
      resumeStreamPlayback()
    }
  })().finally(() => {
    streamConsume = null
  })
}

/** Generate ahead when speech nears the end of the ready content. */
function advanceStream(s: TranscriptStreamHandle, state: TtsState): void {
  if (s.done()) return
  if (shouldPrefetchNow(state, streamSections)) {
    s.prefetch()
    consumeNextStreamSection(s)
  }
}

function readPrefs(): { voiceName: string | null; rate: number } {
  try {
    const raw = lsGet(KEYS.prefs)
    if (raw) {
      const parsed = JSON.parse(raw) as { voiceName?: unknown; rate?: unknown }
      return {
        voiceName: typeof parsed.voiceName === 'string' ? parsed.voiceName : null,
        rate:
          typeof parsed.rate === 'number' && parsed.rate >= 0.5 && parsed.rate <= 2.5
            ? parsed.rate
            : 1.0,
      }
    }
  } catch {
    // corrupt prefs — fall through to defaults
  }
  return { voiceName: null, rate: 1.0 }
}

function writePrefs(voiceName: string | null, rate: number): void {
  lsSet(KEYS.prefs, JSON.stringify({ voiceName, rate }))
}

function applyPrefs(): void {
  const prefs = readPrefs()
  try {
    tts.setRate(prefs.rate)
    if (prefs.voiceName) tts.setVoice(prefs.voiceName)
  } catch {
    // ignore — prefs re-applied on next interaction
  }
}

/** (Re)fill the voice select; voices load asynchronously via voiceschanged. */
function populateVoiceSelect(): void {
  if (!voiceSelect) return
  const prefs = readPrefs()
  voiceSelect.textContent = ''
  const defaultOpt = el('option', undefined, 'Default voice')
  defaultOpt.value = ''
  if (!prefs.voiceName) defaultOpt.selected = true
  voiceSelect.appendChild(defaultOpt)
  for (const v of listVoices()) {
    const opt = el('option', undefined, `${v.name} (${v.lang ?? ''})`)
    opt.value = v.name
    if (prefs.voiceName === v.name) opt.selected = true
    voiceSelect.appendChild(opt)
  }
}

/** Current voiceschanged handler, so a re-render replaces the previous one. */
let voiceChangedHandler: (() => void) | null = null

// ---------- sleep timer label ----------

function updateSleepLabel(): void {
  if (!sleepLabelEl) return
  const ms = sleepTimer ? sleepTimer.remainingMs() : null
  sleepLabelEl.textContent = ms === null ? '' : formatTime(ms / 1000)
}

// ---------- controls ----------

function buildControls(): HTMLDivElement {
  const controls = el('div', 'controls')
  controls.hidden = true
  controlsEl = controls

  // Scrubber: range input drives seekTo; time shown as "m:ss of m:ss".
  const scrubRow = el('div', 'scrubber-row')
  const scrub = el('input', 'scrubber-range')
  scrub.type = 'range'
  scrub.min = '0'
  scrub.max = '1'
  scrub.step = '1'
  scrub.value = '0'
  scrub.title = 'Seek'
  scrub.setAttribute('aria-label', 'Seek position')
  scrubberRange = scrub
  scrubbing = false
  const timeLabel = el('span', 'scrubber-time', '0:00 of 0:00')
  scrubberTime = timeLabel
  scrub.addEventListener('pointerdown', (ev) => {
    scrubbing = true
    // Mouse drags get no implicit pointer capture: released outside the
    // track, the pointerup never reaches this element and `scrubbing` sticks
    // (thumb + time label then freeze at the dragged value). Explicit
    // capture guarantees the release is delivered here.
    try {
      scrub.setPointerCapture(ev.pointerId)
    } catch {
      // best-effort — touch/pen keep implicit capture anyway
    }
  })
  scrub.addEventListener('pointerup', () => {
    scrubbing = false
  })
  scrub.addEventListener('pointercancel', () => {
    scrubbing = false
  })
  scrub.addEventListener('lostpointercapture', () => {
    scrubbing = false
  })
  const seekPending = () => {
    const v = Number(scrub.value)
    if (Number.isFinite(v)) tts.seekTo(Math.round(v))
    updateScrubber()
  }
  scrub.addEventListener('input', () => {
    // Pointer drags seek on release ('change'); keyboard arrows seek at once.
    if (scrubbing) updateScrubber()
    else seekPending()
  })
  scrub.addEventListener('change', seekPending)
  scrubRow.appendChild(scrub)
  scrubRow.appendChild(timeLabel)
  controls.appendChild(scrubRow)

  const prevSection = el('button', 'btn btn-icon', '«')
  prevSection.type = 'button'
  prevSection.title = 'Previous section'
  prevSection.setAttribute('aria-label', 'Previous section')
  prevSection.addEventListener('click', () => tts.skipSection(-1))

  const prevSentence = el('button', 'btn btn-icon', '‹')
  prevSentence.type = 'button'
  prevSentence.title = 'Previous sentence'
  prevSentence.setAttribute('aria-label', 'Previous sentence')
  prevSentence.addEventListener('click', () => tts.skip(-1))

  // Replay: restart the CURRENT sentence (seek to it, keep speaking).
  const replayBtn = el('button', 'btn btn-icon', '↻')
  replayBtn.type = 'button'
  replayBtn.title = 'Replay sentence'
  replayBtn.setAttribute('aria-label', 'Replay current sentence')
  replayBtn.addEventListener('click', () => {
    const st = tts.state()
    if (!st.playing && !st.paused) return
    tts.seekTo(flatSentenceCursor(streamSections, st.sectionIndex, st.sentenceIndex))
    tts.play()
  })

  playBtn = el('button', 'btn btn-primary', 'Play')
  playBtn.type = 'button'
  playBtn.disabled = true
  playBtn.addEventListener('click', () => tts.play())

  pauseBtn = el('button', 'btn', 'Pause')
  pauseBtn.type = 'button'
  pauseBtn.disabled = true
  pauseBtn.addEventListener('click', () => tts.pause())

  stopBtn = el('button', 'btn', 'Stop')
  stopBtn.type = 'button'
  stopBtn.disabled = true
  stopBtn.addEventListener('click', () => stopPlayback())

  const nextSentence = el('button', 'btn btn-icon', '›')
  nextSentence.type = 'button'
  nextSentence.title = 'Next sentence'
  nextSentence.setAttribute('aria-label', 'Next sentence')
  nextSentence.addEventListener('click', () => tts.skip(1))

  const nextSection = el('button', 'btn btn-icon', '»')
  nextSection.type = 'button'
  nextSection.title = 'Next section'
  nextSection.setAttribute('aria-label', 'Next section')
  nextSection.addEventListener('click', () => tts.skipSection(1))

  const prefs = readPrefs()
  const speed = el('select', 'select')
  speed.title = 'Playback speed'
  speed.setAttribute('aria-label', 'Playback speed')
  RATE_OPTIONS.forEach((r) => {
    const opt = el('option', undefined, `${r}x`)
    opt.value = String(r)
    if (Math.abs(r - prefs.rate) < 0.001) opt.selected = true
    speed.appendChild(opt)
  })
  speed.addEventListener('change', () => {
    const rate = Number(speed.value)
    tts.setRate(rate)
    const cur = readPrefs()
    writePrefs(cur.voiceName, rate)
  })

  // Pitch: 0.5-2.0, persisted through the tts controller's own prefs.
  const pitchSel = el('select', 'select select-pitch')
  pitchSel.title = 'Pitch'
  pitchSel.setAttribute('aria-label', 'Pitch')
  const curPitch = tts.getPrefs().pitch
  PITCH_OPTIONS.forEach((p) => {
    const opt = el('option', undefined, `${p}`)
    opt.value = String(p)
    if (Math.abs(p - curPitch) < 0.001) opt.selected = true
    pitchSel.appendChild(opt)
  })
  pitchSel.addEventListener('change', () => {
    tts.setPitch(Number(pitchSel.value))
  })

  // Sleep timer presets; expiry pauses playback.
  const sleepSel = el('select', 'select select-sleep')
  sleepSel.title = 'Sleep timer'
  sleepSel.setAttribute('aria-label', 'Sleep timer')
  SLEEP_PRESETS_MIN.forEach((m) => {
    const opt = el('option', undefined, m === 0 ? 'Sleep: off' : `${m} min`)
    opt.value = String(m)
    sleepSel.appendChild(opt)
  })
  sleepSel.addEventListener('change', () => {
    const mins = Number(sleepSel.value)
    if (sleepTimer) {
      if (Number.isFinite(mins) && mins > 0) sleepTimer.start(mins * 60_000)
      else sleepTimer.cancel()
    }
    updateSleepLabel()
  })
  const sleepLabel = el('span', 'sleep-remaining')
  sleepLabelEl = sleepLabel
  if (sleepTickId !== null) {
    window.clearInterval(sleepTickId)
    sleepTickId = null
  }
  sleepTickId = window.setInterval(updateSleepLabel, 500)

  const voice = el('select', 'select select-voice')
  voice.title = 'Voice'
  voice.setAttribute('aria-label', 'Voice')
  voiceSelect = voice
  populateVoiceSelect()
  // getVoices() is empty until voiceschanged fires; rebuild the list (and
  // re-apply the persisted voice) once the browser reports voices.
  const synth = (
    window as unknown as {
      speechSynthesis?: {
        addEventListener?: (type: string, cb: () => void) => void
        removeEventListener?: (type: string, cb: () => void) => void
      }
    }
  ).speechSynthesis
  if (voiceChangedHandler && synth?.removeEventListener) {
    synth.removeEventListener('voiceschanged', voiceChangedHandler)
  }
  voiceChangedHandler = () => {
    populateVoiceSelect()
    applyPrefs()
  }
  synth?.addEventListener?.('voiceschanged', voiceChangedHandler)
  voice.addEventListener('change', () => {
    const name = voice.value
    if (name) tts.setVoice(name)
    const cur = readPrefs()
    writePrefs(name || null, cur.rate)
  })

  controls.appendChild(prevSection)
  controls.appendChild(prevSentence)
  controls.appendChild(replayBtn)
  controls.appendChild(playBtn)
  controls.appendChild(pauseBtn)
  controls.appendChild(stopBtn)
  controls.appendChild(nextSentence)
  controls.appendChild(nextSection)
  controls.appendChild(speed)
  controls.appendChild(voice)
  controls.appendChild(pitchSel)
  controls.appendChild(sleepSel)
  controls.appendChild(sleepLabel)
  return controls
}

// ---------- section TOC ----------

function buildToc(): HTMLDetailsElement {
  const details = el('details', 'toc')
  details.appendChild(el('summary', 'toc-summary', 'Sections'))
  tocListEl = el('ol', 'toc-list')
  details.appendChild(tocListEl)
  tocEl = details
  return details
}

/** Rebuild the clickable section list from streamSections. */
function renderToc(): void {
  if (!tocListEl || !tocEl) return
  const hadItems = tocListEl.childElementCount > 0
  tocListEl.textContent = ''
  streamSections.forEach((section, si) => {
    const li = el('li', 'toc-item')
    const btn = el('button', 'btn btn-small toc-link', section.title)
    btn.type = 'button'
    btn.addEventListener('click', () => {
      tts.seekTo(flatSentenceCursor(streamSections, si, 0))
    })
    li.appendChild(btn)
    tocListEl!.appendChild(li)
  })
  if (!hadItems && streamSections.length > 0) {
    // Side pane stays expanded on wide screens; collapsible on narrow ones.
    let wide = false
    try {
      wide = window.matchMedia('(min-width: 900px)').matches
    } catch {
      wide = false
    }
    tocEl.open = wide
  }
}

// ---------- queue list ----------

/** Re-render the queue list from the store (hidden when empty). */
async function refreshQueueList(): Promise<void> {
  if (!queueListEl || !store) return
  const items = store ? await store.queueAll() : []
  queueListEl.textContent = ''
  if (items.length === 0) {
    queueListEl.hidden = true
    return
  }
  queueListEl.hidden = false
  for (const item of items) {
    const row = el('div', 'queue-row')
    row.appendChild(el('span', 'queue-title', item.title))
    const rm = el('button', 'btn btn-small', 'Remove')
    rm.type = 'button'
    rm.setAttribute('aria-label', `Remove ${item.title} from queue`)
    rm.addEventListener('click', () => {
      if (!store) return
      void store.removeFromQueue(item.ref).then(() => {
        void refreshQueueList()
      })
    })
    row.appendChild(rm)
    queueListEl.appendChild(row)
  }
}

/** Queue whatever is currently in the input box (without loading it). */
async function enqueueFromInput(input: string): Promise<void> {
  const ref = parsePrInput(input)
  if (!ref) {
    setStatus('Enter a pull request URL or owner/repo#123 to queue.')
    return
  }
  if (!store) return
  const same =
    currentRef !== null &&
    currentRef.owner === ref.owner &&
    currentRef.repo === ref.repo &&
    currentRef.number === ref.number
  await store.enqueue({
    ref,
    title: same ? currentTitle : `${ref.owner}/${ref.repo}#${ref.number}`,
    addedAt: Date.now(),
  })
  await refreshQueueList()
  setStatus('Added to queue.', 'info')
}

// ---------- export / share ----------

function buildTranscriptActions(): HTMLDivElement {
  const row = el('div', 'transcript-actions')
  row.hidden = true
  actionsEl = row

  const copy = el('button', 'btn btn-small', 'Copy transcript')
  copy.type = 'button'
  copy.addEventListener('click', () => {
    void copyTranscript()
  })

  const download = el('button', 'btn btn-small', 'Download .txt')
  download.type = 'button'
  download.addEventListener('click', () => {
    downloadTranscript()
  })

  const share = el('button', 'btn btn-small', 'Share')
  share.type = 'button'
  share.addEventListener('click', () => {
    void shareTranscript()
  })

  row.appendChild(copy)
  row.appendChild(download)
  row.appendChild(share)
  return row
}

async function copyTranscript(): Promise<void> {
  const text = transcriptToText(currentTitle, streamSections)
  let ok = false
  try {
    if (window.navigator.clipboard) {
      await window.navigator.clipboard.writeText(text)
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) ok = legacyCopy(text)
  setStatus(
    ok ? 'Transcript copied.' : 'Could not copy the transcript.',
    ok ? 'info' : 'error',
  )
}

/** Pre-async-clipboard fallback: offscreen textarea + execCommand. */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.className = 'offscreen-copy'
    document.body.appendChild(ta)
    ta.select()
    const copied = document.execCommand('copy')
    ta.remove()
    return copied
  } catch {
    return false
  }
}

function downloadTranscript(): void {
  try {
    const text = transcriptToText(currentTitle, streamSections)
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = el('a')
    a.href = url
    const slug =
      currentTitle.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60) || 'transcript'
    a.download = `${slug}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (err) {
    setStatus(sanitizeError(err))
  }
}

async function shareTranscript(): Promise<void> {
  if (typeof window.navigator.share !== 'function') {
    setStatus('Sharing is not supported here.')
    return
  }
  try {
    await window.navigator.share({
      title: currentTitle,
      text: transcriptToText(currentTitle, streamSections),
    })
  } catch {
    // user cancelled the share sheet — nothing to report
  }
}

// ---------- main view ----------

function showMain(): void {
  resetRoot()
  if (!root) return

  const header = el('header', 'header')
  header.appendChild(el('h1', 'app-title', 'ListenToPR'))
  const headerActions = el('div', 'header-actions')

  // Theme: tri-state cycle auto -> light -> dark, driven by the controller.
  const themeBtn = el('button', 'btn btn-secondary', 'Theme')
  themeBtn.type = 'button'
  const syncThemeBtn = (): void => {
    if (!theme) return
    const mode = theme.getMode()
    themeBtn.textContent = `Theme: ${themeModeLabel(mode)}`
    themeBtn.setAttribute('aria-label', themeModeAria(mode))
  }
  themeBtn.addEventListener('click', () => {
    if (!theme) return
    theme.setMode(nextThemeMode(theme.getMode()))
    syncThemeBtn()
  })
  syncThemeBtn()

  const settingsBtn = el('button', 'btn btn-secondary', 'Settings')
  settingsBtn.type = 'button'
  const lockBtn = el('button', 'btn btn-secondary', 'Lock')
  lockBtn.type = 'button'
  lockBtn.addEventListener('click', () => {
    vault.lock() // onLock listener switches to the locked view
  })
  headerActions.appendChild(themeBtn)
  headerActions.appendChild(settingsBtn)
  headerActions.appendChild(lockBtn)
  header.appendChild(headerActions)

  const settingsPanel = buildSettingsPanel()
  settingsBtn.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden
  })

  const main = el('main', 'main')
  main.appendChild(header)
  main.appendChild(settingsPanel)
  main.appendChild(makeStatusEl())

  if (shouldShowWakeLockFallback() && lsGet(KEYS.wlDismissed) !== '1') {
    const wlBanner = el(
      'div',
      'banner banner-warn',
      'Screen may sleep during playback',
    )
    const dismiss = el('button', 'btn btn-small', 'Dismiss')
    dismiss.type = 'button'
    dismiss.addEventListener('click', () => {
      wlBanner.hidden = true
      lsSet(KEYS.wlDismissed, '1')
    })
    wlBanner.appendChild(dismiss)
    main.appendChild(wlBanner)
  }

  const form = el('form', 'pr-form')
  const urlInput = el('input', 'field-input pr-input')
  urlInput.type = 'text'
  urlInput.autocomplete = 'off'
  urlInput.placeholder = 'PR URL or owner/repo#123'
  urlInput.setAttribute('aria-label', 'Pull request URL')
  listenBtn = el('button', 'btn btn-primary', 'Listen')
  listenBtn.type = 'submit'
  const queueBtn = el('button', 'btn', 'Add to queue')
  queueBtn.type = 'button'
  queueBtn.addEventListener('click', () => {
    void enqueueFromInput(urlInput.value.trim())
  })
  // Demo: bundled transcript, no network, no keys — instant TTS.
  const demoBtn = el('button', 'btn btn-small', 'Try a sample')
  demoBtn.type = 'button'
  demoBtn.addEventListener('click', () => {
    void loadDemo()
  })
  form.appendChild(urlInput)
  form.appendChild(listenBtn)
  form.appendChild(queueBtn)
  form.appendChild(demoBtn)
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void startLoad(urlInput.value.trim())
  })
  main.appendChild(form)

  // Bookmarklet chip: drag to the bookmarks bar, click on any GitHub PR page.
  const bookmarklet = el('a', 'bookmarklet-chip', 'Click to listen')
  bookmarklet.href = BOOKMARKLET_HREF
  bookmarklet.title =
    'Drag me to your bookmarks bar. On any GitHub pull request page, click the bookmark to listen to it in ListenToPR.'
  bookmarklet.setAttribute('aria-label', 'Click to listen bookmarklet — drag to your bookmarks bar')
  bookmarklet.draggable = true
  // The page CSP (script-src 'self') blocks javascript: navigation, so a
  // plain click can do nothing here; copy the bookmarklet instead. Dragging
  // the chip to the bookmarks bar keeps working via the href.
  bookmarklet.addEventListener('click', (e) => {
    e.preventDefault()
    void copyBookmarklet().then((msg) => setStatus(msg, 'info'))
  })
  main.appendChild(bookmarklet)

  queueListEl = el('div', 'queue-list')
  queueListEl.hidden = true
  main.appendChild(queueListEl)
  void refreshQueueList()

  loadingEl = el('p', 'muted loading')
  loadingEl.textContent = 'Loading pull request…'
  loadingEl.hidden = true
  main.appendChild(loadingEl)

  // TOC beside the transcript: side pane on wide screens, collapsible above
  // it on narrow ones (the details element collapses without JavaScript).
  const split = el('div', 'main-split')
  split.appendChild(buildToc())
  transcriptEl = el('article', 'transcript')
  transcriptEl.hidden = true
  split.appendChild(transcriptEl)
  main.appendChild(split)

  main.appendChild(buildTranscriptActions())
  main.appendChild(buildControls())
  root.appendChild(main)

  applyPrefs()

  if (pendingAutoStartUrl) {
    urlInput.value = pendingAutoStartUrl
    const url = pendingAutoStartUrl
    pendingAutoStartUrl = null
    void startLoad(url)
  }
}

// ---------- PR load flow ----------

function prUrlString(ref: PullRequestRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`
}

async function startLoad(url: string): Promise<void> {
  if (!url) {
    setStatus('Enter a GitHub pull request URL or owner/repo#123.')
    return
  }
  const route = routeInput(url)
  if (route.kind === 'error') {
    setStatus(route.message)
    return
  }
  if (route.kind === 'pr') {
    await startLoadRef(route.ref)
    return
  }
  if (route.kind === 'paste') {
    const pr = parsePastedContent(route.text)
    if (pr === null) {
      setStatus(
        'Could not find PR content in that text — paste the description plus the diff.',
      )
      return
    }
    await startLoadPseudo(pr, null)
    return
  }
  await startLoadTarget(route)
}

/**
 * Best-effort "What's New" delta for a returning listener: commits since the
 * last listen, summarized against the previously heard transcript. Any
 * failure degrades to the plain cached transcript.
 */
async function buildDelta(
  ref: PullRequestRef,
  pr: PullRequestData,
  sinceSha: string,
  cfg: LlmConfig,
  token: string,
  endpointOk: boolean,
): Promise<TranscriptSection | null> {
  if (!store || !endpointOk) return null
  try {
    const previous = await store.getCachedTranscript(ref, sinceSha)
    if (!previous) return null
    const last = await store.lastListen(ref)
    const sinceIso = last ? new Date(last.at).toISOString() : ''
    const commits = await fetchNewCommits(ref, sinceIso, token)
    if (commits.length === 0) return null
    return await buildDeltaSection(cfg, pr, commits, summarizeTranscript(previous), {
      detail: readDetail(),
      chat: makeChatFn(),
    })
  } catch {
    // Delta is best-effort: fall back to the plain cached transcript.
    return null
  }
}

/**
 * Load a fully-generated transcript (cache hit): render everything, apply
 * the saved resume position, and start playing.
 */
async function loadFullTranscript(
  ref: PullRequestRef,
  headSha: string | null,
  title: string,
  sections: TranscriptSection[],
  statusMsg: string,
  skipResume: boolean,
): Promise<void> {
  stream = null
  streamSections = []
  streamStarted = false
  streamHolding = false
  streamHoldFlatIndex = null
  playbackActive = false
  renderStreamTitle(title)
  for (const section of sections) {
    appendSectionToView(section)
    streamSections.push(section)
  }
  tts.load({ title, sections })
  applyPrefs()
  if (controlsEl) controlsEl.hidden = false
  updateControlStates(tts.state())
  renderToc()
  updateScrubber()
  if (mediaSession && mediaSession.available()) mediaSession.setMetadata(title)
  if (store) {
    void store.recordListen(ref, headSha ?? '')
    // A What's-New delta was prepended to cached sections: persist the merged
    // transcript under this head, or it exists only in memory and every later
    // load of the same head regenerates the delta through the LLM.
    if (headSha !== null && skipResume) {
      void store.putTranscript(ref, headSha, { title, sections })
    }
  }
  // Resume where the listener left off — skipped when a What's-New delta was
  // prepended: the delta must play from the top.
  let resumeMsg: string | null = null
  if (!skipResume) resumeMsg = await applyResume(ref)
  setStatus(resumeMsg ?? statusMsg, 'info')
  playbackActive = true
  tts.play()
}

/**
 * Shared load preamble: supersede any in-flight stream (which invalidates
 * older loads), stop the old speech, and move the app onto a new ref.
 */
function beginLoad(ref: PullRequestRef): number {
  clearStatus()
  // New load supersedes any in-flight stream (also invalidates older loads).
  abortActiveStream()
  playbackActive = false
  // Stop the old PR's speech BEFORE currentRef moves: onTtsChange keeps
  // firing while the old transcript's utterances advance during the fetch
  // window, and maybeSaveResume would write the old position under the NEW
  // PR's resume key (first write immediate: lastResumeWriteAt resets to 0).
  try {
    tts.stop()
  } catch {
    // ignore — nothing was playing
  }
  lastResumeWriteAt = 0
  currentRef = ref
  currentFileTarget = null
  const myLoad = loadToken
  if (listenBtn) listenBtn.disabled = true
  if (loadingEl) loadingEl.hidden = false
  if (transcriptEl) transcriptEl.hidden = true
  if (actionsEl) actionsEl.hidden = true
  if (controlsEl) controlsEl.hidden = true
  return myLoad
}

function endLoad(): void {
  if (listenBtn) listenBtn.disabled = false
  if (loadingEl) loadingEl.hidden = true
}

function handleLoadError(err: unknown): void {
  if (!window.navigator.onLine || err instanceof TypeError) {
    showOfflineBanner()
  } else {
    setStatus(sanitizeError(err))
  }
}

async function startLoadRef(ref: PullRequestRef, fromQueue = false): Promise<void> {
  const myLoad = beginLoad(ref)
  try {
    const token = (await vaultGetSecret('github-token')) ?? ''
    // Silent null (locked vault, or secret saved under a different unlock
    // method) used to become an empty bearer -> misleading 401. Surface it
    // and continue tokenless (public PRs still work).
    if (token === '' && !vault.isUnlocked()) {
      setStatus('Vault locked — continuing without a GitHub token')
    }
    const pr = await fetchPullRequest(ref, token)
    if (myLoad !== loadToken) return
    await loadPulledPr(pr, myLoad, fromQueue)
  } catch (err) {
    handleLoadError(err)
  } finally {
    endLoad()
  }
}

/** file / commit / compare URLs: fetch into pseudo-PR data, then the shared pipeline. */
async function startLoadTarget(
  route: Extract<InputRoute, { kind: 'file' | 'commit' | 'compare' }>,
): Promise<void> {
  // Key the load under the target's pseudo ref (unique per path/sha/range):
  // resume positions, listen history and the transcript cache all hang off
  // it, and the fetched pseudo-PR carries the same ref (pseudoTargetRef is
  // deterministic), so currentRef and pr.ref agree.
  const myLoad = beginLoad(pseudoTargetRef(route))
  currentFileTarget = route.kind === 'file' ? route.file : null
  try {
    // Token optional everywhere; empty token = unauthenticated GitHub.
    const token = (await vaultGetSecret('github-token')) ?? ''
    const pr =
      route.kind === 'file'
        ? await fetchFileContent(route.file, token)
        : route.kind === 'commit'
          ? await fetchCommit(route.commit.owner, route.commit.repo, route.commit.sha, token)
          : await fetchCompare(
              route.compare.owner,
              route.compare.repo,
              route.compare.base,
              route.compare.head,
              token,
            )
    if (myLoad !== loadToken) return
    await loadPulledPr(pr, myLoad, false)
  } catch (err) {
    handleLoadError(err)
  } finally {
    endLoad()
  }
}

/** Pasted PR text: already-parsed pseudo-PR data, no network. */
async function startLoadPseudo(
  pr: PullRequestData,
  fileTarget: GitFileTarget | null,
): Promise<void> {
  const myLoad = beginLoad(pr.ref)
  currentFileTarget = fileTarget
  try {
    await loadPulledPr(pr, myLoad, false)
  } catch (err) {
    handleLoadError(err)
  } finally {
    endLoad()
  }
}

/** Demo mode: bundled transcript, no network, no keys, instant TTS. */
async function loadDemo(): Promise<void> {
  const myLoad = beginLoad(DEMO_REF)
  currentHeadSha = 'demo'
  currentTitle = DEMO_TRANSCRIPT.title
  void renderDiagramCards([...DEMO_MERMAID_BLOCKS], myLoad)
  try {
    await loadFullTranscript(
      DEMO_REF,
      'demo',
      DEMO_TRANSCRIPT.title,
      DEMO_TRANSCRIPT.sections,
      'Demo transcript',
      true,
    )
  } catch (err) {
    handleLoadError(err)
  } finally {
    endLoad()
  }
}

/**
 * Shared pipeline once a PullRequestData is in hand (real PR, file/commit/
 * compare pseudo-PR, or pasted text): diagrams, cache lookup, streaming.
 */
async function loadPulledPr(
  pr: PullRequestData,
  myLoad: number,
  fromQueue: boolean,
): Promise<void> {
  const ref = pr.ref
  const title = sanitizeLine(pr.title) || 'Pull request'
  const headSha = pr.headSha ?? null
  currentHeadSha = headSha
  currentTitle = title
  // Big-PR honesty: say when lockfiles/generated files were skipped.
  const fileNote = bigPrStatus(pr)
  if (fileNote) setStatus(fileNote, 'info')
  // Diagram cards for this load; renderStreamTitle builds their container
  // later, and entries that finish first are parked until then (a newer
  // load's loadToken still drops the whole result).
  void renderDiagramCards(pr.mermaidBlocks, myLoad)

  const endpoint = lsGet(KEYS.endpoint) ?? ''
  // Custom endpoints the CSP would block still work when the service-worker
  // proxy controls the page (endpointUsable folds that in).
  const endpointOk = endpointUsable(endpoint, { proxyActive: isProxyActive() })
  const visionModel = (lsGet(KEYS.visionModel) ?? '').trim()
  const cfg: LlmConfig = {
    provider: readProvider(),
    endpoint,
    apiKey: (await vaultGetSecret('llm-api-key')) ?? '',
    model: lsGet(KEYS.model) ?? '',
    ...(visionModel !== '' ? { visionModel } : {}),
  }
  if (myLoad !== loadToken) return

  // ---------- cache hit: instant load, no LLM ----------
  let cached: Transcript | null = null
  if (store && headSha) {
    cached = await store.getCachedTranscript(ref, headSha)
    if (myLoad !== loadToken) return
  }
  if (cached !== null) {
    let sections = cached.sections
    let deltaApplied = false
    if (store && headSha) {
      const latestSha = await store.latestCachedSha(ref)
      if (myLoad !== loadToken) return
      if (shouldBuildDelta(latestSha, headSha) && latestSha !== null) {
        const token = (await vaultGetSecret('github-token')) ?? ''
        const delta = await buildDelta(ref, pr, latestSha, cfg, token, endpointOk)
        if (myLoad !== loadToken) return
        if (delta) {
          sections = [delta, ...sections]
          deltaApplied = true
        }
      }
    }
    const cacheStatus = fromQueue ? `Up next: ${title}` : 'Loaded from cache'
    await loadFullTranscript(
      ref,
      headSha,
      title,
      sections,
      fileNote !== null ? `${cacheStatus} — ${fileNote}` : cacheStatus,
      deltaApplied,
    )
    return
  }

  // ---------- cache miss: stream as before ----------
  if (!endpointOk) {
    // Neither connect-src nor the SW proxy can reach that endpoint; CSP
    // would turn the fetch into a TypeError and show a false "offline"
    // banner. Fail with the real cause instead.
    setStatus(CSP_ENDPOINT_MSG)
    return
  }
  // images are best-effort: continue on failure
  const token = (await vaultGetSecret('github-token')) ?? ''
  const settled = await Promise.allSettled(
    pr.imageUrls.map((u) => fetchImageAsDataUrl(u, token)),
  )
  const imageDataUrls = settled
    .filter(
      (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled',
    )
    .map((r) => r.value)
  if (myLoad !== loadToken) return
  // Context budget: only passed when the user set at least one knob, so an
  // untouched install keeps the classic fixed batching. Single-shot can
  // only fire when opted in; a chat wrapper watches for it so the status
  // line can note the single pass (see isSingleShotMessages).
  const budget = readContextBudget()
  const budgeted =
    budget.contextTokens !== undefined ||
    budget.maxContextPerCall !== undefined ||
    budget.singleShot !== undefined
  let singlePass = false
  const baseChat = makeChatFn()
  let chatFn: typeof chat = baseChat
  if (budgeted && budget.singleShot === true) {
    chatFn = (config, messages, opts) => {
      if (!singlePass && isSingleShotMessages(messages)) singlePass = true
      return baseChat(config, messages, opts)
    }
  }
  const s = createTranscriptStream(cfg, pr, {
    imageDataUrls,
    detail: readDetail(),
    ...(budgeted ? { budget } : {}),
    chat: chatFn,
  })
  stream = s
  streamSections = []
  renderStreamTitle(title)
  tts.load({ title, sections: [] })
  applyPrefs()
  if (mediaSession && mediaSession.available()) mediaSession.setMetadata(title)
  const first = await s.next()
  if (myLoad !== loadToken) return
  if (first === null) {
    stream = null
    setStatus('Could not generate a transcript for this pull request.')
    return
  }
  appendStreamSection(first)
  updateControlStates(tts.state())
  if (controlsEl) controlsEl.hidden = false
  streamStarted = true
  if (store) void store.recordListen(ref, headSha ?? '')
  const resumeMsg = await applyResume(ref)
  if (myLoad !== loadToken) return
  const note = initialStreamStatus(resumeMsg, singlePass) ?? fileNote
  if (note) setStatus(note, 'info')
  playbackActive = true
  tts.play()
  // Later sections arrive via onTtsChange prefetching (advanceStream).
}

// ---------- share target / query routing ----------

function routeSharedUrl(): string | null {
  let ref: PullRequestRef | null = null
  try {
    const params = new URLSearchParams(window.location.search)
    const pr = params.get('pr')
    if (pr) ref = parsePrInput(pr)
    if (!ref) {
      for (const key of ['text', 'url']) {
        const val = params.get(key)
        if (val) {
          ref = findPrUrl(val)
          if (ref) break
        }
      }
    }
  } catch {
    return null
  }
  return ref ? prUrlString(ref) : null
}

// ---------- offline + service worker ----------

function wireOffline(): void {
  window.addEventListener('online', hideOfflineBanner)
  window.addEventListener('offline', showOfflineBanner)
  if (!window.navigator.onLine) showOfflineBanner()
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in window.navigator)) return
  const secure =
    window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  if (!secure) return
  // Resolve against the document base so scoped deploys (e.g.
  // https://host/listentopr/) register <base>/sw.js, not host root.
  const swUrl = new URL('sw.js', document.baseURI).href
  void window.navigator.serviceWorker
    .register(swUrl)
    .then((registration) => {
      updateCtrl = createUpdateController({
        registration,
        container: window.navigator.serviceWorker,
        document,
        reloadFn: () => window.location.reload(),
      })
      updateCtrl.onUpdateReady(() => {
        updateBanner.hidden = false
      })
      updateCtrl.schedule()
    })
    .catch(() => undefined)
}

// ---------- init ----------

function init(): void {
  root = document.getElementById('app')
  if (!root) return
  theme = createThemeController()
  theme.apply()
  theme.listen()
  theme.onChange((_mode, resolved) => {
    // Re-render open diagram cards in the new mermaid theme; skip when the
    // resolved theme did not change (e.g. auto -> explicit system match).
    if (resolved === lastDiagramTheme) return
    lastDiagramTheme = resolved
    if (diagrams && diagramsView.cards().length > 0) void diagrams.setTheme(resolved)
  })
  diagrams = createDiagramRenderer()
  vault = new KeyVault()
  tts = createTtsController()
  wakeLock = createWakeLockController()
  store = createStore()
  sleepTimer = createSleepTimer()
  sleepTimer.onExpire(() => {
    const action = sleepExpireAction(tts.state(), streamHolding)
    if (action === 'pause') {
      tts.pause()
    } else if (action === 'stop') {
      // Mid-hold nothing is speaking, so pause() is a guarded no-op — yet
      // the hold pipeline would call tts.play() once the in-flight section
      // lands, playing audio well past the deadline. Tear the hold (and its
      // stream) down instead.
      stopPlayback()
    }
    setStatus('Sleep timer elapsed — playback paused.', 'info')
    updateSleepLabel()
  })
  keyboard = createKeyboardController({ tts, document, onStop: stopPlayback })
  keyboard.attach()
  mediaSession = createMediaSessionController()
  if (mediaSession.available()) mediaSession.wireHandlers(tts)
  // Auto-lock is an idle timer: any user activity resets it, so active
  // listening never gets cut off mid-playback.
  for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
    document.addEventListener(
      type,
      () => {
        vault.notifyActivity()
      },
      { passive: true },
    )
  }
  document.addEventListener('visibilitychange', () => {
    vault.notifyActivity()
    // Background honesty: browsers suspend speech synthesis in hidden tabs.
    if (document.hidden) {
      const st = tts.state()
      if (st.playing && !st.paused) hiddenBanner.hidden = false
    } else {
      hiddenBanner.hidden = true
    }
  })
  tts.onChange(onTtsChange)
  registerServiceWorker()
  wireOffline()
  pendingAutoStartUrl = routeSharedUrl()

  // First run = no gate: probe for saved persistent-vault records; without
  // any, start an ephemeral session vault and go straight to the main view.
  // A later launch with records shows the unlock screen (biometric button
  // first when supported).
  void (async (): Promise<void> => {
    let hasRecords = false
    try {
      hasRecords = await vault.hasSecrets()
    } catch {
      hasRecords = false
    }
    if (hasRecords) {
      vaultEphemeral = false
      vault.onLock(() => {
        showLocked()
      })
      showLocked()
    } else {
      startEphemeralSession()
    }
  })()
}

init()
