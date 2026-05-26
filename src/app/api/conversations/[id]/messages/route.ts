import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getOrCreateSessionId } from '@/lib/session'
import { getConversation, listMessages } from '@/lib/db/queries'
import { normalizeParts } from '@/lib/ai/history'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessionId = await getOrCreateSessionId()
  const convo = await getConversation(sessionId, id)
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
}
