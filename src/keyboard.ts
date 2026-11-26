import type { TtsController } from './types'

// Structural types so tests (and non-DOM runtimes) can pass plain fakes.

export interface KeyboardEventLike {
  key: string
  shiftKey?: boolean
  isComposing?: boolean
  target?: unknown
  preventDefault(): void
}

export interface DocumentLike {
  addEventListener(type: 'keydown', listener: (ev: KeyboardEventLike) => void): void
  removeEventListener(type: 'keydown', listener: (ev: KeyboardEventLike) => void): void
}

export interface KeyboardDeps {
  document?: DocumentLike
  tts: TtsController
  /**
   * App-level stop for the 's' key. Raw tts.stop() leaves
   * playing=false/paused=false, which a live transcript stream reads as a
   * natural end-of-content hold and then resumes from on its own. The app
   * wires this to its stop path so the stream is aborted too. Falls back
   * to tts.stop() when not provided.
   */
  onStop?: () => void
}

export interface KeyboardController {
  /** Install the keydown listener. Idempotent: a second attach() is a no-op. */
  attach(): void
  /** Remove the listener. Safe when not attached. */
  detach(): void
}

const TAGS_TO_IGNORE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const tag = (target as { tagName?: unknown }).tagName
  if (typeof tag !== 'string') return false
  return TAGS_TO_IGNORE.has(tag.toUpperCase())
}

/**
 * Keyboard shortcuts:
 *   Space           toggle play/pause (preventDefault so page does not scroll)
 *   ArrowRight/Left skip one sentence forward/back
 *   ArrowUp/Down    skip one section forward/back (chosen over Shift+Arrow)
 *   j / k           next / previous section (vi-like)
 *   s               stop
 */
export function createKeyboardController(deps: KeyboardDeps): KeyboardController {
  const doc = deps.document ?? (globalThis as { document?: DocumentLike }).document
  const tts = deps.tts
  const onStop = deps.onStop
  let attached = false

  function onKeyDown(ev: KeyboardEventLike): void {
    if (ev.isComposing) return
    if (isEditableTarget(ev.target)) return

    switch (ev.key) {
      case ' ':
        ev.preventDefault()
        {
          const s = tts.state()
          if (s.playing && !s.paused) tts.pause()
          else tts.play()
        }
        break
      case 'ArrowRight':
        tts.skip(1)
        break
      case 'ArrowLeft':
        tts.skip(-1)
        break
      case 'ArrowUp':
        tts.skipSection(1)
        break
      case 'ArrowDown':
        tts.skipSection(-1)
        break
      case 'j':
        tts.skipSection(1)
        break
      case 'k':
        tts.skipSection(-1)
        break
      case 's':
        if (onStop !== undefined) onStop()
        else tts.stop()
        break
      default:
        break
    }
  }

  return {
    attach(): void {
      if (!doc || attached) return
      attached = true
      doc.addEventListener('keydown', onKeyDown)
    },
    detach(): void {
      if (!doc || !attached) return
      attached = false
      doc.removeEventListener('keydown', onKeyDown)
    },
  }
}
