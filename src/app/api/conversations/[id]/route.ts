import { NextResponse } from 'next/server'
import { requireUserId, UnauthenticatedError } from '@/lib/current-user'
import { deleteConversation } from '@/lib/db/queries'

export const runtime = 'nodejs'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const userId = await requireUserId()
    const removed = await deleteConversation(userId, id)
    if (!removed) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ ok: true, id: removed.id })
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }
    console.error('DELETE /api/conversations/[id]:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
