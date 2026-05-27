/** Thrown when fetch was aborted (e.g. React Strict Mode cleanup) — not a real failure. */
export class FetchAbortedError extends Error {
  constructor() {
    super('aborted')
    this.name = 'FetchAbortedError'
  }
}

/**
 * fetch + safe JSON parse. Avoids "Unexpected end of JSON input" on empty bodies
 * (dev server cold start, aborted in-flight requests, proxy glitches).
 */
export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(input, init)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FetchAbortedError()
    }
    throw err
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 800)}` : ''}`)
  }

  const text = await res.text()
  if (!text.trim()) {
    throw new Error('Empty response body')
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Invalid JSON (${text.length} bytes)`)
  }
}

/** Log real failures; ignore aborts from effect cleanup. */
export function isBenignFetchError(err: unknown): boolean {
  return err instanceof FetchAbortedError
}

/**
 * Human-readable message from fetchJson / API failures (parses JSON body after `HTTP n:` if present).
 */
export function errorMessageFromFetch(err: unknown): string {
  if (err instanceof FetchAbortedError) return ''
  if (!(err instanceof Error)) return String(err)
  const raw = err.message?.trim() ?? ''
  if (!raw) return 'Request failed'
  const m = raw.match(/^HTTP \d+: ([\s\S]+)$/)
  const payload = (m?.[1] ?? raw).trim()
  try {
    const parsed = JSON.parse(payload) as { message?: string; error?: string }
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim()
  } catch {
    // not JSON — return trimmed raw / payload
  }
  return payload.slice(0, 400) || raw.slice(0, 400)
}
