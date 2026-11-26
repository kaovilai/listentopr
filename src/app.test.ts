// Behavior tests for the app shell's streaming decision logic.
// app.ts renders DOM at import; the module is imported against stubbed
// document/window globals (init() exits early: no #app element).
import { describe, it, expect, vi, beforeAll } from 'vitest'

function fakeElement(): any {
  return {
    dataset: {},
    classList: { add: () => {}, remove: () => {} },
    hidden: false,
    className: '',
    textContent: '',
    value: '',
    type: '',
    title: '',
    children: [] as any[],
    appendChild(child: any) {
      this.children.push(child)
      return child
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView() {},
  }
}

const storage = new Map<string, string>()

const fakeDocument = {
  createElement: () => fakeElement(),
  createTextNode: (text: string) => ({ text }),
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
  baseURI: 'https://localhost/',
}

const fakeWindow = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  addEventListener() {},
  removeEventListener() {},
  navigator: { onLine: true },
  location: { search: '', origin: 'https://localhost' },
}

vi.stubGlobal('document', fakeDocument)
vi.stubGlobal('window', fakeWindow)

let app: typeof import('./app')
beforeAll(async () => {
  app = await import('./app')
})

function section(sentences: string[]): import('./types').TranscriptSection {
  return { id: 'test', title: 'Test', sentences }
}

function state(over: Partial<import('./types').TtsState>): import('./types').TtsState {
  return { playing: true, paused: false, sectionIndex: 0, sentenceIndex: 0, ...over }
}

describe('shouldPrefetchNow', () => {
  const sections = [
    section(['one', 'two', 'three']),
    section(['a', 'b', 'c', 'd', 'e', 'f']),
  ]

  it('is false while paused or not playing', () => {
    expect(app.shouldPrefetchNow(state({ paused: true, sectionIndex: 1, sentenceIndex: 5 }), sections)).toBe(false)
    expect(app.shouldPrefetchNow(state({ playing: false, sectionIndex: 1, sentenceIndex: 5 }), sections)).toBe(false)
  })

  it('is false with no ready sections', () => {
    expect(app.shouldPrefetchNow(state({}), [])).toBe(false)
  })

  it('is false while an earlier section plays', () => {
    expect(app.shouldPrefetchNow(state({ sectionIndex: 0, sentenceIndex: 2 }), sections)).toBe(false)
  })

  it('is false with more than 4 sentences left in the last section', () => {
    expect(app.shouldPrefetchNow(state({ sectionIndex: 1, sentenceIndex: 0 }), sections)).toBe(false)
    expect(app.shouldPrefetchNow(state({ sectionIndex: 1, sentenceIndex: 1 }), sections)).toBe(false)
  })

  it('is true within the last 4 sentences of the last section', () => {
    // 6 sentences: indexes 2..5 leave <=4 remaining
    expect(app.shouldPrefetchNow(state({ sectionIndex: 1, sentenceIndex: 2 }), sections)).toBe(true)
    expect(app.shouldPrefetchNow(state({ sectionIndex: 1, sentenceIndex: 5 }), sections)).toBe(true)
  })

  it('is true at the last sentence of a short section', () => {
    expect(app.shouldPrefetchNow(state({ sentenceIndex: 2 }), [section(['x', 'y', 'z'])])).toBe(true)
  })
})

describe('streamHoldNeeded', () => {
  const base = { active: true, started: true, done: false }

  it('is true when playback stopped while more sections are coming', () => {
    expect(app.streamHoldNeeded(state({ playing: false }), base)).toBe(true)
  })

  it('is false while playing or paused', () => {
    expect(app.streamHoldNeeded(state({}), base)).toBe(false)
    expect(app.streamHoldNeeded(state({ paused: true }), base)).toBe(false)
  })

  it('is false when the stream is done, inactive, or playback never started', () => {
    expect(app.streamHoldNeeded(state({ playing: false }), { ...base, done: true })).toBe(false)
    expect(app.streamHoldNeeded(state({ playing: false }), { ...base, active: false })).toBe(false)
    expect(app.streamHoldNeeded(state({ playing: false }), { ...base, started: false })).toBe(false)
  })
})

describe('flatSentenceCursor', () => {
  const sections = [
    section(['a', 'b', 'c']),
    section(['d']),
    section(['e', 'f']),
  ]

  it('counts sentences of all preceding sections plus the sentence index', () => {
    expect(app.flatSentenceCursor(sections, 0, 0)).toBe(0)
    expect(app.flatSentenceCursor(sections, 0, 2)).toBe(2)
    expect(app.flatSentenceCursor(sections, 1, 0)).toBe(3)
    expect(app.flatSentenceCursor(sections, 2, 1)).toBe(5)
  })

  it('ignores sections past the cursor', () => {
    expect(app.flatSentenceCursor([...sections, section(['g'])], 2, 0)).toBe(4)
  })
})

describe('resumeSkipCount', () => {
  it('is one step when the cursor still sits on the hold-time sentence', () => {
    // Natural end: hold captured the last spoken sentence, cursor unmoved.
    expect(app.resumeSkipCount(5, 5)).toBe(1)
  })

  it('adds one step per sentence the cursor moved back during the hold', () => {
    // Two prev-sentence clicks: two already-heard sentences would replay
    // with a single skip(1); the count must cover them plus the boundary.
    expect(app.resumeSkipCount(5, 3)).toBe(3)
    expect(app.resumeSkipCount(5, 0)).toBe(6)
  })

  it('never steps backwards, even if the cursor moved forward past the hold', () => {
    expect(app.resumeSkipCount(3, 7)).toBe(1)
  })
})

describe('readProvider', () => {
  it('defaults to openai when nothing is persisted', () => {
    storage.delete('listentopr.llm-provider')
    expect(app.readProvider()).toBe('openai')
  })

  it('defaults to openai for a bogus persisted value', () => {
    storage.set('listentopr.llm-provider', 'grok')
    expect(app.readProvider()).toBe('openai')
  })

  it('returns each persisted valid provider', () => {
    for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
      storage.set('listentopr.llm-provider', provider)
      expect(app.readProvider()).toBe(provider)
    }
  })
})
