// App-side service-worker update flow.
// The SW installs but does NOT skipWaiting by itself; the app decides when to
// activate an update (reload banner), so a running listening session is never
// disrupted silently. reload() asks the waiting worker to SKIP_WAITING and
// reloads the page once it takes control.

export interface UpdateRegistrationLike {
  update(): Promise<unknown>
  addEventListener(type: string, cb: () => void): void
  readonly waiting?: { postMessage(msg: unknown): void } | null
  readonly installing?: {
    state: string
    addEventListener(type: string, cb: () => void): void
  } | null
}

export interface UpdateContainerLike {
  readonly controller?: unknown
  addEventListener(type: string, cb: () => void): void
}

export interface UpdateDocumentLike {
  visibilityState?: string
  addEventListener(type: string, cb: () => void): void
}

export interface UpdateControllerDeps {
  registration: UpdateRegistrationLike
  container?: UpdateContainerLike | null
  document?: UpdateDocumentLike | null
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  reloadFn?: () => void
}

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000 // hourly

export function createUpdateController(deps: UpdateControllerDeps) {
  const { registration } = deps
  const container = deps.container ?? null
  const doc = deps.document ?? null
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval
  const reloadFn = deps.reloadFn ?? (() => location.reload())

  const readyCallbacks = new Set<() => void>()
  let intervalId: ReturnType<typeof setInterval> | null = null
  let visibilityHandler: (() => void) | null = null
  let controllerChangeHandler: (() => void) | null = null
  let reloaded = false

  function notifyReady(): void {
    for (const cb of readyCallbacks) cb()
  }

  function check(): void {
    try {
      void registration.update().catch(() => undefined)
    } catch {
      // update() throws synchronously on unsupported browsers — ignore
    }
  }

  function watchWorker(
    worker: NonNullable<UpdateRegistrationLike['installing']>
  ): void {
    if (worker.state === 'installed') {
      onInstalled()
      return
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') onInstalled()
    })
  }

  function onInstalled(): void {
    // Only an update (a controller already exists) needs the banner; a
    // first-time install activates immediately, nothing to reload from.
    if (container && container.controller) notifyReady()
  }

  function onUpdateReady(cb: () => void): () => void {
    readyCallbacks.add(cb)
    return () => {
      readyCallbacks.delete(cb)
    }
  }

  function reload(): void {
    if (reloaded) return
    const waiting = registration.waiting
    if (!waiting) {
      // No waiting worker (already activated, or nothing installed) — a
      // plain reload picks up the refreshed cache either way.
      reloaded = true
      reloadFn()
      return
    }
    if (container && controllerChangeHandler === null) {
      controllerChangeHandler = () => {
        if (reloaded) return
        reloaded = true
        reloadFn()
      }
      container.addEventListener('controllerchange', controllerChangeHandler)
    }
    waiting.postMessage({ type: 'SKIP_WAITING' })
  }

  /** Start periodic + on-foreground update checks and an immediate check. */
  function schedule(): void {
    if (intervalId === null) {
      intervalId = setIntervalFn(check, UPDATE_CHECK_INTERVAL_MS)
    }
    if (doc && visibilityHandler === null) {
      visibilityHandler = () => {
        if (doc.visibilityState === 'visible') check()
      }
      doc.addEventListener('visibilitychange', visibilityHandler)
    }
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      if (installing) watchWorker(installing)
    })
    check()
  }

  function dispose(): void {
    if (intervalId !== null) {
      clearIntervalFn(intervalId)
      intervalId = null
    }
    visibilityHandler = null
    readyCallbacks.clear()
  }

  return { check, schedule, reload, onUpdateReady, dispose }
}

export type UpdateController = ReturnType<typeof createUpdateController>
