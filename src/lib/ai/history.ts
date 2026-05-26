import { type UIMessage } from 'ai'
import {
  buildEndpointSpec,
  type EndpointSpec,
} from './orchestration'

// Context-window strategy: bounded total turns, large old tool outputs collapsed.
const MAX_TOTAL_MESSAGES = 40
const KEEP_RECENT_VERBATIM = 4
const MAX_TOOL_OUTPUT_BYTES_IN_HISTORY = 4 * 1024

export type DbMessage = {
  id: string
  role: string
  content: unknown
  createdAt?: Date | string
}

export type CanonicalPart = {
  type: string
  text?: string
  continuedFromId?: string
  toolCallId?: string
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  input?: unknown
  output?: unknown
  errorText?: string
}

/**
 * Convert any stored content blob into the canonical AI SDK v6 unified parts array.
 * Handles every historical format produced by earlier versions of this codebase:
 *  - raw string
 *  - whole UIMessage envelope {id, role, parts}
 *  - legacy {type:'tool-call'} + {type:'tool-result'} pair
 *  - already-canonical [{type:'tool-NAME', state, input, output}]
 *
 * Any tool part that ends up without a terminal state is forced to 'output-error'
 * so convertToModelMessages emits a valid tool_use + tool_result pair.
 */
export function normalizeParts(content: unknown): CanonicalPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const o = content as Record<string, unknown>
    if (Array.isArray(o.parts)) return normalizeParts(o.parts)
    if (typeof o.text === 'string') return [{ type: 'text', text: o.text }]
    return [{ type: 'text', text: '' }]
  }
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]

  const out: CanonicalPart[] = []
  const byCallId = new Map<string, CanonicalPart>()

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const t = typeof r.type === 'string' ? r.type : ''
    if (t === 'text') {
      out.push({ type: 'text', text: String(r.text ?? '') })
      continue
    }
    if (t === 'tool-call') {
      const toolName = String(r.toolName ?? '')
      const toolCallId = String(r.toolCallId ?? '')
      const part: CanonicalPart = {
        type: `tool-${toolName}`,
        toolCallId,
        state: 'input-available',
        input: r.input ?? r.args,
      }
      out.push(part)
      if (toolCallId) byCallId.set(toolCallId, part)
      continue
    }
    if (t === 'tool-result') {
      const toolCallId = String(r.toolCallId ?? '')
      const toolName = String(r.toolName ?? '')
      const output = unwrapProviderOutput(r.output ?? r.result)
      const isError = isErrorOutput(output)
      const existing = toolCallId ? byCallId.get(toolCallId) : undefined
      if (existing) {
        existing.output = output
        existing.state = isError ? 'output-error' : 'output-available'
        if (isError) existing.errorText = extractErrorMessage(output)
      } else {
        out.push({
          type: `tool-${toolName}`,
          toolCallId,
          state: isError ? 'output-error' : 'output-available',
          output,
          errorText: isError ? extractErrorMessage(output) : undefined,
        })
      }
      continue
    }
    if (t === 'step-start') {
      out.push({ type: 'step-start' })
      continue
    }
    if (t === 'context-continuity') {
      out.push({
        type: 'context-continuity',
        text: String(r.text ?? ''),
        continuedFromId: typeof r.continuedFromId === 'string' ? r.continuedFromId : undefined,
      })
      continue
    }
    if (t.startsWith('tool-')) {
      const toolCallId = String(r.toolCallId ?? '')
      const output = unwrapProviderOutput(r.output)
      const part: CanonicalPart = {
        type: t,
        toolCallId,
        state: (r.state as CanonicalPart['state']) ?? (output != null ? 'output-available' : 'input-available'),
        input: r.input,
        output,
        errorText: typeof r.errorText === 'string' ? r.errorText : undefined,
      }
      out.push(part)
      if (toolCallId) byCallId.set(toolCallId, part)
      continue
    }
  }

  // Safety: any tool part stuck without a terminal state -> output-error
  for (const p of out) {
    if (!p.type.startsWith('tool-')) continue
    if (p.state === 'output-available' || p.state === 'output-error') continue
    p.state = 'output-error'
    p.errorText = p.errorText ?? 'Previous tool call did not complete.'
  }

  return out
}

/**
 * Trim conversation history before sending to the LLM:
 *  - cap total messages
 *  - collapse large tool outputs in older turns to a short placeholder
 *
 * Keeps the most recent KEEP_RECENT_VERBATIM messages fully intact so the
 * model can reason over fresh raw responses.
 */
