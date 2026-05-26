'use client'

import { useEffect, useRef } from 'react'
import type { UIMessage } from 'ai'
import { MessageUser } from './message-user'
import { MessageAssistant } from './message-assistant'

export function MessageList({ messages, isStreaming }: { messages: UIMessage[]; isStreaming: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, isStreaming])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        {messages.map((m) => (m.role === 'user' ? <MessageUser key={m.id} m={m} /> : <MessageAssistant key={m.id} m={m} />))}
        {isStreaming && messages[messages.length - 1]?.role !== 'assistant' ? (
          <div className="text-sm text-muted-foreground animate-pulse-soft">Thinking…</div>
        ) : null}
      </div>
    </div>
  )
}
