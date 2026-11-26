// Behavior tests for the app shell's streaming decision logic.
// app.ts renders DOM at import; the module is imported against stubbed
// document/window globals (init() exits early: no #app element).
import { describe, it, expect, vi, beforeAll } from 'vitest'
import type { DiagramRenderAllEntry } from './diagrams'

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

describe('shouldBuildDelta', () => {
  it('is false without a cached sha or a current head sha', () => {
    expect(app.shouldBuildDelta(null, 'abc')).toBe(false)
    expect(app.shouldBuildDelta('abc', null)).toBe(false)
    expect(app.shouldBuildDelta('abc', undefined)).toBe(false)
    expect(app.shouldBuildDelta(null, null)).toBe(false)
  })

  it('is false when the cached sha matches the current head', () => {
    expect(app.shouldBuildDelta('abc', 'abc')).toBe(false)
  })

  it('is true when the head moved past the cached sha', () => {
    expect(app.shouldBuildDelta('abc', 'def')).toBe(true)
  })
})

describe('seekIndexFromRatio', () => {
  it('maps a scrubber ratio onto a sentence queue index', () => {
    expect(app.seekIndexFromRatio(0, 10)).toBe(0)
    expect(app.seekIndexFromRatio(0.5, 10)).toBe(5)
    // the last sentence is the end of the bar, not one past it
    expect(app.seekIndexFromRatio(1, 10)).toBe(9)
  })

  it('clamps out-of-range ratios and empty queues', () => {
    expect(app.seekIndexFromRatio(-1, 10)).toBe(0)
    expect(app.seekIndexFromRatio(2, 10)).toBe(9)
    expect(app.seekIndexFromRatio(0.5, 0)).toBe(0)
    expect(app.seekIndexFromRatio(Number.NaN, 10)).toBe(0)
  })
})

