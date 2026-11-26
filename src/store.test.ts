import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createStore, type QueueItem } from './store'
import type { PullRequestRef, Transcript } from './types'

const ref: PullRequestRef = { owner: 'octo', repo: 'demo', number: 1 }
const refB: PullRequestRef = { owner: 'octo', repo: 'demo', number: 2 }

function transcript(title: string): Transcript {
  return {
    title,
    sections: [{ id: 's1', title: 'Section', sentences: [`${title} sentence.`] }],
  }
}

let dbCounter = 0
let store: ReturnType<typeof createStore>

beforeEach(() => {
  store = createStore({ dbName: `listentopr-store-test-${dbCounter++}` })
})

describe('transcript cache', () => {
  it('round-trips a transcript for the exact sha', async () => {
    const t = transcript('cache me')
    await store.putTranscript(ref, 'sha-aaa', t)
    expect(await store.getCachedTranscript(ref, 'sha-aaa')).toEqual(t)
  })

  it('returns null on sha mismatch', async () => {
    await store.putTranscript(ref, 'sha-aaa', transcript('one'))
    expect(await store.getCachedTranscript(ref, 'sha-bbb')).toBeNull()
  })

  it('returns null when nothing cached for ref', async () => {
    expect(await store.getCachedTranscript(ref, 'sha-aaa')).toBeNull()
  })

  it('keeps transcripts for different shas of the same ref', async () => {
    const a = transcript('a')
    const b = transcript('b')
    await store.putTranscript(ref, 'sha-1', a)
    await store.putTranscript(ref, 'sha-2', b)
    expect(await store.getCachedTranscript(ref, 'sha-1')).toEqual(a)
    expect(await store.getCachedTranscript(ref, 'sha-2')).toEqual(b)
  })

  it('isolates refs from each other', async () => {
    await store.putTranscript(ref, 'sha-x', transcript('mine'))
    expect(await store.getCachedTranscript(refB, 'sha-x')).toBeNull()
  })

  it('latestCachedSha returns null with no cache', async () => {
    expect(await store.latestCachedSha(ref)).toBeNull()
  })

  it('latestCachedSha picks most recent by stored timestamp', async () => {
    await store.putTranscript(ref, 'sha-old', transcript('old'))
    await new Promise((r) => setTimeout(r, 5))
    await store.putTranscript(ref, 'sha-new', transcript('new'))
    expect(await store.latestCachedSha(ref)).toBe('sha-new')
  })

  it('latestCachedSha ignores other refs', async () => {
    await store.putTranscript(ref, 'sha-old', transcript('old'))
    await new Promise((r) => setTimeout(r, 5))
    await store.putTranscript(refB, 'sha-new', transcript('new'))
    expect(await store.latestCachedSha(ref)).toBe('sha-old')
  })

  it('dropTranscript removes all shas for the ref only', async () => {
    await store.putTranscript(ref, 'sha-1', transcript('one'))
    await store.putTranscript(ref, 'sha-2', transcript('two'))
    await store.putTranscript(refB, 'sha-keep', transcript('keep'))
    await store.dropTranscript(ref)
    expect(await store.getCachedTranscript(ref, 'sha-1')).toBeNull()
    expect(await store.getCachedTranscript(ref, 'sha-2')).toBeNull()
    expect(await store.getCachedTranscript(refB, 'sha-keep')).not.toBeNull()
    expect(await store.latestCachedSha(ref)).toBeNull()
  })

  it('concurrent put of same key leaves one consistent record', async () => {
    const results = await Promise.all([
      store.putTranscript(ref, 'sha-same', transcript('first')),
      store.putTranscript(ref, 'sha-same', transcript('second')),
      store.putTranscript(ref, 'sha-same', transcript('third')),
    ])
    expect(results).toEqual([undefined, undefined, undefined])
    const cached = await store.getCachedTranscript(ref, 'sha-same')
    expect(cached).not.toBeNull()
    expect(['first', 'second', 'third']).toContain(cached!.title)
    expect(await store.latestCachedSha(ref)).toBe('sha-same')
  })
})

