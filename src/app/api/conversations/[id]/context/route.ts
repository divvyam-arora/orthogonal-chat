import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getOrCreateSessionId } from '@/lib/session'
import { getConversation } from '@/lib/db/queries'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessionId = await getOrCreateSessionId()
  const convo = await getConversation(sessionId, id)
  if (!convo) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const totalTokens = convo.totalTokens ?? 0
  const limit = env.CONTEXT_TOKENS_PER_CONVERSATION
  const pct = limit > 0 ? Math.min(100, (totalTokens / limit) * 100) : 0

  return NextResponse.json({
    conversationId: id,
    totalTokens,
    limit,
    pct,
    atLimit: totalTokens >= limit,
    continuedFromConversationId: convo.continuedFromConversationId ?? null,
  })
}
