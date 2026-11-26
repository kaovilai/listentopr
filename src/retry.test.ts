import { describe, expect, it, vi } from 'vitest'
import { actionableLlmError, retryableHttpError, withRetry } from './retry'

function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

function fakeSleep(record: number[] = []): (ms: number) => Promise<void> {
  return (ms: number) => {
    record.push(ms)
    return Promise.resolve()
  }
}

describe('withRetry', () => {
  it('returns the first result without sleeping when fn succeeds immediately', async () => {
    const delays: number[] = []
    const fn = vi.fn(() => Promise.resolve('ok'))
    const result = await withRetry(fn, { sleepFn: fakeSleep(delays) })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('retries a failing call and succeeds once fn stops throwing', async () => {
    const delays: number[] = []
    let calls = 0
    const fn = vi.fn(() => {
      calls++
      if (calls < 3) return Promise.reject(httpError(503))
      return Promise.resolve('recovered')
    })
    const onRetry = vi.fn()
    const result = await withRetry(fn, { sleepFn: fakeSleep(delays), onRetry })
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(delays).toHaveLength(2)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, delays[0], httpError(503))
  })

  it('rejects with the last error and sleeps once per retry when retries are exhausted', async () => {
    const delays: number[] = []
    const fn = vi.fn(() => Promise.reject(httpError(500)))
    await expect(
      withRetry(fn, { retries: 3, sleepFn: fakeSleep(delays) }),
    ).rejects.toMatchObject({ status: 500 })
    // 1 initial attempt + 3 retries
    expect(fn).toHaveBeenCalledTimes(4)
    expect(delays).toHaveLength(3)
  })

  it('retries zero times when retries: 0', async () => {
    const delays: number[] = []
    const fn = vi.fn(() => Promise.reject(httpError(429)))
    await expect(
      withRetry(fn, { retries: 0, sleepFn: fakeSleep(delays) }),
    ).rejects.toMatchObject({ status: 429 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('keeps every backoff within the full-jitter bounds for its attempt', async () => {
    const delays: number[] = []
    const fn = vi.fn(() => Promise.reject(httpError(502)))
    await expect(
      withRetry(fn, {
        retries: 4,
        baseDelayMs: 1000,
        maxDelayMs: 3000,
        sleepFn: fakeSleep(delays),
      }),
    ).rejects.toMatchObject({ status: 502 })
    expect(delays).toHaveLength(4)
    const caps = [1000, 2000, 3000, 3000]
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(caps[i]!)
    })
  })

  it('respects retryOn: false stops immediately without sleeping', async () => {
    const delays: number[] = []
    const fn = vi.fn(() => Promise.reject(httpError(400)))
    const retryOn = vi.fn(() => false)
    await expect(
      withRetry(fn, { retries: 5, retryOn, sleepFn: fakeSleep(delays) }),
    ).rejects.toMatchObject({ status: 400 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(retryOn).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('respects retryOn: only matching errors are retried', async () => {
    const delays: number[] = []
    let calls = 0
    const fn = vi.fn(() => {
      calls++
      if (calls === 1) return Promise.reject(new Error('no status'))
      return Promise.resolve('done')
    })
    const result = await withRetry(fn, {
      retries: 3,
      retryOn: (err) => err instanceof Error && err.message === 'no status',
      sleepFn: fakeSleep(delays),
    })
    expect(result).toBe('done')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(delays).toHaveLength(1)
  })

  it('calls onRetry with the 1-based attempt, the drawn delay, and the error', async () => {
    const onRetry = vi.fn()
    const err = httpError(503)
    let calls = 0
    const fn = vi.fn(() => {
      calls++
      if (calls < 3) return Promise.reject(err)
      return Promise.resolve('ok')
    })
    await withRetry(fn, { onRetry, sleepFn: fakeSleep() })
    expect(onRetry).toHaveBeenCalledTimes(2)
    const [attempt1, delay1, err1] = onRetry.mock.calls[0]!
    const [attempt2, delay2, err2] = onRetry.mock.calls[1]!
    expect(attempt1).toBe(1)
    expect(attempt2).toBe(2)
    expect(typeof delay1).toBe('number')
    expect(typeof delay2).toBe('number')
    expect(err1).toBe(err)
    expect(err2).toBe(err)
  })
})

describe('retryableHttpError', () => {
  it('is true for 408, 425, 429, 500, 502, 503, 504', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(retryableHttpError(httpError(status))).toBe(true)
    }
  })

  it('is false for other HTTP statuses', () => {
    for (const status of [400, 401, 403, 404, 409, 418, 422, 451, 501, 505]) {
      expect(retryableHttpError(httpError(status))).toBe(false)
    }
  })

  it('is true for network TypeErrors with no status', () => {
    expect(retryableHttpError(new TypeError('fetch failed'))).toBe(true)
  })

  it('is false for plain errors and status-less objects', () => {
    expect(retryableHttpError(new Error('boom'))).toBe(false)
    expect(retryableHttpError('string error')).toBe(false)
    expect(retryableHttpError(null)).toBe(false)
  })

  it('reads the status off any object exposing {status}', () => {
    expect(retryableHttpError({ status: 429 })).toBe(true)
    expect(retryableHttpError({ status: 403 })).toBe(false)
  })
})

describe('actionableLlmError', () => {
  it('maps 401 and 403 to the API-key message', () => {
    expect(actionableLlmError(httpError(401))).toBe(
      'LLM provider rejected the API key — re-check it in Settings',
    )
    expect(actionableLlmError(httpError(403))).toBe(
      'LLM provider rejected the API key — re-check it in Settings',
    )
  })

  it('maps 404 to the model-name message', () => {
    expect(actionableLlmError(httpError(404))).toBe(
      'Model not found — check the model name in Settings',
    )
  })

  it('maps 429 to the rate-limit message', () => {
    expect(actionableLlmError(httpError(429))).toBe('Rate limited — retrying')
  })

  it('maps 5xx statuses to the provider-error message', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(actionableLlmError(httpError(status))).toBe('Provider error — retrying')
    }
  })

  it('maps TypeError to the network message', () => {
    expect(actionableLlmError(new TypeError('fetch failed'))).toBe(
      'Network error — check connection (custom endpoints need CSP/proxy allowlisting)',
    )
  })

  it('falls back to a generic message for anything else', () => {
    expect(actionableLlmError(new Error('weird failure'))).toBe('Generation failed')
    expect(actionableLlmError({ status: 400 })).toBe('Generation failed')
    expect(actionableLlmError(undefined)).toBe('Generation failed')
  })

  it('never leaks the API key from the failing error', () => {
    const err = httpError(401, 'Unauthorized: key sk-test-secret rejected')
    const message = actionableLlmError(err)
    expect(message).not.toContain('sk-test-secret')
    expect(message).not.toContain('Unauthorized')
  })
})
