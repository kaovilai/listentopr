import type { WakeLockController } from './types'

// Structural types so tests (and non-DOM runtimes) can pass plain fakes.

export interface WakeLockSentinel {
  release(): Promise<void>
  onrelease: ((ev?: unknown) => void) | null
}

export interface WakeLockLike {
  request(mode: 'screen'): Promise<WakeLockSentinel>
}

export interface NavigatorLike {
  wakeLock?: WakeLockLike
}

export interface DocumentLike {
  visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface WakeLockDeps {
  navigator?: NavigatorLike
  document?: DocumentLike
}

function resolveNavigator(deps: WakeLockDeps): NavigatorLike | undefined {
  return deps.navigator ?? (globalThis as { navigator?: NavigatorLike }).navigator
}

function resolveDocument(deps: WakeLockDeps): DocumentLike | undefined {
  return deps.document ?? (globalThis as { document?: DocumentLike }).document
}

/** True when the Screen Wake Lock API is absent entirely (UI shows warning banner). */
export function shouldShowWakeLockFallback(deps: WakeLockDeps = {}): boolean {
  const nav = resolveNavigator(deps)
  return !nav || !nav.wakeLock
}

export function createWakeLockController(deps: WakeLockDeps = {}): WakeLockController {
  const nav = resolveNavigator(deps)
  const doc = resolveDocument(deps)

  let sentinel: WakeLockSentinel | null = null
  let held = false
  // True when the user wants the lock (held at least once, not released by us).
  // Survives the browser's automatic release on tab hide.
  let wanted = false
  // Bumped on every release() and at the start of every acquire(); a request
  // that resolves after either of those is stale and must not flip `held`.
  let sentinelAbort = 0

  const listeners = new Set<(held: boolean) => void>()
  const notify = (): void => {
    for (const cb of listeners) cb(held)
  }

  async function acquire(): Promise<boolean> {
    if (held) return true
    const wakeLock = nav?.wakeLock
    if (!wakeLock) return false
    const myEpoch = ++sentinelAbort
    try {
      const s = await wakeLock.request('screen')
      if (myEpoch !== sentinelAbort) return false // stale: released or superseded meanwhile
      sentinel = s
      held = true
      wanted = true
      s.onrelease = () => {
        // Browser released the lock (e.g. tab hidden). Keep `wanted` so we
        // can re-acquire when the document becomes visible again.
        if (sentinel !== s) return
        sentinel = null
        held = false
        notify()
      }
      notify()
      return true
    } catch {
      return false
    }
  }

  function release(): void {
    wanted = false
    sentinelAbort++
    const s = sentinel
    if (s) {
      s.onrelease = null
      sentinel = null
      s.release().catch(() => {
        // Release failure is not actionable; the lock is gone either way.
      })
    }
    if (held) {
      held = false
      notify()
    }
  }

  function onVisibilityChange(): void {
    if (!doc) return
    if (doc.visibilityState === 'visible' && wanted && !held) {
      void acquire().catch(() => {
        // acquire never throws, but a rejected promise must not go unhandled.
      })
    }
  }

  if (doc) doc.addEventListener('visibilitychange', onVisibilityChange)

  return {
    acquire,
    release,
    isHeld: () => held,
    onChange(cb: (held: boolean) => void): () => void {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
