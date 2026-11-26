import type { TtsController, TtsProgress } from './types'

// Structural types so tests (and non-DOM runtimes) can pass plain fakes.

export type MediaSessionAction =
  | 'play'
  | 'pause'
  | 'previoustrack'
  | 'nexttrack'
  | 'seekbackward'
  | 'seekforward'

export type MediaSessionHandler = ((details?: unknown) => void) | null

export interface MediaSessionLike {
  metadata: unknown
  setActionHandler(action: MediaSessionAction, handler: MediaSessionHandler): void
  setPositionState(state: {
    duration: number
    position: number
    playbackRate: number
  }): void
}

export interface MediaMetadataLike {
  new (init: { title: string; artist: string }): unknown
}

export interface MediaSessionDeps {
  mediaSession?: MediaSessionLike
  /** Constructor for MediaMetadata; defaults to navigator.MediaMetadata. */
  MetadataCtor?: MediaMetadataLike
}

/** Subset of navigator the media-session code touches. */
interface NavigatorLike {
  mediaSession?: MediaSessionLike
  MediaMetadata?: MediaMetadataLike
}

function resolveNavigator(): NavigatorLike | undefined {
  return (globalThis as { navigator?: NavigatorLike }).navigator
}

export interface MediaSessionController {
  /** Show title/artist on the OS media surface. Artist defaults to 'ListenToPR'. */
  setMetadata(title: string, artist?: string): void
  /** Map OS media keys to TTS controls. Returns unwire(). */
  wireHandlers(tts: TtsController): () => void
  /** Publish playback position for OS progress UI. Never throws. */
  updatePositionState(progress: TtsProgress): void
  /** True when navigator.mediaSession exists. */
  available(): boolean
}

export function createMediaSessionController(
  deps: MediaSessionDeps = {},
): MediaSessionController {
  const mediaSession: MediaSessionLike | undefined =
    deps.mediaSession ?? resolveNavigator()?.mediaSession

  const resolveMetadataCtor = (): MediaMetadataLike | undefined =>
    deps.MetadataCtor ?? resolveNavigator()?.MediaMetadata

  function setMetadata(title: string, artist?: string): void {
    if (!mediaSession) return
    const Ctor = resolveMetadataCtor()
    if (!Ctor) return
    try {
      mediaSession.metadata = new Ctor({
        title,
        artist: artist ?? 'ListenToPR',
      })
    } catch {
      // Unsupported or constructor threw; metadata is cosmetic, not fatal.
    }
  }

  function wireHandlers(tts: TtsController): () => void {
    if (!mediaSession) return () => {}
    // TtsController.skip() only accepts +/-1, so the OS seek buttons jump
    // two sentences through getProgress() + seekTo() instead.
    const mapping: [MediaSessionAction, () => void][] = [
      ['play', () => tts.play()],
      ['pause', () => tts.pause()],
      ['previoustrack', () => tts.skip(-1)],
      ['nexttrack', () => tts.skip(1)],
      ['seekbackward', () => tts.seekTo(tts.getProgress().sentenceIndex - 2)],
      ['seekforward', () => tts.seekTo(tts.getProgress().sentenceIndex + 2)],
    ]
    for (const [action, handler] of mapping) {
      try {
        mediaSession.setActionHandler(action, handler)
      } catch {
        // Action unsupported on this platform; skip it.
      }
    }
    return () => {
      for (const [action] of mapping) {
        try {
          // The spec allows null to clear a handler; platforms that
          // reject it are simply left with the old handler.
          mediaSession.setActionHandler(action, null)
        } catch {
          // No way to clear; ignore.
        }
      }
    }
  }

  function updatePositionState(progress: TtsProgress): void {
    if (!mediaSession) return
    try {
      mediaSession.setPositionState({
        duration: progress.totalEstimatedSeconds,
        position: progress.estimatedSeconds,
        playbackRate: 1,
      })
    } catch {
      // setPositionState throws on non-finite or non-positive duration;
      // progress UI is cosmetic, not fatal.
    }
  }

  return {
    setMetadata,
    wireHandlers,
    updatePositionState,
    available: () => mediaSession !== undefined,
  }
}
