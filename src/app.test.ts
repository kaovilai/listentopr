// Behavior tests for the app shell's streaming decision logic.
// app.ts renders DOM at import; the module is imported against stubbed
// document/window globals (init() exits early: no #app element).
import { describe, it, expect, vi, beforeAll } from 'vitest'
import type { DiagramRenderAllEntry } from './diagrams'
import { GhAuthError } from './ghauth'

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
    replaceWith() {},
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
  // app.ts wires sprite icons at module level (banners), which builds svg
  // nodes through icons.ts document.createElementNS.
  createElementNS: () => fakeElement(),
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
    for (const provider of ['openai', 'anthropic', 'gemini', 'github', 'copilot'] as const) {
      storage.set('listentopr.llm-provider', provider)
      expect(app.readProvider()).toBe(provider)
    }
  })
})

describe('resolveLlmApiKey', () => {
  it('prefers the explicit LLM key when set, for every provider', () => {
    for (const provider of ['openai', 'anthropic', 'gemini', 'github', 'copilot'] as const) {
      expect(app.resolveLlmApiKey(provider, 'sk-llm', 'ghp_token')).toBe('sk-llm')
    }
  })

  it('falls back to the GitHub token only for the github and copilot providers', () => {
    expect(app.resolveLlmApiKey('github', '', 'ghp_token')).toBe('ghp_token')
    expect(app.resolveLlmApiKey('copilot', '', 'gho_token')).toBe('gho_token')
    expect(app.resolveLlmApiKey('openai', '', 'ghp_token')).toBe('')
    expect(app.resolveLlmApiKey('anthropic', '', 'ghp_token')).toBe('')
    expect(app.resolveLlmApiKey('gemini', '', 'ghp_token')).toBe('')
  })

  it('is empty when both secrets are empty', () => {
    expect(app.resolveLlmApiKey('github', '', '')).toBe('')
    expect(app.resolveLlmApiKey('copilot', '', '')).toBe('')
    expect(app.resolveLlmApiKey('openai', '', '')).toBe('')
  })
})

describe('parseOAuthClientId', () => {
  it('trims surrounding whitespace', () => {
    expect(app.parseOAuthClientId('  Iv1.abc123  ')).toBe('Iv1.abc123')
  })

  it('is empty for null, empty, and whitespace-only input', () => {
    expect(app.parseOAuthClientId(null)).toBe('')
    expect(app.parseOAuthClientId('')).toBe('')
    expect(app.parseOAuthClientId('   ')).toBe('')
  })
})

describe('ghAuthErrorMessage', () => {
  it('maps each device-flow error code to an actionable message', () => {
    expect(app.ghAuthErrorMessage(new GhAuthError('expired', 'Sign-in code expired — start sign-in again'))).toContain('expired')
    expect(app.ghAuthErrorMessage(new GhAuthError('access_denied', 'Sign-in was denied'))).toContain('denied')
    expect(app.ghAuthErrorMessage(new GhAuthError('unsupported_grant_type', 'rejected'))).toContain('client ID')
    expect(app.ghAuthErrorMessage(new GhAuthError('network', 'Network error contacting GitHub sign-in'))).toContain('connection')
  })

  it('passes the ghauth message through for http_error and bad_response', () => {
    expect(app.ghAuthErrorMessage(new GhAuthError('http_error', 'GitHub sign-in endpoint returned HTTP 500'))).toBe('GitHub sign-in endpoint returned HTTP 500')
    expect(app.ghAuthErrorMessage(new GhAuthError('bad_response', 'GitHub sign-in endpoint returned non-JSON'))).toBe('GitHub sign-in endpoint returned non-JSON')
  })

  it('sanitizes non-GhAuthError values', () => {
    expect(app.ghAuthErrorMessage(new Error('boom'))).toBe('boom')
    expect(app.ghAuthErrorMessage('nope')).toBe('nope')
    expect(app.ghAuthErrorMessage(42)).toBe('Something went wrong')
  })
})