export function applyContextWindow(messages: UIMessage[]): UIMessage[] {
  const trimmed = messages.slice(-MAX_TOTAL_MESSAGES)
  const boundary = trimmed.length - KEEP_RECENT_VERBATIM
  return trimmed.map((m, idx) => {
    if (idx >= boundary) return m
    const parts = (m as unknown as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return m
    let changed = false
    const fixed = (parts as Array<Record<string, unknown>>).map((p) => {
      if (!p || typeof p !== 'object') return p
      const t = String(p.type ?? '')
      if (!t.startsWith('tool-')) return p
      const output = p.output
      if (output == null) return p
      const size = safeJsonSize(output)
      if (size <= MAX_TOOL_OUTPUT_BYTES_IN_HISTORY) return p
      changed = true
      const ok = typeof output === 'object' && output !== null ? (output as Record<string, unknown>).ok : true
      return {
        ...p,
        output: {
          ok,
          truncated: true,
          summary: `Output omitted to save context (~${Math.round(size / 1024)}KB).`,
        },
      }
    })
    if (!changed) return m
    return { ...(m as object), parts: fixed } as UIMessage
  })
}

/** DB rows -> UIMessages with canonical parts. */
export function dbMessagesToUIMessages(rows: DbMessage[]): UIMessage[] {
  return rows.map((r) => ({
    id: r.id,
    role: r.role as UIMessage['role'],
    parts: normalizeParts(r.content),
  })) as unknown as UIMessage[]
}

const CONTINUITY_USER_PREFIX =
  'The conversation continues from an earlier thread that reached the context limit. ' +
  'Use this summary as established background — the user may ask follow-ups about people, APIs, or facts mentioned here:\n\n'

/**
 * AI SDK convertToModelMessages only understands text/tool/file parts.
 * Our context-continuity parts are UI-only unless expanded here.
 */
export function expandContinuityForModel(messages: UIMessage[]): UIMessage[] {
  const out: UIMessage[] = []

  for (const m of messages) {
    const role = (m as { role?: string }).role
    const parts = (m as { parts?: unknown }).parts
    if (role !== 'assistant' || !Array.isArray(parts)) {
      out.push(m)
      continue
    }

    const continuityTexts: string[] = []
    const rest: unknown[] = []

    for (const raw of parts) {
      if (!raw || typeof raw !== 'object') continue
      const p = raw as { type?: string; text?: string }
      if (p.type === 'context-continuity' && p.text?.trim()) {
        continuityTexts.push(p.text.trim())
      } else {
        rest.push(raw)
      }
    }

    if (continuityTexts.length > 0) {
      out.push({
        id: `${String((m as { id?: string }).id ?? 'c')}-continuity-ctx`,
        role: 'user',
        parts: [{ type: 'text', text: CONTINUITY_USER_PREFIX + continuityTexts.join('\n\n---\n\n') }],
      } as UIMessage)
    }

    if (rest.length > 0) {
      out.push({ ...(m as object), parts: rest } as UIMessage)
    }
  }

  return out
}

/**
 * Extract successfully-inspected (api, path) pairs from history so the
 * run_api guard knows what's already been seen this conversation.
 * Path comparison is case-insensitive and trailing-slash-tolerant in the guard itself.
 */
export function collectInspectedEndpoints(messages: UIMessage[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const m of messages) {
    if ((m as { role?: string }).role !== 'assistant') continue
    const parts = (m as unknown as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const raw of parts as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object') continue
      if (raw.type !== 'tool-get_details') continue
      const output = raw.output as Record<string, unknown> | undefined
      if (!output || output.ok !== true) continue
      const input = raw.input as Record<string, unknown> | undefined
      const api = (output.api as string | undefined) ?? (input?.api as string | undefined)
      const path = (output.path as string | undefined) ?? (input?.path as string | undefined)
      if (typeof api === 'string' && typeof path === 'string' && api && path) {
        out.push([api, path])
      }
    }
  }
  return out
}

/** Rebuild endpoint param specs from prior get_details tool outputs in this conversation. */
export function collectEndpointSpecsFromHistory(messages: UIMessage[]): EndpointSpec[] {
  const out: EndpointSpec[] = []
  for (const m of messages) {
    if ((m as { role?: string }).role !== 'assistant') continue
    const parts = (m as unknown as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const raw of parts as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object' || raw.type !== 'tool-get_details') continue
      const output = raw.output as Record<string, unknown> | undefined
      if (!output || output.ok !== true) continue
      const input = raw.input as Record<string, unknown> | undefined
      const api = (output.api as string | undefined) ?? (input?.api as string | undefined)
      const path = (output.path as string | undefined) ?? (input?.path as string | undefined)
      if (typeof api !== 'string' || typeof path !== 'string' || !api || !path) continue
      out.push(buildEndpointSpec(api, path, output.bodyParams, output.queryParams))
    }
  }
  return out
}

/**
 * Convert the assistant + tool messages emitted by streamText.response.messages
 * (provider-format) into canonical unified parts for persistence + display.
 *
 * Two non-obvious correctness rules:
 *
 *  1. Unwrap the provider's tool-result envelope `{type:'json', value: X}` -> `X`.
 *     The canonical UIMessage tool-part stores the RAW output value. If we leave
 *     the wrapper in, convertToModelMessages wraps it again on the next turn,
 *     producing `{type:'json', value:{type:'json', value:X}}` which the Anthropic
 *     provider cannot match back to the tool_use id and rejects with
 *     "tool_use ids were found without tool_result blocks".
 *
 *  2. Emit a `step-start` marker between successive assistant messages from the
 *     provider so convertToModelMessages splits each tool step into its own
 *     assistant/tool message pair, mirroring the multi-step format the model
 *     originally produced.
 */
export function partsFromResponseMessages(
  response: { messages?: Array<{ role: string; content?: unknown }> },
): CanonicalPart[] {
  const msgs = response?.messages ?? []
  const out: CanonicalPart[] = []
  const byCallId = new Map<string, CanonicalPart>()
  let seenAssistantBlock = false

  for (const m of msgs) {
    if (m.role !== 'assistant' && m.role !== 'tool') continue

    if (m.role === 'assistant') {
      if (seenAssistantBlock) out.push({ type: 'step-start' })
      seenAssistantBlock = true
    }

    const content = m.content
    if (typeof content === 'string') {
      out.push({ type: 'text', text: content })
      continue
    }
    if (!Array.isArray(content)) continue
    for (const c of content as Array<Record<string, unknown>>) {
      const t = String(c.type ?? '')
      if (t === 'text') {
        out.push({ type: 'text', text: String(c.text ?? '') })
      } else if (t === 'tool-call') {
        const toolName = String(c.toolName ?? '')
        const toolCallId = String(c.toolCallId ?? '')
        const part: CanonicalPart = {
          type: `tool-${toolName}`,
          toolCallId,
          state: 'input-available',
          input: c.input ?? c.args,
        }
        out.push(part)
        if (toolCallId) byCallId.set(toolCallId, part)
      } else if (t === 'tool-result') {
        const toolCallId = String(c.toolCallId ?? '')
        const toolName = String(c.toolName ?? '')
        const rawOutput = unwrapProviderOutput(c.output ?? c.result)
        const isError = isErrorOutput(rawOutput)
        const existing = toolCallId ? byCallId.get(toolCallId) : undefined
        if (existing) {
          existing.output = rawOutput
          existing.state = isError ? 'output-error' : 'output-available'
          if (isError) existing.errorText = extractErrorMessage(rawOutput)
        } else {
          out.push({
            type: `tool-${toolName}`,
            toolCallId,
            state: isError ? 'output-error' : 'output-available',
            output: rawOutput,
            errorText: isError ? extractErrorMessage(rawOutput) : undefined,
          })
        }
      }
    }
  }
  return out
}

/**
 * Strip the provider's wire-format envelope from a tool result.
 *   { type: 'json', value: X } -> X
 *   { type: 'text', value: X } -> X
 *   anything else              -> as-is
 */
function unwrapProviderOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output
  const o = output as Record<string, unknown>
  if ((o.type === 'json' || o.type === 'text' || o.type === 'error-json' || o.type === 'error-text') && 'value' in o) {
    return o.value
  }
  return output
}

