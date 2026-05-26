import { NextResponse } from 'next/server'
import { getOrCreateSessionId } from '@/lib/session'
import { deleteConversation } from '@/lib/db/queries'

export const runtime = 'nodejs'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessionId = await getOrCreateSessionId()
  const removed = await deleteConversation(sessionId, id)
  if (!removed) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true, id: removed.id })
}