describe('formatTime', () => {
  it('formats seconds as m:ss', () => {
    expect(app.formatTime(0)).toBe('0:00')
    expect(app.formatTime(9.4)).toBe('0:09')
    expect(app.formatTime(65)).toBe('1:05')
    expect(app.formatTime(600)).toBe('10:00')
  })

  it('tolerates non-finite and negative input', () => {
    expect(app.formatTime(-5)).toBe('0:00')
    expect(app.formatTime(Number.NaN)).toBe('0:00')
    expect(app.formatTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('scrubberTimeLabel', () => {
  it('labels a ratio of the total as "m:ss of m:ss"', () => {
    expect(app.scrubberTimeLabel(0, 190)).toBe('0:00 of 3:10')
    expect(app.scrubberTimeLabel(0.5, 190)).toBe('1:35 of 3:10')
    expect(app.scrubberTimeLabel(1, 190)).toBe('3:10 of 3:10')
  })

  it('clamps the ratio into [0, 1]', () => {
    expect(app.scrubberTimeLabel(-1, 100)).toBe('0:00 of 1:40')
    expect(app.scrubberTimeLabel(2, 100)).toBe('1:40 of 1:40')
    expect(app.scrubberTimeLabel(Number.NaN, 100)).toBe('0:00 of 1:40')
  })
})

describe('createDiagramsView', () => {
  const entry = (block: string, ok: boolean): DiagramRenderAllEntry => ({
    block,
    result: ok
      ? {
          element: fakeElement() as unknown as SVGElement,
          rerender: async () => {},
        }
      : null,
  })

  it('hasBlocks reflects the recorded blocks of the current load', () => {
    const view = app.createDiagramsView()
    expect(view.hasBlocks()).toBe(false)
    view.setBlocks(['graph TD; A-->B'])
    expect(view.hasBlocks()).toBe(true)
    view.reset()
    expect(view.hasBlocks()).toBe(false)
  })

  it('parks entries delivered before the container exists and flushes them on build', () => {
    const view = app.createDiagramsView()
    view.setBlocks(['graph TD; A-->B', 'graph BROKEN'])
    // renderAll finished before renderStreamTitle built the section.
    view.deliver([entry('graph TD; A-->B', true), entry('graph BROKEN', false)])
    expect(view.cards()).toHaveLength(0)

    const container = view.buildContainer()
    expect(view.cards()).toHaveLength(2)
    // Cards landed inside the section body, in block order.
    const body = (container as any).children[1]
    expect(body.children).toHaveLength(2)
    expect(body.children[0].children).toHaveLength(2) // caption + svg
    // Failed block still gets a card (caption + error text + source).
    expect(body.children[1].children).toHaveLength(3)
  })

  it('fills immediately when the container already exists', () => {
    const view = app.createDiagramsView()
    view.setBlocks(['graph TD; A-->B'])
    view.buildContainer()
    view.deliver([entry('graph TD; A-->B', true)])
    expect(view.cards()).toHaveLength(1)
  })

  it('reset drops parked entries so a stale render cannot repopulate the view', () => {
    const view = app.createDiagramsView()
    view.setBlocks(['graph TD; A-->B'])
    view.deliver([entry('graph TD; A-->B', true)])
    view.reset()
    view.buildContainer()
    expect(view.cards()).toHaveLength(0)
  })

  it('a second build starts a fresh body; reset clears cards and parked state', () => {
    const view = app.createDiagramsView()
    view.setBlocks(['graph TD; A-->B'])
    view.buildContainer()
    view.deliver([entry('graph TD; A-->B', true)])
    expect(view.cards()).toHaveLength(1)
    const second = view.buildContainer()
    expect(view.cards()).toHaveLength(0)
    expect((second as any).children[1].children).toHaveLength(0)
  })
})

describe('describeResumePosition', () => {
  const sections = [
    section(['a', 'b', 'c']),
    section(['d', 'e']),
  ]

  it('labels the 1-based section and sentence at a flat index', () => {
    expect(app.describeResumePosition(sections, 0)).toBe('section 1, sentence 1')
    expect(app.describeResumePosition(sections, 3)).toBe('section 2, sentence 1')
    expect(app.describeResumePosition(sections, 4)).toBe('section 2, sentence 2')
  })

  it('falls back to a flat sentence label past the end', () => {
    expect(app.describeResumePosition(sections, 9)).toBe('sentence 10')
    expect(app.describeResumePosition([], 2)).toBe('sentence 3')
  })
})

describe('shouldWriteResume', () => {
  it('writes at most once per throttle interval', () => {
    expect(app.shouldWriteResume(0, 0)).toBe(false)
    expect(app.shouldWriteResume(0, 1999)).toBe(false)
    expect(app.shouldWriteResume(0, 2000)).toBe(true)
    expect(app.shouldWriteResume(1000, 2999)).toBe(false)
    expect(app.shouldWriteResume(1000, 3000)).toBe(true)
  })
})

describe('sleepExpireAction', () => {
  it('pauses while speech is live, even with a hold also pending', () => {
    expect(app.sleepExpireAction(state({ playing: true, paused: false }), false)).toBe('pause')
    expect(app.sleepExpireAction(state({ playing: true, paused: false }), true)).toBe('pause')
  })

  it('stops when a stream hold is pending and nothing is speaking', () => {
    // Pause is a guarded no-op mid-hold; without a stop the hold pipeline
    // restarts audio when the in-flight section lands, past the deadline.
    expect(app.sleepExpireAction(state({ playing: false, paused: false }), true)).toBe('stop')
  })

  it('does nothing when already paused or idle with no hold', () => {
    expect(app.sleepExpireAction(state({ playing: true, paused: true }), false)).toBe('none')
    expect(app.sleepExpireAction(state({ playing: false, paused: false }), false)).toBe('none')
  })
})

describe('summarizeTranscript', () => {
  it('uses the first two spoken sentences as the previous summary', () => {
    const t = { title: 'T', sections: [section(['one', 'two', 'three']), section(['four'])] }
    expect(app.summarizeTranscript(t)).toBe('one two')
  })

  it('handles empty transcripts', () => {
    expect(app.summarizeTranscript({ title: 'T', sections: [] })).toBe('')
    expect(app.summarizeTranscript({ title: 'T', sections: [section([])] })).toBe('')
  })
})

describe('transcriptToText', () => {
  it('renders title and sections as plain text', () => {
    const text = app.transcriptToText('My PR', [section(['a', 'b'])])
    expect(text).toContain('My PR')
    expect(text).toContain('## Test')
    expect(text).toContain('a b')
  })

  it('ends with a newline and works empty', () => {
    expect(app.transcriptToText('T', [])).toBe('T\n')
  })
})

describe('nextThemeMode', () => {
  it('cycles auto -> light -> dark -> auto', () => {
    expect(app.nextThemeMode('auto')).toBe('light')
    expect(app.nextThemeMode('light')).toBe('dark')
    expect(app.nextThemeMode('dark')).toBe('auto')
  })
})

describe('themeModeLabel / themeModeAria', () => {
  it('labels each mode', () => {
    expect(app.themeModeLabel('auto')).toBe('Auto')
    expect(app.themeModeLabel('light')).toBe('Light')
    expect(app.themeModeLabel('dark')).toBe('Dark')
  })

  it('the auto label says it follows the system', () => {
    expect(app.themeModeAria('auto')).toBe('Theme: Auto (follows system)')
    expect(app.themeModeAria('light')).toBe('Theme: Light')
    expect(app.themeModeAria('dark')).toBe('Theme: Dark')
  })
})

describe('diagramSectionSpoken', () => {
  it('is true for the architecture section id', () => {
    expect(app.diagramSectionSpoken({ id: 'architecture', title: 'Anything', sentences: [] })).toBe(true)
  })

  it('is true for titles mentioning diagrams or architecture', () => {
    expect(app.diagramSectionSpoken({ id: 'x', title: 'Architecture and Diagrams', sentences: [] })).toBe(true)
    expect(app.diagramSectionSpoken({ id: 'x', title: 'System diagrams', sentences: [] })).toBe(true)
  })

  it('is false for other sections and missing input', () => {
    expect(app.diagramSectionSpoken({ id: 'overview', title: 'Overview', sentences: [] })).toBe(false)
    expect(app.diagramSectionSpoken({ id: 'changes', title: 'Key Changes', sentences: [] })).toBe(false)
    expect(app.diagramSectionSpoken(undefined)).toBe(false)
  })
})
