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
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
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
