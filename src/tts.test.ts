import { describe, expect, it } from 'vitest'
import { createTtsController, listVoices } from './tts'
import type { SpeechSynthesisLike, StorageLike, UtteranceCtor } from './tts'
import type { Transcript, TranscriptSection, TtsState } from './types'

// ---- fakes: synth records calls, tests trigger onend/onerror manually ----

class FakeUtterance {
  text: string
  rate = 1
  voice: { name: string } | null = null
  onend: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

function makeEnv(voices: Array<{ name: string }> = []) {
  const spoken: FakeUtterance[] = []
  const calls: string[] = []
  const synth: SpeechSynthesisLike = {
    speak: (u) => {
      calls.push('speak')
      spoken.push(u as FakeUtterance)
    },
    cancel: () => {
      calls.push('cancel')
    },
    pause: () => {
      calls.push('pause')
    },
    resume: () => {
      calls.push('resume')
    },
    getVoices: () => voices,
  }
  const store = new Map<string, string>()
  const ls: StorageLike = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => {
      store.set(k, v)
    },
  }
  return { synth, ls, store, spoken, calls, voices }
}

function makeController(env: ReturnType<typeof makeEnv>) {
  return createTtsController({
    speechSynthesis: env.synth,
    SpeechSynthesisUtterance: FakeUtterance as unknown as UtteranceCtor,
    localStorage: env.ls,
  })
}

function last(arr: FakeUtterance[]): FakeUtterance {
  const u = arr[arr.length - 1]
  if (u === undefined) throw new Error('nothing spoken yet')
  return u
}

function fireEnd(u: FakeUtterance): void {
  if (u.onend) u.onend()
}

function fireError(u: FakeUtterance): void {
  if (u.onerror) u.onerror({ error: 'synthesis-failed' })
}

/** Sections: (0,0) (0,1) | (1,0) | (2,0) (2,1) (2,2) — 6 sentences flat. */
const transcript: Transcript = {
  title: 'PR 1',
  sections: [
    { id: 's0', title: 'Overview', sentences: ['A one.', 'A two.'] },
    { id: 's1', title: 'Files', sentences: ['B one.'] },
    { id: 's2', title: 'Notes', sentences: ['C one.', 'C two.', 'C three.'] },
  ],
}

describe('load', () => {
  it('flattens sections into queue and resets position to start', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    expect(c.state()).toEqual({
      playing: false,
      paused: false,
      sectionIndex: 0,
      sentenceIndex: 0,
    })
    expect(env.spoken.length).toBe(0)
  })

  it('resets position and cancels when a new transcript is loaded mid-playback', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    fireEnd(last(env.spoken))
    expect(c.state().sentenceIndex).toBe(1)
    c.load(transcript)
    expect(env.calls).toContain('cancel')
    expect(c.state()).toEqual({
      playing: false,
      paused: false,
      sectionIndex: 0,
      sentenceIndex: 0,
    })
    c.play()
    expect(last(env.spoken).text).toBe('A one.')
  })

  it('play on empty transcript is a no-op', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load({ title: 'empty', sections: [] })
    c.play()
    expect(env.spoken.length).toBe(0)
    expect(c.state().playing).toBe(false)
  })
})

describe('sequential chaining', () => {
  it('speaks exactly one utterance at a time, in transcript order', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    expect(env.spoken.map((u) => u.text)).toEqual(['A one.'])
    fireEnd(env.spoken[0]!)
    expect(env.spoken.map((u) => u.text)).toEqual(['A one.', 'A two.'])
    fireEnd(env.spoken[1]!)
    expect(env.spoken[2]!.text).toBe('B one.')
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 1, sentenceIndex: 0 })
    fireEnd(env.spoken[2]!)
    expect(env.spoken[3]!.text).toBe('C one.')
    fireEnd(env.spoken[3]!)
    expect(env.spoken[4]!.text).toBe('C two.')
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 2, sentenceIndex: 1 })
  })

  it('final sentence end stops playback and reports null current sentence', () => {
    const env = makeEnv()
    const c = makeController(env)
    const events: Array<{ state: TtsState; sentence: string | null }> = []
    c.onChange((state, sentence) => events.push({ state: { ...state }, sentence }))
    c.load(transcript)
    c.play()
    for (let i = 0; i < 6; i++) fireEnd(last(env.spoken))
    expect(c.state().playing).toBe(false)
    expect(env.spoken.length).toBe(6)
    const final = events[events.length - 1]!
    expect(final.state.playing).toBe(false)
    expect(final.sentence).toBeNull()
  })

  it('repeat play while already playing does not restart the utterance', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.play()
    expect(env.spoken.length).toBe(1)
  })
})

