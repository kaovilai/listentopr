import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GhAuthError,
  POLL_ABORTED,
  pollForToken,
  refreshOAuthToken,
  startDeviceFlow,
} from './ghauth'
import type { DeviceFlowStart, PollProgress } from './ghauth'

// ---------- fetch mock helpers ----------

interface MockRes {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

function jsonRes(body: unknown, opts: { status?: number } = {}): MockRes {
  const status = opts.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }
}

function okFetch(body: unknown): typeof fetch {
  return vi.fn(async () => jsonRes(body)) as unknown as typeof fetch
}

/** Queue one response per poll; default filler = authorization_pending. */
function queueFetch(bodies: unknown[], filler?: unknown): typeof fetch {
  const fn = vi.fn(async () => {
    const next = bodies.shift()
    return jsonRes(next === undefined ? (filler ?? { error: 'authorization_pending' }) : next)
  })
  return fn as unknown as typeof fetch
}

const START: DeviceFlowStart = {
  deviceCode: 'dc123',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
}

const TOKEN = 'gho_testtoken'

const sleepFn = vi.fn(async () => {})

beforeEach(() => {
  sleepFn.mockClear()
})

describe('startDeviceFlow', () => {
  it('posts scope default repo and maps the response', async () => {
    const fetchFn = okFetch({
      device_code: 'dc_1',
      user_code: 'WXYZ-99',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 7,
    })
    const start = await startDeviceFlow('cid', { fetchFn })

    expect(start).toEqual({
      deviceCode: 'dc_1',
      userCode: 'WXYZ-99',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 7,
    })
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call?.[0]).toBe('https://github.com/login/device/code')
    const init = call?.[1] as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Accept']).toBe('application/json')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ client_id: 'cid', scope: 'repo' })
  })

  it('defaults interval to 5 when the API omits it', async () => {
    const fetchFn = okFetch({
      device_code: 'dc',
      user_code: 'UC',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
    })
    const start = await startDeviceFlow('cid', { fetchFn })
    expect(start.interval).toBe(5)
  })

  it('allows scope override including empty string (public only)', async () => {
    const fetchFn = okFetch({
      device_code: 'dc',
      user_code: 'UC',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    })
    await startDeviceFlow('cid', { fetchFn, scope: '' })
    const init = ((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]) as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ client_id: 'cid', scope: '' })
  })

  it('throws typed http_error on non-2xx', async () => {
    const failing = vi.fn(async () => jsonRes({}, { status: 400 })) as unknown as typeof fetch
    await expect(startDeviceFlow('cid', { fetchFn: failing })).rejects.toMatchObject({
      name: 'GhAuthError',
      code: 'http_error',
    })
  })

  it('throws typed bad_response when device_code is missing', async () => {
    const fetchFn = okFetch({ user_code: 'UC' })
    await expect(startDeviceFlow('cid', { fetchFn })).rejects.toMatchObject({
      name: 'GhAuthError',
      code: 'bad_response',
    })
  })
})

