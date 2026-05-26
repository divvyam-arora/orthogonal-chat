import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getOrCreateSessionId } from '@/lib/session'
import { upsertSession, getSessionTotals } from '@/lib/db/queries'

export const runtime = 'nodejs'

export async function GET() {
  const sessionId = await getOrCreateSessionId()
  await upsertSession(sessionId)
  const totals = await getSessionTotals(sessionId)
  return NextResponse.json({
    totalCostUsd: Number(totals?.totalCostUsd ?? 0),
    totalTokens: totals?.totalTokens ?? 0,
    cap: env.BUDGET_USD_PER_SESSION,
  })
}
