import { NextResponse } from 'next/server'
import { streamText, convertToModelMessages, type UIMessage } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { env } from '@/lib/env'
import { getOrCreateSessionId } from '@/lib/session'
import {
  upsertSession,
  getSessionTotals,
  bumpSessionTotals,
  createConversation,
  getConversation,
  insertMessage,
  insertToolResult,
  touchConversation,
  listMessages,
} from '@/lib/db/queries'
import { buildTools } from '@/lib/ai/tools'
import { calcCost } from '@/lib/pricing'
import { getRatelimit } from '@/lib/redis'

export const runtime = 'nodejs'
export const maxDuration = 300

const SYSTEM_PROMPT = `You are Orthogonal Chat, an assistant that helps users discover and call third-party APIs.

You have three tools:
- search_apis(query, limit?) — find APIs by natural-language query
- get_details(api, path) — fetch endpoint parameter requirements
- run_api(api, path, body?, query?) — execute an API call

Required workflow for API usage:
1. Call search_apis first to find candidate API/path pairs.
2. Pick the best candidate and call get_details for that exact api/path.
3. Build run_api inputs from get_details:
   - Use body for request body fields.
   - Use query for query-string fields.
4. Only then call run_api.
5. Summarize the result in plain language. Cite the API name. Do not paste raw JSON unless asked.

Do not guess endpoint parameters before calling get_details.
If get_details or run_api fails, explain briefly, retry once with corrected params, otherwise recommend the closest alternative endpoint from search results.
Keep replies tight.`

type ChatBody = {
  messages: UIMessage[]
  conversationId?: string | null
}

export async function POST(req: Request) {
  const sessionId = await getOrCreateSessionId()
  await upsertSession(sessionId)

  // Rate limit (optional — only when Upstash configured)
  const rl = getRatelimit()
  if (rl) {
    const { success, reset } = await rl.limit(`chat:session:${sessionId}`)
    if (!success) {
      const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
      return NextResponse.json(
        { error: 'rate_limited', retryAfter },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      )
    }
  }

  // Budget cap
  const totals = await getSessionTotals(sessionId)
  const spent = Number(totals?.totalCostUsd ?? 0)
  if (spent >= env.BUDGET_USD_PER_SESSION) {
    return NextResponse.json(
      { error: 'cap_exceeded', spent, cap: env.BUDGET_USD_PER_SESSION },
      { status: 402 },
    )
  }

  const body = (await req.json()) as ChatBody
  const incoming = body.messages ?? []
  if (incoming.length === 0) {
    return NextResponse.json({ error: 'empty_messages' }, { status: 400 })
  }

  // Ensure conversation exists
  let conversationId = body.conversationId ?? null
  if (conversationId) {
    const c = await getConversation(sessionId, conversationId)
    if (!c) conversationId = null
  }
  if (!conversationId) {
    const c = await createConversation(sessionId)
    conversationId = c.id
  }

  // Persist the last user message
  const lastUser = [...incoming].reverse().find((m) => m.role === 'user')
  let firstTurnTitle: string | null = null
  if (lastUser) {
    const userText = extractText(lastUser).slice(0, 4000)
    await insertMessage({
      conversationId,
      role: 'user',
      content: lastUser as unknown as object,
    })
    // Auto-title from first message if title is null
    const existingMsgs = await listMessages(conversationId)
    if (existingMsgs.filter((m) => m.role === 'user').length === 1) {
      firstTurnTitle = userText.slice(0, 60)
    }
  }
  await touchConversation(conversationId, firstTurnTitle ?? undefined)

  const tools = buildTools()

  const result = streamText({
    model: anthropic(env.DEFAULT_MODEL),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(incoming),
    tools,
    stopWhen: ({ steps }) => steps.length >= 10,
    onFinish: async ({ usage, response }) => {
      try {
        const inputTokens = usage?.inputTokens ?? 0
        const outputTokens = usage?.outputTokens ?? 0
        const llmCost = calcCost(env.DEFAULT_MODEL, inputTokens, outputTokens)

        // Collect tool costs and persist tool_results
        const assistantParts = collectAssistantParts(response)
        const toolCallsMeta = extractToolMeta(assistantParts)
        const toolCost = toolCallsMeta.reduce((acc, t) => acc + (t.costUsd ?? 0), 0)
        const totalCost = llmCost + toolCost

        const inserted = await insertMessage({
          conversationId: conversationId!,
          role: 'assistant',
          content: assistantParts as unknown as object,
          inputTokens,
          outputTokens,
          costUsd: totalCost.toFixed(6),
        })
        for (const t of toolCallsMeta) {
          await insertToolResult({
            messageId: inserted.id,
            toolName: t.toolName,
            toolCallId: t.toolCallId,
            input: t.input,
            output: t.output ?? null,
            error: t.error ?? null,
            latencyMs: t.latencyMs ?? null,
            costUsd: (t.costUsd ?? 0).toFixed(6),
            cacheHit: !!t.cacheHit,
          })
        }

        await bumpSessionTotals(sessionId, totalCost, inputTokens + outputTokens)
        await touchConversation(conversationId!)
      } catch (err) {
        console.error('chat onFinish error:', err)
      }
    },
  })

  return result.toUIMessageStreamResponse({
    headers: {
      'X-Conversation-Id': conversationId,
    },
  })
}

