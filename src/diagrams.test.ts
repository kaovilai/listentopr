// All tests inject fakes: no real mermaid import ever runs here.
import { describe, expect, it, vi } from 'vitest'
import {
  createDiagramRenderer,
  DiagramError,
  type DiagramDeps,
  type MermaidLike,
} from './diagrams'

interface FakeElement {
  tagName: string
  svg: string
  style: Record<string, string>
  parentNode: FakeParent | null
}

interface FakeParent {
  children: FakeElement[]
  replaceChild(newChild: FakeElement, oldChild: FakeElement): void
}

function fakeElement(svg: string): FakeElement {
  return { tagName: 'svg', svg, style: {}, parentNode: null }
}

function fakeParent(child: FakeElement): FakeParent {
  const parent: FakeParent = {
    children: [child],
    replaceChild(newChild, oldChild) {
      const i = this.children.indexOf(oldChild)
      if (i >= 0) this.children[i] = newChild
      oldChild.parentNode = null
      newChild.parentNode = this
    },
  }
  child.parentNode = parent
  return parent
}

interface InitCall {
  startOnLoad: boolean
  securityLevel: string
  theme: string
}

interface RenderCall {
  id: string
  text: string
}

function createFakeMermaid(opts: {
  failBlocks?: string[]
  renderImpl?: (id: string, text: string) => Promise<{ svg: string }>
} = {}): { mermaid: MermaidLike; initCalls: InitCall[]; renderCalls: RenderCall[] } {
  const initCalls: InitCall[] = []
  const renderCalls: RenderCall[] = []
  const mermaid: MermaidLike = {
    initialize(cfg) {
      initCalls.push({ ...cfg })
    },
    async render(id, text) {
      if (opts.failBlocks?.includes(text)) {
        throw new Error(`mermaid syntax error: ${text}`)
      }
      if (opts.renderImpl) return opts.renderImpl(id, text)
      renderCalls.push({ id, text })
      return { svg: `<svg data-id="${id}">${text}</svg>` }
    },
  }
  return { mermaid, initCalls, renderCalls }
}

function makeDeps(
  fake: ReturnType<typeof createFakeMermaid>,
): DiagramDeps & { elements: FakeElement[] } {
  const elements: FakeElement[] = []
  return {
    mermaid: fake.mermaid,
    parseSvg: (svg: string) => {
      const el = fakeElement(svg)
      elements.push(el)
      return el as unknown as Element
    },
    elements,
  }
}

