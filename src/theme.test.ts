import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createThemeController,
  prefersDark,
  THEME_STORAGE_KEY,
  type DocumentLike,
  type MatchMediaLike,
  type MediaQueryListLike,
  type StorageLike,
} from './theme'

// ---------- fakes ----------

interface FakeMediaList extends MediaQueryListLike {
  set(matches: boolean): void
  /** Flip `matches` then fire registered 'change' listeners. */
  dispatch(): void
  listenerCount(): number
}

function fakeMediaList(initial: boolean): FakeMediaList {
  const listeners = new Set<() => void>()
  let matches = initial
  return {
    get matches(): boolean {
      return matches
    },
    addEventListener(_type: 'change', listener: () => void): void {
      listeners.add(listener)
    },
    removeEventListener(_type: 'change', listener: () => void): void {
      listeners.delete(listener)
    },
    set(next: boolean): void {
      matches = next
    },
    /** Fire registered 'change' listeners (state changed via set()). */
    dispatch(): void {
      for (const l of [...listeners]) l()
    },
    listenerCount(): number {
      return listeners.size
    },
  }
}

function fakeMatchMedia(initial: boolean): MatchMediaLike & { list: FakeMediaList } {
  const list = fakeMediaList(initial)
  const fn = vi.fn((query: string): MediaQueryListLike => {
    void query
    return list
  })
  return Object.assign(fn, { list })
}

interface FakeMeta {
  name: string
  content: string
  setAttribute(name: string, value: string): void
}

function fakeDocument(options?: { meta?: FakeMeta | null }) {
  const meta: FakeMeta | null =
    options?.meta === undefined
      ? {
          name: 'theme-color',
          content: '',
          setAttribute(name: string, value: string): void {
            if (name === 'content') this.content = value
          },
        }
      : options.meta
  const doc: DocumentLike & {
    documentElement: { dataset: { theme?: string } }
    metaContent(): string | null
  } = {
    documentElement: { dataset: {} },
    querySelector(selector: string) {
      return selector === 'meta[name="theme-color"]' && meta ? meta : null
    },
    metaContent(): string | null {
      return meta ? meta.content : null
    },
  }
  return doc
}

function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  map: Map<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem(key: string): string | null {
      return map.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      map.set(key, value)
    },
  }
}

const throwingStorage = (): StorageLike => ({
  getItem(): string | null {
    throw new Error('corrupted store')
  },
  setItem(): void {
    throw new Error('quota exceeded')
  },
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- prefersDark (pure) ----------

describe('prefersDark', () => {
  it('returns true for the dark color-scheme query', () => {
    expect(prefersDark('(prefers-color-scheme: dark)')).toBe(true)
  })

  it('returns false for the light query', () => {
    expect(prefersDark('(prefers-color-scheme: light)')).toBe(false)
  })

  it('returns false for unrelated or malformed queries', () => {
    expect(prefersDark('')).toBe(false)
    expect(prefersDark('(min-width: 600px)')).toBe(false)
    expect(prefersDark('prefers-color-scheme')).toBe(false)
  })

  it('tolerates whitespace and case', () => {
    expect(prefersDark('(prefers-color-scheme:dark)')).toBe(true)
    expect(prefersDark('( PREFERS-COLOR-SCHEME :  dark )')).toBe(true)
  })
})

// ---------- persistence + legacy mapping ----------

describe('createThemeController persisted mode', () => {
  it('treats a never-written key as the legacy default dark (light-OS user keeps dark)', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(false),
      localStorage: fakeStorage(),
    })
    expect(c.getMode()).toBe('dark')
    expect(c.getResolved()).toBe('dark')
  })

  it('maps legacy stored light to light', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(true),
      localStorage: fakeStorage({ [THEME_STORAGE_KEY]: 'light' }),
    })
    expect(c.getMode()).toBe('light')
    expect(c.getResolved()).toBe('light')
  })

  it('keeps an explicitly stored dark as dark', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(false),
      localStorage: fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }),
    })
    expect(c.getMode()).toBe('dark')
    expect(c.getResolved()).toBe('dark')
  })

  it('reads a persisted auto back as auto', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(true),
      localStorage: fakeStorage({ [THEME_STORAGE_KEY]: 'auto' }),
    })
    expect(c.getMode()).toBe('auto')
    expect(c.getResolved()).toBe('dark')
  })

  it('treats corrupt stored values as the legacy default dark', () => {
    for (const bad of ['banana', ' LIGHT ', '{}']) {
      const c = createThemeController({
        document: fakeDocument(),
        matchMedia: fakeMatchMedia(true),
        localStorage: fakeStorage({ [THEME_STORAGE_KEY]: bad }),
      })
      expect(c.getMode()).toBe('dark')
    }
  })

  it('survives a storage that throws on read (legacy default dark)', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(false),
      localStorage: throwingStorage(),
    })
    expect(c.getMode()).toBe('dark')
  })

  it('defaults to dark when no storage exists at all', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(true),
    })
    expect(c.getMode()).toBe('dark')
    expect(c.getResolved()).toBe('dark')
  })
})

