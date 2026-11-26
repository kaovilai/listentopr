// speechSynthesis controller (DVC section 3).
// Everything flows through injectable deps so tests need no globals.
import type { Transcript, TtsController, TtsPrefs, TtsState } from './types'

export interface SpeechSynthesisVoiceLike {
  name: string
  lang?: string
}

export interface SpeechSynthesisUtteranceLike {
  text: string
  rate?: number
  voice?: SpeechSynthesisVoiceLike | null
  onend?: (() => void) | null
  onerror?: ((event: unknown) => void) | null
}

export interface SpeechSynthesisLike {
  speak(utterance: SpeechSynthesisUtteranceLike): void
  cancel(): void
  pause(): void
  resume(): void
  getVoices(): SpeechSynthesisVoiceLike[]
}

export type UtteranceCtor = new (text: string) => SpeechSynthesisUtteranceLike

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface TtsControllerDeps {
  speechSynthesis: SpeechSynthesisLike
  SpeechSynthesisUtterance: UtteranceCtor
  localStorage: StorageLike
}

const PREFS_KEY = 'listentopr.tts.prefs'

// ---- fallbacks for environments without the Web Speech API ----

class NoopUtterance implements SpeechSynthesisUtteranceLike {
  text: string
  rate = 1
  voice: SpeechSynthesisVoiceLike | null = null
  onend: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

const noopSynth: SpeechSynthesisLike = {
  speak: () => {},
  cancel: () => {},
  pause: () => {},
  resume: () => {},
  getVoices: () => [],
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

function resolveDefaults(): TtsControllerDeps {
  const g = globalThis as {
    speechSynthesis?: SpeechSynthesisLike
    SpeechSynthesisUtterance?: UtteranceCtor
    localStorage?: StorageLike
  }
  return {
    speechSynthesis: g.speechSynthesis ?? noopSynth,
    SpeechSynthesisUtterance: g.SpeechSynthesisUtterance ?? NoopUtterance,
    localStorage: g.localStorage ?? memoryStorage(),
  }
}

/** Wrap synth.getVoices(); empty array if the synth has none. */
export function listVoices(
  deps?: { speechSynthesis?: SpeechSynthesisLike },
): SpeechSynthesisVoiceLike[] {
  const synth = deps?.speechSynthesis ?? resolveDefaults().speechSynthesis
  try {
    return synth.getVoices()
  } catch {
    return []
  }
}

function clampRate(rate: number): number {
  return Math.min(2.0, Math.max(0.8, rate))
}

interface QueueItem {
  sectionIndex: number
  sentenceIndex: number
  text: string
}

export function createTtsController(deps: Partial<TtsControllerDeps> = {}): TtsController {
  const d: TtsControllerDeps = { ...resolveDefaults(), ...deps }
  const listeners = new Set<(state: TtsState, currentSentence: string | null) => void>()

  let queue: QueueItem[] = []
  let idx = 0
  let playing = false
  let paused = false
  /** Bumped on every speak/jump/stop; stale utterance events are dropped. */
  let generation = 0
  let rate = 1
  let voiceName: string | null = null

  function voiceAvailable(name: string): boolean {
    try {
      return d.speechSynthesis.getVoices().some((v) => v.name === name)
    } catch {
      return false
    }
  }

  // Load persisted prefs; tolerate corrupted JSON and unavailable voices.
  try {
    const raw = d.localStorage.getItem(PREFS_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as { rate?: unknown; voiceName?: unknown }
        if (typeof p.rate === 'number' && Number.isFinite(p.rate)) rate = clampRate(p.rate)
        if (typeof p.voiceName === 'string') voiceName = p.voiceName
      }
    }
  } catch {
    // corrupted prefs -> keep defaults
  }
  if (voiceName !== null && !voiceAvailable(voiceName)) {
    // getVoices() returns [] until voiceschanged fires in real browsers;
    // only drop a stored voice once the voice list is loaded without it.
    let voicesLoaded = false
    try {
      voicesLoaded = d.speechSynthesis.getVoices().length > 0
    } catch {
      voicesLoaded = false
    }
    if (voicesLoaded) voiceName = null
  }

  function persistPrefs(): void {
    const prefs: TtsPrefs = { voiceName, rate }
    try {
      d.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // storage unavailable -> prefs stay in memory only
    }
  }

  function currentState(): TtsState {
    const item = queue[idx]
    return {
      playing,
      paused,
      sectionIndex: item?.sectionIndex ?? 0,
      sentenceIndex: item?.sentenceIndex ?? 0,
    }
  }

  function currentSentence(): string | null {
    if (!playing) return null
    return queue[idx]?.text ?? null
  }

  function fire(): void {
    const state = currentState()
    const sentence = currentSentence()
    for (const cb of listeners) cb(state, sentence)
  }

  function resolveVoice(): SpeechSynthesisVoiceLike | null {
    if (voiceName === null) return null
    try {
      return d.speechSynthesis.getVoices().find((v) => v.name === voiceName) ?? null
    } catch {
      return null
    }
  }

  function finish(): void {
    playing = false
    paused = false
    fire()
  }

  function advance(): void {
    if (idx + 1 < queue.length) {
      idx++
      speakCurrent()
      fire()
    } else {
      finish()
    }
  }

  // iOS-safe chaining: exactly ONE utterance is ever live; onend/onerror
  // advance to the next sentence.
  function speakCurrent(): void {
    const item = queue[idx]
    if (item === undefined) {
      finish()
      return
    }
    generation++
    const gen = generation
    const u = new d.SpeechSynthesisUtterance(item.text)
    u.rate = rate
    const voice = resolveVoice()
    if (voice !== null) u.voice = voice
    u.onend = () => {
      if (gen !== generation) return
      advance()
    }
    u.onerror = () => {
      if (gen !== generation) return
      advance()
    }
    d.speechSynthesis.speak(u)
  }

  function jumpTo(newIdx: number): void {
    if (queue.length === 0) return
    const wasPlaying = playing
    generation++
    d.speechSynthesis.cancel()
    // Chrome keeps the synth paused after cancel(); without resume() the
    // next utterance never sounds and never fires onend.
    d.speechSynthesis.resume()
    idx = Math.max(0, Math.min(newIdx, queue.length - 1))
    paused = false
    if (wasPlaying) {
      playing = true
      speakCurrent()
    } else {
      playing = false
    }
    fire()
  }

  return {
    load(transcript: Transcript): void {
      generation++
      d.speechSynthesis.cancel()
      d.speechSynthesis.resume()
      queue = []
      for (let s = 0; s < transcript.sections.length; s++) {
        const section = transcript.sections[s]
        if (section === undefined) continue
        for (let i = 0; i < section.sentences.length; i++) {
          const text = section.sentences[i]
          if (text === undefined) continue
          queue.push({ sectionIndex: s, sentenceIndex: i, text })
        }
      }
      idx = 0
      playing = false
      paused = false
      fire()
    },

    play(): void {
      if (queue.length === 0) {
        fire()
        return
      }
      if (playing) {
        if (paused) {
          d.speechSynthesis.resume()
          paused = false
          fire()
        }
        return
      }
      playing = true
      paused = false
      speakCurrent()
      fire()
    },

    pause(): void {
      if (!playing || paused) return
      d.speechSynthesis.pause()
      paused = true
      fire()
    },

    resume(): void {
      if (!playing || !paused) return
      d.speechSynthesis.resume()
      paused = false
      fire()
    },

    stop(): void {
      generation++
      d.speechSynthesis.cancel()
      d.speechSynthesis.resume()
      playing = false
      paused = false
      idx = 0
      fire()
    },

    skip(delta: 1 | -1): void {
      // Next at the last sentence is a no-op, not a replay of that sentence.
      if (delta === 1 && idx >= queue.length - 1) return
      jumpTo(idx + delta)
    },

    skipSection(delta: 1 | -1): void {
      if (queue.length === 0) return
      const current = queue[idx] ?? queue[0]
      if (current === undefined) return
      const lastItem = queue[queue.length - 1]
      const lastSection = lastItem?.sectionIndex ?? 0
      // Next at the last section is a no-op, not a replay from its start.
      if (delta === 1 && current.sectionIndex >= lastSection) return
      const target = Math.max(0, Math.min(current.sectionIndex + delta, lastSection))
      let newIdx = queue.findIndex((q) => q.sectionIndex === target)
      if (newIdx < 0) newIdx = idx
      jumpTo(newIdx)
    },

    setRate(newRate: number): void {
      rate = clampRate(newRate)
      persistPrefs()
    },

    setVoice(name: string): void {
      if (voiceAvailable(name)) {
        voiceName = name
      } else {
        // Keep the name while the voice list has not loaded yet (browsers
        // fill getVoices() asynchronously); resolveVoice() falls back to the
        // default voice per utterance until then. Null (and persist) only
        // once the list is loaded and the name is genuinely absent.
        let voicesLoaded = false
        try {
          voicesLoaded = d.speechSynthesis.getVoices().length > 0
        } catch {
          voicesLoaded = false
        }
        voiceName = voicesLoaded ? null : name
      }
      persistPrefs()
    },

    getPrefs(): TtsPrefs {
      return { voiceName, rate }
    },

    state(): TtsState {
      return currentState()
    },

    onChange(cb: (state: TtsState, currentSentence: string | null) => void): () => void {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