describe('createDiagramRenderer', () => {
  it('does not initialize mermaid before the first render', () => {
    const fake = createFakeMermaid()
    createDiagramRenderer(makeDeps(fake))
    expect(fake.initCalls).toHaveLength(0)
    expect(fake.renderCalls).toHaveLength(0)
  })

  it('initializes mermaid once on first render with strict config', async () => {
    const fake = createFakeMermaid()
    const renderer = createDiagramRenderer(makeDeps(fake))
    await renderer.render('graph TD; A-->B')
    await renderer.render('graph TD; C-->D')
    expect(fake.initCalls).toHaveLength(1)
    expect(fake.initCalls[0]).toEqual({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
    })
  })

  it('renders detached elements with responsive style, unique ids', async () => {
    const fake = createFakeMermaid()
    const deps = makeDeps(fake)
    const renderer = createDiagramRenderer(deps)

    const a = await renderer.render('graph TD; A-->B')
    const b = await renderer.render('graph TD; C-->D')

    expect(fake.renderCalls.map((c) => c.id)).toHaveLength(2)
    const ids = new Set(fake.renderCalls.map((c) => c.id))
    expect(ids.size).toBe(2)
    expect(fake.renderCalls.map((c) => c.text)).toEqual([
      'graph TD; A-->B',
      'graph TD; C-->D',
    ])

    for (const handle of [a, b]) {
      expect(handle.element.style['width']).toBe('100%')
      expect(handle.element.style['height']).toBe('auto')
      expect((handle.element as unknown as FakeElement).parentNode).toBeNull()
    }
    // Parsed from the svg the fake mermaid produced, in call order.
    expect(deps.elements.map((e) => e.svg)).toEqual([
      `<svg data-id="${fake.renderCalls[0]?.id}">graph TD; A-->B</svg>`,
      `<svg data-id="${fake.renderCalls[1]?.id}">graph TD; C-->D</svg>`,
    ])
  })

  it('throws typed DiagramError when mermaid rejects a block', async () => {
    const fake = createFakeMermaid({ failBlocks: ['graph BAD'] })
    const renderer = createDiagramRenderer(makeDeps(fake))
    await expect(renderer.render('graph BAD')).rejects.toBeInstanceOf(DiagramError)
    await expect(renderer.render('graph BAD')).rejects.toThrow(/mermaid failed to render/)
  })

  it('throws typed DiagramError when svg parsing fails', async () => {
    const fake = createFakeMermaid()
    const renderer = createDiagramRenderer({
      mermaid: fake.mermaid,
      parseSvg: () => {
        throw new Error('boom')
      },
    })
    await expect(renderer.render('graph TD; A-->B')).rejects.toBeInstanceOf(DiagramError)
    await expect(renderer.render('graph TD; A-->B')).rejects.toThrow(/failed to parse mermaid svg/)
  })

  it('setTheme re-initializes with the new theme and re-renders prior handles', async () => {
    const fake = createFakeMermaid()
    const deps = makeDeps(fake)
    const renderer = createDiagramRenderer(deps)

    const a = await renderer.render('graph TD; A-->B')
    const b = await renderer.render('graph TD; C-->D')
    const renderCountBefore = fake.renderCalls.length
    const elementsBefore = deps.elements.slice()

    await renderer.setTheme('light')

    expect(fake.initCalls).toHaveLength(2)
    expect(fake.initCalls[1]).toEqual({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'light',
    })
    // Both prior blocks re-rendered.
    expect(fake.renderCalls.length).toBe(renderCountBefore + 2)
    expect(fake.renderCalls.slice(-2).map((c) => c.text).sort()).toEqual([
      'graph TD; A-->B',
      'graph TD; C-->D',
    ])
    // Re-render ids stay unique.
    const ids = new Set(fake.renderCalls.map((c) => c.id))
    expect(ids.size).toBe(fake.renderCalls.length)
    // Handles now expose fresh elements, not the originals.
    expect(a.element).not.toBe(elementsBefore[0])
    expect(b.element).not.toBe(elementsBefore[1])
  })

  it('setTheme to the current theme is a no-op', async () => {
    const fake = createFakeMermaid()
    const renderer = createDiagramRenderer(makeDeps(fake))
    await renderer.render('graph TD; A-->B')
    await renderer.setTheme('dark')
    expect(fake.initCalls).toHaveLength(1)
    expect(fake.renderCalls).toHaveLength(1)
  })

  it('setTheme before any render just records the theme (init deferred, no rerender)', async () => {
    const fake = createFakeMermaid()
    const renderer = createDiagramRenderer(makeDeps(fake))
    await renderer.setTheme('light')
    expect(fake.initCalls).toHaveLength(1)
    expect(fake.initCalls[0]?.theme).toBe('light')
    expect(fake.renderCalls).toHaveLength(0)
    // First render initializes once (no second init from the render path).
    await renderer.render('graph TD; A-->B')
    expect(fake.initCalls).toHaveLength(1)
  })

  it('release drops cached handles: later setTheme does not re-render them', async () => {
    const fake = createFakeMermaid()
    const renderer = createDiagramRenderer(makeDeps(fake))
    await renderer.render('graph TD; A-->B')
    await renderer.render('graph TD; C-->D')
    expect(fake.renderCalls).toHaveLength(2)

    renderer.release()
    await renderer.setTheme('light')

    // Mermaid re-initialized for the new theme, but no block re-rendered.
    expect(fake.initCalls).toHaveLength(2)
    expect(fake.initCalls[1]?.theme).toBe('light')
    expect(fake.renderCalls).toHaveLength(2)
  })

  it('release rejects in-flight renders from joining the handle cache', async () => {
    const fake = createFakeMermaid()
    const renderer = createDiagramRenderer(makeDeps(fake))
    // Defer the render so release() lands while it is still in flight.
    let started = false
    let resolveRender: (value: { svg: string }) => void = () => undefined
    fake.mermaid.render = () => {
      started = true
      return new Promise((resolve) => {
        resolveRender = resolve
      })
    }
    const pending = renderer.render('graph TD; A-->B')
    // Let ensureInitialized's awaits run so the deferred render actually starts.
    await vi.waitFor(() => expect(started).toBe(true))
    renderer.release()
    resolveRender({ svg: '<svg>late</svg>' })
    await pending

    fake.mermaid.render = async (id, text) => {
      fake.renderCalls.push({ id, text })
      return { svg: `<svg>${text}</svg>` }
    }
    await renderer.setTheme('light')
    // The late handle never joined the cache: nothing re-rendered.
    expect(fake.renderCalls).toHaveLength(0)
  })

  it('handles cached after release belong to the new load only', async () => {
    const fake = createFakeMermaid()
    const renderer = createDiagramRenderer(makeDeps(fake))
    await renderer.render('graph TD; old')
    renderer.release()
    await renderer.render('graph TD; new')
    await renderer.setTheme('light')
    // Only the post-release block re-renders on the theme switch.
    expect(fake.renderCalls.map((c) => c.text)).toEqual([
      'graph TD; old',
      'graph TD; new',
      'graph TD; new',
    ])
  })

  it('rerender re-renders the block and swaps a mounted element in place', async () => {
    const fake = createFakeMermaid()
    const deps = makeDeps(fake)
    const renderer = createDiagramRenderer(deps)
    const handle = await renderer.render('graph TD; A-->B')

    const parent = fakeParent(handle.element as unknown as FakeElement)
    const oldElement = handle.element
    await handle.rerender()

    expect(fake.renderCalls).toHaveLength(2)
    expect(fake.renderCalls[1]?.text).toBe('graph TD; A-->B')
    expect(fake.renderCalls[0]?.id).not.toBe(fake.renderCalls[1]?.id)
    expect(handle.element).not.toBe(oldElement)
    // Old element cleared from its mount; fresh one in its place.
    expect(parent.children).toEqual([handle.element as unknown as FakeElement])
    expect((oldElement as unknown as FakeElement).parentNode).toBeNull()
  })

  it('rerender failure surfaces a DiagramError', async () => {
    const fake = createFakeMermaid({ failBlocks: [] })
    const renderer = createDiagramRenderer(makeDeps(fake))
    const handle = await renderer.render('graph TD; A-->B')
    // Flip the fake to fail only on the rerender call.
    fake.mermaid.render = async () => {
      throw new Error('later failure')
    }
    await expect(handle.rerender()).rejects.toBeInstanceOf(DiagramError)
  })

  it('renderAll isolates per-block failure', async () => {
    const fake = createFakeMermaid({ failBlocks: ['graph BROKEN'] })
    const renderer = createDiagramRenderer(makeDeps(fake))
    const entries = await renderer.renderAll([
      'graph TD; A-->B',
      'graph BROKEN',
      'graph TD; C-->D',
    ])
    expect(entries.map((e) => e.block)).toEqual([
      'graph TD; A-->B',
      'graph BROKEN',
      'graph TD; C-->D',
    ])
    expect(entries[0]?.result).not.toBeNull()
    expect(entries[1]?.result).toBeNull()
    expect(entries[2]?.result).not.toBeNull()
    // Good siblings actually rendered.
    expect(fake.renderCalls.map((c) => c.text)).toEqual([
      'graph TD; A-->B',
      'graph TD; C-->D',
    ])
  })

  it('available() reflects injected mermaid + svg parser', () => {
    const fake = createFakeMermaid()
    expect(createDiagramRenderer(makeDeps(fake)).available()).toBe(true)
    // Missing parser (and no DOMParser in node) -> unavailable.
    expect(createDiagramRenderer({ mermaid: fake.mermaid }).available()).toBe(false)
    // Nothing injected at all in node -> unavailable, and no import attempted.
    expect(createDiagramRenderer().available()).toBe(false)
    // No injected mermaid: import not attempted yet, but the module is
    // bundled, so availability tracks only the parser here.
    expect(
      createDiagramRenderer({
        parseSvg: (svg: string) => fakeElement(svg) as unknown as Element,
      }).available(),
    ).toBe(true)
  })
})
