import { describe, expect, it, vi } from 'vitest'
import {
  createWakeLockController,
  shouldShowWakeLockFallback,
  type DocumentLike,
  type WakeLockSentinel,
} from './wakelock'

// ---------- fakes ----------

interface FakeSentinel extends WakeLockSentinel {
  releaseCalls: number
}

function fakeSentinel(): FakeSentinel {
  return {
    releaseCalls: 0,
    onrelease: null,
    release(): Promise<void> {
      this.releaseCalls++
      return Promise.resolve()
    },
  }
}

interface DeferredSentinel {
  promise: Promise<WakeLockSentinel>
  resolve(s: FakeSentinel): void
  reject(err: Error): void
}

function deferredSentinel(): DeferredSentinel {
  let resolve!: (s: FakeSentinel) => void
  let reject!: (err: Error) => void
  const promise = new Promise<WakeLockSentinel>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeDocument(initialVisibility = 'visible') {
  const listeners = new Map<string, Set<() => void>>()
  const doc: DocumentLike & {
    visibilityState: string
    dispatch(type: string): void
  } = {
    visibilityState: initialVisibility,
    addEventListener(type: 'visibilitychange', listener: () => void): void {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    dispatch(type: string): void {
      for (const l of listeners.get(type) ?? []) l()
    },
  }
  return doc
}

function fakeNavigator(options?: { deferred: DeferredSentinel }) {
  const sentinels: FakeSentinel[] = []
  const request = vi.fn(async (_mode: 'screen'): Promise<WakeLockSentinel> => {
    const s = fakeSentinel()
    sentinels.push(s)
    return s
  })
  if (options && 'deferred' in options) {
    // First request is controlled by the test; later ones resolve immediately.
    let first = true
    request.mockImplementation(async () => {
      if (first) {
        first = false
        return options.deferred.promise
      }
      const s = fakeSentinel()
      sentinels.push(s)
      return s
    })
  }
  return {
    sentinels,
    request,
    wakeLock: { request: request as (mode: 'screen') => Promise<WakeLockSentinel> },
  }
}

// ---------- tests ----------

describe('createWakeLockController', () => {
  it('acquires screen lock, reports held, notifies subscribers', async () => {
    const nav = fakeNavigator()
    const doc = fakeDocument()
    const c = createWakeLockController({ navigator: nav, document: doc })

    const events: boolean[] = []
    c.onChange((held) => events.push(held))

    const ok = await c.acquire()
    expect(ok).toBe(true)
    expect(c.isHeld()).toBe(true)
    expect(nav.request.mock.calls[0]?.[0]).toBe('screen')
    expect(events).toEqual([true])
    expect(shouldShowWakeLockFallback({ navigator: nav })).toBe(false)
  })

  it('acquire is a no-op when already held', async () => {
    const nav = fakeNavigator()
    const c = createWakeLockController({ navigator: nav, document: fakeDocument() })
    await c.acquire()
    await c.acquire()
    expect(nav.request).toHaveBeenCalledTimes(1)
    expect(c.isHeld()).toBe(true)
  })

  it('missing API: acquire resolves false, fallback banner true', async () => {
    const nav = {} // no wakeLock
    const c = createWakeLockController({ navigator: nav, document: fakeDocument() })
    await expect(c.acquire()).resolves.toBe(false)
    expect(c.isHeld()).toBe(false)
    expect(shouldShowWakeLockFallback({ navigator: nav })).toBe(true)
  })

  it('rejected request: acquire resolves false, never throws', async () => {
    const d = deferredSentinel()
    const nav = fakeNavigator({ deferred: d })
    const c = createWakeLockController({ navigator: nav, document: fakeDocument() })
    const p = c.acquire()
    d.reject(new Error('NotAllowedError'))
    await expect(p).resolves.toBe(false)
    expect(c.isHeld()).toBe(false)
  })

  it('release: sentinel released, held false, notify, no re-acquire later', async () => {
    const nav = fakeNavigator()
    const doc = fakeDocument()
    const c = createWakeLockController({ navigator: nav, document: doc })
    await c.acquire()
    const events: boolean[] = []
    c.onChange((held) => events.push(held))

    c.release()
    expect(nav.sentinels[0]?.releaseCalls).toBe(1)
    expect(c.isHeld()).toBe(false)
    expect(events).toEqual([false])

    // Wanted state cleared: becoming visible must not re-acquire.
    doc.visibilityState = 'visible'
    doc.dispatch('visibilitychange')
    await new Promise((r) => setTimeout(r, 0))
    expect(nav.request).toHaveBeenCalledTimes(1)
  })

  it('browser release while hidden keeps wanted; visible re-acquires', async () => {
    const nav = fakeNavigator()
    const doc = fakeDocument()
    const c = createWakeLockController({ navigator: nav, document: doc })
    await c.acquire()
    expect(c.isHeld()).toBe(true)

    // Tab hidden: browser fires sentinel.onrelease.
    doc.visibilityState = 'hidden'
    nav.sentinels[0]?.onrelease?.()
    expect(c.isHeld()).toBe(false)

    // Stays not held while hidden.
    doc.dispatch('visibilitychange')
    await new Promise((r) => setTimeout(r, 0))
    expect(nav.request).toHaveBeenCalledTimes(1)

    // Visible again: re-acquire automatically.
    doc.visibilityState = 'visible'
    doc.dispatch('visibilitychange')
    await new Promise((r) => setTimeout(r, 0))
    expect(nav.request).toHaveBeenCalledTimes(2)
    expect(c.isHeld()).toBe(true)
  })

  it('stale acquire resolution after release cannot resurrect held', async () => {
    const d = deferredSentinel()
    const nav = fakeNavigator({ deferred: d })
    const c = createWakeLockController({ navigator: nav, document: fakeDocument() })

    const p = c.acquire()
    // User releases before the browser grants the lock.
    c.release()
    d.resolve(fakeSentinel())
    await expect(p).resolves.toBe(false)
    expect(c.isHeld()).toBe(false)
  })

  it('onChange unsubscribe stops notifications', async () => {
    const nav = fakeNavigator()
    const c = createWakeLockController({ navigator: nav, document: fakeDocument() })
    const events: boolean[] = []
    const unsub = c.onChange((held) => events.push(held))
    await c.acquire()
    unsub()
    c.release()
    expect(events).toEqual([true])
  })

  it('no document override: controller still constructs and acquires', async () => {
    const nav = fakeNavigator()
    const c = createWakeLockController({ navigator: nav })
    await expect(c.acquire()).resolves.toBe(true)
    expect(c.isHeld()).toBe(true)
  })
})

describe('shouldShowWakeLockFallback', () => {
  it('true when navigator absent entirely', () => {
    expect(shouldShowWakeLockFallback({ navigator: undefined })).toBe(true)
  })

  it('false when wakeLock present', () => {
    expect(shouldShowWakeLockFallback({ navigator: fakeNavigator() })).toBe(false)
  })
})
