'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { Sidebar } from './sidebar'
import { HeaderCost, type Totals } from './header-cost'
import { MessageList } from './message-list'
import { Composer } from './composer'
import { fetchJson, isBenignFetchError, errorMessageFromFetch } from '@/lib/fetch-json'

const EXAMPLES = [
  'Price of Bitcoin',
  'How much funding has Tesla gotten till date?',
  'Tell me the precipitation data in SF today',
]

const ACTIVE_CONVO_KEY = 'orthchat:activeConversationId'

function restoreMessages(
  rows: Array<{ id: string; role: string; parts: unknown }> | undefined,
) {
  return (rows ?? []).map((m) => ({
    id: m.id,
    role: m.role as 'user' | 'assistant' | 'system',
    parts: Array.isArray(m.parts) ? m.parts : [],
  }))
}

export type AppShellUser = {
  name: string | null
  email: string | null
  image: string | null
}

export function AppShell({ user }: { user: AppShellUser }) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [rotationNotice, setRotationNotice] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [conversationLoadError, setConversationLoadError] = useState<string | null>(null)
  const [budgetCapped, setBudgetCapped] = useState(false)
  const conversationIdRef = useRef<string | null>(null)
  const pendingRotationReloadRef = useRef(false)

  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  /* eslint-disable react-hooks/refs */
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        // Server is the source of truth for history — send only the new user message.
        prepareSendMessagesRequest: ({ messages }) => {
          let last = null as (typeof messages)[number] | null
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
              last = messages[i]
              break
            }
          }
          return {
            body: {
              conversationId: conversationIdRef.current,
              message: last,
            },
          }
        },
        fetch: async (input, init) => {
          const r = await fetch(input as RequestInfo, init)
          const cid = r.headers.get('X-Conversation-Id')
          if (r.headers.get('X-Context-Rotated') === '1') {
            pendingRotationReloadRef.current = true
          }
          if (cid && cid !== conversationIdRef.current) {
            conversationIdRef.current = cid
            setConversationId(cid)
            setRefreshKey((k) => k + 1)
            try {
              if (typeof window !== 'undefined') {
                window.localStorage.setItem(ACTIVE_CONVO_KEY, cid)
              }
            } catch {
              // ignore storage errors
            }
          }
          return r
        },
      }),
    [],
  )
  /* eslint-enable react-hooks/refs */

  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    transport,
    onFinish: async () => {
      if (pendingRotationReloadRef.current && conversationIdRef.current) {
        pendingRotationReloadRef.current = false
        const id = conversationIdRef.current
        try {
          const data = await fetchJson<{ messages?: Array<{ id: string; role: string; parts: unknown }> }>(
            `/api/conversations/${id}/messages`,
            { cache: 'no-store' },
          )
          setMessages(restoreMessages(data.messages))
        } catch (e) {
          console.error('reload after context rotation failed', e)
        }
        setRotationNotice(
          'This chat reached its context limit. A new chat was started with a summary of the previous thread.',
        )
      }
      setRefreshKey((k) => k + 1)
    },
  })

  const loadConversationMessages = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const data = await fetchJson<{ messages?: Array<{ id: string; role: string; parts: unknown }> }>(
        `/api/conversations/${id}/messages`,
        { cache: 'no-store', signal },
      )
      setMessages(restoreMessages(data.messages))
    },
    [setMessages],
  )

  const handleSelectConversation = useCallback(
    async (id: string | null) => {
      conversationIdRef.current = id
      setConversationId(id)
      setRotationNotice(null)
      setConversationLoadError(null)
      try {
        if (typeof window !== 'undefined') {
          if (id) window.localStorage.setItem(ACTIVE_CONVO_KEY, id)
          else window.localStorage.removeItem(ACTIVE_CONVO_KEY)
        }
      } catch {
        // ignore storage errors
      }
      if (id) {
        try {
          await loadConversationMessages(id)
        } catch (e) {
          if (!isBenignFetchError(e)) console.error('load conversation failed', e)
          if (!isBenignFetchError(e)) {
            setConversationLoadError(
              errorMessageFromFetch(e) || "Could not load this chat's messages",
            )
          }
        }
      } else {
        setMessages([])
      }
    },
    [setMessages, loadConversationMessages],
  )

  // On mount, restore last-active conversation (or fall back to most recent).
  useEffect(() => {
    const ac = new AbortController()
    let active = true
    ;(async () => {
      try {
        const data = await fetchJson<{ conversations?: Array<{ id: string }> }>('/api/conversations', {
          cache: 'no-store',
          signal: ac.signal,
        })
        if (!active) return
        setBootError(null)
        const list = data.conversations ?? []
        if (list.length === 0 || conversationId) return

        let target: string | null = null
        try {
          if (typeof window !== 'undefined') {
            const saved = window.localStorage.getItem(ACTIVE_CONVO_KEY)
            if (saved && list.some((c) => c.id === saved)) target = saved
          }
        } catch {
          // ignore storage errors
        }
        if (!target) target = list[0].id

        handleSelectConversation(target)
      } catch (e) {
        if (!isBenignFetchError(e)) console.error('initial load failed', e)
        if (active && !isBenignFetchError(e)) {
          setBootError(errorMessageFromFetch(e) || 'Could not load your chats')
        }
      }
    })()
    return () => {
      active = false
      ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleNew = () => {
    handleSelectConversation(null)
  }

  const handleDeleted = useCallback(
    async (deletedId: string, wasCurrent: boolean) => {
      setRefreshKey((k) => k + 1)
      if (!wasCurrent) return
      // The active conversation was just deleted — fall back to the most recent
      // remaining one, or an empty New-chat state.
      try {
        const data = await fetchJson<{ conversations?: Array<{ id: string }> }>('/api/conversations', {
          cache: 'no-store',
        })
        const list = data.conversations ?? []
        const next = list.find((c) => c.id !== deletedId)?.id ?? null
        handleSelectConversation(next)
      } catch (e) {
        if (!isBenignFetchError(e)) console.error('post-delete refresh failed', e)
        handleSelectConversation(null)
      }
    },
    [handleSelectConversation],
  )

  const handleSend = (text: string) => {
    sendMessage({ text })
  }

  const handleExample = (text: string) => {
    handleSend(text)
  }

  const isStreaming = status === 'streaming' || status === 'submitted'

  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden md:grid-cols-[280px_1fr]">
      <Sidebar
        currentId={conversationId}
        onSelect={handleSelectConversation}
        onNew={handleNew}
        onDeleted={handleDeleted}
        refreshKey={refreshKey}
      />
      <main className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <div className="shrink-0">
          <HeaderCost
            refreshKey={refreshKey}
            conversationId={conversationId}
            user={user}
            onTotalsChange={(t: Totals) => setBudgetCapped(t.cap > 0 && t.totalCostUsd >= t.cap)}
          />
        </div>
        {rotationNotice ? (
          <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-950 dark:text-amber-100">
            {rotationNotice}
          </div>
        ) : null}
        {bootError ? (
          <div
            className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-700 dark:text-red-300"
            role="alert"
          >
            {bootError}
          </div>
        ) : null}
        {conversationLoadError ? (
          <div
            className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-700 dark:text-red-300"
            role="alert"
          >
            {conversationLoadError}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          {messages.length === 0 ? (
            <EmptyState onPick={handleExample} />
          ) : (
            <MessageList messages={messages} isStreaming={isStreaming} />
          )}
        </div>
        {error ? (
          <div className="shrink-0">
            <ErrorBanner error={error} />
          </div>
        ) : null}
        <div className="shrink-0">
          <Composer
            onSend={handleSend}
            disabled={budgetCapped}
            isStreaming={isStreaming}
            onStop={stop}
          />
        </div>
      </main>
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6 py-12 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Orthogonal Chat</h1>
      <p className="mt-2 text-muted-foreground">Natural-language access to any API.</p>
      <div className="mt-8 grid w-full gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => onPick(ex)}
            className="rounded-md border border-foreground/15 px-4 py-3 text-left text-sm hover:bg-foreground/5"
          >
            {ex} →
          </button>
        ))}
      </div>
    </div>
  )
}

function formatChatErrorMessage(error: Error): string {
  const raw = error.message?.trim()
  if (!raw) return 'Something went wrong.'
  try {
    const parsed = JSON.parse(raw) as { message?: string }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim()
    }
  } catch {
    // not JSON — show raw (e.g. HTTP errors with text bodies)
  }
  return raw
}

function ErrorBanner({ error }: { error: Error }) {
  return (
    <div className="border-t border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-700 dark:text-red-300">
      {formatChatErrorMessage(error)}
    </div>
  )
}