describe('completeDeviceSignIn', () => {
  it('stores the token under github-token and reports ok', async () => {
    const putSecret = vi.fn(async () => {})
    const out = await app.completeDeviceSignIn('gho_x', { putSecret })
    expect(out).toEqual({ ok: true })
    expect(putSecret).toHaveBeenCalledTimes(1)
    expect(putSecret).toHaveBeenCalledWith('github-token', 'gho_x')
  })

  it('reports a sanitized message instead of throwing when the vault rejects the write', async () => {
    const putSecret = vi.fn(async () => {
      throw new Error('vault is locked')
    })
    const out = await app.completeDeviceSignIn('gho_x', { putSecret })
    expect(out).toEqual({ ok: false, message: 'vault is locked' })
  })

  it('sanitizes non-Error rejections from the vault', async () => {
    const putSecret = vi.fn(async () => {
      throw undefined
    })
    const out = await app.completeDeviceSignIn('gho_x', { putSecret })
    expect(out).toEqual({ ok: false, message: 'Something went wrong' })
  })
})

describe('devicePollStatus', () => {
  it('reports the attempt number while authorization is pending', () => {
    expect(app.devicePollStatus({ attempt: 3, intervalSeconds: 5, lastError: 'authorization_pending' })).toBe('Waiting for you to finish signing in… (attempt 3)')
  })

  it('notes the slower cadence after a slow_down response', () => {
    const s = app.devicePollStatus({ attempt: 2, intervalSeconds: 10, lastError: 'slow_down' })
    expect(s).toContain('checking a little slower')
    expect(s).toContain('attempt 2')
  })

  it('omits the slow-down note when there is no last error', () => {
    expect(app.devicePollStatus({ attempt: 1, intervalSeconds: 5 })).toBe('Waiting for you to finish signing in… (attempt 1)')
  })
})

describe('copilotModelsAsCatalog', () => {
  it('maps Copilot entries onto the catalog picker shape', () => {
    const out = app.copilotModelsAsCatalog([
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vision: false },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', vision: null },
      { id: 'gpt-5-vision', name: 'GPT-5 Vision', vision: true },
    ])
    expect(out).toEqual([
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', publisher: 'Copilot', summary: '', vision: false, maxInputTokens: null, rateLimitTier: null },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', publisher: 'Copilot', summary: '', vision: false, maxInputTokens: null, rateLimitTier: null },
      { id: 'gpt-5-vision', name: 'GPT-5 Vision', publisher: 'Copilot', summary: '', vision: true, maxInputTokens: null, rateLimitTier: null },
    ])
  })
})

