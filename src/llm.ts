// Multi-provider chat client for ListenToPR (openai / anthropic / gemini / github).
import type { LlmConfig, LlmMessage, LlmProvider } from './types'

/** Typed error thrown by chat(): carries HTTP status and a sanitized body. */
export class LlmError extends Error {
  readonly status: number | undefined
  readonly body: string | undefined

  constructor(message: string, status?: number, body?: string) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.body = body
  }
}

export interface ChatOptions {
  /** Abort timeout in ms. Default 120000. */
  timeoutMs?: number
  /** Optional external abort signal, combined with the timeout. */
  signal?: AbortSignal
  /**
   * Fetch implementation used for the request. Defaults to the global fetch.
   * The app passes the service-worker LLM proxy fetch here so custom
   * endpoints bypass the page CSP (see src/llmproxy.ts).
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

/** Public default base URLs per provider; used when config.endpoint is empty. */
export const PROVIDER_DEFAULT_ENDPOINTS: Record<LlmProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  github: 'https://models.github.ai',
}

function providerOf(config: LlmConfig): LlmProvider {
  return config.provider ?? 'openai'
}

/** Resolved base URL: config.endpoint when non-empty, else the provider default; trailing '/' stripped. */
function baseOf(config: LlmConfig, provider: LlmProvider): string {
  const endpoint =
    config.endpoint && config.endpoint.trim() !== ''
      ? config.endpoint
      : PROVIDER_DEFAULT_ENDPOINTS[provider]
  return endpoint.replace(/\/+$/, '')
}

/** True when any message carries at least one image. */
function callHasImages(messages: LlmMessage[]): boolean {
  return messages.some((m) => (m.images?.length ?? 0) > 0)
}

/**
 * Model for one call: the dedicated vision model when the call carries
 * images and one is configured, else the primary model.
 */
function resolveModel(config: LlmConfig, hasImages: boolean): string {
  return hasImages && config.visionModel ? config.visionModel : config.model
}

/** Replace every occurrence of a secret with '[redacted]'. */
function redact(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('[redacted]')
}

// ---------------------------------------------------------------------------
// Image normalization (shared by all adapters)
// ---------------------------------------------------------------------------

export interface NormalizedImage {
  /** Media type parsed from a data URL. */
  mimeType?: string
  /** Base64 payload parsed from a data URL. */
  data?: string
  /** Original URL when the input was not a data URL. */
  url?: string
}

/**
 * Parse a data URL into {mimeType, base64 data}; anything else is passed
 * through as {url} for providers that accept remote image URLs.
 */
function normalizeImage(url: string): NormalizedImage {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(url)
  if (!m) return { url }
  const mimeType = m[1] || 'application/octet-stream'
  const isBase64 = /;base64/i.test(m[2] ?? '')
  if (!isBase64) return { url }
  return { mimeType, data: m[3] }
}

// ---------------------------------------------------------------------------
// Request shapes per provider
// ---------------------------------------------------------------------------

interface PreparedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

// ---- OpenAI ----

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAiResponseBody {
  choices?: Array<{ message?: { content?: unknown } }>
}

/**
 * GitHub Models path: exactly one '/inference/chat/completions', even when
 * the endpoint already ends with /inference (models.github.ai serves its
 * OpenAI-dialect API under /inference).
 */
function githubUrl(base: string): string {
  return `${base.endsWith('/inference') ? base : `${base}/inference`}/chat/completions`
}

