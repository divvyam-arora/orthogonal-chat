import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { requireUserId, UnauthenticatedError } from '@/lib/current-user'
import { getConversation } from '@/lib/db/queries'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const userId = await requireUserId()
    const convo = await getConversation(userId, id)
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
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }
    console.error('GET /api/conversations/[id]/context:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