describe('resolveCopilotModels', () => {
  const models: import('./copilotmodels').CopilotModel[] = [
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vision: false },
    { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', vision: null },
  ]

  it('serves a fresh cache entry without fetching, mapped onto the catalog shape', async () => {
    const fetchModels = vi.fn()
    const writeCache = vi.fn()
    const out = await app.resolveCopilotModels('gho_x', {
      readCache: () => ({ models, fetchedAt: Date.now() }),
      writeCache,
      fetchModels,
    })
    expect(out.kind).toBe('cache')
    if (out.kind !== 'fallback') {
      expect(out.models).toEqual(app.copilotModelsAsCatalog(models))
    }
    expect(fetchModels).not.toHaveBeenCalled()
    expect(writeCache).not.toHaveBeenCalled()
  })

  it('fetches on a cache miss and caches the result', async () => {
    const fetchModels = vi.fn().mockResolvedValue(models)
    const writeCache = vi.fn()
    const out = await app.resolveCopilotModels('gho_x', {
      readCache: () => null,
      writeCache,
      fetchModels,
    })
    expect(out.kind).toBe('fetch')
    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(fetchModels).toHaveBeenCalledWith('gho_x')
    expect(writeCache).toHaveBeenCalledWith(models)
  })

  it('falls back with the reason when the fetch fails, and does not cache', async () => {
    const fetchModels = vi.fn().mockRejectedValue(new Error('Copilot model list request failed (401)'))
    const writeCache = vi.fn()
    const out = await app.resolveCopilotModels('gho_x', {
      readCache: () => null,
      writeCache,
      fetchModels,
    })
    expect(out.kind).toBe('fallback')
    if (out.kind === 'fallback') expect(out.reason).toContain('(401)')
    expect(writeCache).not.toHaveBeenCalled()
  })

  it('falls back with "no token" before reading the cache or fetching', async () => {
    const readCache = vi.fn()
    const fetchModels = vi.fn()
    const out = await app.resolveCopilotModels('', {
      readCache,
      writeCache: () => {},
      fetchModels,
    })
    expect(out).toEqual({ kind: 'fallback', reason: 'no token' })
    expect(readCache).not.toHaveBeenCalled()
    expect(fetchModels).not.toHaveBeenCalled()
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

describe('themeModeIcon', () => {
  it('maps each mode onto its sprite icon name', () => {
    expect(app.themeModeIcon('auto')).toBe('monitor')
    expect(app.themeModeIcon('light')).toBe('sun')
    expect(app.themeModeIcon('dark')).toBe('moon')
  })

  it('only returns names present in the icon sprite', async () => {
    const { SPRITE } = await import('./icons')
    for (const mode of ['auto', 'light', 'dark'] as const) {
      expect(app.themeModeIcon(mode) in SPRITE).toBe(true)
    }
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

describe('parseContextSettings', () => {
  it('returns empty for null, empty, and corrupt JSON', () => {
    expect(app.parseContextSettings(null)).toEqual({})
    expect(app.parseContextSettings('')).toEqual({})
    expect(app.parseContextSettings('{not json')).toEqual({})
    expect(app.parseContextSettings('undefined')).toEqual({})
  })

  it('returns empty for non-object JSON', () => {
    expect(app.parseContextSettings('42')).toEqual({})
    expect(app.parseContextSettings('"x"')).toEqual({})
    expect(app.parseContextSettings('[1,2]')).toEqual({})
    expect(app.parseContextSettings('null')).toEqual({})
  })

  it('keeps finite positive numbers and a true singleShot flag', () => {
    expect(
      app.parseContextSettings('{"contextTokens":64000,"maxContextPerCall":128000,"singleShot":true}'),
    ).toEqual({ contextTokens: 64000, maxContextPerCall: 128000, singleShot: true })
  })

  it('omits zero, negative, non-finite, and non-number values', () => {
    expect(
      app.parseContextSettings('{"contextTokens":0,"maxContextPerCall":-5}'),
    ).toEqual({})
    expect(
      app.parseContextSettings('{"contextTokens":Infinity,"maxContextPerCall":"128000"}'),
    ).toEqual({})
    expect(app.parseContextSettings('{"contextTokens":NaN}')).toEqual({})
  })

  it('omits singleShot unless exactly true', () => {
    expect(app.parseContextSettings('{"singleShot":false}')).toEqual({})
    expect(app.parseContextSettings('{"singleShot":"yes"}')).toEqual({})
    expect(app.parseContextSettings('{"singleShot":1}')).toEqual({})
  })

  it('keeps valid fields while dropping invalid siblings', () => {
    expect(app.parseContextSettings('{"contextTokens":200000,"maxContextPerCall":0,"singleShot":true}')).toEqual(
      { contextTokens: 200000, singleShot: true },
    )
  })
})

describe('readContextBudget', () => {
  it('reads parsed settings from localStorage', () => {
    storage.set('listentopr.llm-context', '{"contextTokens":32000,"singleShot":true}')
    expect(app.readContextBudget()).toEqual({ contextTokens: 32000, singleShot: true })
  })

  it('tolerates corrupt stored values by degrading to empty', () => {
    storage.set('listentopr.llm-context', 'garbage{')
    expect(app.readContextBudget()).toEqual({})
    storage.delete('listentopr.llm-context')
    expect(app.readContextBudget()).toEqual({})
  })
})

describe('parseContextTokens', () => {
  it('parses positive numbers with surrounding whitespace', () => {
    expect(app.parseContextTokens('128000')).toBe(128000)
    expect(app.parseContextTokens('  64000 ')).toBe(64000)
  })

  it('is null for empty input (field left unset)', () => {
    expect(app.parseContextTokens('')).toBeNull()
    expect(app.parseContextTokens('   ')).toBeNull()
  })

  it('is null for non-numeric, zero, negative, and non-finite input', () => {
    expect(app.parseContextTokens('abc')).toBeNull()
    expect(app.parseContextTokens('12px')).toBeNull()
    expect(app.parseContextTokens('0')).toBeNull()
    expect(app.parseContextTokens('-1000')).toBeNull()
    expect(app.parseContextTokens('Infinity')).toBeNull()
    expect(app.parseContextTokens('NaN')).toBeNull()
  })
})

describe('isSingleShotMessages', () => {
  it('is true for a user prompt carrying the whole-PR file block', () => {
    expect(
      app.isSingleShotMessages([
        { role: 'system', text: 'You narrate pull requests.' },
        { role: 'user', text: 'Pull request: o/r#1\n\n## Changed files\n- a.ts' },
      ]),
    ).toBe(true)
  })

  it('is false for sectioned prompts and non-user roles', () => {
    expect(
      app.isSingleShotMessages([
        { role: 'user', text: '## Files in this batch (batch 1 of 2)\n- a.ts' },
      ]),
    ).toBe(false)
    expect(app.isSingleShotMessages([{ role: 'user', text: '## Description' }])).toBe(false)
    expect(app.isSingleShotMessages([{ role: 'system', text: '## Changed files' }])).toBe(false)
    expect(app.isSingleShotMessages([])).toBe(false)
  })
})

describe('initialStreamStatus', () => {
  it('prefers the resume message over the single-pass note', () => {
    expect(app.initialStreamStatus('Resumed at section 2, sentence 3', true)).toBe(
      'Resumed at section 2, sentence 3',
    )
  })

  it('notes single-pass generation when single-shot fired', () => {
    expect(app.initialStreamStatus(null, true)).toBe('Generating in a single pass.')
  })

  it('is null without a resume message or single pass', () => {
    expect(app.initialStreamStatus(null, false)).toBeNull()
  })
})

describe('routeInput', () => {
  it('routes PR URLs and shorthand to the pr path', () => {
    const r1 = app.routeInput('https://github.com/octocat/hello/pull/42')
    expect(r1).toEqual({ kind: 'pr', ref: { owner: 'octocat', repo: 'hello', number: 42 } })
    const r2 = app.routeInput('octocat/hello#42')
    expect(r2).toEqual({ kind: 'pr', ref: { owner: 'octocat', repo: 'hello', number: 42 } })
  })

  it('routes blob, raw, commit and compare URLs to their fetchers', () => {
    expect(app.routeInput('https://github.com/o/r/blob/main/src/a.ts')).toEqual({
      kind: 'file',
      file: { owner: 'o', repo: 'r', ref: 'main', path: 'src/a.ts' },
    })
    expect(app.routeInput('https://raw.githubusercontent.com/o/r/v1/lib/b.ts')).toEqual({
      kind: 'file',
      file: { owner: 'o', repo: 'r', ref: 'v1', path: 'lib/b.ts' },
    })
    expect(app.routeInput('https://github.com/o/r/commit/abc1234')).toEqual({
      kind: 'commit',
      commit: { owner: 'o', repo: 'r', sha: 'abc1234' },
    })
    expect(app.routeInput('https://github.com/o/r/compare/v1...v2')).toEqual({
      kind: 'compare',
      compare: { owner: 'o', repo: 'r', base: 'v1', head: 'v2' },
    })
  })

  it('routes multiline or long free text to the paste parser', () => {
    const pasted = '# Fix login\n\nThe session cookie was not refreshed.\n\ndiff --git a/auth.ts b/auth.ts'
    const r = app.routeInput(pasted)
    expect(r.kind).toBe('paste')
    if (r.kind === 'paste') expect(r.text).toBe(pasted.trim())
    const long = 'x'.repeat(100)
    expect(app.routeInput(long).kind).toBe('paste')
  })

  it('rejects short single-line garbage with a clear error', () => {
    const r = app.routeInput('hello world')
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toMatch(/GitHub pull request/)
    expect(app.routeInput('').kind).toBe('error')
  })
})

describe('parseDetailSetting', () => {
  it('returns detailed only for the exact persisted value', () => {
    expect(app.parseDetailSetting('detailed')).toBe('detailed')
    expect(app.parseDetailSetting('brief')).toBe('brief')
    expect(app.parseDetailSetting(null)).toBe('brief')
    expect(app.parseDetailSetting('')).toBe('brief')
    expect(app.parseDetailSetting('DETAILS')).toBe('brief')
  })
})

describe('bigPrStatus', () => {
  const base = {
    ref: { owner: 'o', repo: 'r', number: 1 },
    title: 't',
    body: '',
    author: 'a',
    additions: 1,
    deletions: 1,
    changedFiles: 2,
    files: [],
    comments: [],
    reviews: [],
    imageUrls: [],
    mermaidBlocks: [],
  }

  it('is null when nothing was filtered or the source reports no raw count', () => {
    expect(app.bigPrStatus({ ...base, rawChangedFiles: 2 })).toBeNull()
    expect(app.bigPrStatus({ ...base, rawChangedFiles: 1 })).toBeNull()
    expect(app.bigPrStatus(base)).toBeNull()
  })

  it('names the kept and raw counts when generated files were skipped', () => {
    expect(app.bigPrStatus({ ...base, rawChangedFiles: 5 })).toBe(
      'Showing 2 of 5 changed files (lockfiles/generated skipped)',
    )
  })
})

describe('fileChipHref', () => {
  it('links real PRs to the PR files tab', () => {
    expect(
      app.fileChipHref({ owner: 'o', repo: 'r', number: 7 }, null, 'src/a.ts'),
    ).toBe('https://github.com/o/r/pull/7/files')
  })

  it('links file-target loads to the blob URL, encoding the path', () => {
    expect(
      app.fileChipHref(
        { owner: 'o', repo: 'r', number: 0 },
        { owner: 'o', repo: 'r', ref: 'main', path: 'src/a.ts' },
        'src/a b.ts',
      ),
    ).toBe('https://github.com/o/r/blob/main/src/a%20b.ts')
  })

  it('returns null for pasted content and pseudo-PRs without a file target', () => {
    expect(app.fileChipHref({ owner: 'pasted', repo: 'content', number: 0 }, null, 'a.ts')).toBeNull()
    expect(app.fileChipHref(null, null, 'a.ts')).toBeNull()
  })

  it('never links pseudo-PR refs (numbers at or above the pseudo floor) to a PR page', () => {
    expect(app.fileChipHref({ owner: 'pasted', repo: 'content', number: 1_234_567_890 }, null, 'a.ts')).toBeNull()
    expect(app.fileChipHref({ owner: 'o', repo: 'r', number: 1_900_000_000 }, null, 'a.ts')).toBeNull()
  })
})

describe('retryStatusMessage', () => {
  it('rounds the backoff up to at least one second', () => {
    expect(app.retryStatusMessage(0)).toBe('Retrying in 1s…')
    expect(app.retryStatusMessage(1500)).toBe('Retrying in 2s…')
    expect(app.retryStatusMessage(8000)).toBe('Retrying in 8s…')
  })
})

describe('demo transcript', () => {
  it('ships four narrated sections with files and a mermaid block', () => {
    expect(app.DEMO_TRANSCRIPT.sections).toHaveLength(4)
    for (const s of app.DEMO_TRANSCRIPT.sections) {
      expect(s.title).toBeTruthy()
      expect(s.sentences.length).toBeGreaterThanOrEqual(2)
    }
    const withFiles = app.DEMO_TRANSCRIPT.sections.filter((s) => (s.files ?? []).length > 0)
    expect(withFiles.length).toBeGreaterThanOrEqual(2)
    expect(app.DEMO_MERMAID_BLOCKS.length).toBeGreaterThanOrEqual(1)
    expect(app.DEMO_MERMAID_BLOCKS[0]).toMatch(/^flowchart/)
    expect(app.DEMO_REF).toEqual({ owner: 'demo', repo: 'sample', number: 0 })
  })
})

describe('BOOKMARKLET_HREF', () => {
  it('hops to ListenToPR with the current page URL as the pr parameter', () => {
    expect(app.BOOKMARKLET_HREF).toContain("javascript:location.href='https://github.tig.pw/listentopr/?pr='+encodeURIComponent(location.href)")
  })
})

describe('copyBookmarklet', () => {
  const originalNavigator = globalThis.navigator

  it('copies the bookmarklet URL and reports it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      const msg = await app.copyBookmarklet()
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith(app.BOOKMARKLET_HREF)
      expect(msg).toContain('Bookmarklet copied')
    } finally {
      vi.stubGlobal('navigator', originalNavigator)
    }
  })

  it('falls back to the drag hint when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    try {
      const msg = await app.copyBookmarklet()
      expect(msg).toContain('drag')
    } finally {
      vi.stubGlobal('navigator', originalNavigator)
    }
  })
})

describe('pinOnlyVaultMessage', () => {
  it('points at the biometric unlock when this screen offers one', () => {
    expect(app.pinOnlyVaultMessage(true)).toContain('biometric unlock')
    expect(app.pinOnlyVaultMessage(true)).not.toContain('Wipe')
  })

  it('points at the wipe escape hatch when no biometric unlock exists here', () => {
    const msg = app.pinOnlyVaultMessage(false)
    expect(msg).toContain('unavailable')
    expect(msg).toContain('Wipe vault and start fresh')
  })
})

describe('resolveModelCatalog', () => {
  const models: import('./modelcatalog').CatalogModel[] = [
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      publisher: 'OpenAI',
      summary: 'Multimodal flagship',
      vision: true,
      maxInputTokens: 128000,
      rateLimitTier: null,
    },
    {
      id: 'meta/llama-4-scout',
      name: 'Llama 4 Scout',
      publisher: 'Meta',
      summary: '',
      vision: false,
      maxInputTokens: null,
      rateLimitTier: 'low',
    },
  ]

  it('serves a fresh cache entry without fetching', async () => {
    const fetchCatalog = vi.fn()
    const writeCache = vi.fn()
    const out = await app.resolveModelCatalog('ghp_x', {
      readCache: () => ({ models, fetchedAt: Date.now() }),
      writeCache,
      fetchCatalog,
    })
    expect(out).toEqual({ kind: 'cache', models })
    expect(fetchCatalog).not.toHaveBeenCalled()
    expect(writeCache).not.toHaveBeenCalled()
  })

  it('fetches on a stale or missing cache entry and caches the result', async () => {
    // createCatalogCache.read returns null once the 24h TTL passed, so a
    // stale entry reads exactly like a miss: the picker must re-fetch.
    const fetchCatalog = vi.fn().mockResolvedValue(models)
    const writeCache = vi.fn()
    const out = await app.resolveModelCatalog('ghp_x', {
      readCache: () => null,
      writeCache,
      fetchCatalog,
    })
    expect(out).toEqual({ kind: 'fetch', models })
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    expect(fetchCatalog).toHaveBeenCalledWith('ghp_x')
    expect(writeCache).toHaveBeenCalledWith(models)
  })

  it('falls back with the reason when the fetch fails, and does not cache', async () => {
    const fetchCatalog = vi.fn().mockRejectedValue(new Error('GitHub Models catalog request failed (401)'))
    const writeCache = vi.fn()
    const out = await app.resolveModelCatalog('ghp_x', {
      readCache: () => null,
      writeCache,
      fetchCatalog,
    })
    expect(out.kind).toBe('fallback')
    if (out.kind === 'fallback') expect(out.reason).toContain('(401)')
    expect(writeCache).not.toHaveBeenCalled()
  })

  it('falls back with "no token" before reading the cache or fetching', async () => {
    const readCache = vi.fn()
    const fetchCatalog = vi.fn()
    const out = await app.resolveModelCatalog('', {
      readCache,
      writeCache: () => {},
      fetchCatalog,
    })
    expect(out).toEqual({ kind: 'fallback', reason: 'no token' })
    expect(readCache).not.toHaveBeenCalled()
    expect(fetchCatalog).not.toHaveBeenCalled()
  })
})
