import type { UIMessage } from 'ai'
import { parseParamList } from './orchestration'

/**
 * Strategy: when replaying history to Claude, KEEP all decision-critical content
 * (descriptions, param hints, answer fields) and DROP pure noise (metadata, dup ids,
 * provider envelope fields, ranking signals). Live tool execute() outputs are untouched
 * so the current turn always sees full fidelity — this only trims what's sent on
 * follow-up requests.
 */

/** Top catalog results the model needs to pick an endpoint. */
const SEARCH_RESULTS_FOR_MODEL = 6
/** Hard guard against absurdly long descriptions (rare). */
const SEARCH_DESC_HARD_CAP = 800
const ENDPOINT_DESC_HARD_CAP = 1200
const PARAM_DESC_HARD_CAP = 400

/** Params the model needs to fill run_api correctly — keep description (it carries format hints). */
function slimParamList(raw: unknown): Array<{ name: string; required: boolean; type?: string; description?: string }> {
  return parseParamList(raw).map((p) => ({
    name: p.name,
    required: p.required,
    ...(p.type ? { type: p.type } : {}),
    ...(p.description ? { description: truncate(p.description, PARAM_DESC_HARD_CAP) } : {}),
  }))
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

/**
 * Compact a tool output for the model only. UI / DB keep the full execute() payload.
 * Rules: drop implementation noise, keep decision-critical facts.
 */
export function compactToolOutputForModel(toolName: string, output: unknown): unknown {
  if (!output || typeof output !== 'object') return output
  const o = output as Record<string, unknown>

  if (o.ok === false) {
    const err = o.error
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>
      return {
        ok: false,
        error: {
          message: e.message,
          code: e.code,
          missingFields: e.missingFields,
          suspiciousFields: e.suspiciousFields,
          suggestedNextSteps: e.suggestedNextSteps,
        },
        _meta: o._meta,
      }
    }
    return output
  }

  switch (toolName) {
    case 'search_apis':
      return compactSearchOutput(o)
    case 'get_details':
      return compactGetDetailsOutput(o)
    case 'run_api':
      return compactRunApiOutput(o)
    default:
      return output
  }
}

function compactSearchOutput(o: Record<string, unknown>): unknown {
  const results = Array.isArray(o.results) ? o.results : []
  return {
    ok: true,
    results: (results as Array<Record<string, unknown>>).slice(0, SEARCH_RESULTS_FOR_MODEL).map((r) => ({
      api: r.api ?? r.api_id,
      path: r.path,
      method: r.method,
      name: r.name,
      // Preserve description in full (it often holds input-format hints like "btcusdt").
      description: truncate(String(r.description ?? ''), SEARCH_DESC_HARD_CAP),
      // Preserve price if present — needed for "cheapest API" reasoning.
      ...(r.price != null ? { price: r.price } : {}),
    })),
    _meta: o._meta,
  }
}

function compactGetDetailsOutput(o: Record<string, unknown>): unknown {
  return {
    ok: true,
    api: o.api,
    path: o.path,
    method: o.method,
    description: typeof o.description === 'string' ? truncate(o.description, ENDPOINT_DESC_HARD_CAP) : o.description,
    bodyParams: slimParamList(o.bodyParams),
    queryParams: slimParamList(o.queryParams),
    orchestration: o.orchestration,
    // Drop details.raw only — that's Orthogonal docs / x402 / usage examples (not content the model reasons over).
    _meta: o._meta,
  }
}

function compactRunApiOutput(o: Record<string, unknown>): unknown {
  const body = compactRunApiBody(o.body)
  return {
    ok: true,
    status: o.status,
    body,
    _meta: o._meta,
  }
}

/**
 * Keep enough of run_api body for accurate follow-ups; trim only obvious bloat.
 * Threshold is generous (12KB) — typical answers are well under, only huge SERPs and
 * paginated arrays get trimmed.
 */
export function compactRunApiBody(body: unknown): unknown {
  if (body == null) return body
  const HARD_BUDGET = 12_000

  if (typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>

    // Serper / Google-style SERP: keep top 10 organic + answer box + knowledge graph.
    if (Array.isArray(b.organic)) {
      return {
        organic: (b.organic as Array<Record<string, unknown>>).slice(0, 10).map((item) => ({
          title: item.title,
          link: item.link,
          snippet: typeof item.snippet === 'string' ? truncate(item.snippet, 500) : item.snippet,
        })),
        answerBox: b.answerBox ?? b.answer_box,
        knowledgeGraph: b.knowledgeGraph ?? b.knowledge_graph,
      }
    }

    // Direct answer / summary blocks — keep as-is.
    if (b.answer || b.summary || b.text || b.result) {
      const json = JSON.stringify(b)
      if (json.length <= HARD_BUDGET) return body
    }
  }

  const json = JSON.stringify(body)
  if (json.length <= HARD_BUDGET) return body

  if (Array.isArray(body)) {
    return {
      items: body.slice(0, 15),
      _truncated: true,
      _note: `Array had ${body.length} items; showing first 15 for context.`,
    }
  }

  return {
    preview: truncate(json, HARD_BUDGET),
    _truncated: true,
    _note: `Response (~${Math.round(json.length / 1024)}KB) trimmed for context; key facts retained above.`,
  }
}

/**
 * Slim tool parts in message history before convertToModelMessages.
 * User-visible messages in DB stay full; only the Claude request is compacted.
 */
export function slimMessagesForModel(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if ((m as { role?: string }).role !== 'assistant') return m
    const parts = (m as unknown as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return m

    let changed = false
    const fixed = (parts as Array<Record<string, unknown>>).map((p) => {
      if (!p || typeof p !== 'object') return p
      const type = String(p.type ?? '')
      if (!type.startsWith('tool-')) return p
      const toolName = type.slice('tool-'.length)
      if (p.output == null) return p
      const compacted = compactToolOutputForModel(toolName, p.output)
      if (compacted === p.output) return p
      changed = true
      return { ...p, output: compacted }
    })

    if (!changed) return m
    return { ...(m as object), parts: fixed } as UIMessage
  })
}