function extractText(msg: UIMessage): string {
  const parts = (msg as unknown as { parts?: Array<{ type: string; text?: string }> }).parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n')
}

type AssistantPart = {
  type: string
  text?: string
  toolName?: string
  toolCallId?: string
  input?: unknown
  output?: unknown
  state?: string
  errorText?: string
}

function collectAssistantParts(response: { messages?: Array<{ role: string; content?: unknown }> }): AssistantPart[] {
  const msgs = response?.messages ?? []
  const out: AssistantPart[] = []
  for (const m of msgs) {
    if (m.role !== 'assistant' && m.role !== 'tool') continue
    const content = m.content
    if (typeof content === 'string') {
      out.push({ type: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const c of content as Array<Record<string, unknown>>) {
        const t = String(c.type)
        if (t === 'text') {
          out.push({ type: 'text', text: String(c.text ?? '') })
        } else if (t === 'tool-call') {
          out.push({
            type: 'tool-call',
            toolName: String(c.toolName ?? ''),
            toolCallId: String(c.toolCallId ?? ''),
            input: c.input ?? c.args,
          })
        } else if (t === 'tool-result') {
          out.push({
            type: 'tool-result',
            toolName: String(c.toolName ?? ''),
            toolCallId: String(c.toolCallId ?? ''),
            output: c.output ?? c.result,
          })
        }
      }
    }
  }
  return out
}

function extractToolMeta(parts: AssistantPart[]) {
  const calls = new Map<
    string,
    {
      toolName: string
      toolCallId: string
      input: unknown
      output?: unknown
      error?: unknown
      latencyMs?: number
      costUsd?: number
      cacheHit?: boolean
    }
  >()
  for (const p of parts) {
    if (p.type === 'tool-call' && p.toolCallId) {
      calls.set(p.toolCallId, {
        toolName: p.toolName ?? '',
        toolCallId: p.toolCallId,
        input: p.input,
      })
    } else if (p.type === 'tool-result' && p.toolCallId) {
      const entry = calls.get(p.toolCallId) ?? {
        toolName: p.toolName ?? '',
        toolCallId: p.toolCallId,
        input: null,
      }
      const out = p.output as Record<string, unknown> | null | undefined
      const meta = (out?._meta ?? {}) as Record<string, unknown>
      entry.output = out
      entry.latencyMs = (meta.latencyMs as number) ?? undefined
      entry.costUsd = (meta.costUsd as number) ?? 0
      entry.cacheHit = !!meta.cacheHit
      if (out && out.ok === false) {
        entry.error = out.error ?? null
      }
      calls.set(p.toolCallId, entry)
    }
  }
  return Array.from(calls.values())
}