// ---------- apply / setMode ----------

describe('apply and setMode', () => {
  it('writes the resolved theme to <html data-theme>', () => {
    const doc = fakeDocument()
    const c = createThemeController({
      document: doc,
      matchMedia: fakeMatchMedia(true),
      localStorage: fakeStorage(),
    })
    expect(c.apply()).toBe('dark')
    expect(doc.documentElement.dataset.theme).toBe('dark')
  })

  it('resolves auto light when the OS prefers light', () => {
    const doc = fakeDocument()
    const c = createThemeController({
      document: doc,
      matchMedia: fakeMatchMedia(false),
      localStorage: fakeStorage({ [THEME_STORAGE_KEY]: 'auto' }),
    })
    c.apply()
    expect(doc.documentElement.dataset.theme).toBe('light')
  })

  it('resolves auto to light when matchMedia is absent', () => {
    const c = createThemeController({
      document: fakeDocument(),
      localStorage: fakeStorage({ [THEME_STORAGE_KEY]: 'auto' }),
    })
    expect(c.getResolved()).toBe('light')
  })

  it('resolves auto to light when matchMedia throws', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: () => {
        throw new Error('no media support')
      },
      localStorage: fakeStorage({ [THEME_STORAGE_KEY]: 'auto' }),
    })
    expect(c.getResolved()).toBe('light')
  })

  it('updates <meta name="theme-color"> content per resolved theme', () => {
    const doc = fakeDocument()
    const c = createThemeController({
      document: doc,
      matchMedia: fakeMatchMedia(false),
      localStorage: fakeStorage(),
    })
    c.setMode('dark')
    expect(doc.metaContent()).toBe('#0e1116')
    c.setMode('light')
    expect(doc.metaContent()).toBe('#f6f7f9')
  })

  it('skips the meta update when no meta element exists', () => {
    const doc = fakeDocument({ meta: null })
    const c = createThemeController({
      document: doc,
      matchMedia: fakeMatchMedia(false),
      localStorage: fakeStorage(),
    })
    expect(() => c.setMode('dark')).not.toThrow()
    expect(doc.documentElement.dataset.theme).toBe('dark')
  })

  it('persists setMode to storage', () => {
    const storage = fakeStorage()
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(false),
      localStorage: storage,
    })
    c.setMode('light')
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe('light')
  })

  it('applies and notifies even when persistence throws', () => {
    const doc = fakeDocument()
    const c = createThemeController({
      document: doc,
      matchMedia: fakeMatchMedia(false),
      localStorage: throwingStorage(),
    })
    const seen: Array<[string, string]> = []
    c.onChange((m, r) => seen.push([m, r]))
    expect(() => c.setMode('dark')).not.toThrow()
    expect(doc.documentElement.dataset.theme).toBe('dark')
    expect(seen).toEqual([['dark', 'dark']])
  })

  it('notifies onChange subscribers with mode and resolved', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(false),
      localStorage: fakeStorage(),
    })
    const seen: Array<[string, string]> = []
    const off = c.onChange((m, r) => seen.push([m, r]))
    c.setMode('dark')
    c.setMode('auto') // media says light
    off()
    c.setMode('light')
    expect(seen).toEqual([
      ['dark', 'dark'],
      ['auto', 'light'],
    ])
  })
})

// ---------- media following ----------