describe('pause / resume / stop', () => {
  it('pause and resume map to synth.pause and synth.resume', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.pause()
    expect(env.calls).toContain('pause')
    expect(c.state()).toMatchObject({ playing: true, paused: true })
    c.resume()
    expect(env.calls).toContain('resume')
    expect(c.state()).toMatchObject({ playing: true, paused: false })
  })

  it('stop cancels, resets to start; next play begins at first sentence', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    fireEnd(env.spoken[0]!)
    expect(c.state().sentenceIndex).toBe(1)
    c.stop()
    expect(env.calls).toContain('cancel')
    expect(c.state()).toEqual({
      playing: false,
      paused: false,
      sectionIndex: 0,
      sentenceIndex: 0,
    })
    c.play()
    expect(last(env.spoken).text).toBe('A one.')
  })

  // Chrome keeps the synth paused after cancel(); every cancel must be
  // followed by resume() or the next utterance never sounds.
  it('cancel while paused is followed by resume (skip)', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.pause()
    const callsBeforeSkip = env.calls.length
    c.skip(1)
    const around = env.calls.slice(callsBeforeSkip)
    expect(around.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(around.indexOf('resume')).toBeGreaterThan(around.indexOf('cancel'))
  })

  it('cancel while paused is followed by resume (stop, then load)', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.pause()
    let callsBefore = env.calls.length
    c.stop()
    let around = env.calls.slice(callsBefore)
    expect(around.indexOf('resume')).toBeGreaterThan(around.indexOf('cancel'))
    c.play()
    c.pause()
    callsBefore = env.calls.length
    c.load(transcript)
    around = env.calls.slice(callsBefore)
    expect(around.indexOf('resume')).toBeGreaterThan(around.indexOf('cancel'))
  })
})

describe('skip', () => {
  it('moves by sentence across section boundaries and keeps speaking', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.skip(1)
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 0, sentenceIndex: 1 })
    expect(last(env.spoken).text).toBe('A two.')
    c.skip(1)
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 1, sentenceIndex: 0 })
    expect(last(env.spoken).text).toBe('B one.')
    c.skip(-1)
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 0, sentenceIndex: 1 })
    expect(last(env.spoken).text).toBe('A two.')
  })

  it('moves position without speaking when stopped', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.skip(2 as 1) // multi-sentence jump; impl must land on (1,0)
    expect(env.spoken.length).toBe(0)
    expect(c.state()).toMatchObject({ playing: false, sectionIndex: 1, sentenceIndex: 0 })
    c.play()
    expect(env.spoken[0]!.text).toBe('B one.')
  })

  it('clamps at queue boundaries', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.skip(-1)
    expect(c.state()).toMatchObject({ sectionIndex: 0, sentenceIndex: 0 })
    c.skip(100 as 1) // oversized jump clamps to last sentence
    expect(c.state()).toMatchObject({ sectionIndex: 2, sentenceIndex: 2 })
    c.skip(1)
    expect(c.state()).toMatchObject({ sectionIndex: 2, sentenceIndex: 2 })
  })

  it('skip(1) on the last sentence is a no-op, not a replay', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    for (let i = 0; i < 5; i++) fireEnd(last(env.spoken)) // now at (2,2), playing
    const spokenBefore = env.spoken.length
    c.skip(1)
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 2, sentenceIndex: 2 })
    expect(env.spoken.length).toBe(spokenBefore)
  })
})

