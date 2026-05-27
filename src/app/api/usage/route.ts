import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { requireUserId, UnauthenticatedError } from '@/lib/current-user'
import { getUserTotals, setUserBudget } from '@/lib/db/queries'

export const runtime = 'nodejs'

const MIN_BUDGET = 0.01
const MAX_BUDGET = 1000

function effectiveBudget(rowBudget: string | number | null | undefined): number {
  if (rowBudget === null || rowBudget === undefined) return env.BUDGET_USD_PER_SESSION
  const n = typeof rowBudget === 'number' ? rowBudget : Number(rowBudget)
  return Number.isFinite(n) && n > 0 ? n : env.BUDGET_USD_PER_SESSION
}

export async function GET() {
  try {
    const userId = await requireUserId()
    const totals = await getUserTotals(userId)
    return NextResponse.json({
      totalCostUsd: Number(totals?.totalCostUsd ?? 0),
      totalTokens: totals?.totalTokens ?? 0,
      cap: effectiveBudget(totals?.budgetUsd ?? null),
      capIsCustom: totals?.budgetUsd != null,
      defaultCap: env.BUDGET_USD_PER_SESSION,
    })
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }
    console.error('GET /api/usage:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}

type PatchBody = { budgetUsd?: number | null }

export async function PATCH(req: Request) {
  try {
    const userId = await requireUserId()
    const body = (await req.json().catch(() => ({}))) as PatchBody
    const raw = body.budgetUsd

    if (raw === null) {
      await setUserBudget(userId, null)
    } else {
      const n = typeof raw === 'string' ? Number(raw) : raw
      if (typeof n !== 'number' || !Number.isFinite(n) || n < MIN_BUDGET || n > MAX_BUDGET) {
        return NextResponse.json(
          {
            error: 'invalid_budget',
            message: `Budget must be between $${MIN_BUDGET.toFixed(2)} and $${MAX_BUDGET.toFixed(2)}`,
          },
          { status: 400 },
        )
      }
      await setUserBudget(userId, n)
    }

    const totals = await getUserTotals(userId)
    return NextResponse.json({
      totalCostUsd: Number(totals?.totalCostUsd ?? 0),
      totalTokens: totals?.totalTokens ?? 0,
      cap: effectiveBudget(totals?.budgetUsd ?? null),
      capIsCustom: totals?.budgetUsd != null,
      defaultCap: env.BUDGET_USD_PER_SESSION,
    })
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }
    console.error('PATCH /api/usage:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
