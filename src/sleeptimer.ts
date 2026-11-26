// Sleep timer: fire registered callbacks once after a delay, then go idle.

export interface SleepTimerDeps {
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (id: unknown) => void
}

export interface SleepTimer {
  /** Arm the timer; replaces any active one. Fire runs onExpire callbacks. */
  start(ms: number): void
  /** Disarm the timer. Callbacks are not run. Safe when inactive. */
  cancel(): void
  /** ms left on the armed timer, clamped at 0; null when inactive. */
  remainingMs(): number | null
  /** Re-arm from now with a (possibly new) duration. */
  restart(ms: number): void
  /** Register an expiry callback; returns unsubscribe. */
  onExpire(cb: () => void): () => void
}

export function createSleepTimer(deps: SleepTimerDeps = {}): SleepTimer {
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((id: unknown) => clearTimeout(id as Parameters<typeof clearTimeout>[0]))

  const listeners = new Set<() => void>()
  let timerId: unknown = null
  let endsAt = 0

  function clearTimer(): void {
    if (timerId !== null) {
      clearTimeoutFn(timerId)
      timerId = null
    }
    endsAt = 0
  }

  function arm(ms: number): void {
    clearTimer()
    timerId = setTimeoutFn(() => {
      timerId = null
      endsAt = 0
      for (const cb of [...listeners]) cb()
    }, ms)
    endsAt = Date.now() + ms
  }

  return {
    start: arm,
    cancel: clearTimer,
    remainingMs(): number | null {
      if (timerId === null) return null
      return Math.max(0, endsAt - Date.now())
    },
    restart: arm,
    onExpire(cb: () => void): () => void {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