describe('listen and auto re-resolve', () => {
  it('re-applies and notifies when the media preference flips while auto', () => {
    const doc = fakeDocument()
    const media = fakeMatchMedia(true) // start dark
    const c = createThemeController({
      document: doc,
      matchMedia: media,
      localStorage: fakeStorage({ [THEME_STORAGE_KEY]: 'auto' }),
    })
    c.listen()
    c.apply()
    expect(doc.documentElement.dataset.theme).toBe('dark')

    const seen: Array<[string, string]> = []
    c.onChange((m, r) => seen.push([m, r]))
    media.list.set(false) // dark -> light
    media.list.dispatch()
    expect(doc.documentElement.dataset.theme).toBe('light')
    expect(seen).toEqual([['auto', 'light']])

    media.list.set(true) // light -> dark
    media.list.dispatch()
    expect(doc.documentElement.dataset.theme).toBe('dark')
    expect(seen).toEqual([
      ['auto', 'light'],
      ['auto', 'dark'],
    ])
  })

  it('ignores media changes while an explicit mode is set', () => {
    const doc = fakeDocument()
    const media = fakeMatchMedia(true)
    const c = createThemeController({
      document: doc,
      matchMedia: media,
      localStorage: fakeStorage({ [THEME_STORAGE_KEY]: 'light' }),
    })
    c.listen()
    c.apply()
    expect(doc.documentElement.dataset.theme).toBe('light')
    const seen: Array<[string, string]> = []
    c.onChange((m, r) => seen.push([m, r]))
    media.list.set(true)
    media.list.dispatch()
    expect(doc.documentElement.dataset.theme).toBe('light')
    expect(seen).toEqual([])
  })

  it('resumes following after switching back to auto', () => {
    const doc = fakeDocument()
    const media = fakeMatchMedia(false)
    const c = createThemeController({
      document: doc,
      matchMedia: media,
      localStorage: fakeStorage(),
    })
    c.listen()
    c.setMode('dark')
    expect(doc.documentElement.dataset.theme).toBe('dark')
    media.list.set(true)
    media.list.dispatch()
    expect(doc.documentElement.dataset.theme).toBe('dark') // explicit mode wins
    c.setMode('auto')
    expect(doc.documentElement.dataset.theme).toBe('dark') // media now dark
    media.list.set(false)
    media.list.dispatch()
    expect(doc.documentElement.dataset.theme).toBe('light')
  })

  it('is idempotent: a second listen() registers no extra listener', () => {
    const media = fakeMatchMedia(true)
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: media,
      localStorage: fakeStorage(),
    })
    c.listen()
    c.listen()
    expect(media.list.listenerCount()).toBe(1)
  })

  it('registers nothing when matchMedia is absent', () => {
    const c = createThemeController({
      document: fakeDocument(),
      localStorage: fakeStorage(),
    })
    expect(() => c.listen()).not.toThrow()
  })

  it('dispose removes the media listener and subscribers', () => {
    const doc = fakeDocument()
    const media = fakeMatchMedia(true)
    const c = createThemeController({
      document: doc,
      matchMedia: media,
      localStorage: fakeStorage(),
    })
    c.listen()
    const seen: Array<[string, string]> = []
    c.onChange((m, r) => seen.push([m, r]))
    c.dispose()
    expect(media.list.listenerCount()).toBe(0)
    media.list.dispatch()
    expect(seen).toEqual([])
    expect(doc.documentElement.dataset.theme).toBeUndefined()
  })

  it('dispose without listen() is safe', () => {
    const c = createThemeController({
      document: fakeDocument(),
      matchMedia: fakeMatchMedia(true),
      localStorage: fakeStorage(),
    })
    expect(() => c.dispose()).not.toThrow()
  })
})

// ---------- globalThis defaults ----------

describe('globalThis defaults', () => {
  it('constructs safely with no browser globals at all', () => {
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('matchMedia', undefined)
    vi.stubGlobal('localStorage', undefined)
    const c = createThemeController()
    expect(c.getMode()).toBe('dark')
    expect(c.getResolved()).toBe('dark')
    expect(() => c.setMode('dark')).not.toThrow()
    expect(c.getMode()).toBe('dark')
    expect(() => {
      c.listen()
      c.dispose()
      c.apply()
    }).not.toThrow()
  })

  it('uses globalThis.document when no deps are given', () => {
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('matchMedia', undefined)
    vi.stubGlobal('localStorage', undefined)
    const c = createThemeController()
    c.setMode('light')
    expect(doc.documentElement.dataset.theme).toBe('light')
  })
})
