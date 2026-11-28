// GitHub OAuth device-flow client (DVC section: sign-in).
// Produces a gho_ user token that works for both api.github.com (PR
// ingestion) and api.githubcopilot.com (LLM provider). All network/sleep/
// clock access is injectable for tests: pass {fetchFn, sleepFn, nowFn} in
// any function's options.

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Seconds until the user_code expires. */
  expiresIn: number
  /** Seconds between token polls. Default 5 when the API omits it. */
  interval: number
}

/** Error codes are fixed strings; messages never contain any token. */
export type GhAuthErrorCode =
  | 'expired'
  | 'unsupported_grant_type'
  | 'access_denied'
  | 'network'
  | 'http_error'
  | 'bad_response'

export class GhAuthError extends Error {
  readonly code: GhAuthErrorCode
  constructor(code: GhAuthErrorCode, message: string) {
    super(message)
    this.name = 'GhAuthError'
    this.code = code
  }
}

/** Rejection sentinel: pollForToken's AbortSignal fired. Identity-compared. */
export const POLL_ABORTED = new Error('sign-in poll aborted')

export interface GhAuthDeps {
  /** Injectable fetch (tests). Default: global fetch. */
  fetchFn?: typeof fetch
  /** Injectable sleep (tests). Default: setTimeout-based. */
  sleepFn?: (ms: number) => Promise<void>
  /** Injectable clock (tests). Default: Date.now. */
  nowFn?: () => number
}

export interface StartDeviceFlowOptions extends GhAuthDeps {
  /**
   * OAuth scope. Default 'repo' (private PR read). Pass '' for
   * public-repo-only access.
   */
  scope?: string
}

export interface PollProgress {
  /** 1-based poll attempt number. */
  attempt: number
  /** Interval (seconds) that will be slept before the next poll. */
  intervalSeconds: number
  /** Last non-terminal response code ('authorization_pending' | 'slow_down'). */
  lastError?: string
}

export interface PollForTokenOptions extends GhAuthDeps {
  /** Notified after every non-terminal poll response (UI progress). */
  onPoll?: (progress: PollProgress) => void
  /**
   * Aborts the poll loop at the next iteration boundary: once aborted, no
   * further token request fires. Rejects with the POLL_ABORTED sentinel.
   */
  signal?: AbortSignal
}

export interface RefreshedToken {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const SLOW_DOWN_BUMP_SECONDS = 5
const DEFAULT_INTERVAL_SECONDS = 5

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

interface JsonInit {
  url: string
  body: Record<string, string>
  fetchFn: typeof fetch
}

/** POST JSON, expect JSON back. Sanitized typed errors; never any token. */
async function postJson({ url, body, fetchFn }: JsonInit): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new GhAuthError('network', 'Network error contacting GitHub sign-in')
  }
  if (!res.ok) {
    throw new GhAuthError(
      'http_error',
      `GitHub sign-in endpoint returned HTTP ${res.status}`,
    )
  }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new GhAuthError('bad_response', 'GitHub sign-in endpoint returned non-JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GhAuthError('bad_response', 'GitHub sign-in endpoint returned unexpected data')
  }
  return parsed as Record<string, unknown>
}

/**
 * Start the device flow. Returns the code the user must enter at
 * verificationUri. Default scope 'repo'; '' = public repos only.
 */
export async function startDeviceFlow(
  clientId: string,
  opts: StartDeviceFlowOptions = {},
): Promise<DeviceFlowStart> {
  const fetchFn = opts.fetchFn ?? fetch
  const scope = opts.scope !== undefined ? opts.scope : 'repo'
  const data = await postJson({
    url: DEVICE_CODE_URL,
    body: { client_id: clientId, scope },
    fetchFn,
  })
  const deviceCode = data['device_code']
  const userCode = data['user_code']
  const verificationUri = data['verification_uri']
  const expiresIn = data['expires_in']
  const interval = data['interval']
  if (
    typeof deviceCode !== 'string' || deviceCode === '' ||
    typeof userCode !== 'string' || userCode === '' ||
    typeof verificationUri !== 'string' || verificationUri === '' ||
    typeof expiresIn !== 'number'
  ) {
    throw new GhAuthError('bad_response', 'GitHub sign-in endpoint returned unexpected data')
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn,
    interval: typeof interval === 'number' ? interval : DEFAULT_INTERVAL_SECONDS,
  }
}