export type ToolMeta = {
  toolName: string
  toolCallId: string
  input: unknown
  output?: unknown
  error?: unknown
  latencyMs?: number
  costUsd?: number
  cacheHit?: boolean
}

/** Pull per-tool-call metadata out of canonical parts for tool_results table inserts. */
export function extractToolMeta(parts: CanonicalPart[]): ToolMeta[] {
  const out: ToolMeta[] = []
  for (const p of parts) {
    if (!p.type.startsWith('tool-')) continue
    if (!p.toolCallId) continue
    const toolName = p.type.slice('tool-'.length)
    const output = p.output as Record<string, unknown> | null | undefined
    const meta = (output?._meta ?? {}) as Record<string, unknown>
    out.push({
      toolName,
      toolCallId: p.toolCallId,
      input: p.input ?? null,
      output: output ?? undefined,
      latencyMs: typeof meta.latencyMs === 'number' ? meta.latencyMs : undefined,
      costUsd: typeof meta.costUsd === 'number' ? meta.costUsd : 0,
      cacheHit: !!meta.cacheHit,
      error: output && output.ok === false ? (output.error ?? null) : undefined,
    })
  }
  return out
}

function isErrorOutput(output: unknown): boolean {
  return !!(output && typeof output === 'object' && (output as Record<string, unknown>).ok === false)
}

function extractErrorMessage(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined
  const err = (output as Record<string, unknown>).error
  if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    return String((err as Record<string, unknown>).message)
  }
  return undefined
}

function safeJsonSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}
