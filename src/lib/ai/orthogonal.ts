import { env } from '../env'
import {
  breakerEndpointKey,
  detailsCache,
  orthogonalBreaker,
  searchCache,
  stableCacheKey,
} from './orthogonal-resilience'

export type SearchApisResult = {
  results: Array<{
    api_id: string
    api: string
    path?: string
    method?: string
    name: string
    description: string
    score?: number
    price?: string
    verified?: boolean
  }>
  /** Set when served from short TTL cache (search is free). */
  cache_hit?: boolean
}

export type RunApiResult = {
  status: number
  headers?: Record<string, string>
  body: unknown
  latency_ms: number
  cost_usd?: number
  cache_hit?: boolean
  result_id?: string
}

export type DetailsResult = {
  api: string
  path: string
  method?: string
  description?: string
  bodyParams?: unknown
  queryParams?: unknown
  raw: unknown
  cache_hit?: boolean
}

type OrthogonalSearchEndpoint = {
  path?: string
  method?: string
  description?: string
  price?: string
  verified?: boolean
  score?: number
}

type OrthogonalSearchApi = {
  id?: string
  slug?: string
  name?: string
  description?: string
  endpoints?: OrthogonalSearchEndpoint[]
}

type OrthogonalSearchResponse = {
  success?: boolean
  error?: string
  details?: string
  results?: OrthogonalSearchApi[]
}

type OrthogonalListEndpointsResponse = {
  success?: boolean
  error?: string
  apis?: OrthogonalSearchApi[]
}

type OrthogonalRunResponse = {
  success?: boolean
  error?: string
  code?: string
  requestId?: string
  price?: string | number
  priceCents?: number
  data?: unknown
}

type OrthogonalDetailsResponse = {
  success?: boolean
  error?: string
  code?: string
  requestId?: string
  api?: {
    slug?: string
    name?: string
  }
  endpoint?: {
    path?: string
    method?: string
    description?: string
    bodyParams?: unknown
    queryParams?: unknown
  }
  data?: {
    api?: string
    path?: string
    method?: string
    description?: string
    bodyParams?: unknown
    queryParams?: unknown
  } & Record<string, unknown>
}

const baseHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${env.ORTHOGONAL_API_KEY}`,
})

// Hard cap so a slow/hung upstream can't pin a chat turn forever.
const FETCH_TIMEOUT_MS = 30_000

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const t0 = Date.now()
  const url = `${env.ORTHOGONAL_API_BASE_URL}${path}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: ac.signal,
    })
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
    if (e.name === 'AbortError') {
      throw new Error(`Orthogonal ${path} timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`)
    }
    const cause = e.cause
    const reason = cause?.message ?? e.message ?? 'network error'
    const code = cause?.code ? ` (${cause.code})` : ''
    const host = new URL(url).host
    throw new Error(
      `Orthogonal request failed for ${host}${path}${code}: ${reason}. Check ORTHOGONAL_API_BASE_URL and DNS/VPN access.`,
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let extra = ''
    try {
      const parsed = JSON.parse(text) as { error?: string; code?: string; details?: string }
      const detailParts = [parsed.error, parsed.code, parsed.details].filter(Boolean)
      if (detailParts.length) extra = ` (${detailParts.join(' | ')})`
    } catch {
      // keep raw text fallback
    }
    const err = new Error(`Orthogonal ${path} returned ${res.status}${extra}: ${text.slice(0, 200)}`)
    ;(err as Error & { status?: number; latencyMs?: number }).status = res.status
    ;(err as Error & { status?: number; latencyMs?: number }).latencyMs = Date.now() - t0
    throw err
  }
  return (await res.json()) as T
}

