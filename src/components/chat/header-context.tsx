'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { fetchJson, isBenignFetchError } from '@/lib/fetch-json'

type ContextStats = {
  totalTokens: number
  limit: number
  pct: number
  atLimit: boolean
}

export function HeaderContext({ conversationId, refreshKey }: { conversationId: string | null; refreshKey: number }) {
  const [stats, setStats] = useState<ContextStats | null>(null)

  useEffect(() => {
    if (!conversationId) return
    const ac = new AbortController()
    let active = true
    ;(async () => {
      try {
        const data = await fetchJson<{
          totalTokens?: number
          limit?: number
          pct?: number
          atLimit?: boolean
        }>(`/api/conversations/${conversationId}/context`, {
          cache: 'no-store',
          signal: ac.signal,
        })
        if (active) {
          setStats({
            totalTokens: data.totalTokens ?? 0,
            limit: data.limit ?? 22_000,
            pct: data.pct ?? 0,
            atLimit: !!data.atLimit,
          })
        }
      } catch (e) {
        if (!isBenignFetchError(e)) console.error('context fetch failed', e)
      }
    })()
    return () => {
      active = false
      ac.abort()
    }
  }, [conversationId, refreshKey])

  if (!conversationId) return null
  if (!stats) return null

  const state =
    stats.atLimit ? 'full' : stats.pct >= 85 ? 'near' : stats.pct >= 60 ? 'warn' : 'ok'

  return (
    <div
      className="flex items-center gap-2 font-mono text-xs text-muted-foreground"
      aria-label={`Chat context ${stats.totalTokens.toLocaleString()} of ${stats.limit.toLocaleString()} tokens`}
    >
      <span className={cn(state === 'full' && 'text-amber-600 dark:text-amber-400')}>
        chat {stats.totalTokens.toLocaleString()} / {stats.limit.toLocaleString()} tok
      </span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10">
        <div
          className={cn(
            'h-full transition-all',
            state === 'ok' && 'bg-foreground/30',
            state === 'warn' && 'bg-amber-500',
            state === 'near' && 'bg-orange-500',
            state === 'full' && 'bg-amber-600',
          )}
          style={{ width: `${Math.min(100, stats.pct)}%` }}
        />
      </div>
    </div>
  )
}
