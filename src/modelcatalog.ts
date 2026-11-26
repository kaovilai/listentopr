// GitHub Models catalog client (models.github.ai). Lists the models the
// stored GitHub PAT can use, groups them by publisher, and caches the list
// in an injected storage for a day. All network access goes through fetch
// (overridable via deps for tests); callers mock fetch.

/** A model from the GitHub Models catalog, mapped to app-facing fields. */
export interface CatalogModel {
  id: string
  name: string
  publisher: string
  summary: string
  vision: boolean
  maxInputTokens: number | null
  rateLimitTier: string | null
}

/** Catalog request failure: HTTP status (0 for network errors) + sanitized body. */
export class CatalogError extends Error {
  readonly status: number
  /** Error body with the token redacted; '' when none was read. */
  readonly body: string

  constructor(message: string, status = 0, body = '') {
    super(message)
    this.name = 'CatalogError'
    this.status = status
    this.body = body
  }
}

const CATALOG_URL = 'https://models.github.ai/catalog/models'

/** Cache lifetime for the model list. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

const CACHE_KEY = 'listentopr.gh-models'

/** Raw catalog item shape (subset of the fields the endpoint returns). */
interface RawCatalogModel {
  id?: unknown
  name?: unknown
  publisher?: unknown
  summary?: unknown
  limits?: { max_input_tokens?: unknown } | null
  rate_limit_tier?: unknown
  supported_input_modalities?: unknown
  supported_output_modalities?: unknown
}

/** Never let the token surface in a thrown error or its body. */
function sanitize(text: string, token: string): string {
  return token !== '' && text.includes(token) ? text.split(token).join('[REDACTED]') : text
}

function mapModel(raw: RawCatalogModel): CatalogModel | null {
  if (
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.publisher !== 'string'
  ) {
    return null
  }
  // Only text-output models are usable for transcript generation.
  const outputs = Array.isArray(raw.supported_output_modalities)
    ? raw.supported_output_modalities
    : []
  if (!outputs.includes('text')) return null
  const inputs = Array.isArray(raw.supported_input_modalities)
    ? raw.supported_input_modalities
    : []
  const maxInput = raw.limits?.max_input_tokens
  return {
    id: raw.id,
    name: raw.name,
    publisher: raw.publisher,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    vision: inputs.includes('image'),
    maxInputTokens: typeof maxInput === 'number' ? maxInput : null,
    rateLimitTier: typeof raw.rate_limit_tier === 'string' ? raw.rate_limit_tier : null,
  }
}

/**
 * Fetch the GitHub Models catalog with the stored PAT. Throws CatalogError
 * on an empty token, non-2xx responses (body sanitized, token redacted),
 * network failures, and a non-array response body.
 */
export async function fetchModelCatalog(
  token: string,
  deps?: { fetchFn?: typeof fetch }
): Promise<CatalogModel[]> {
  if (token === '') throw new CatalogError('no token')
  const fetchFn = deps?.fetchFn ?? fetch
  let res: Response
  try {
    res = await fetchFn(CATALOG_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    })
  } catch (err) {
    // Network failure (e.g. TypeError from fetch): pass the message through
    // as a CatalogError, token redacted.
    const raw = err instanceof Error ? err.message : String(err)
    throw new CatalogError(sanitize(raw, token))
  }
  if (!res.ok) {
    let body = ''
    try {
      body = sanitize(await res.text(), token)
    } catch {
      // unreadable body; status alone is enough
    }
    throw new CatalogError(
      `GitHub Models catalog request failed (${res.status})${body === '' ? '' : `: ${body}`}`,
      res.status,
      body
    )
  }
  let data: unknown
  try {
    data = await res.json()
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    throw new CatalogError(sanitize(`catalog response is not JSON: ${raw}`, token))
  }
  if (!Array.isArray(data)) {
    throw new CatalogError('catalog response is not an array')
  }
  const models: CatalogModel[] = []
  for (const raw of data as RawCatalogModel[]) {
    const mapped = mapModel(raw)
    if (mapped !== null) models.push(mapped)
  }
  return models
}

/** Group models by publisher, groups sorted by publisher, models by id. */
export function groupByPublisher(
  models: CatalogModel[]
): Array<{ publisher: string; models: CatalogModel[] }> {
  const groups = new Map<string, CatalogModel[]>()
  for (const m of models) {
    const list = groups.get(m.publisher)
    if (list === undefined) groups.set(m.publisher, [m])
    else list.push(m)
  }
  return [...groups.entries()]
    .map(([publisher, list]) => ({
      publisher,
      models: [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }))
    .sort((a, b) =>
      a.publisher < b.publisher ? -1 : a.publisher > b.publisher ? 1 : 0
    )
}

/** True while a cache entry fetched at fetchedAt is still usable at now. */
export function isCacheFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < CATALOG_TTL_MS
}

/** Minimal injectable storage (tests use a Map fake). */
export interface CatalogStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface CachedCatalog {
  models: CatalogModel[]
  fetchedAt: number
}

/**
 * JSON cache for the catalog under 'listentopr.gh-models'. read() returns
 * null on absent, corrupt, or expired entries; write() stamps fetchedAt.
 */
export function createCatalogCache(storage: CatalogStorage): {
  read(): { models: CatalogModel[]; fetchedAt: number } | null
  write(models: CatalogModel[]): void
} {
  return {
    read(): { models: CatalogModel[]; fetchedAt: number } | null {
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
      const rec = parsed as Partial<CachedCatalog>
      if (!Array.isArray(rec.models) || typeof rec.fetchedAt !== 'number') return null
      if (!isCacheFresh(rec.fetchedAt, Date.now())) return null
      for (const m of rec.models) {
        if (m === null || typeof m !== 'object') return null
        const c = m as Partial<CatalogModel>
        if (
          typeof c.id !== 'string' ||
          typeof c.name !== 'string' ||
          typeof c.publisher !== 'string' ||
          typeof c.summary !== 'string' ||
          typeof c.vision !== 'boolean' ||
          (c.maxInputTokens !== null && typeof c.maxInputTokens !== 'number') ||
          typeof c.rateLimitTier !== 'string'
        ) {
          return null
        }
      }
      return { models: rec.models, fetchedAt: rec.fetchedAt }
    },
    write(models: CatalogModel[]): void {
      try {
        storage.setItem(CACHE_KEY, JSON.stringify({ models, fetchedAt: Date.now() } satisfies CachedCatalog))
      } catch {
        // storage full or unavailable; cache is best-effort
      }
    },
  }
}
