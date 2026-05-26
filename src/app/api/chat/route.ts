import { NextResponse } from 'next/server'
import { streamText, convertToModelMessages } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { getOrCreateSessionId } from '@/lib/session'
import {
  upsertSession,
  getSessionTotals,
  bumpSessionTotals,
  bumpConversationTokens,
  createConversation,
  getConversation,
  insertMessage,
  insertToolResult,
  touchConversation,
  listMessages,
} from '@/lib/db/queries'
import { rotateConversationIfNeeded } from '@/lib/ai/context-rotation'
import { env } from '@/lib/env'
import { buildTools } from '@/lib/ai/tools'
import { calcCost } from '@/lib/pricing'
import { getRatelimit } from '@/lib/redis'
import { slimMessagesForModel } from '@/lib/ai/compact-for-model'
import {
  applyContextWindow,
  collectEndpointSpecsFromHistory,
  collectInspectedEndpoints,
  dbMessagesToUIMessages,
  expandContinuityForModel,
  extractToolMeta,
  partsFromResponseMessages,
} from '@/lib/ai/history'

export const runtime = 'nodejs'
export const maxDuration = 300

const SYSTEM_PROMPT = `You are Orthogonal Chat, an assistant that helps users discover and call third-party APIs.

You have three tools:
- search_apis(query, limit?) — find APIs in the Orthogonal catalog. FREE. Use liberally.
- get_details(api, path) — fetch endpoint parameter requirements + orchestration hints. Free but adds latency.
- run_api(api, path, body?, query?) — execute the actual API call. This is the only step that can cost money.

## Plan before you act

1. **Start with search_apis** using a query that matches the user's goal. Read the results.
2. **A second search is fine** if the first batch doesn't cover the task well (different angle, e.g. "web search"). Don't loop endlessly — two searches is usually plenty.
3. **Choose the cheapest path that actually answers the question:**
   - If a single endpoint can answer it directly with the inputs the user gave → one run_api is enough.
   - If the user asked an informational question ("what's the URL of...", "who are the cofounders of...") and a web-search endpoint can answer in one call → just use that.
   - Only chain (search → enrich) when the question demands structured data the user did NOT provide (e.g. "enrich this lead" with only a name, where the enrichment endpoint requires a domain).
4. **Then act.** get_details on the chosen endpoint, then run_api.

## Choosing single-step vs multi-step

Single run_api is usually correct when:
- The user's question is factual ("what is X?", "who is Y?", "find the URL of Z") and a search/lookup API exists.
- The endpoint's required inputs are already in the user's message (e.g. user said "stripe.com", endpoint needs company_domain).
- A general-purpose API (web search, knowledge graph, public data) covers it.

Multi-step (resolve → enrich) is only needed when:
- The user explicitly wants STRUCTURED output (specific fields, JSON enrichment).
- The best endpoint requires identifiers (domain, URL, email, LinkedIn URL) that the user did NOT provide.
- A plain search wouldn't return data in the form the user wants.

When in doubt, prefer the single-step option. Tell the user what you used and offer to go deeper.

## Handling required inputs

When get_details reports orchestration.requiredFields:
- If the user already supplied all required values (or close equivalents you can plug in) → proceed to run_api.
- If a required identifier (domain/URL/email/LinkedIn) is missing, decide based on the question:
  - User wants a quick factual answer → switch to a web-search API instead, that's usually one call.
  - User wants structured enrichment → search_apis for a web-search/lookup API to resolve just the missing identifier, then come back to the enrichment endpoint.

If run_api returns missing_prerequisites or suspicious_inputs, do NOT retry blindly. Re-plan: is there a simpler API that answers the user's actual question?

## Output

Summarize in plain language. Cite the API name(s) used. Don't paste raw JSON unless the user asks.
Older tool outputs in history may be truncated to save context — work from your earlier summary when needed.
If the thread starts with a "Continued from previous chat" summary, treat it as authoritative background from an earlier thread.
Keep replies tight.`

type IncomingPart = { type: string; text?: string }
type IncomingMessage = {
  id?: string
  role?: string
  parts?: IncomingPart[]
  text?: string
}

type ChatBody = {
  conversationId?: string | null
  // New-style: client sends only the new user message.
  message?: IncomingMessage
  // Legacy: full messages array — we pluck the latest user message only.
  messages?: IncomingMessage[]
}

