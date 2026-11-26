// Theme engine: 'auto' | 'light' | 'dark' with persistence, media-query
// following and DOM application. Structural deps so tests (and non-DOM
// runtimes) can pass plain fakes; globalThis is only read lazily inside the
// factory, so importing this module never throws outside a browser.

export type ThemeMode = 'auto' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** Existing persisted key (legacy values: 'light' / anything else = dark). */
export const THEME_STORAGE_KEY = 'listentopr.theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Browser-bar color advertised through <meta name="theme-color">. */
const THEME_COLOR_DARK = '#0e1116'
const THEME_COLOR_LIGHT = '#f6f7f9'

/**
 * Pure helper: does a media-query string ask for the dark color scheme?
 * Kept pure (no matchMedia) so query building stays unit-testable.
 */
export function prefersDark(query: string): boolean {
  return /prefers-color-scheme\s*:\s*dark/i.test(query)
}

// ---------- structural dep types ----------

export interface ElementLike {
  setAttribute(name: string, value: string): void
}

export interface DocumentLike {
  documentElement: { dataset: { theme?: string } }
  querySelector?(selector: string): ElementLike | null
}

export interface MediaQueryListLike {
  readonly matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

export type MatchMediaLike = (query: string) => MediaQueryListLike

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ThemeDeps {
  document?: DocumentLike
  matchMedia?: MatchMediaLike
  localStorage?: StorageLike
}

export interface ThemeController {
  getMode(): ThemeMode
  getResolved(): ResolvedTheme
  /** Persist + apply + notify. Persistence failure never blocks the switch. */
  setMode(mode: ThemeMode): void
  /** Write the resolved theme to <html data-theme> and the theme-color meta. */
  apply(): ResolvedTheme
  /** Follow prefers-color-scheme changes while mode is 'auto'. Idempotent. */
  listen(): void
  /** Drop the media listener and all onChange subscribers. */
  dispose(): void
  onChange(cb: (mode: ThemeMode, resolved: ResolvedTheme) => void): () => void
}

const MODES: readonly ThemeMode[] = ['auto', 'light', 'dark']

/**
 * Read the persisted mode. Legacy mapping: the pre-controller UI treated
 * anything but a stored 'light' as dark, so a missing, corrupt or unknown
 * value stays 'dark' — an existing user who never toggled must not silently
 * flip to light on a light-OS machine after the update. 'auto' is only read
 * back once this controller has persisted it.
 */
function readStoredMode(storage: StorageLike | undefined): ThemeMode {
  if (!storage) return 'dark'
  let raw: string | null
  try {
    raw = storage.getItem(THEME_STORAGE_KEY)
  } catch {
    return 'dark'
  }
  return MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : 'dark'
}

export function createThemeController(deps: ThemeDeps = {}): ThemeController {
  const doc = deps.document ?? (globalThis as { document?: DocumentLike }).document
  const matchMedia =
    deps.matchMedia ?? (globalThis as { matchMedia?: MatchMediaLike }).matchMedia
  const storage =
    deps.localStorage ?? (globalThis as { localStorage?: StorageLike }).localStorage

  let mode: ThemeMode = readStoredMode(storage)
  // Cached so resolve() and the change listener always observe the same list.
  let darkList: MediaQueryListLike | null | undefined
  let mediaListener: (() => void) | null = null
  const subscribers = new Set<(mode: ThemeMode, resolved: ResolvedTheme) => void>()

  function getDarkList(): MediaQueryListLike | null {
    if (darkList === undefined) {
      darkList = null
      if (matchMedia) {
        try {
          darkList = matchMedia(DARK_QUERY)
        } catch {
          darkList = null
        }
      }
    }
    return darkList
  }

  function resolve(m: ThemeMode): ResolvedTheme {
    if (m === 'light' || m === 'dark') return m
    // No matchMedia (or a throwing one): the CSS spec default is light.
    return getDarkList()?.matches === true ? 'dark' : 'light'
  }

  function apply(): ResolvedTheme {
    const resolved = resolve(mode)
    if (doc) {
      doc.documentElement.dataset.theme = resolved
      const meta = doc.querySelector?.('meta[name="theme-color"]')
      if (meta) {
        meta.setAttribute(
          'content',
          resolved === 'dark' ? THEME_COLOR_DARK : THEME_COLOR_LIGHT,
        )
      }
    }
    return resolved
  }

  function notify(resolved: ResolvedTheme): void {
    for (const cb of subscribers) cb(mode, resolved)
  }

  function setMode(m: ThemeMode): void {
    mode = m
    if (storage) {
      try {
        storage.setItem(THEME_STORAGE_KEY, m)
      } catch {
        // Persistence failure (quota, corrupted store) must not break the switch.
      }
    }
    notify(apply())
  }

  function listen(): void {
    if (mediaListener) return
    const list = getDarkList()
    if (!list) return
    const onMediaChange = (): void => {
      if (mode !== 'auto') return
      notify(apply())
    }
    list.addEventListener('change', onMediaChange)
    mediaListener = onMediaChange
  }

  function dispose(): void {
    if (mediaListener) {
      getDarkList()?.removeEventListener('change', mediaListener)
      mediaListener = null
    }
    subscribers.clear()
  }

  return {
    getMode: () => mode,
    getResolved: () => resolve(mode),
    setMode,
    apply,
    listen,
    dispose,
    onChange(cb: (mode: ThemeMode, resolved: ResolvedTheme) => void): () => void {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
  }
}