/**
 * Poll the token endpoint every start.interval seconds until the user
 * approves (returns the access_token), the code expires (GhAuthError
 * 'expired'), or GitHub rejects the grant (typed GhAuthError, e.g.
 * 'unsupported_grant_type'). slow_down responses grow the interval by
 * 5 seconds. onPoll fires after each non-terminal response. Passing an
 * already- or later-aborted signal stops the loop before its next token
 * request (POLL_ABORTED).
 */
export async function pollForToken(
  clientId: string,
  start: DeviceFlowStart,
  opts: PollForTokenOptions = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch
  const sleep = opts.sleepFn ?? defaultSleep
  const now = opts.nowFn ?? Date.now

  const deadline = now() + start.expiresIn * 1000
  let intervalSeconds = start.interval > 0 ? start.interval : DEFAULT_INTERVAL_SECONDS
  let attempt = 0
  let lastError: string | undefined

  for (;;) {
    if (opts.signal?.aborted) throw POLL_ABORTED
    if (now() >= deadline) {
      throw new GhAuthError('expired', 'Sign-in code expired — start sign-in again')
    }
    attempt++
    const data = await postJson({
      url: ACCESS_TOKEN_URL,
      body: {
        client_id: clientId,
        device_code: start.deviceCode,
        grant_type: DEVICE_GRANT,
      },
      fetchFn,
    })

    const accessToken = data['access_token']
    if (typeof accessToken === 'string' && accessToken !== '') {
      return accessToken
    }

    const error = data['error']
    if (error === 'authorization_pending') {
      lastError = 'authorization_pending'
    } else if (error === 'slow_down') {
      lastError = 'slow_down'
      intervalSeconds += SLOW_DOWN_BUMP_SECONDS
    } else if (error === 'expired_token') {
      throw new GhAuthError('expired', 'Sign-in code expired — start sign-in again')
    } else if (error === 'unsupported_grant_type') {
      throw new GhAuthError('unsupported_grant_type', 'GitHub rejected the device grant type')
    } else if (error === 'access_denied') {
      throw new GhAuthError('access_denied', 'Sign-in was denied')
    } else if (typeof error === 'string') {
      throw new GhAuthError('bad_response', `GitHub sign-in failed: ${error}`)
    } else {
      throw new GhAuthError('bad_response', 'GitHub sign-in endpoint returned unexpected data')
    }

    opts.onPoll?.({ attempt, intervalSeconds, lastError })
    await sleep(intervalSeconds * 1000)
  }
}

/**
 * Exchange a refresh token for a new access token. Returns null when
 * GitHub rejects the refresh (expired/revoked) so the caller can fall
 * back to a fresh sign-in; throws GhAuthError on network/HTTP failures.
 */
export async function refreshOAuthToken(
  clientId: string,
  refreshToken: string,
  deps: GhAuthDeps = {},
): Promise<RefreshedToken | null> {
  const data = await postJson({
    url: ACCESS_TOKEN_URL,
    body: {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    fetchFn: deps.fetchFn ?? fetch,
  })

  const accessToken = data['access_token']
  if (typeof accessToken !== 'string' || accessToken === '') return null

  const refreshed = data['refresh_token']
  const expiresIn = data['expires_in']
  return {
    accessToken,
    ...(typeof refreshed === 'string' && refreshed !== '' ? { refreshToken: refreshed } : {}),
    ...(typeof expiresIn === 'number' ? { expiresIn } : {}),
  }
}