function openaiRequest(
  config: LlmConfig,
  messages: LlmMessage[],
  provider: LlmProvider,
): PreparedRequest {
  const model = resolveModel(config, callHasImages(messages))
  const requestMessages = messages.map((m) => {
    if (!m.images || m.images.length === 0) {
      return { role: m.role, content: m.text }
    }
    const content: OpenAiContentPart[] = [{ type: 'text', text: m.text }]
    for (const url of m.images) {
      content.push({ type: 'image_url', image_url: { url } })
    }
    return { role: m.role, content }
  })
  const base = baseOf(config, provider)
  return {
    url: provider === 'github' ? githubUrl(base) : `${base}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model, messages: requestMessages }),
  }
}

function openaiText(data: OpenAiResponseBody): string {
  let content: unknown = data.choices?.[0]?.message?.content
  if (Array.isArray(content)) {
    content = content
      .filter(
        (p): p is { type: string; text?: string } =>
          typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text',
      )
      .map((p) => p.text ?? '')
      .join('')
  }
  return typeof content === 'string' ? content : ''
}

// ---- Anthropic ----

type AnthropicContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }

interface AnthropicResponseBody {
  content?: Array<{ type?: string; text?: unknown }>
}

/** Anthropic path: exactly one '/v1/messages', even when the endpoint already ends with /v1. */
function anthropicUrl(base: string): string {
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

function anthropicRequest(config: LlmConfig, messages: LlmMessage[]): PreparedRequest {
  const model = resolveModel(config, callHasImages(messages))
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.text)
    .join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const content: AnthropicContentPart[] = [{ type: 'text', text: m.text }]
      for (const image of m.images ?? []) {
        const n = normalizeImage(image)
        if (n.data !== undefined) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: n.mimeType ?? 'application/octet-stream',
              data: n.data,
            },
          })
        } else {
          content.push({ type: 'image', source: { type: 'url', url: n.url ?? image } })
        }
      }
      return { role: m.role, content }
    })
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: contents,
  }
  if (system) body.system = system
  return {
    url: anthropicUrl(baseOf(config, 'anthropic')),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }
}

function anthropicText(data: AnthropicResponseBody): string {
  return (data.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

// ---- Gemini ----

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: { file_uri: string } }

interface GeminiResponseBody {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>
}

function geminiRequest(config: LlmConfig, messages: LlmMessage[]): PreparedRequest {
  const model = resolveModel(config, callHasImages(messages))
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.text)
    .join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const parts: GeminiPart[] = [{ text: m.text }]
      for (const image of m.images ?? []) {
        const n = normalizeImage(image)
        if (n.data !== undefined) {
          parts.push({
            inline_data: { mime_type: n.mimeType ?? 'application/octet-stream', data: n.data },
          })
        } else {
          parts.push({ file_data: { file_uri: n.url ?? image } })
        }
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts }
    })
  // Never double-append /v1beta when the endpoint already carries it.
  const base = baseOf(config, 'gemini')
  const versioned = base.endsWith('/v1beta') ? base : `${base}/v1beta`
  const body: Record<string, unknown> = { contents }
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] }
  return {
    url: `${versioned}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function geminiText(data: GeminiResponseBody): string {
  return (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}

// ---------------------------------------------------------------------------
// Shared transport: timeout + external abort + error redaction
// ---------------------------------------------------------------------------

async function postJson(
  config: LlmConfig,
  request: PreparedRequest,
  opts: ChatOptions,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 120_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = (): void => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', onExternalAbort)
  }

  let response: Response
  try {
    response = await (opts.fetch ?? fetch)(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      throw new LlmError(
        `LLM request failed with status ${response.status}`,
        response.status,
        redact(raw, config.apiKey),
      )
    }

    // The timeout must cover the body read too: an endpoint that sends
    // headers then stalls would otherwise hang json() forever. AbortSignal
    // aborts in-flight body reads, so keep the timer armed until here.
    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new LlmError('LLM response was not valid JSON', response.status)
    }
    return { status: response.status, data }
  } catch (err) {
    if (err instanceof LlmError) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new LlmError(`LLM request failed: ${redact(detail, config.apiKey)}`)
  } finally {
    clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort)
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Send a chat completion request using config.provider's dialect
 * (default 'openai'). Applies config.visionModel automatically when the
 * call carries images.
 */
export async function chat(
  config: LlmConfig,
  messages: LlmMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const provider = providerOf(config)
  const request =
    provider === 'anthropic'
      ? anthropicRequest(config, messages)
      : provider === 'gemini'
        ? geminiRequest(config, messages)
        : openaiRequest(config, messages, provider)
  const { status, data } = await postJson(config, request, opts)
  const text =
    provider === 'anthropic'
      ? anthropicText(data as AnthropicResponseBody)
      : provider === 'gemini'
        ? geminiText(data as GeminiResponseBody)
        : openaiText(data as OpenAiResponseBody)
  if (text.length === 0) {
    throw new LlmError('LLM returned no message content', status)
  }
  return text
}
