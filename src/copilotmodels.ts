// GitHub Copilot model-list client (api.githubcopilot.com/models). Lists the
// models the stored GitHub token (gho_/ghu_/github_pat_) can use, keeping
// only chat-completions-capable entries, and caches the list in an injected
// storage for a day. All network access goes through fetch (overridable via
// deps for tests); callers mock fetch.

/** A model from the Copilot model list, mapped to app-facing fields. */
export interface CopilotModel {
  id: string
  name: string
  /** True/false when the entry exposes an input-modality field; null when unknown. */
  vision: boolean | null
}

/** Model-list request failure: HTTP status (0 for network errors) + sanitized body. */
export class CopilotModelsError extends Error {
  readonly status: number
  /** Error body with the token redacted; '' when none was read. */
  readonly body: string

  constructor(message: string, status = 0, body = '') {
    super(message)
    this.name = 'CopilotModelsError'
    this.status = status
    this.body = body
  }
}

const MODELS_URL = 'https://api.githubcopilot.com/models'

/** Cache lifetime for the model list; same TTL shape as the catalog cache. */
export const COPILOT_MODELS_TTL_MS = 24 * 60 * 60 * 1000

const CACHE_KEY = 'listentopr.copilot-models'

/** Raw /models item shape (subset of the fields the endpoint returns). */
interface RawCopilotModel {
  id?: unknown
  name?: unknown
  /**
   * Chat-completions capability. Entries are chat-capable when the array
   * includes 'chat/completions'; entries lacking the field are assumed
   * capable.
   */
  supported_endpoints?: unknown
  /** Optional input-modality field; vision is passed through when present. */
  supported_input_modalities?: unknown
}

/** Never let the token surface in a thrown error or its body. */
function sanitize(text: string, token: string): string {
  return token !== '' && text.includes(token) ? text.split(token).join('[REDACTED]') : text
}

function isChatCompletionsCapable(raw: RawCopilotModel): boolean {
  if (raw.supported_endpoints === undefined || raw.supported_endpoints === null) return true
  return Array.isArray(raw.supported_endpoints) && raw.supported_endpoints.includes('chat/completions')
}

function mapModel(raw: RawCopilotModel): CopilotModel | null {
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  if (!isChatCompletionsCapable(raw)) return null
  let vision: boolean | null = null
  if (Array.isArray(raw.supported_input_modalities)) {
    vision = raw.supported_input_modalities.includes('image')
  }
  return { id: raw.id, name: raw.name, vision }
}

/**
 * Fetch the Copilot model list with the stored token. Throws
 * CopilotModelsError on an empty token, non-2xx responses (body sanitized,
 * token redacted), network failures, and a non-array response body.
 */
export async function fetchCopilotModels(
  token: string,
  deps?: { fetchFn?: typeof fetch }
): Promise<CopilotModel[]> {
  if (token === '') throw new CopilotModelsError('no token')
  const fetchFn = deps?.fetchFn ?? fetch
  let res: Response
  try {
    res = await fetchFn(MODELS_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Copilot-Integration-Id': 'vscode-chat',
      },
    })
  } catch (err) {
    // Network failure (e.g. TypeError from fetch): pass the message through
    // as a CopilotModelsError, token redacted.
    const raw = err instanceof Error ? err.message : String(err)
    throw new CopilotModelsError(sanitize(raw, token))
  }
  if (!res.ok) {
    let body = ''
    try {
      body = sanitize(await res.text(), token)
    } catch {
      // unreadable body; status alone is enough
    }
    throw new CopilotModelsError(
      `Copilot model list request failed (${res.status})${body === '' ? '' : `: ${body}`}`,
      res.status,
      body
    )
  }
  let data: unknown
  try {
    data = await res.json()
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    throw new CopilotModelsError(sanitize(`model list response is not JSON: ${raw}`, token))
  }
  if (!Array.isArray(data)) {
    throw new CopilotModelsError('model list response is not an array')
  }
  const models: CopilotModel[] = []
  for (const raw of data as RawCopilotModel[]) {
    const mapped = mapModel(raw)
    if (mapped !== null) models.push(mapped)
  }
  return models
}

/** True while a cache entry fetched at fetchedAt is still usable at now. */
export function isCopilotCacheFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < COPILOT_MODELS_TTL_MS
}

/** Minimal injectable storage (tests use a Map fake). */
export interface CopilotModelsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface CachedModels {
  models: CopilotModel[]
  fetchedAt: number
}

/**
 * JSON cache for the model list under 'listentopr.copilot-models'. read()
 * returns null on absent, corrupt, or expired entries; write() stamps
 * fetchedAt. Same shape as the catalog cache, kept local because the
 * catalog cache validates CatalogModel-specific fields.
 */
export function createCopilotModelsCache(storage: CopilotModelsStorage): {
  read(): { models: CopilotModel[]; fetchedAt: number } | null
  write(models: CopilotModel[]): void
} {
  return {
    read(): { models: CopilotModel[]; fetchedAt: number } | null {
      let raw: string | null
      try {
        raw = storage.getItem(CACHE_KEY)
      } catch {
        return null
      }
      if (raw === null || raw === '') return null
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return null
      }
      if (parsed === null || typeof parsed !== 'object') return null
      const rec = parsed as Partial<CachedModels>
      if (!Array.isArray(rec.models) || typeof rec.fetchedAt !== 'number') return null
      if (!isCopilotCacheFresh(rec.fetchedAt, Date.now())) return null
      for (const m of rec.models) {
        if (m === null || typeof m !== 'object') return null
        const c = m as Partial<CopilotModel>
        if (
          typeof c.id !== 'string' ||
          typeof c.name !== 'string' ||
          !(c.vision === null || typeof c.vision === 'boolean')
        ) {
          return null
        }
      }
      return { models: rec.models, fetchedAt: rec.fetchedAt }
    },
    write(models: CopilotModel[]): void {
      try {
        storage.setItem(CACHE_KEY, JSON.stringify({ models, fetchedAt: Date.now() } satisfies CachedModels))
      } catch {
        // storage full or unavailable; cache is best-effort
      }
    },
  }
}
