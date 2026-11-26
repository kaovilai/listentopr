import { describe, expect, it, vi } from 'vitest'
import { createKeyboardController, type KeyboardEventLike } from './keyboard'
import type { TtsController, TtsState, TtsPrefs, TtsProgress } from './types'
import type { Transcript, TranscriptSection } from './types'

// ---------- fakes ----------

function fakeTts(over?: Partial<TtsState>): TtsController & { calls: string[] } {
  const calls: string[] = []
  let state: TtsState = {
    playing: true,
    paused: false,
    sectionIndex: 0,
    sentenceIndex: 0,
    ...over,
  }
  const tts = {
    calls,
    load: vi.fn((_t: Transcript) => {}),
    appendSections: vi.fn((_s: TranscriptSection[]) => {}),
    seekTo: vi.fn((i: number) => calls.push(`seekTo:${i}`)),
    play: vi.fn(() => calls.push('play')),
    pause: vi.fn(() => calls.push('pause')),
    resume: vi.fn(() => calls.push('resume')),
    stop: vi.fn(() => calls.push('stop')),
    skip: vi.fn((d: number) => calls.push(`skip:${d}`)),
    skipSection: vi.fn((d: number) => calls.push(`skipSection:${d}`)),
    setRate: vi.fn(() => {}),
    setPitch: vi.fn(() => {}),
    setVoice: vi.fn(() => {}),
    getPrefs: vi.fn((): TtsPrefs => ({ voiceName: null, rate: 1, pitch: 1 })),
    getProgress: vi.fn((): TtsProgress => ({
      sentenceIndex: 0,
      totalSentences: 0,
      estimatedSeconds: 0,
      totalEstimatedSeconds: 0,
    })),
    state: () => state,
    onChange: vi.fn((_cb: (s: TtsState, cur: string | null) => void) => () => {}),
  }
  return tts as TtsController & { calls: string[] }
}

function fakeDocument() {
  const listeners = new Set<(ev: KeyboardEventLike) => void>()
  const doc = {
    listeners,
    addEventListener(_type: 'keydown', listener: (ev: KeyboardEventLike) => void): void {
      listeners.add(listener)
    },
    removeEventListener(_type: 'keydown', listener: (ev: KeyboardEventLike) => void): void {
      listeners.delete(listener)
    },
    keyDown(ev: KeyboardEventLike): void {
      for (const l of [...listeners]) l(ev)
    },
    listenerCount(): number {
      return listeners.size
    },
  }
  return doc
}

function ev(key: string, over?: Partial<KeyboardEventLike>): KeyboardEventLike {
  return {
    key,
    preventDefault: vi.fn(),
    ...over,
  }
}

// ---------- tests ----------

describe('createKeyboardController', () => {
  it('Space toggles pause while playing, preventDefault called', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    const e = ev(' ')
    doc.keyDown(e)
    expect(tts.calls).toEqual(['pause'])
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('Space plays when paused', () => {
    const doc = fakeDocument()
    const tts = fakeTts({ playing: true, paused: true })
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    doc.keyDown(ev(' '))
    expect(tts.calls).toEqual(['play'])
  })

  it('Space plays when stopped entirely', () => {
    const doc = fakeDocument()
    const tts = fakeTts({ playing: false, paused: false })
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    doc.keyDown(ev(' '))
    expect(tts.calls).toEqual(['play'])
  })

  it('ArrowRight/ArrowLeft skip one sentence', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    doc.keyDown(ev('ArrowRight'))
    doc.keyDown(ev('ArrowLeft'))
    expect(tts.calls).toEqual(['skip:1', 'skip:-1'])
  })

  it('ArrowUp/ArrowDown skip one section', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    doc.keyDown(ev('ArrowUp'))
    doc.keyDown(ev('ArrowDown'))
    expect(tts.calls).toEqual(['skipSection:1', 'skipSection:-1'])
  })

  it('j/k skip sections vi-style: j next, k previous', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    doc.keyDown(ev('j'))
    doc.keyDown(ev('k'))
    expect(tts.calls).toEqual(['skipSection:1', 'skipSection:-1'])
  })

  it('s stops playback', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    doc.keyDown(ev('s'))
    expect(tts.calls).toEqual(['stop'])
  })

  it('s routes through onStop when provided, bypassing raw tts.stop', () => {
    // Raw tts.stop() leaves playing=false/paused=false, which a live
    // transcript stream misreads as an end-of-content hold and resumes from.
    // The app must be able to intercept 's' with its own stop path.
    const doc = fakeDocument()
    const tts = fakeTts()
    const onStop = vi.fn()
    const c = createKeyboardController({ document: doc, tts, onStop })
    c.attach()

    doc.keyDown(ev('s'))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(tts.calls).toEqual([])
  })

  it('other keys do not trigger onStop', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const onStop = vi.fn()
    const c = createKeyboardController({ document: doc, tts, onStop })
    c.attach()

    doc.keyDown(ev(' '))
    doc.keyDown(ev('ArrowRight'))
    expect(onStop).not.toHaveBeenCalled()
  })

  it('ignored in input/textarea/select targets', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      doc.keyDown(ev(' ', { target: { tagName } }))
    }
    expect(tts.calls).toEqual([])
  })

  it('ignored while composing (IME)', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    doc.keyDown(ev(' ', { isComposing: true }))
    expect(tts.calls).toEqual([])
  })

  it('unrelated keys do nothing, no preventDefault', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()

    const e = ev('x')
    doc.keyDown(e)
    expect(tts.calls).toEqual([])
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('detach removes the listener', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()
    expect(doc.listenerCount()).toBe(1)

    c.detach()
    expect(doc.listenerCount()).toBe(0)

    doc.keyDown(ev(' '))
    expect(tts.calls).toEqual([])
  })

  it('attach is idempotent', () => {
    const doc = fakeDocument()
    const tts = fakeTts()
    const c = createKeyboardController({ document: doc, tts })
    c.attach()
    c.attach()
    expect(doc.listenerCount()).toBe(1)

    // One keypress still triggers exactly one action.
    doc.keyDown(ev('s'))
    expect(tts.calls).toEqual(['stop'])
  })

  it('detach when not attached is safe', () => {
    const doc = fakeDocument()
    const c = createKeyboardController({ document: doc, tts: fakeTts() })
    expect(() => c.detach()).not.toThrow()
  })
})
