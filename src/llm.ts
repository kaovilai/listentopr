// OpenAI-compatible chat client for ListenToPR.
import type { LlmConfig, LlmMessage } from './types'

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
}

/** Join a full base URL (e.g. https://api.example.com/v1) with an API path without double slashes. */
function endpointUrl(endpoint: string, path: string): string {
  return endpoint.replace(/\/+$/, '') + path
}

/** Replace every occurrence of a secret with '[redacted]'. */
function redact(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('[redacted]')
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ChatResponseBody {
  choices?: Array<{ message?: { content?: unknown } }>
}

export async function chat(
  config: LlmConfig,
  messages: LlmMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const requestMessages = messages.map((m) => {
    if (!m.images || m.images.length === 0) {
      return { role: m.role, content: m.text }
    }
    const content: ContentPart[] = [{ type: 'text', text: m.text }]
    for (const url of m.images) {
      content.push({ type: 'image_url', image_url: { url } })
    }
    return { role: m.role, content }
  })

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
    response = await fetch(endpointUrl(config.endpoint, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, messages: requestMessages }),
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
    let data: ChatResponseBody
    try {
      data = (await response.json()) as ChatResponseBody
    } catch {
      throw new LlmError('LLM response was not valid JSON', response.status)
    }

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
    if (typeof content !== 'string' || content.length === 0) {
      throw new LlmError('LLM returned no message content', response.status)
    }
    return content
  } catch (err) {
    if (err instanceof LlmError) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new LlmError(`LLM request failed: ${redact(detail, config.apiKey)}`)
  } finally {
    clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort)
  }
}
