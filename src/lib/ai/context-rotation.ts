import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { env } from '@/lib/env'
import { calcCost } from '@/lib/pricing'
import {
  bumpUserTotals,
  createContinuedConversation,
  getConversation,
  listMessages,
  touchConversation,
} from '@/lib/db/queries'
import { normalizeParts, type CanonicalPart, type DbMessage } from '@/lib/ai/history'

const SUMMARY_SYSTEM = `You summarize chat threads so they can continue in a fresh conversation with a smaller context window.

Preserve everything needed to continue without re-doing work:
- User goals, constraints, and named entities (people, companies, URLs, tickers)
- APIs discovered and called (api slug + path) and whether they succeeded
- Key facts, numbers, and conclusions from tool/API results
- Open questions or obvious next steps

Write in clear sections. No raw JSON. Target 400–900 words.`

function partText(parts: CanonicalPart[]): string {
  return parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n')
}

function toolBrief(parts: CanonicalPart[]): string {
  const lines: string[] = []
  for (const p of parts) {
    if (!p.type.startsWith('tool-')) continue
    const name = p.type.slice('tool-'.length)
    const input = p.input as Record<string, unknown> | undefined
    const output = p.output as Record<string, unknown> | undefined
    const api = input?.api ?? output?.api
    const path = input?.path ?? output?.path
    const ok = output && typeof output === 'object' ? output.ok : undefined
    const err =
      output && typeof output === 'object' && output.error && typeof output.error === 'object'
        ? (output.error as Record<string, unknown>).message
        : undefined
    lines.push(
      `[${name}${api ? ` ${api}${path ? path : ''}` : ''}: ${ok === false ? `failed — ${err ?? 'error'}` : ok === true ? 'ok' : 'called'}]`,
    )
  }
  return lines.join('\n')
}

/** Build a compact transcript for the summarizer (not sent to the main chat model). */
export function buildTranscriptForSummary(rows: DbMessage[]): string {
  const chunks: string[] = []
  for (const row of rows) {
    const parts = normalizeParts(row.content)
    if (row.role === 'user') {
      const t = partText(parts)
      if (t) chunks.push(`User:\n${t}`)
      continue
    }
    if (row.role === 'assistant') {
      const continuity = parts.find((p) => p.type === 'context-continuity')
      if (continuity?.text) {
        chunks.push(`[Prior thread summary]\n${continuity.text}`)
        continue
      }
      const t = partText(parts)
      const tools = toolBrief(parts)
      if (t) chunks.push(`Assistant:\n${t}`)
      if (tools) chunks.push(tools)
    }
  }
  const joined = chunks.join('\n\n---\n\n')
  return joined.length > 48_000 ? `${joined.slice(0, 48_000)}\n\n[transcript truncated]` : joined
}

export async function summarizeForContinuation(rows: DbMessage[]): Promise<{
  summary: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}> {
  const transcript = buildTranscriptForSummary(rows)
  const model = env.SUMMARY_MODEL

  const { text, usage } = await generateText({
    model: anthropic(model),
    system: SUMMARY_SYSTEM,
    prompt: `Summarize this thread for continuation:\n\n${transcript}`,
    maxOutputTokens: 2048,
  })

  const inputTokens = usage?.inputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  const costUsd = calcCost(model, inputTokens, outputTokens)

  return {
    summary: text.trim() || 'Previous conversation covered API discovery and user questions; details were not captured in the summary.',
    inputTokens,
    outputTokens,
    costUsd,
  }
}

/**
 * When a conversation hits the per-chat token budget, summarize it and open a
 * new conversation carrying that summary as the first message.
 */
export async function rotateConversationIfNeeded(
  userId: string,
  conversationId: string,
): Promise<{ conversationId: string; rotated: boolean; continuedFromId?: string }> {
  const conv = await getConversation(userId, conversationId)
  if (!conv) return { conversationId, rotated: false }

  let used = conv.totalTokens ?? 0
  const rows = await listMessages(conversationId)
  if (used === 0 && rows.length > 0) {
    used = rows.reduce((acc, m) => acc + (m.inputTokens ?? 0) + (m.outputTokens ?? 0), 0)
  }
  if (used < env.CONTEXT_TOKENS_PER_CONVERSATION) {
    return { conversationId, rotated: false }
  }

  if (rows.length === 0) {
    return { conversationId, rotated: false }
  }

  const { summary, inputTokens, outputTokens, costUsd } = await summarizeForContinuation(rows)
  await bumpUserTotals(userId, costUsd, inputTokens + outputTokens)

  const oldTitle = conv.title?.trim() || 'Chat'
  const newConv = await createContinuedConversation({
    userId,
    continuedFromConversationId: conversationId,
    title: `Continued: ${oldTitle}`.slice(0, 60),
    summary,
    summaryInputTokens: inputTokens,
    summaryOutputTokens: outputTokens,
    summaryCostUsd: costUsd,
  })

  await touchConversation(conversationId, `${oldTitle} (full)`.slice(0, 60))

  return {
    conversationId: newConv.id,
    rotated: true,
    continuedFromId: conversationId,
  }
}

