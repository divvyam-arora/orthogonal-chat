import { NextResponse } from 'next/server'
import { requireUserId, UnauthenticatedError } from '@/lib/current-user'
import { listConversations, createConversation } from '@/lib/db/queries'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const userId = await requireUserId()
    const items = await listConversations(userId)
    return NextResponse.json({ conversations: items })
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }
    console.error('GET /api/conversations:', err)
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown_error'
    return NextResponse.json(
      { error: 'internal_error', message: message.slice(0, 800) },
      { status: 500 },
    )
  }
}

export async function POST() {
  try {
    const userId = await requireUserId()
    const row = await createConversation(userId)
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }
    console.error('POST /api/conversations:', err)
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown_error'
    return NextResponse.json(
      { error: 'internal_error', message: message.slice(0, 800) },
      { status: 500 },
    )
  }
}