describe('pollForToken', () => {
  it('happy path: pending -> pending -> success, sleeps interval each round', async () => {
    const fetchFn = queueFetch([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: TOKEN, token_type: 'bearer', scope: 'repo' },
    ])
    const onPoll = vi.fn()
    const token = await pollForToken('cid', START, { fetchFn, sleepFn, onPoll })

    expect(token).toBe(TOKEN)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(sleepFn).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenNthCalledWith(1, 5000)
    expect(sleepFn).toHaveBeenNthCalledWith(2, 5000)
    const polls = onPoll.mock.calls.map((c) => c[0] as PollProgress)
    expect(polls).toEqual([
      { attempt: 1, intervalSeconds: 5, lastError: 'authorization_pending' },
      { attempt: 2, intervalSeconds: 5, lastError: 'authorization_pending' },
    ])
  })

  it('sends the device-grant body shape to the token endpoint', async () => {
    const fetchFn = queueFetch([{ access_token: TOKEN }])
    await pollForToken('cid', START, { fetchFn, sleepFn })
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call?.[0]).toBe('https://github.com/login/oauth/access_token')
    const init = call?.[1] as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Accept']).toBe('application/json')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: 'cid',
      device_code: 'dc123',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
  })

  it('slow_down grows the interval by 5 seconds', async () => {
    const fetchFn = queueFetch([
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: TOKEN },
    ])
    const onPoll = vi.fn()
    const token = await pollForToken('cid', START, { fetchFn, sleepFn, onPoll })

    expect(token).toBe(TOKEN)
    expect(sleepFn).toHaveBeenNthCalledWith(1, 5000)
    expect(sleepFn).toHaveBeenNthCalledWith(2, 10000)
    const polls = onPoll.mock.calls.map((c) => c[0] as PollProgress)
    expect(polls[1]).toEqual({ attempt: 2, intervalSeconds: 10, lastError: 'slow_down' })
  })

  it('throws expired once expires_in elapses on the injected clock', async () => {
    let clock = 0
    const nowFn = () => clock
    // Each sleep advances the clock past the 900 s deadline.
    const sleepTick = vi.fn(async () => {
      clock += 901_000
    })
    const fetchFn = queueFetch([{ error: 'authorization_pending' }, { access_token: TOKEN }])
    await expect(
      pollForToken('cid', START, { fetchFn, sleepFn: sleepTick, nowFn }),
    ).rejects.toMatchObject({ name: 'GhAuthError', code: 'expired' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('maps server expired_token to expired', async () => {
    const fetchFn = queueFetch([{ error: 'expired_token' }])
    await expect(
      pollForToken('cid', START, { fetchFn, sleepFn }),
    ).rejects.toMatchObject({ name: 'GhAuthError', code: 'expired' })
  })

  it('throws typed unsupported_grant_type without leaking the device code', async () => {
    const fetchFn = queueFetch([{ error: 'unsupported_grant_type' }])
    const err = await pollForToken('cid', START, { fetchFn, sleepFn }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GhAuthError)
    expect((err as GhAuthError).code).toBe('unsupported_grant_type')
    expect((err as Error).message).not.toContain('dc123')
  })

  it('throws typed access_denied', async () => {
    const fetchFn = queueFetch([{ error: 'access_denied' }])
    await expect(
      pollForToken('cid', START, { fetchFn, sleepFn }),
    ).rejects.toMatchObject({ name: 'GhAuthError', code: 'access_denied' })
  })

  it('rejects with POLL_ABORTED before any request when the signal is already aborted', async () => {
    const fetchFn = queueFetch([{ access_token: TOKEN }])
    const controller = new AbortController()
    controller.abort()
    await expect(
      pollForToken('cid', START, { fetchFn, sleepFn, signal: controller.signal }),
    ).rejects.toBe(POLL_ABORTED)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('aborts at the next iteration boundary without another token request', async () => {
    const fetchFn = queueFetch([{ error: 'authorization_pending' }])
    const controller = new AbortController()
    const onPoll = vi.fn(() => controller.abort())
    await expect(
      pollForToken('cid', START, { fetchFn, sleepFn, onPoll, signal: controller.signal }),
    ).rejects.toBe(POLL_ABORTED)
    // One poll happened, then the abort stopped the loop before a second POST.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(onPoll).toHaveBeenCalledTimes(1)
  })

  it('still returns a token when the signal aborts after the final response', async () => {
    const fetchFn = queueFetch([{ access_token: TOKEN }])
    const controller = new AbortController()
    const token = await pollForToken('cid', START, {
      fetchFn,
      sleepFn,
      signal: controller.signal,
    })
    expect(token).toBe(TOKEN)
    controller.abort()
  })
})

describe('refreshOAuthToken', () => {
  it('exchanges the refresh token and returns the new pair', async () => {
    const fetchFn = okFetch({
      access_token: 'gho_new',
      refresh_token: 'ghor_new',
      expires_in: 28800,
      token_type: 'bearer',
    })
    const out = await refreshOAuthToken('cid', 'ghor_old', { fetchFn })

    expect(out).toEqual({ accessToken: 'gho_new', refreshToken: 'ghor_new', expiresIn: 28800 })
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call?.[0]).toBe('https://github.com/login/oauth/access_token')
    const init = call?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Accept']).toBe('application/json')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: 'cid',
      grant_type: 'refresh_token',
      refresh_token: 'ghor_old',
    })
  })

  it('omits refreshToken/expiresIn when the response lacks them', async () => {
    const fetchFn = okFetch({ access_token: 'gho_new', token_type: 'bearer' })
    const out = await refreshOAuthToken('cid', 'ghor_old', { fetchFn })
    expect(out).toEqual({ accessToken: 'gho_new' })
  })

  it('returns null when the refresh is rejected', async () => {
    const fetchFn = okFetch({ error: 'expired_token' })
    const out = await refreshOAuthToken('cid', 'ghor_old', { fetchFn })
    expect(out).toBeNull()
  })

  it('returns null when no access_token comes back', async () => {
    const fetchFn = okFetch({ refresh_token: 'ghor_x' })
    const out = await refreshOAuthToken('cid', 'ghor_old', { fetchFn })
    expect(out).toBeNull()
  })

  it('throws typed network error when fetch rejects', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(refreshOAuthToken('cid', 'ghor_old', { fetchFn })).rejects.toMatchObject({
      name: 'GhAuthError',
      code: 'network',
    })
  })
})
