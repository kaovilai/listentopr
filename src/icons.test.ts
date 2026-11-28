// Behavior tests for the SVG icon sprite module (node env: a minimal fake
// DOM stands in for document.createElementNS / element tree queries).
import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SPRITE, SPRITE_ID, icon, injectSprite, type IconName } from './icons'

/** Minimal element: tag, id, attributes, children, '#id' querySelector. */
class FakeElement {
  tagName: string
  id = ''
  innerHTML = ''
  children: FakeElement[] = []
  private attrs: Record<string, string> = {}
  constructor(tag: string) {
    this.tagName = tag
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null
  }
  removeChild(child: FakeElement): FakeElement {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    return child
  }
  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith('#')) return null
    return this.findById(selector.slice(1))
  }
  private findById(id: string): FakeElement | null {
    for (const child of this.children) {
      if (child.id === id) return child
      const hit = child.findById(id)
      if (hit) return hit
    }
    return null
  }
}

const fakeDocument = {
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
}
vi.stubGlobal('document', fakeDocument)

/** A detached container element (never attached to any document). */
function detachedTarget(): HTMLElement {
  return new FakeElement('div') as unknown as HTMLElement
}

const DESIGN_DIR = fileURLToPath(new URL('../design/icons', import.meta.url))

describe('SPRITE stays in sync with design/icons', () => {
  const files = readdirSync(DESIGN_DIR)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.replace(/\.svg$/, ''))

  it('covers every design/icons/*.svg file', () => {
    expect(files.length).toBe(32)
    for (const name of files) {
      expect(SPRITE, `missing SPRITE key: ${name}`).toHaveProperty(name)
      expect((SPRITE as Record<string, unknown>)[name]).toBeTruthy()
    }
  })

  it('has no keys without a source file', () => {
    for (const key of Object.keys(SPRITE)) {
      expect(files, `SPRITE key without design file: ${key}`).toContain(key)
    }
  })

  it('sprite markup matches the source file inner markup', () => {
    for (const name of files) {
      const svg = readFileSync(path.join(DESIGN_DIR, `${name}.svg`), 'utf8')
      const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
      expect(SPRITE[name as IconName]).toBe(inner)
    }
  })

  it('has no dead icons: every SPRITE key is referenced in app.ts', () => {
    const appSource = readFileSync(
      path.join(DESIGN_DIR, '../../src/app.ts'),
      'utf8',
    )
    for (const key of Object.keys(SPRITE)) {
      expect(
        appSource.includes(`'${key}'`),
        `SPRITE key never used in app.ts: ${key}`,
      ).toBe(true)
    }
  })
})

describe('injectSprite', () => {
  it('creates one hidden sprite with a symbol per icon', () => {
    const target = detachedTarget()
    injectSprite(target)
    const root = target as unknown as FakeElement
    const sprite = root.querySelector(`#${SPRITE_ID}`)
    expect(sprite).not.toBeNull()
    expect(sprite!.getAttribute('style')).toBe('display:none')
    expect(sprite!.getAttribute('aria-hidden')).toBe('true')
    expect(sprite!.children).toHaveLength(32)
  })

  it('is idempotent: two calls leave a single sprite node', () => {
    const target = detachedTarget()
    injectSprite(target)
    injectSprite(target)
    const root = target as unknown as FakeElement
    const sprites = root.children.filter((c) => c.id === SPRITE_ID)
    expect(sprites).toHaveLength(1)
    expect(sprites[0]!.children).toHaveLength(32)
  })

  it('refreshes in place: the existing node object is reused', () => {
    const target = detachedTarget()
    injectSprite(target)
    const root = target as unknown as FakeElement
    const first = root.querySelector(`#${SPRITE_ID}`)
    injectSprite(target)
    expect(root.querySelector(`#${SPRITE_ID}`)).toBe(first)
  })

  it('prefixes every symbol id and carries Feather presentation attrs', () => {
    const target = detachedTarget()
    injectSprite(target)
    const symbols = (target as unknown as FakeElement).querySelector(`#${SPRITE_ID}`)!
      .children
    for (const symbol of symbols) {
      expect(symbol.id.startsWith('lpr-icon-')).toBe(true)
      expect(symbol.getAttribute('viewBox')).toBe('0 0 24 24')
      expect(symbol.getAttribute('fill')).toBe('none')
      expect(symbol.getAttribute('stroke')).toBe('currentColor')
      expect(symbol.getAttribute('stroke-width')).toBe('2')
      expect(symbol.getAttribute('stroke-linecap')).toBe('round')
      expect(symbol.getAttribute('stroke-linejoin')).toBe('round')
    }
  })

  it('works on a detached element (no document attachment needed)', () => {
    const target = detachedTarget()
    expect(() => injectSprite(target)).not.toThrow()
    expect((target as unknown as FakeElement).children.length).toBe(1)
  })
})

describe('icon', () => {
  it('returns a decorative <svg><use> pointing at the sprite symbol', () => {
    const el = icon('play')
    const svg = el as unknown as FakeElement
    expect(svg.tagName).toBe('svg')
    expect(svg.getAttribute('class')).toBe('icon')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.children).toHaveLength(1)
    const use = svg.children[0]!
    expect(use.tagName).toBe('use')
    expect(use.getAttribute('href')).toBe('#lpr-icon-play')
  })

  it('throws at runtime for an unknown name (JS callers)', () => {
    expect(() => icon('nope' as IconName)).toThrow(/unknown icon name/)
    // @ts-expect-error unknown names must not compile for TS callers
    expect(() => icon('nope')).toThrow(/unknown icon name/)
  })
})
