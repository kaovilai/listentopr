// Shared contracts for ListenToPR modules. Do not change signatures
// without updating every consumer; modules are implemented separately.

// ---------- GitHub PR ingestion ----------

export interface PullRequestRef {
  owner: string
  repo: string
  number: number
}

export interface PrFile {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export interface PrComment {
  author: string
  body: string
}

export interface PrReview {
  author: string
  state: string
  body: string
}

export interface PullRequestData {
  ref: PullRequestRef
  title: string
  body: string
  author: string
  /** Head commit SHA of the PR branch, when the API provides it. */
  headSha?: string
  additions: number
  deletions: number
  changedFiles: number
  files: PrFile[]
  comments: PrComment[]
  reviews: PrReview[]
  /** Image URLs extracted from body + comments (markdown + <img>). */
  imageUrls: string[]
  /** Raw mermaid blocks extracted from body + comments. */
  mermaidBlocks: string[]
}

// ---------- Transcript ----------

export interface TranscriptSection {
  id: string
  title: string
  sentences: string[]
}

export interface Transcript {
  title: string
  sections: TranscriptSection[]
}

// ---------- Key vault ----------

/** IDs of secrets managed by the vault. */
export type SecretId = 'github-token' | 'llm-api-key'

/** Encrypted-at-rest record persisted in IndexedDB. Never holds plaintext. */
export interface StoredSecret {
  id: SecretId
  ciphertext: ArrayBuffer
  iv: ArrayBuffer
  salt: ArrayBuffer
  /** 1 for PIN-derived, 2 for WebAuthn-PRF-derived. */
  method: 1 | 2
  createdAt: number
}

export interface VaultOptions {
  dbName?: string
  /** Idle auto-lock in ms; 0 disables. Default 15 min. */
  idleTimeoutMs?: number
}

// ---------- TTS ----------

export interface TtsState {
  playing: boolean
  paused: boolean
  sectionIndex: number
  sentenceIndex: number
}

export interface TtsPrefs {
  voiceName: string | null
  rate: number
  pitch: number
}

/** Playback position + spoken-time estimate (words / 150 wpm). */
export interface TtsProgress {
  sentenceIndex: number
  totalSentences: number
  estimatedSeconds: number
  totalEstimatedSeconds: number
}

export interface TtsController {
  load(transcript: Transcript): void
  /** Append sections to an already-loaded transcript (streaming). */
  appendSections(sections: TranscriptSection[]): void
  /** Jump to an absolute sentence index (clamped). */
  seekTo(sentenceIndex: number): void
  play(): void
  pause(): void
  resume(): void
  stop(): void
  /** Skip to next/previous sentence. */
  skip(delta: 1 | -1): void
  /** Skip to next/previous section. */
  skipSection(delta: 1 | -1): void
  setRate(rate: number): void
  setPitch(pitch: number): void
  setVoice(voiceName: string): void
  getPrefs(): TtsPrefs
  getProgress(): TtsProgress
  state(): TtsState
  onChange(cb: (state: TtsState, currentSentence: string | null) => void): () => void
}

// ---------- Wake lock ----------

export interface WakeLockController {
  /** Request the screen wake lock. No-op if already held. */
  acquire(): Promise<boolean>
  /** Release the wake lock if held. */
  release(): void
  /** True while the lock is held. */
  isHeld(): boolean
  onChange(cb: (held: boolean) => void): () => void
}

// ---------- LLM ----------

export type LlmProvider = 'openai' | 'anthropic' | 'gemini'

export interface LlmConfig {
  /** API dialect. Default 'openai'. */
  provider?: LlmProvider
  /** Base URL. When empty, use the provider's public default. */
  endpoint?: string
  apiKey: string
  model: string
  /** Optional separate model for image-bearing calls; falls back to model. */
  visionModel?: string
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  text: string
  /** Optional data-URL images attached to this message. */
  images?: string[]
}

// ---------- Context-window budgeting ----------

/** Context-window-aware generation knobs. All fields optional. */
export interface TranscriptBudget {
  /** Model context window, tokens. Default 128000. */
  contextTokens?: number
  /** Max input tokens per LLM call. Default 200000. */
  maxContextPerCall?: number
  /** When true and the whole PR fits contextTokens, use one single call. */
  singleShot?: boolean
}

// ---------- Streaming transcript ----------

/**
 * Lazily-generated transcript: sections arrive as the LLM produces them,
 * each call carrying only rolling summaries of prior sections (flat context
 * regardless of PR size). Start speech after the first section.
 */
export interface TranscriptStream extends AsyncIterable<TranscriptSection> {
  /**
   * Kick off generation of the next section now. Called ahead of need
   * (speech entering the last ~4 sentences of the last ready section).
   */
  prefetch(): void
  /** True once every section has been emitted. */
  done(): boolean
  /** Cancel any in-flight generation and mark the stream done. */
  abort(): void
}
