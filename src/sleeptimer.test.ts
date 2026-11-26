import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSleepTimer } from './sleeptimer'

describe('createSleepTimer (real Date via fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onExpire callbacks after the delay', () => {
    const t = createSleepTimer()
    const fired: number[] = []
    t.onExpire(() => fired.push(1))
    t.onExpire(() => fired.push(2))

    t.start(1000)
    vi.advanceTimersByTime(999)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual([1, 2])
  })

  it('remainingMs counts down, null when inactive', () => {
    const t = createSleepTimer()
    expect(t.remainingMs()).toBeNull()

    t.start(5000)
    expect(t.remainingMs()).toBe(5000)
    vi.advanceTimersByTime(2000)
    expect(t.remainingMs()).toBe(3000)

    vi.advanceTimersByTime(3000)
    expect(t.remainingMs()).toBeNull()
  })

  it('cancel disarms without firing callbacks', () => {
    const t = createSleepTimer()
    const cb = vi.fn()
    t.onExpire(cb)

    t.start(1000)
    t.cancel()
    vi.advanceTimersByTime(5000)
    expect(cb).not.toHaveBeenCalled()
    expect(t.remainingMs()).toBeNull()
  })

  it('start replaces an armed timer (only one active)', () => {
    const t = createSleepTimer()
    const cb = vi.fn()
    t.onExpire(cb)

    t.start(1000)
    vi.advanceTimersByTime(500)
    t.start(3000)
    // Old 1s deadline passed, but the timer was replaced.
    vi.advanceTimersByTime(500)
    expect(cb).not.toHaveBeenCalled()
    expect(t.remainingMs()).toBe(2500)

    vi.advanceTimersByTime(2500)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('restart re-arms from now', () => {
    const t = createSleepTimer()
    const cb = vi.fn()
    t.onExpire(cb)

    t.start(1000)
    vi.advanceTimersByTime(400)
    t.restart(2000)
    expect(t.remainingMs()).toBe(2000)

    vi.advanceTimersByTime(1999)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops expiry notification', () => {
    const t = createSleepTimer()
    const kept = vi.fn()
    const dropped = vi.fn()
    t.onExpire(kept)
    const unsub = t.onExpire(dropped)
    unsub()

    t.start(100)
    vi.advanceTimersByTime(100)
    expect(kept).toHaveBeenCalledTimes(1)
    expect(dropped).not.toHaveBeenCalled()
  })
})

describe('createSleepTimer (injected timer functions)', () => {
  it('uses injected setTimeoutFn/clearTimeoutFn; only one timer armed', () => {
    // Holder object: plain let + closure assignment trips TS control-flow
    // narrowing at the use site, box.current does not.
    const box: { current: { fn: () => void; ms: number } | null } = { current: null }
    const setTimeoutFn = vi.fn((fn: () => void, ms: number) => {
      box.current = { fn, ms }
      return 42
    })
    const clearTimeoutFn = vi.fn((_id: unknown) => {})

    const t = createSleepTimer({ setTimeoutFn, clearTimeoutFn })
    const cb = vi.fn()
    t.onExpire(cb)

    t.start(100)
    expect(setTimeoutFn).toHaveBeenCalledTimes(1)
    expect(box.current?.ms).toBe(100)

    // Replacing the armed timer clears the old id exactly once.
    t.start(200)
    expect(setTimeoutFn).toHaveBeenCalledTimes(2)
    expect(clearTimeoutFn).toHaveBeenCalledTimes(1)
    expect(clearTimeoutFn.mock.calls.map((c) => c[0])).toEqual([42])

    // Fire: callbacks run, timer goes inactive.
    box.current?.fn()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(t.remainingMs()).toBeNull()
  })

  it('after expiry the timer is inactive; cancel is safe', () => {
    const box: { current: { fn: () => void; ms: number } | null } = { current: null }
    const t = createSleepTimer({
      setTimeoutFn: (fn: () => void, ms: number) => {
        box.current = { fn, ms }
        return 1
      },
      clearTimeoutFn: () => {},
    })
    const cb = vi.fn()
    t.onExpire(cb)

    t.start(50)
    box.current?.fn()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(t.remainingMs()).toBeNull()
    expect(() => t.cancel()).not.toThrow()
  })
})
