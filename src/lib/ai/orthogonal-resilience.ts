import { env } from '@/lib/env'

/** Thrown when a circuit is open — callers should fail fast without hitting upstream. */
export class CircuitOpenError extends Error {
  readonly code = 'circuit_open' as const

  constructor(
    public readonly endpointKey: string,
    public readonly retryAfterMs: number,
  ) {
    const secs = Math.max(1, Math.ceil(retryAfterMs / 1000))
    super(
      `API temporarily unavailable (${endpointKey}). Circuit open after repeated failures — try another API or retry in ~${secs}s.`,
    )
    this.name = 'CircuitOpenError'
  }
}

type CacheEntry<T> = { value: T; expiresAt: number }

/** In-process TTL cache (per server instance). Good for MVP; use Redis for multi-instance. */
export class TtlCache {
  private readonly map = new Map<string, CacheEntry<unknown>>()

  constructor(private readonly ttlMs: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key)
      return undefined
    }
    return entry.value as T
  }

  set<T>(key: string, value: T): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    if (this.map.size > 256) this.pruneExpired()
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [k, v] of this.map) {
      if (now > v.expiresAt) this.map.delete(k)
    }
  }
}

type BreakerRecord = {
  state: 'closed' | 'open' | 'half-open'
  failures: number
  openedAt: number
}

/**
 * Per-endpoint circuit breaker (in-process).
 * After N upstream failures, fail fast instead of waiting on timeouts.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<string, BreakerRecord>()

  constructor(
    private readonly failureThreshold: number,
    private readonly openMs: number,
  ) {}

  async exec<T>(endpointKey: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now()
    let record = this.circuits.get(endpointKey)
    if (!record) {
      record = { state: 'closed', failures: 0, openedAt: 0 }
      this.circuits.set(endpointKey, record)
    }

    if (record.state === 'open') {
      const elapsed = now - record.openedAt
      if (elapsed >= this.openMs) {
        record.state = 'half-open'
      } else {
        throw new CircuitOpenError(endpointKey, this.openMs - elapsed)
      }
    }

    try {
      const result = await fn()
      record.state = 'closed'
      record.failures = 0
      return result
    } catch (err) {
      if (!shouldTripBreaker(err)) throw err

      record.failures += 1
      if (record.state === 'half-open' || record.failures >= this.failureThreshold) {
        record.state = 'open'
        record.openedAt = now
      }
      throw err
    }
  }
}

/** Normalize api+path for breaker keys. */
export function breakerEndpointKey(api: string, path: string): string {
  return `${api.trim().toLowerCase()}::${path.trim().replace(/\/+$/, '').toLowerCase()}`
}

export function stableCacheKey(prefix: string, payload: Record<string, unknown>): string {
  const sorted = Object.keys(payload)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = payload[k]
      return acc
    }, {})
  return `${prefix}:${JSON.stringify(sorted)}`
}

function shouldTripBreaker(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false
  const status = (err as { status?: number })?.status
  if (typeof status === 'number') {
    if (status >= 500) return true
    if (status === 429) return true
    return false
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('timed out')) return true
  if (msg.includes('returned 5')) return true
  if (msg.includes('returned 503')) return true
  if (msg.includes('network error') || msg.includes('fetch failed')) return true
  if (msg.includes('Orthogonal request failed')) return true
  return false
}

const cacheTtlMs = env.ORTHOGONAL_CACHE_TTL_SEC * 1000
const openMs = env.ORTHOGONAL_CIRCUIT_OPEN_SEC * 1000

export const searchCache = new TtlCache(cacheTtlMs)
export const detailsCache = new TtlCache(cacheTtlMs)
export const orthogonalBreaker = new CircuitBreaker(env.ORTHOGONAL_CIRCUIT_FAILURES, openMs)
