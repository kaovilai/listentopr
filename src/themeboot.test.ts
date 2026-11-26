// Tests for public/theme-boot.js — the pre-paint theme resolver loaded
// blocking in <head> (CSP: script-src 'self', no inline script allowed).
// The script is executed against stubbed globals so its legacy mapping is
// verified behaviorally, and index.html / sw.js are checked statically.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

const bootSource = readFileSync(
  new URL('../public/theme-boot.js', import.meta.url),
  'utf8',
)
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')

interface BootResult {
  dataTheme: string | undefined
  themeColor: string | null
}

/** Run theme-boot.js against stubbed browser globals and observe its writes. */
function runBoot(opts: {
  storedMode: string | null
  mediaDark: boolean
  hasMatchMedia?: boolean
  storageThrows?: boolean
}): BootResult {
  const metaWrites: Array<{ name: string; value: string }> = []
  const meta = {
    setAttribute(name: string, value: string) {
      metaWrites.push({ name, value })
    },
  }
  const documentElement = { dataset: {} as { theme?: string } }
  vi.stubGlobal(
    'localStorage',
    opts.storageThrows
      ? {
          getItem(): string | null {
            throw new Error('corrupted store')
          },
        }
      : { getItem: () => opts.storedMode },
  )
  vi.stubGlobal(
    'window',
    opts.hasMatchMedia === false
      ? {}
      : { matchMedia: () => ({ matches: opts.mediaDark }) },
  )
  vi.stubGlobal('document', {
    documentElement,
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]' ? meta : null,
  })
  // The boot file is a plain IIFE: execute it in global scope.
  new Function(bootSource)()
  const themeColor =
    metaWrites.find((w) => w.name === 'content')?.value ?? '#0e1116'
  return { dataTheme: documentElement.dataset.theme, themeColor }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme-boot pre-paint resolution', () => {
  it('keeps dark for a never-written key (legacy default, light-OS user)', () => {
    const r = runBoot({ storedMode: null, mediaDark: false })
    expect(r.dataTheme).toBe('dark')
    expect(r.themeColor).toBe('#0e1116')
  })

  it('keeps dark for corrupt or unknown stored values', () => {
    for (const bad of ['banana', '{}', ' LIGHT ']) {
      expect(runBoot({ storedMode: bad, mediaDark: false }).dataTheme).toBe('dark')
    }
  })

  it('resolves light for a persisted light mode', () => {
    const r = runBoot({ storedMode: 'light', mediaDark: true })
    expect(r.dataTheme).toBe('light')
    expect(r.themeColor).toBe('#f6f7f9')
  })

  it("follows the OS preference for 'auto'", () => {
    expect(runBoot({ storedMode: 'auto', mediaDark: true }).dataTheme).toBe('dark')
    expect(runBoot({ storedMode: 'auto', mediaDark: false }).dataTheme).toBe('light')
  })

  it("resolves 'auto' to light when matchMedia is absent (mirrors theme.ts)", () => {
    expect(runBoot({ storedMode: 'auto', mediaDark: true, hasMatchMedia: false }).dataTheme)
      .toBe('light')
  })

  it('leaves the dark CSS default untouched when storage throws (private mode)', () => {
    const r = runBoot({ storedMode: 'light', mediaDark: false, storageThrows: true })
    // No data-theme written: styles.css :root default (dark) keeps rendering.
    expect(r.dataTheme).toBeUndefined()
    expect(r.themeColor).toBe('#0e1116')
  })

  it('never writes storage (read-only boot)', () => {
    expect(bootSource).not.toMatch(/setItem|removeItem|clear\s*\(/)
  })
})

describe('theme-boot wiring', () => {
  it('index.html loads it blocking in <head>, after the theme-color meta', () => {
    const scriptTag = '<script src="./theme-boot.js"></script>'
    expect(indexHtml).toContain(scriptTag)
    const scriptAt = indexHtml.indexOf(scriptTag)
    const metaAt = indexHtml.indexOf('<meta name="theme-color"')
    expect(metaAt).toBeGreaterThanOrEqual(0)
    expect(scriptAt).toBeGreaterThan(metaAt)
    // No inline script anywhere: CSP script-src 'self' must stay meaningful.
    expect(indexHtml).not.toMatch(/<script(?![^>]*src=)[^>]*>/)
  })

  it('the service worker precaches theme-boot.js (blocking script must not miss)', () => {
    expect(swSource).toMatch(/'\.\/theme-boot\.js'/)
  })
})
