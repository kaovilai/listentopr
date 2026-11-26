import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  createUpdateController,
  type UpdateContainerLike,
  type UpdateDocumentLike,
} from './update'

interface FakeWorker {
  state: string
  postMessage: (msg: unknown) => void
  listeners: Record<string, Array<() => void>>
  addEventListener(type: string, cb: () => void): void
  setState(s: string): void
}

function fakeWorker(state = 'installing'): FakeWorker {
  const w: FakeWorker = {
    state,
    postMessage: vi.fn(),
    listeners: {},
    addEventListener(type, cb) {
      ;(w.listeners[type] ??= []).push(cb)
    },
    setState(s) {
      w.state = s
      for (const cb of w.listeners['statechange'] ?? []) cb()
    },
  }
  return w
}

function fakeRegistration() {
  const regListeners: Record<string, Array<() => void>> = {}
  let installing: FakeWorker | null = null
  let waiting: FakeWorker | null = null
  const update = vi.fn(() => Promise.resolve())
  const reg = {
    update,
    addEventListener(type: string, cb: () => void) {
      ;(regListeners[type] ??= []).push(cb)
    },
    get installing() {
      return installing
    },
    get waiting() {
      return waiting
    },
    _setInstalling(w: FakeWorker | null) {
      installing = w
    },
    _setWaiting(w: FakeWorker | null) {
      waiting = w
    },
    _fireUpdatefound() {
      for (const cb of regListeners['updatefound'] ?? []) cb()
    },
  }
  return reg
}

function fakeContainer(hasController: boolean) {
  const listeners: Record<string, Array<() => void>> = {}
  const container: UpdateContainerLike = {
    get controller() {
      return hasController ? { marker: true } : undefined
    },
    addEventListener(type: string, cb: () => void) {
      ;(listeners[type] ??= []).push(cb)
    },
  }
  return {
    container,
    fireControllerChange() {
      for (const cb of listeners['controllerchange'] ?? []) cb()
    },
  }
}

function fakeDocument() {
  const listeners: Record<string, Array<() => void>> = {}
  let visibility = 'visible'
  const doc: UpdateDocumentLike = {
    get visibilityState() {
      return visibility
    },
    addEventListener(type: string, cb: () => void) {
      ;(listeners[type] ??= []).push(cb)
    },
  }
  return {
    doc,
    setVisible(v: string) {
      visibility = v
    },
    fireVisibilityChange() {
      for (const cb of listeners['visibilitychange'] ?? []) cb()
    },
  }
}

describe('update controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires update-ready when a new worker finishes installing while a controller exists', () => {
    const reg = fakeRegistration()
    const { container } = fakeContainer(true)
    const ctrl = createUpdateController({ registration: reg, container })
    const onReady = vi.fn()
    ctrl.onUpdateReady(onReady)
    ctrl.schedule()

    const worker = fakeWorker('installing')
    reg._setInstalling(worker)
    reg._fireUpdatefound()

    expect(onReady).not.toHaveBeenCalled()
    worker.setState('installed')
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('does not fire for a first-time install (no controller yet)', () => {
    const reg = fakeRegistration()
    const { container } = fakeContainer(false)
    const ctrl = createUpdateController({ registration: reg, container })
    const onReady = vi.fn()
    ctrl.onUpdateReady(onReady)
    ctrl.schedule()

    const worker = fakeWorker('installing')
    reg._setInstalling(worker)
    reg._fireUpdatefound()
    worker.setState('installed')

    expect(onReady).not.toHaveBeenCalled()
  })

  it('fires immediately if the worker is already installed when updatefound fires', () => {
    const reg = fakeRegistration()
    const { container } = fakeContainer(true)
    const ctrl = createUpdateController({ registration: reg, container })
    const onReady = vi.fn()
    ctrl.onUpdateReady(onReady)

    const worker = fakeWorker('installed')
    reg._setInstalling(worker)
    ctrl.schedule()
    reg._fireUpdatefound()

    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('check() asks the registration to update and swallows errors', () => {
    const reg = fakeRegistration()
    reg.update = vi.fn(() => Promise.reject(new Error('boom')))
    const ctrl = createUpdateController({ registration: reg })
    expect(() => ctrl.check()).not.toThrow()
    expect(reg.update).toHaveBeenCalledTimes(1)

    const throwing = vi.fn(() => {
      throw new Error('sync throw')
    })
    reg.update = throwing as unknown as typeof reg.update
    expect(() => ctrl.check()).not.toThrow()
  })

  it('schedule() checks immediately, hourly, and when the tab becomes visible', () => {
    const reg = fakeRegistration()
    const { doc, setVisible, fireVisibilityChange } = fakeDocument()
    const ctrl = createUpdateController({ registration: reg, document: doc })

    ctrl.schedule()
    expect(reg.update).toHaveBeenCalledTimes(1) // immediate

    fireVisibilityChange() // visible
    expect(reg.update).toHaveBeenCalledTimes(2)

    setVisible('hidden')
    fireVisibilityChange() // hidden — no check
    expect(reg.update).toHaveBeenCalledTimes(2)

    setVisible('visible')
    fireVisibilityChange()
    expect(reg.update).toHaveBeenCalledTimes(3)

    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(reg.update).toHaveBeenCalledTimes(4)
  })

  it('dispose() stops the hourly interval', () => {
    const reg = fakeRegistration()
    const ctrl = createUpdateController({ registration: reg })
    ctrl.schedule()
    expect(reg.update).toHaveBeenCalledTimes(1)
    ctrl.dispose()
    vi.advanceTimersByTime(5 * 60 * 60 * 1000)
    expect(reg.update).toHaveBeenCalledTimes(1)
  })

  it('reload() posts SKIP_WAITING to the waiting worker and reloads on controllerchange', () => {
    const reg = fakeRegistration()
    const waiting = fakeWorker('installed')
    reg._setWaiting(waiting)
    const { container, fireControllerChange } = fakeContainer(true)
    const reloadFn = vi.fn()
    const ctrl = createUpdateController({
      registration: reg,
      container,
      reloadFn,
    })

    ctrl.reload()
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(reloadFn).not.toHaveBeenCalled()

    fireControllerChange()
    expect(reloadFn).toHaveBeenCalledTimes(1)

    // guarded: a second controllerchange must not reload again
    fireControllerChange()
    expect(reloadFn).toHaveBeenCalledTimes(1)
  })

  it('reload() reloads directly when no worker is waiting', () => {
    const reg = fakeRegistration()
    const reloadFn = vi.fn()
    const ctrl = createUpdateController({ registration: reg, reloadFn })
    ctrl.reload()
    expect(reloadFn).toHaveBeenCalledTimes(1)
  })

  it('onUpdateReady returns an unsubscribe function', () => {
    const reg = fakeRegistration()
    const { container } = fakeContainer(true)
    const ctrl = createUpdateController({ registration: reg, container })
    const onReady = vi.fn()
    const unsub = ctrl.onUpdateReady(onReady)
    unsub()
    ctrl.dispose() // also clears

    const worker = fakeWorker('installed')
    reg._setInstalling(worker)
    ctrl.schedule()
    reg._fireUpdatefound()
    expect(onReady).not.toHaveBeenCalled()
  })
})