export const realOrthogonal = {
  async searchApis(query: string, limit = 5): Promise<SearchApisResult> {
    const cacheKey = stableCacheKey('search', { query: query.trim().toLowerCase(), limit })
    const cached = searchCache.get<SearchApisResult>(cacheKey)
    if (cached) return { ...cached, cache_hit: true }

    const result = await orthogonalBreaker.exec('orthogonal::search', async () => {
      try {
        const response = await postJson<OrthogonalSearchResponse>('/v1/search', { prompt: query, limit })
        if (response.success === false) {
          throw new Error(`Orthogonal /v1/search failed: ${response.error ?? response.details ?? 'unknown error'}`)
        }
        return { results: flattenSearchApis(response.results ?? [], limit), cache_hit: false }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (
          message.includes('/v1/search returned 503') ||
          message.toLowerCase().includes('semantic search unavailable')
        ) {
          const fallback = await fallbackSearchFromCatalog(query, limit)
          return { ...fallback, cache_hit: false }
        }
        throw err
      }
    })

    searchCache.set(cacheKey, result)
    return result
  },
  async getDetails(api: string, path: string): Promise<DetailsResult> {
    const cacheKey = stableCacheKey('details', {
      api: api.trim().toLowerCase(),
      path: path.trim().replace(/\/+$/, '').toLowerCase(),
    })
    const cached = detailsCache.get<DetailsResult>(cacheKey)
    if (cached) return { ...cached, cache_hit: true }

    const result = await orthogonalBreaker.exec(breakerEndpointKey(api, path), async () => {
      const response = await postJson<OrthogonalDetailsResponse>('/v1/details', { api, path })
      if (response.success === false) {
        throw new Error(
          `Orthogonal /v1/details failed${response.code ? ` (${response.code})` : ''}: ${response.error ?? 'unknown error'}`,
        )
      }

      const details = response.data ?? {}
      const endpoint = response.endpoint ?? {}
      const apiMeta = response.api ?? {}
      return {
        api: String(details.api ?? apiMeta.slug ?? apiMeta.name ?? api),
        path: String(details.path ?? endpoint.path ?? path),
        method:
          typeof details.method === 'string'
            ? details.method
            : typeof endpoint.method === 'string'
              ? endpoint.method
              : undefined,
        description:
          typeof details.description === 'string'
            ? details.description
            : typeof endpoint.description === 'string'
              ? endpoint.description
              : undefined,
        bodyParams: details.bodyParams ?? endpoint.bodyParams,
        queryParams: details.queryParams ?? endpoint.queryParams,
        raw: response,
        cache_hit: false,
      }
    })

    detailsCache.set(cacheKey, result)
    return result
  },
  async runApi(
    api: string,
    path: string,
    body: Record<string, unknown> = {},
    query: Record<string, unknown> = {},
  ): Promise<RunApiResult> {
    return orthogonalBreaker.exec(breakerEndpointKey(api, path), async () => {
      const t0 = Date.now()
      const payload: {
        api: string
        path: string
        body?: Record<string, unknown>
        query?: Record<string, unknown>
      } = { api, path }
      if (Object.keys(body).length > 0) payload.body = body
      if (Object.keys(query).length > 0) payload.query = query
      const response = await postJson<OrthogonalRunResponse>('/v1/run', payload)
      if (response.success === false) {
        throw new Error(
          `Orthogonal /v1/run failed${response.code ? ` (${response.code})` : ''}: ${response.error ?? 'unknown error'}`,
        )
      }

      const price =
        typeof response.price === 'number'
          ? response.price
          : typeof response.price === 'string'
            ? Number(response.price)
            : typeof response.priceCents === 'number'
              ? response.priceCents / 100
              : 0

      return {
        status: 200,
        body: response.data ?? response,
        latency_ms: Date.now() - t0,
        cost_usd: Number.isFinite(price) ? price : 0,
        cache_hit: false,
        result_id: response.requestId,
      }
    })
  },
}

