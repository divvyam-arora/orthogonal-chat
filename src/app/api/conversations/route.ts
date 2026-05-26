import { NextResponse } from 'next/server'
import { getOrCreateSessionId } from '@/lib/session'
import { upsertSession, listConversations, createConversation } from '@/lib/db/queries'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const sessionId = await getOrCreateSessionId()
    await upsertSession(sessionId)
    const items = await listConversations(sessionId)
    return NextResponse.json({ conversations: items })
  } catch (err) {
    console.error('GET /api/conversations:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}

export async function POST() {
  try {
    const sessionId = await getOrCreateSessionId()
    await upsertSession(sessionId)
    const row = await createConversation(sessionId)
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    console.error('POST /api/conversations:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