describe('skipSection', () => {
  it('jumps to first sentence of adjacent section', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.skipSection(1)
    expect(c.state()).toMatchObject({ sectionIndex: 1, sentenceIndex: 0 })
    c.skipSection(1)
    expect(c.state()).toMatchObject({ sectionIndex: 2, sentenceIndex: 0 })
    c.skipSection(-1)
    expect(c.state()).toMatchObject({ sectionIndex: 1, sentenceIndex: 0 })
  })

  it('from mid-section, previous section goes to that section start, not current', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.skip(4 as 1) // (2,1) 'C two.'
    c.skipSection(-1)
    expect(c.state()).toMatchObject({ sectionIndex: 1, sentenceIndex: 0 })
  })

  it('clamps at first and last section', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.skipSection(-1)
    expect(c.state()).toMatchObject({ sectionIndex: 0, sentenceIndex: 0 })
    c.skipSection(5 as 1) // oversized jump clamps to last section start
    expect(c.state()).toMatchObject({ sectionIndex: 2, sentenceIndex: 0 })
  })

  it('skipSection(1) on the last section is a no-op, not a replay of its start', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.skip(4 as 1) // (2,1) 'C two.'
    c.skipSection(1)
    expect(c.state()).toMatchObject({ sectionIndex: 2, sentenceIndex: 1 })
  })

  it('continues speaking from the new section when it was playing', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.skipSection(1)
    expect(c.state().playing).toBe(true)
    expect(last(env.spoken).text).toBe('B one.')
    expect(env.calls).toContain('cancel')
  })
})

describe('rate and voice', () => {
  it('setRate clamps to 0.8..2.0 and applies to utterances spoken afterwards', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.setRate(0.1)
    expect(c.getPrefs().rate).toBe(0.8)
    c.setRate(9)
    expect(c.getPrefs().rate).toBe(2)
    c.setRate(1.4)
    c.load(transcript)
    c.play()
    expect(env.spoken[0]!.rate).toBe(1.4)
    c.setRate(1.8)
    fireEnd(env.spoken[0]!)
    expect(env.spoken[1]!.rate).toBe(1.8)
  })

  it('setVoice matches against synth.getVoices and applies the voice', () => {
    const env = makeEnv([{ name: 'Alex' }, { name: 'Sam' }])
    const c = makeController(env)
    c.setVoice('Sam')
    expect(c.getPrefs().voiceName).toBe('Sam')
    c.load(transcript)
    c.play()
    expect(env.spoken[0]!.voice?.name).toBe('Sam')
  })

  it('setVoice with unavailable name falls back to null voice', () => {
    const env = makeEnv([{ name: 'Alex' }])
    const c = makeController(env)
    c.setVoice('Nobody')
    expect(c.getPrefs().voiceName).toBeNull()
    c.load(transcript)
    c.play()
    expect(env.spoken[0]!.voice).toBeNull()
  })
})

describe('prefs persistence', () => {
  it('persists rate and voice, reloaded by a new controller on the same storage', () => {
    const env = makeEnv([{ name: 'Alex' }])
    const a = makeController(env)
    a.setRate(1.5)
    a.setVoice('Alex')
    const b = makeController(env)
    expect(b.getPrefs()).toEqual({ voiceName: 'Alex', rate: 1.5 })
  })

  it('corrupted stored JSON falls back to defaults without throwing', () => {
    const env = makeEnv()
    env.store.set('listentopr.tts.prefs', '{not valid json')
    const c = makeController(env)
    expect(c.getPrefs()).toEqual({ voiceName: null, rate: 1 })
    env.store.set('listentopr.tts.prefs', '{"rate":"fast","voiceName":42}')
    const c2 = makeController(env)
    expect(c2.getPrefs()).toEqual({ voiceName: null, rate: 1 })
  })

  it('stored voice unavailable on this synth falls back to null, rate kept', () => {
    const env = makeEnv([{ name: 'Alex' }])
    env.store.set('listentopr.tts.prefs', JSON.stringify({ voiceName: 'Gone', rate: 1.5 }))
    const c = makeController(env)
    expect(c.getPrefs()).toEqual({ voiceName: null, rate: 1.5 })
  })

  it('stored voice is kept (not nulled) while the voice list has not loaded', () => {
    const voices: Array<{ name: string }> = [] // getVoices() -> [] until loaded
    const env = makeEnv(voices)
    env.store.set('listentopr.tts.prefs', JSON.stringify({ voiceName: 'Alex', rate: 1.5 }))
    const c = makeController(env)
    expect(c.getPrefs()).toEqual({ voiceName: 'Alex', rate: 1.5 })
    // A setVoice of the persisted name before voices load must not wipe it.
    c.setVoice('Alex')
    expect(c.getPrefs().voiceName).toBe('Alex')
    expect(JSON.parse(env.store.get('listentopr.tts.prefs')!).voiceName).toBe('Alex')
    // Once the browser reports voices, the retained name applies.
    voices.push({ name: 'Alex' })
    c.load(transcript)
    c.play()
    expect(env.spoken[0]!.voice?.name).toBe('Alex')
  })
})

