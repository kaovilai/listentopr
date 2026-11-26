import { describe, expect, it, vi } from 'vitest'
import { createMediaSessionController, type MediaSessionLike } from './mediasession'
import type { TtsController, TtsProgress } from './types'

// ---------- fakes ----------

class FakeMediaMetadata {
  title: string
  artist: string
  constructor(init: { title: string; artist: string }) {
    this.title = init.title
    this.artist = init.artist
  }
}

function fakeMediaSession() {
  const handlers = new Map<string, ((details?: unknown) => void) | null>()
  const positionStates: Array<{ duration: number; position: number; playbackRate: number }> = []
  const ms: MediaSessionLike & {
    handlers: typeof handlers
    positionStates: typeof positionStates
    metadataValue: unknown
    fire(action: string, details?: unknown): void
  } = {
    handlers,
    positionStates,
    metadataValue: null,
    metadata: null,
    setActionHandler(action, handler) {
      handlers.set(action, handler)
    },
    setPositionState(state) {
      positionStates.push(state)
    },
    fire(action: string, details?: unknown) {
      const h = handlers.get(action)
      if (h) h(details)
    },
  }
  Object.defineProperty(ms, 'metadata', {
    get() {
      return ms.metadataValue
    },
    set(v: unknown) {
      ms.metadataValue = v
    },
  })
  return ms
}

function fakeTts() {
  const calls: string[] = []
  let sentenceIndex = 2
  const tts = {
    calls,
    play: vi.fn(() => calls.push('play')),
    pause: vi.fn(() => calls.push('pause')),
    resume: vi.fn(() => calls.push('resume')),
    stop: vi.fn(() => calls.push('stop')),
    skip: vi.fn((d: number) => {
      sentenceIndex += d
      calls.push(`skip:${d}`)
    }),
    skipSection: vi.fn((d: number) => calls.push(`skipSection:${d}`)),
    seekTo: vi.fn((i: number) => {
      sentenceIndex = i
      calls.push(`seekTo:${i}`)
    }),
    getProgress: () => ({
      sentenceIndex,
      totalSentences: 10,
      estimatedSeconds: sentenceIndex * 15,
      totalEstimatedSeconds: 150,
    }),
  }
  return tts as unknown as TtsController & { calls: string[] }
}

function fakeProgress(over?: Partial<TtsProgress>): TtsProgress {
  return {
    sentenceIndex: 2,
    totalSentences: 10,
    estimatedSeconds: 30,
    totalEstimatedSeconds: 150,
    ...over,
  }
}

// ---------- tests ----------

describe('createMediaSessionController', () => {
  it('setMetadata writes MediaMetadata with title and artist', () => {
    const ms = fakeMediaSession()
    const c = createMediaSessionController({ mediaSession: ms, MetadataCtor: FakeMediaMetadata })
    c.setMetadata('Add login flow', 'alice')
    const md = ms.metadataValue as FakeMediaMetadata
    expect(md).toBeInstanceOf(FakeMediaMetadata)
    expect(md.title).toBe('Add login flow')
    expect(md.artist).toBe('alice')
  })

  it('setMetadata defaults artist to ListenToPR', () => {
    const ms = fakeMediaSession()
    const c = createMediaSessionController({ mediaSession: ms, MetadataCtor: FakeMediaMetadata })
    c.setMetadata('Fix crash')
    expect((ms.metadataValue as FakeMediaMetadata).artist).toBe('ListenToPR')
  })

  it('setMetadata is a no-op when MediaMetadata constructor is missing', () => {
    const ms = fakeMediaSession()
    const c = createMediaSessionController({ mediaSession: ms })
    c.setMetadata('t')
    expect(ms.metadataValue).toBeNull()
  })

  it('setMetadata swallows constructor errors', () => {
    const ms = fakeMediaSession()
    const throwing = class {
      constructor() {
        throw new Error('nope')
      }
    }
    const c = createMediaSessionController({ mediaSession: ms, MetadataCtor: throwing })
    expect(() => c.setMetadata('t')).not.toThrow()
  })

  it('wireHandlers maps OS actions to TTS controls', () => {
    const ms = fakeMediaSession()
    const tts = fakeTts()
    const c = createMediaSessionController({ mediaSession: ms, MetadataCtor: FakeMediaMetadata })
    c.wireHandlers(tts)

    ms.fire('play')
    ms.fire('pause')
    ms.fire('previoustrack')
    ms.fire('nexttrack')
    ms.fire('seekbackward')
    ms.fire('seekforward')

    expect(tts.calls).toEqual([
      'play',
      'pause',
      'skip:-1',
      'skip:1',
      // seekbackward: 2-2=0; seekforward reads the new index: 0+2=2.
      'seekTo:0',
      'seekTo:2',
    ])
  })

  it('unwire nulls all handlers', () => {
    const ms = fakeMediaSession()
    const tts = fakeTts()
    const c = createMediaSessionController({ mediaSession: ms, MetadataCtor: FakeMediaMetadata })
    const unwire = c.wireHandlers(tts)
    unwire()

    for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward']) {
      expect(ms.handlers.get(action)).toBeNull()
    }

    // Fired after unwire: nothing reaches TTS.
    ms.fire('play')
    expect(tts.calls).toEqual([])
  })

  it('wireHandlers on missing mediaSession returns harmless unwire', () => {
    const c = createMediaSessionController({ mediaSession: undefined, MetadataCtor: FakeMediaMetadata })
    const unwire = c.wireHandlers(fakeTts())
    expect(() => unwire()).not.toThrow()
  })

  it('updatePositionState publishes duration/position/rate 1', () => {
    const ms = fakeMediaSession()
    const c = createMediaSessionController({ mediaSession: ms, MetadataCtor: FakeMediaMetadata })
    c.updatePositionState(fakeProgress())
    expect(ms.positionStates).toEqual([
      { duration: 150, position: 30, playbackRate: 1 },
    ])
  })

  it('updatePositionState swallows throw from setPositionState', () => {
    const ms = fakeMediaSession()
    ms.setPositionState = () => {
      throw new TypeError('duration must be positive')
    }
    const c = createMediaSessionController({ mediaSession: ms, MetadataCtor: FakeMediaMetadata })
    expect(() =>
      c.updatePositionState(fakeProgress({ totalEstimatedSeconds: 0, estimatedSeconds: 0 })),
    ).not.toThrow()
  })

  it('available true with mediaSession, false without', () => {
    const withMs = createMediaSessionController({ mediaSession: fakeMediaSession() })
    const without = createMediaSessionController({ mediaSession: undefined })
    expect(withMs.available()).toBe(true)
    expect(without.available()).toBe(false)
  })

  it('all operations safe when mediaSession absent', () => {
    const c = createMediaSessionController({ mediaSession: undefined })
    expect(() => c.setMetadata('t')).not.toThrow()
    expect(() => c.updatePositionState(fakeProgress())).not.toThrow()
  })
})
