// Retry engine (DVC section: LLM resilience): bounded exponential backoff
// with full jitter, plus human-readable classification of LLM call errors.

export interface RetryOptions {
  /** Max retries after the first attempt. Default 2. */
  retries?: number
  /** First backoff cap before jitter. Default 1000 ms. */
  baseDelayMs?: number
  /** Upper bound on any single backoff. Default 15000 ms. */
  maxDelayMs?: number
  /** Retry only when this returns true for the thrown error. Default: always. */
  retryOn?: (err: unknown) => boolean
  /** Notified before each sleep with the 1-based failed attempt number. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void
  /** Injectable sleep (tests). Default: setTimeout-based. */
  sleepFn?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** HTTP statuses worth retrying: request timeouts, too-early, rate limit, transient server errors. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * True when the error is a network-level TypeError or carries a retryable
 * HTTP status. The status is read from (err as {status?: number}).status,
 * the shape thrown by the LLM client; anything else is not retryable.
 */
export function retryableHttpError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const status = (err as { status?: number } | null | undefined)?.status
  return typeof status === 'number' && RETRYABLE_STATUSES.has(status)
}

/**
 * Map an LLM call error to an actionable, user-facing message. Never
 * includes the API key: only fixed strings and the error's status shape
 * are consulted, never its message text.
 */
export function actionableLlmError(err: unknown): string {
  if (err instanceof TypeError) {
    return 'Network error — check connection (custom endpoints need CSP/proxy allowlisting)'
  }
  const status = (err as { status?: number } | null | undefined)?.status
  if (status === 401 || status === 403) {
    return 'LLM provider rejected the API key — re-check it in Settings'
  }
  if (status === 404) return 'Model not found — check the model name in Settings'
  if (status === 429) return 'Rate limited — retrying'
  if (typeof status === 'number' && status >= 500 && status <= 599) {
    return 'Provider error — retrying'
  }
  return 'Generation failed'
}

/**
 * Run fn with bounded retries and exponential backoff (full jitter):
 * after failed attempt n (1-based), sleep a uniformly random duration in
 * [0, min(maxDelayMs, baseDelayMs * 2^(n-1)]) and try again, up to
 * opts.retries times. The last error is rethrown when retries are
 * exhausted or retryOn says stop.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 2
  const baseDelayMs = opts.baseDelayMs ?? 1000
  const maxDelayMs = opts.maxDelayMs ?? 15000
  const sleep = opts.sleepFn ?? defaultSleep

  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      if (attempt > retries) throw err
      if (opts.retryOn !== undefined && !opts.retryOn(err)) throw err
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const delayMs = Math.floor(Math.random() * cap)
      opts.onRetry?.(attempt, delayMs, err)
      await sleep(delayMs)
    }
  }
}
