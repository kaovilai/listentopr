// Mermaid diagram rendering for PR-embedded mermaid blocks
// (PullRequestData.mermaidBlocks). Rendering is lazy: the real mermaid bundle
// is only imported on first render, so pages without diagrams never pay for
// it. Tests inject a fake mermaid + fake svg parser; no real import happens.

export type DiagramTheme = 'dark' | 'light'

/** Minimal slice of mermaid's API this module needs (structural, fake-friendly). */
export interface MermaidLike {
  initialize(config: {
    startOnLoad: boolean
    securityLevel: 'strict'
    theme: DiagramTheme
  }): unknown
  render(id: string, text: string): Promise<{ svg: string }>
}

export interface DiagramRenderResult {
  /** Detached styled element; the caller appends it to the DOM. */
  element: SVGElement | HTMLElement
  /** Re-render the same block (e.g. after a theme switch). */
  rerender(): Promise<void>
}

export interface DiagramRenderAllEntry {
  block: string
  /** Null when this block failed to render (bad syntax etc.). */
  result: DiagramRenderResult | null
}

export interface DiagramRenderer {
  render(block: string): Promise<DiagramRenderResult>
  renderAll(blocks: string[]): Promise<DiagramRenderAllEntry[]>
  setTheme(theme: DiagramTheme): Promise<void>
  /**
   * Drop every cached handle and reject in-flight renders from joining the
   * cache. The caller aborts the load these diagrams belong to: later
   * setTheme calls must not re-render (or keep alive) discarded diagrams.
   */
  release(): void
  /** True when rendering can work here (mermaid importable + svg parser present). */
  available(): boolean
}

export interface DiagramDeps {
  /** Injectable mermaid (tests pass a fake). Default: real mermaid import. */
  mermaid?: MermaidLike
  /** Injectable svg-string -> Element step (tests pass a fake). Default: DOMParser. */
  parseSvg?: (svg: string) => Element
}

/** Typed error for mermaid syntax failures and svg parse failures. */
export class DiagramError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DiagramError'
  }
}

// Sequence numbers so every generated mermaid id is unique, even across
// multiple renderer instances in one page.
let rendererSeq = 0

function defaultParseSvg(svg: string): Element {
  // Browser-only path: DOMParser is absent in node, so callers there must
  // inject deps.parseSvg.
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  const parseFailed =
    !root ||
    root.tagName.toLowerCase() === 'parsererror' ||
    !!root.querySelector('parsererror')
  if (parseFailed) {
    throw new DiagramError('mermaid produced unparseable svg output')
  }
  return root
}

export function createDiagramRenderer(deps: DiagramDeps = {}): DiagramRenderer {
  const rid = ++rendererSeq
  let idCounter = 0
  const nextId = (): string => `lpr-diagram-${rid}-${++idCounter}`

  let currentTheme: DiagramTheme = 'dark'
  let initialized = false

  // Real-mermaid import state. 'idle' means "not attempted yet" — the module
  // is statically bundled, so an attempt will succeed in the browser; only a
  // failed dynamic import (transport error) flips this to 'failed'.
  let importState: 'idle' | 'ok' | 'failed' = 'idle'
  let importPromise: Promise<MermaidLike> | null = null

  function loadRealMermaid(): Promise<MermaidLike> {
    if (!importPromise) {
      importPromise = import('mermaid')
        .then((m) => {
          importState = 'ok'
          return m.default as unknown as MermaidLike
        })
        .catch((err: unknown) => {
          importState = 'failed'
          importPromise = null
          throw err
        })
    }
    return importPromise
  }

  async function ensureMermaid(): Promise<MermaidLike> {
    if (deps.mermaid) return deps.mermaid
    return loadRealMermaid()
  }

  /** Resolve mermaid and run initialize exactly once per theme change. */
  async function ensureInitialized(): Promise<MermaidLike> {
    const m = await ensureMermaid()
    if (!initialized) {
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: currentTheme,
      })
      initialized = true
    }
    return m
  }

  const parse: (svg: string) => Element = deps.parseSvg ?? defaultParseSvg

  async function produceElement(block: string): Promise<SVGElement | HTMLElement> {
    const m = await ensureInitialized()
    let svg: string
    try {
      svg = (await m.render(nextId(), block)).svg
    } catch (err) {
      throw new DiagramError(
        `mermaid failed to render diagram: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    let parsed: Element
    try {
      parsed = parse(svg)
    } catch (err) {
      if (err instanceof DiagramError) throw err
      throw new DiagramError(
        `failed to parse mermaid svg output: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    const style = (parsed as HTMLElement).style
    if (style) {
      style.width = '100%'
      style.height = 'auto'
    }
    return parsed as SVGElement | HTMLElement
  }

  // Every live handle, so setTheme can re-render blocks the caller already
  // placed. Handle identity is stable; `element` is swapped on rerender.
  const handles = new Set<DiagramRenderResult>()
  // Bumped by release(): a render that resolves after its load was released
  // must not (re)join the handle cache, or the leak release() exists to fix
  // comes straight back through the in-flight path.
  let handleGeneration = 0

  async function render(block: string): Promise<DiagramRenderResult> {
    // Fail fast (typed error) if the block cannot render; never lets a
    // mermaid throw escape as anything but DiagramError.
    const myGeneration = handleGeneration
    const element = await produceElement(block)
    const handle: DiagramRenderResult = {
      element,
      rerender: async (): Promise<void> => {
        const fresh = await produceElement(block)
        const old = handle.element
        // Clear + replace: if the caller appended the old element, swap in
        // the fresh one in place; otherwise just hand it back detached.
        const parent = (old as {
          parentNode?: { replaceChild?(newChild: Node, oldChild: Node): unknown } | null
        }).parentNode
        if (parent?.replaceChild) parent.replaceChild(fresh, old)
        handle.element = fresh
      },
    }
    if (myGeneration === handleGeneration) handles.add(handle)
    return handle
  }

  async function renderAll(
    blocks: string[],
  ): Promise<DiagramRenderAllEntry[]> {
    return Promise.all(
      blocks.map(async (block): Promise<DiagramRenderAllEntry> => {
        try {
          return { block, result: await render(block) }
        } catch {
          // Per-block isolation: a bad block must not sink its siblings.
          return { block, result: null }
        }
      }),
    )
  }

  async function setTheme(theme: DiagramTheme): Promise<void> {
    if (initialized && theme === currentTheme) return
    currentTheme = theme
    const m = await ensureMermaid()
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
    initialized = true
    await Promise.all([...handles].map((h) => h.rerender()))
  }

  function release(): void {
    handleGeneration++
    handles.clear()
  }

  function available(): boolean {
    const hasParser = !!deps.parseSvg || typeof DOMParser !== 'undefined'
    if (deps.mermaid) return hasParser
    return hasParser && importState !== 'failed'
  }

  return { render, renderAll, setTheme, release, available }
}