describe('resume position', () => {
  it('round-trips resume position', async () => {
    await store.setResume(ref, 7)
    expect(await store.getResume(ref)).toBe(7)
  })

  it('overwrites in place', async () => {
    await store.setResume(ref, 3)
    await store.setResume(ref, 12)
    expect(await store.getResume(ref)).toBe(12)
  })

  it('returns null when no resume stored', async () => {
    expect(await store.getResume(ref)).toBeNull()
  })

  it('clearResume removes the position', async () => {
    await store.setResume(ref, 5)
    await store.clearResume(ref)
    expect(await store.getResume(ref)).toBeNull()
  })

  it('tracks refs independently', async () => {
    await store.setResume(ref, 1)
    await store.setResume(refB, 2)
    await store.clearResume(ref)
    expect(await store.getResume(refB)).toBe(2)
  })
})

describe('queue', () => {
  it('dequeue returns null when empty', async () => {
    expect(await store.dequeue()).toBeNull()
  })

  it('dequeues in FIFO order', async () => {
    await store.enqueue({ ref, title: 'first', addedAt: 1 })
    await store.enqueue({ ref: refB, title: 'second', addedAt: 2 })
    expect(await store.queueLength()).toBe(2)
    const one = await store.dequeue()
    expect(one?.title).toBe('first')
    const two = await store.dequeue()
    expect(two?.title).toBe('second')
    expect(await store.dequeue()).toBeNull()
    expect(await store.queueLength()).toBe(0)
  })

  it('dequeue preserves the full QueueItem shape', async () => {
    const item: QueueItem = { ref, title: 'shape', addedAt: 42 }
    await store.enqueue(item)
    expect(await store.dequeue()).toEqual(item)
  })

  it('queueAll returns items ordered by addedAt', async () => {
    await store.enqueue({ ref, title: 'b', addedAt: 2 })
    await store.enqueue({ ref: refB, title: 'a', addedAt: 1 })
    const all = await store.queueAll()
    expect(all.map((q) => q.title)).toEqual(['a', 'b'])
  })

  it('removeFromQueue drops only the matching ref', async () => {
    await store.enqueue({ ref, title: 'target', addedAt: 1 })
    await store.enqueue({ ref, title: 'target-2', addedAt: 2 })
    await store.enqueue({ ref: refB, title: 'other', addedAt: 3 })
    await store.removeFromQueue(ref)
    expect(await store.queueLength()).toBe(1)
    const all = await store.queueAll()
    expect(all.map((q) => q.title)).toEqual(['other'])
  })

  it('queueLength tracks enqueue and dequeue', async () => {
    expect(await store.queueLength()).toBe(0)
    await store.enqueue({ ref, title: 'x', addedAt: 1 })
    expect(await store.queueLength()).toBe(1)
    await store.dequeue()
    expect(await store.queueLength()).toBe(0)
  })
})

describe('listen history', () => {
  it('returns null when never listened', async () => {
    expect(await store.lastListen(ref)).toBeNull()
  })

  it('records a listen', async () => {
    await store.recordListen(ref, 'sha-1')
    const last = await store.lastListen(ref)
    expect(last?.headSha).toBe('sha-1')
    expect(typeof last?.at).toBe('number')
  })

  it('overwrites in place with the newest listen', async () => {
    await store.recordListen(ref, 'sha-old')
    await new Promise((r) => setTimeout(r, 5))
    await store.recordListen(ref, 'sha-new')
    const last = await store.lastListen(ref)
    expect(last?.headSha).toBe('sha-new')
  })

  it('tracks refs independently', async () => {
    await store.recordListen(ref, 'sha-a')
    await store.recordListen(refB, 'sha-b')
    expect((await store.lastListen(ref))?.headSha).toBe('sha-a')
    expect((await store.lastListen(refB))?.headSha).toBe('sha-b')
  })
})

describe('wipe', () => {
  it('clears every store in the database', async () => {
    await store.putTranscript(ref, 'sha-1', transcript('t'))
    await store.setResume(ref, 4)
    await store.enqueue({ ref, title: 'q', addedAt: 1 })
    await store.recordListen(ref, 'sha-1')

    await store.wipe()

    expect(await store.getCachedTranscript(ref, 'sha-1')).toBeNull()
    expect(await store.latestCachedSha(ref)).toBeNull()
    expect(await store.getResume(ref)).toBeNull()
    expect(await store.queueAll()).toEqual([])
    expect(await store.queueLength()).toBe(0)
    expect(await store.dequeue()).toBeNull()
    expect(await store.lastListen(ref)).toBeNull()
  })

  it('store remains usable after wipe', async () => {
    await store.wipe()
    await store.setResume(ref, 9)
    expect(await store.getResume(ref)).toBe(9)
  })
})