describe('error recovery', () => {
  it('onerror advances to the next sentence instead of stalling', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    fireError(env.spoken[0]!)
    expect(env.spoken.length).toBe(2)
    expect(env.spoken[1]!.text).toBe('A two.')
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 0, sentenceIndex: 1 })
  })

  it('onerror on the final sentence finishes playback', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    for (let i = 0; i < 5; i++) fireEnd(last(env.spoken))
    fireError(last(env.spoken))
    expect(c.state().playing).toBe(false)
    expect(env.spoken.length).toBe(6)
  })
})

describe('stale utterance events', () => {
  it('late onend from a cancelled utterance does not advance the queue', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    const stale = env.spoken[0]!
    c.skip(1) // cancels stale, speaks idx 1
    fireEnd(stale) // browser may fire onend after cancel
    expect(env.spoken.length).toBe(2)
    expect(c.state()).toMatchObject({ sectionIndex: 0, sentenceIndex: 1 })
    fireEnd(env.spoken[1]!) // real end -> idx 2
    expect(env.spoken.length).toBe(3)
    expect(c.state()).toMatchObject({ sectionIndex: 1, sentenceIndex: 0 })
  })

  it('late onerror from a cancelled utterance is ignored', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    const stale = env.spoken[0]!
    c.stop()
    fireError(stale)
    expect(env.spoken.length).toBe(1)
    expect(c.state().playing).toBe(false)
  })
})

describe('onChange', () => {
  it('fires with current sentence while playing, null when stopped; unsubscribes', () => {
    const env = makeEnv()
    const c = makeController(env)
    const seen: Array<{ state: TtsState; sentence: string | null }> = []
    const unsub = c.onChange((state, sentence) => seen.push({ state: { ...state }, sentence }))
    c.load(transcript)
    c.play()
    expect(seen[seen.length - 1]!.sentence).toBe('A one.')
    fireEnd(env.spoken[0]!)
    expect(seen[seen.length - 1]!.sentence).toBe('A two.')
    expect(seen[seen.length - 1]!.state).toMatchObject({
      playing: true,
      sectionIndex: 0,
      sentenceIndex: 1,
    })
    c.stop()
    expect(seen[seen.length - 1]!.sentence).toBeNull()
    unsub()
    const count = seen.length
    c.play()
    fireEnd(env.spoken[env.spoken.length - 1]!)
    expect(seen.length).toBe(count)
  })
})

describe('listVoices', () => {
  it('wraps synth.getVoices', () => {
    const env = makeEnv([{ name: 'Alex' }, { name: 'Sam' }])
    expect(listVoices({ speechSynthesis: env.synth })).toEqual([
      { name: 'Alex' },
      { name: 'Sam' },
    ])
  })
})

// ---------------------------------------------------------------------------
// appendSections (streaming)
// ---------------------------------------------------------------------------

