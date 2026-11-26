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
}

export interface TtsController {
  load(transcript: Transcript): void
  play(): void
  pause(): void
  resume(): void
  stop(): void
  /** Skip to next/previous sentence. */
  skip(delta: 1 | -1): void
  /** Skip to next/previous section. */
  skipSection(delta: 1 | -1): void
  setRate(rate: number): void
  setVoice(voiceName: string): void
  getPrefs(): TtsPrefs
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

export interface LlmConfig {
  endpoint: string
  apiKey: string
  model: string
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  text: string
  /** Optional data-URL images attached to this message. */
  images?: string[]
}
