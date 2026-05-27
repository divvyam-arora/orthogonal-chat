import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { requireUserId, UnauthenticatedError } from '@/lib/current-user'
import { getConversation, listMessages } from '@/lib/db/queries'
import { normalizeParts } from '@/lib/ai/history'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const userId = await requireUserId()
    const convo = await getConversation(userId, id)
    if (!convo) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const items = await listMessages(id)
    const messages = items.map((m) => ({
      id: m.id,
      role: m.role,
      parts: normalizeParts(m.content),
      createdAt: m.createdAt,
    }))
    return NextResponse.json({
      messages,
      context: {
        totalTokens: convo.totalTokens ?? 0,
        limit: env.CONTEXT_TOKENS_PER_CONVERSATION,
        continuedFromConversationId: convo.continuedFromConversationId ?? null,
      },
    })
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }
    console.error('GET /api/conversations/[id]/messages:', err)
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown_error'
    return NextResponse.json(
      { error: 'internal_error', message: message.slice(0, 800) },
      { status: 500 },
    )
  }
}