export async function POST(req: Request) {
  const sessionId = await getOrCreateSessionId()
  await upsertSession(sessionId)

  // Optional rate limit (only when Upstash configured).
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

  // Budget cap.
  const totals = await getSessionTotals(sessionId)
  const spent = Number(totals?.totalCostUsd ?? 0)
  if (spent >= env.BUDGET_USD_PER_SESSION) {
    return NextResponse.json(
      { error: 'cap_exceeded', spent, cap: env.BUDGET_USD_PER_SESSION },
      { status: 402 },
    )
  }

  const body = (await req.json()) as ChatBody
  const userMessage = pickLastUser(body)
  if (!userMessage) {
    return NextResponse.json({ error: 'no_user_message' }, { status: 400 })
  }

  // Resolve conversation (own this session, create if missing).
  let conversationId = body.conversationId ?? null
  if (conversationId) {
    const c = await getConversation(sessionId, conversationId)
    if (!c) conversationId = null
  }
  if (!conversationId) {
    const c = await createConversation(sessionId)
    conversationId = c.id
  }

  // Per-chat context cap (Cursor-style): summarize + open a fresh thread when full.
  let contextRotated = false
  let continuedFromId: string | undefined
  const rotation = await rotateConversationIfNeeded(sessionId, conversationId)
  if (rotation.rotated) {
    contextRotated = true
    continuedFromId = rotation.continuedFromId
    conversationId = rotation.conversationId
  }

  // Persist the new user message FIRST so the DB is the source of truth before the LLM runs.
  const userText = extractText(userMessage).slice(0, 4000)
  const userParts: IncomingPart[] =
    Array.isArray(userMessage.parts) && userMessage.parts.length > 0
      ? userMessage.parts
      : [{ type: 'text', text: userText }]
  await insertMessage({
    conversationId,
    role: 'user',
    content: userParts as unknown as object,
  })

  // Auto-title from the first user message; touch updatedAt for sidebar ordering.
  const existing = await listMessages(conversationId)
  const userCount = existing.filter((m) => m.role === 'user').length
  await touchConversation(conversationId, userCount === 1 ? userText.slice(0, 60) : undefined)

  // Server is authoritative: build LLM input from DB-loaded canonical history.
  const fullHistory = dbMessagesToUIMessages(existing)

  // Carry forward get_details memory from the parent thread after context rotation.
  const conv = await getConversation(sessionId, conversationId)
  let guardHistory = fullHistory
  if (conv?.continuedFromConversationId) {
    const parentRows = await listMessages(conv.continuedFromConversationId)
    guardHistory = [...dbMessagesToUIMessages(parentRows), ...fullHistory]
  }

  const inspectedFromHistory = collectInspectedEndpoints(guardHistory)
  const specsFromHistory = collectEndpointSpecsFromHistory(guardHistory)
  const modelMessages = slimMessagesForModel(
    applyContextWindow(expandContinuityForModel(fullHistory)),
  )
  const tools = buildTools({
    inspectedEndpoints: inspectedFromHistory,
    endpointSpecs: specsFromHistory,
  })

  const result = streamText({
    model: anthropic(env.DEFAULT_MODEL),
    system: {
      role: 'system',
      content: SYSTEM_PROMPT,
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    },
    messages: await convertToModelMessages(modelMessages),
    tools,
    maxOutputTokens: 6144,
    stopWhen: ({ steps }) => steps.length >= 10,
    onFinish: async ({ usage, response }) => {
      try {
        const inputTokens = usage?.inputTokens ?? 0
        const outputTokens = usage?.outputTokens ?? 0
        const llmCost = calcCost(env.DEFAULT_MODEL, inputTokens, outputTokens)

        const assistantParts = partsFromResponseMessages(response)
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

        const turnTokens = inputTokens + outputTokens
        await bumpSessionTotals(sessionId, totalCost, turnTokens)
        await bumpConversationTokens(conversationId!, turnTokens)
        await touchConversation(conversationId!)
      } catch (err) {
        console.error('chat onFinish error:', err)
      }
    },
  })

  const headers: Record<string, string> = {
    'X-Conversation-Id': conversationId!,
    'X-Context-Limit': String(env.CONTEXT_TOKENS_PER_CONVERSATION),
  }
  if (contextRotated) {
    headers['X-Context-Rotated'] = '1'
    if (continuedFromId) headers['X-Continued-From'] = continuedFromId
  }

  return result.toUIMessageStreamResponse({ headers })
}

function pickLastUser(body: ChatBody): IncomingMessage | null {
  if (body.message && (body.message.role ?? 'user') === 'user') return body.message
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i]
      if (m && m.role === 'user') return m
    }
  }
  return null
}

function extractText(msg: IncomingMessage): string {
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p) => p?.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n')
  }
  return msg.text ?? ''
}
