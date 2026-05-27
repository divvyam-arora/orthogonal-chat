'use client'

import { useEffect, useRef, useState } from 'react'
import { cn, fmtMoney } from '@/lib/utils'
import { fetchJson, isBenignFetchError } from '@/lib/fetch-json'
import { HeaderContext } from './header-context'
import { UserMenu } from './user-menu'
import type { AppShellUser } from './app-shell'

export type Totals = {
  totalCostUsd: number
  totalTokens: number
  cap: number
  capIsCustom: boolean
  defaultCap: number
}

const DEFAULT_TOTALS: Totals = {
  totalCostUsd: 0,
  totalTokens: 0,
  cap: 0.5,
  capIsCustom: false,
  defaultCap: 0.5,
}

export function HeaderCost({
  refreshKey,
  conversationId,
  user,
  onTotalsChange,
}: {
  refreshKey: number
  conversationId: string | null
  user: AppShellUser
  onTotalsChange?: (t: Totals) => void
}) {
  const [totals, setTotals] = useState<Totals>(DEFAULT_TOTALS)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const onTotalsChangeRef = useRef(onTotalsChange)
  useEffect(() => {
    onTotalsChangeRef.current = onTotalsChange
  }, [onTotalsChange])

  useEffect(() => {
    const ac = new AbortController()
    let active = true
    ;(async () => {
      try {
        const data = await fetchJson<Totals>('/api/usage', {
          cache: 'no-store',
          signal: ac.signal,
        })
        if (active) {
          setTotals(data)
          onTotalsChangeRef.current?.(data)
        }
      } catch (e) {
        if (!isBenignFetchError(e)) console.error('usage fetch failed', e)
      }
    })()
    return () => {
      active = false
      ac.abort()
    }
  }, [refreshKey])

  useEffect(() => {
    if (editing) {
      setDraft(totals.cap.toFixed(2))
      setError(null)
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [editing, totals.cap])

  const pct = Math.min(100, totals.cap > 0 ? (totals.totalCostUsd / totals.cap) * 100 : 0)
  const state = pct >= 100 ? 'capped' : pct >= 85 ? 'near' : pct >= 60 ? 'warn' : 'ok'

  const submit = async () => {
    if (busy) return
    const value = Number(draft)
    if (!Number.isFinite(value) || value < 0.01 || value > 1000) {
      setError('Enter $0.01 – $1000')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const next = await fetchJson<Totals>('/api/usage', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetUsd: value }),
      })
      setTotals(next)
      onTotalsChangeRef.current?.(next)
      setEditing(false)
    } catch (e) {
      console.error('budget save failed', e)
      setError(e instanceof Error ? e.message.slice(0, 80) : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const resetToDefault = async () => {
    if (busy) return
    setBusy(true)
    try {
      const next = await fetchJson<Totals>('/api/usage', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetUsd: null }),
      })
      setTotals(next)
      onTotalsChangeRef.current?.(next)
      setEditing(false)
    } catch (e) {
      console.error('budget reset failed', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="flex items-center justify-between border-b border-border bg-background/80 px-4 py-2 text-sm backdrop-blur">
      <div className="font-medium tracking-tight">Orthogonal Chat</div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <HeaderContext conversationId={conversationId} refreshKey={refreshKey} />
        <div
          className="flex flex-nowrap items-center gap-2 font-mono text-xs"
          aria-label={`Session cost ${fmtMoney(totals.totalCostUsd)} of ${fmtMoney(totals.cap)}, ${pct.toFixed(0)}% used`}
        >
          <span className={cn('whitespace-nowrap', state === 'capped' && 'text-red-500')}>
            {fmtMoney(totals.totalCostUsd)} /
          </span>
          {editing ? (
            <span className="flex items-center gap-1">
              <span>$</span>
              <input
                ref={inputRef}
                type="number"
                step="0.5"
                min="0.01"
                max="1000"
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  } else if (e.key === 'Escape') {
                    setEditing(false)
                  }
                }}
                onBlur={() => {
                  // Tiny delay so clicks on save/reset buttons land first.
                  setTimeout(() => setEditing(false), 150)
                }}
                className="w-16 rounded border border-foreground/30 bg-background px-1 py-0.5 text-right font-mono text-xs outline-none focus:border-foreground/60"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={submit}
                disabled={busy}
                className="rounded border border-foreground/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-foreground/5 disabled:opacity-40"
              >
                Save
              </button>
              {totals.capIsCustom ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={resetToDefault}
                  disabled={busy}
                  className="rounded border border-foreground/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-foreground/5 disabled:opacity-40"
                  title={`Reset to default ($${totals.defaultCap.toFixed(2)})`}
                >
                  Reset
                </button>
              ) : null}
              {error ? <span className="text-[10px] text-red-500">{error}</span> : null}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={cn(
                'whitespace-nowrap rounded px-1 hover:bg-foreground/10',
                state === 'capped' && 'text-red-500',
                totals.capIsCustom && 'underline decoration-dotted underline-offset-2',
              )}
              title="Click to edit your budget"
            >
              {fmtMoney(totals.cap)}
            </button>
          )}
          <span className="text-muted-foreground">·</span>
          <span className="whitespace-nowrap text-muted-foreground">
            {totals.totalTokens.toLocaleString()} tok
          </span>
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
        <UserMenu user={user} />
      </div>
    </header>
  )
}