async function fallbackSearchFromCatalog(query: string, limit: number): Promise<SearchApisResult> {
  const url = `${env.ORTHOGONAL_API_BASE_URL}/v1/list-endpoints`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.ORTHOGONAL_API_KEY}` },
      cache: 'no-store',
      signal: ac.signal,
    })
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e.name === 'AbortError') {
      throw new Error(`Orthogonal /v1/list-endpoints timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`)
    }
    throw new Error(`Orthogonal /v1/list-endpoints failed: ${e.message ?? 'network error'}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Orthogonal /v1/list-endpoints returned ${res.status}: ${text.slice(0, 200)}`)
  }
  const payload = (await res.json()) as OrthogonalListEndpointsResponse
  if (payload.success === false) {
    throw new Error(`Orthogonal /v1/list-endpoints failed: ${payload.error ?? 'unknown error'}`)
  }
  const ranked = flattenSearchApis(payload.apis ?? [], limit, query)
  return { results: ranked }
}

function flattenSearchApis(
  apis: OrthogonalSearchApi[],
  limit: number,
  query?: string,
): SearchApisResult['results'] {
  const terms = tokenize(query ?? '')
  const flattened = apis.flatMap((api) => {
    const apiSlug = (api.slug ?? api.id ?? '').trim()
    const apiName = (api.name ?? apiSlug ?? 'Unknown API').trim()
    const endpoints = api.endpoints ?? []

    if (!endpoints.length) {
      const description = api.description ?? ''
      return [
        {
          api_id: apiSlug || apiName,
          api: apiSlug || apiName,
          name: apiName,
          description,
          score: rankText(`${apiName} ${apiSlug} ${description}`, terms),
        },
      ]
    }

    return endpoints.map((ep) => {
      const description = ep.description ?? api.description ?? ''
      const text = `${apiName} ${apiSlug} ${ep.path ?? ''} ${description}`
      return {
        api_id: apiSlug || apiName,
        api: apiSlug || apiName,
        path: ep.path,
        method: ep.method,
        name: apiName,
        description,
        score: ep.score ?? rankText(text, terms),
        price: ep.price,
        verified: ep.verified,
      }
    })
  })

  flattened.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return flattened.slice(0, limit)
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length > 1)
}

function rankText(text: string, terms: string[]): number {
  if (!terms.length) return 0
  const hay = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (hay.includes(term)) score += 1
  }
  return score / terms.length
}

// Fake client for local dev without an Orthogonal account
export const fakeOrthogonal = {
  async searchApis(query: string, limit = 3): Promise<SearchApisResult> {
    await delay(300)
    const all: SearchApisResult['results'] = [
      { api_id: 'coingecko', api: 'coingecko', name: 'CoinGecko', description: 'Crypto prices and market data (public, no key)', score: 0.92 },
      { api_id: 'open-meteo', api: 'open-meteo', name: 'Open-Meteo', description: 'Free weather forecast API', score: 0.88 },
      { api_id: 'libretranslate', api: 'libretranslate', name: 'LibreTranslate', description: 'Open-source text translation', score: 0.81 },
      { api_id: 'restcountries', api: 'restcountries', name: 'REST Countries', description: 'Country info by name/code', score: 0.78 },
    ]
    const filtered = all.filter((a) =>
      `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase().split(' ')[0] ?? ''),
    )
    return { results: (filtered.length ? filtered : all).slice(0, limit) }
  },
  async getDetails(api: string, path: string): Promise<DetailsResult> {
    await delay(220)
    return {
      api,
      path,
      method: 'POST',
      description: 'Fake details response for local development',
      bodyParams: [{ name: 'example', type: 'string', required: false }],
      queryParams: [],
      raw: { api, path, fake: true },
    }
  },
  async runApi(
    api: string,
    path: string,
    body: Record<string, unknown> = {},
    query: Record<string, unknown> = {},
  ): Promise<RunApiResult> {
    await delay(450)
    const cache_hit = Math.random() < 0.25
    const fakeBody: Record<string, unknown> = {
      coingecko: { ethereum: { usd: 3247.18 }, bitcoin: { usd: 67432.5 } },
      'open-meteo': { latitude: 35.68, longitude: 139.69, current: { temperature_2m: 22.3, weather: 'Clear' } },
      libretranslate: { translatedText: '[fake translation of: ' + JSON.stringify(body) + ']' },
      restcountries: [{ name: { common: 'Japan' }, capital: ['Tokyo'], population: 125_000_000 }],
    }
    return {
      status: 200,
      body: fakeBody[api] ?? { ok: true, api, path, body, query, note: 'fake response' },
      latency_ms: 280 + Math.floor(Math.random() * 250),
      cost_usd: cache_hit ? 0 : 0.001,
      cache_hit,
      result_id: cryptoId(),
    }
  },
}

export const orthogonal = env.ORTHOGONAL_FAKE ? fakeOrthogonal : realOrthogonal

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
function cryptoId() {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
}
