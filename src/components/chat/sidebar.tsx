'use client'

import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchJson, isBenignFetchError } from '@/lib/fetch-json'

type Convo = { id: string; title: string | null; updatedAt: string }

const VISIBLE_DEFAULT = 15

export function Sidebar({
  currentId,
  onSelect,
  onNew,
  onDeleted,
  refreshKey,
}: {
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDeleted: (id: string, wasCurrent: boolean) => void
  refreshKey: number
}) {
  const [items, setItems] = useState<Convo[]>([])
  const [expanded, setExpanded] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    let active = true
    ;(async () => {
      try {
        const data = await fetchJson<{ conversations?: Convo[] }>('/api/conversations', {
          cache: 'no-store',
          signal: ac.signal,
        })
        if (active) setItems(data.conversations ?? [])
      } catch (e) {
        if (!isBenignFetchError(e)) console.error('list conversations failed', e)
      }
    })()
    return () => {
      active = false
      ac.abort()
    }
  }, [refreshKey])

  const visible = expanded ? items : items.slice(0, VISIBLE_DEFAULT)
  const hidden = Math.max(0, items.length - VISIBLE_DEFAULT)

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (pendingDeleteId === id) return
    setPendingDeleteId(id)
    try {
      const r = await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`delete failed (${r.status})`)
      setItems((prev) => prev.filter((c) => c.id !== id))
      onDeleted(id, currentId === id)
    } catch (err) {
      console.error('delete conversation failed', err)
    } finally {
      setPendingDeleteId(null)
    }
  }

  return (
    <aside className="hidden h-dvh min-h-0 flex-col overflow-hidden border-r border-border bg-muted/30 md:flex">
      <div className="shrink-0 p-3">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-md border border-foreground/15 bg-background px-3 py-2 text-sm hover:bg-foreground/5"
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {items.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">No conversations yet</div>
        ) : (
          <ul className="space-y-1">
            {visible.map((c) => {
              const isCurrent = currentId === c.id
              const isDeleting = pendingDeleteId === c.id
              return (
                <li key={c.id} className="group relative">
                  <button
                    onClick={() => onSelect(c.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-3 py-2 pr-9 text-left text-sm hover:bg-foreground/5',
                      isCurrent && 'bg-foreground/10 font-medium',
                      isDeleting && 'opacity-50',
                    )}
                    title={c.title ?? 'Untitled'}
                  >
                    <span className="truncate">{c.title ?? 'New chat'}</span>
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, c.id)}
                    disabled={isDeleting}
                    aria-label={`Delete ${c.title ?? 'conversation'}`}
                    className={cn(
                      'absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-foreground/10 hover:text-red-500 focus:opacity-100 group-hover:opacity-100',
                      isCurrent && 'opacity-60',
                      isDeleting && 'opacity-100',
                    )}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {hidden > 0 && !expanded ? (
          <button
            onClick={() => setExpanded(true)}
            className="mt-2 w-full rounded-md px-3 py-2 text-left text-xs text-muted-foreground hover:bg-foreground/5"
          >
            Show {hidden} more
          </button>
        ) : null}
        {expanded && items.length > VISIBLE_DEFAULT ? (
          <button
            onClick={() => setExpanded(false)}
            className="mt-2 w-full rounded-md px-3 py-2 text-left text-xs text-muted-foreground hover:bg-foreground/5"
          >
            Show less
          </button>
        ) : null}
      </nav>
    </aside>
  )
}
