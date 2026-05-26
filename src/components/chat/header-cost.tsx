'use client'

import { useEffect, useState } from 'react'
import { cn, fmtMoney } from '@/lib/utils'
import { fetchJson, isBenignFetchError } from '@/lib/fetch-json'
import { HeaderContext } from './header-context'

type Totals = { totalCostUsd: number; totalTokens: number; cap: number }

export function HeaderCost({
  refreshKey,
  conversationId,
}: {
  refreshKey: number
  conversationId: string | null
}) {
  const [totals, setTotals] = useState<Totals>({ totalCostUsd: 0, totalTokens: 0, cap: 0.5 })

  useEffect(() => {
    const ac = new AbortController()
    let active = true
    ;(async () => {
      try {
        const data = await fetchJson<Totals>('/api/usage', {
          cache: 'no-store',
          signal: ac.signal,
        })
        if (active) setTotals(data)
      } catch (e) {
        if (!isBenignFetchError(e)) console.error('usage fetch failed', e)
      }
    })()
    return () => {
      active = false
      ac.abort()
    }
  }, [refreshKey])

  const pct = Math.min(100, totals.cap > 0 ? (totals.totalCostUsd / totals.cap) * 100 : 0)
  const state = pct >= 100 ? 'capped' : pct >= 85 ? 'near' : pct >= 60 ? 'warn' : 'ok'

  return (
    <header className="flex items-center justify-between border-b border-border bg-background/80 px-4 py-2 text-sm backdrop-blur">
      <div className="font-medium tracking-tight">Orthogonal Chat</div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <HeaderContext conversationId={conversationId} refreshKey={refreshKey} />
        <div
          className="flex flex-wrap items-center gap-3 font-mono text-xs"
          aria-label={`Session cost ${fmtMoney(totals.totalCostUsd)} of ${fmtMoney(totals.cap)}, ${pct.toFixed(0)}% used`}
        >
        <span className={cn(state === 'capped' && 'text-red-500')}>
          {fmtMoney(totals.totalCostUsd)} / {fmtMoney(totals.cap)}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{totals.totalTokens.toLocaleString()} tok</span>
        <div className="h-2 w-24 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn(
              'h-full transition-all',
              state === 'ok' && 'bg-foreground/40',
              state === 'warn' && 'bg-amber-500',
              state === 'near' && 'bg-orange-500',
              state === 'capped' && 'bg-red-500',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        </div>
      </div>
    </header>
  )
}