describe('appendSections', () => {
  const appended: TranscriptSection = { id: 's3', title: 'More', sentences: ['D one.', 'D two.'] }

  it('appending while playing continues seamlessly into the new section', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.appendSections([appended])
    // The live utterance is untouched; only the queue grew.
    expect(env.spoken.map((u) => u.text)).toEqual(['A one.'])
    for (let i = 0; i < 6; i++) fireEnd(last(env.spoken))
    // 6 original sentences consumed -> chained into the appended section.
    expect(env.spoken[6]!.text).toBe('D one.')
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 3, sentenceIndex: 0 })
    fireEnd(last(env.spoken))
    fireEnd(last(env.spoken))
    expect(c.state().playing).toBe(false)
    expect(env.spoken.map((u) => u.text)).toEqual([
      'A one.',
      'A two.',
      'B one.',
      'C one.',
      'C two.',
      'C three.',
      'D one.',
      'D two.',
    ])
  })

  it('appending while stopped extends the queue; play then covers everything', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    fireEnd(env.spoken[0]!)
    c.stop()
    c.appendSections([appended])
    expect(c.state()).toEqual({
      playing: false,
      paused: false,
      sectionIndex: 0,
      sentenceIndex: 0,
    })
    c.play()
    let guard = 0
    while (c.state().playing && guard++ < 20) fireEnd(last(env.spoken))
    expect(c.state().playing).toBe(false)
    expect(env.spoken[env.spoken.length - 1]!.text).toBe('D two.')
    for (const text of [
      'A one.',
      'A two.',
      'B one.',
      'C one.',
      'C two.',
      'C three.',
      'D one.',
      'D two.',
    ]) {
      expect(env.spoken.map((u) => u.text)).toContain(text)
    }
  })

  it('appending while paused keeps position and pause state', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.pause()
    c.appendSections([appended])
    expect(c.state()).toEqual({
      playing: true,
      paused: true,
      sectionIndex: 0,
      sentenceIndex: 0,
    })
    c.resume()
    expect(c.state().paused).toBe(false)
    fireEnd(last(env.spoken))
    expect(last(env.spoken).text).toBe('A two.')
    expect(c.state()).toMatchObject({ sectionIndex: 0, sentenceIndex: 1 })
  })

  it('stale onend after an append does not skip or double-advance', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    const stale = env.spoken[0]!
    c.skip(1) // cancels the stale utterance, speaks 'A two.'
    c.appendSections([appended])
    fireEnd(stale) // late event from the cancelled utterance
    expect(env.spoken).toHaveLength(2)
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 0, sentenceIndex: 1 })
    fireEnd(env.spoken[1]!) // real end -> next sentence
    expect(env.spoken[2]!.text).toBe('B one.')
  })

  it('stale onend from before stop + append + play is ignored', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    const stale = env.spoken[0]!
    c.stop()
    c.appendSections([appended])
    c.play()
    fireEnd(stale)
    expect(env.spoken).toHaveLength(2)
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 0, sentenceIndex: 0 })
    fireEnd(env.spoken[1]!)
    expect(env.spoken[2]!.text).toBe('A two.')
  })

  it('skip and skipSection reach into appended sections', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.skip(4 as 1) // (2,1) 'C two.'
    c.appendSections([appended])
    c.skip(1) // previously the last sentence; now advances into (2,2)
    expect(last(env.spoken).text).toBe('C three.')
    c.skipSection(1) // into the appended section
    expect(last(env.spoken).text).toBe('D one.')
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 3, sentenceIndex: 0 })
  })

  it('appending to an empty transcript queues the content for playback', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load({ title: 'empty', sections: [] })
    c.appendSections([appended])
    expect(c.state()).toEqual({
      playing: false,
      paused: false,
      sectionIndex: 0,
      sentenceIndex: 0,
    })
    c.play()
    expect(env.spoken[0]!.text).toBe('D one.')
    expect(c.state()).toMatchObject({ playing: true, sectionIndex: 0, sentenceIndex: 0 })
  })

  it('appending an empty array is a no-op', () => {
    const env = makeEnv()
    const c = makeController(env)
    c.load(transcript)
    c.play()
    c.appendSections([])
    expect(env.spoken).toHaveLength(1)
    fireEnd(last(env.spoken))
    expect(env.spoken[1]!.text).toBe('A two.')
  })
})
