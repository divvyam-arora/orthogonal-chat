'use client'

import type { UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import { ToolCard } from './tool-card'

export function MessageAssistant({ m }: { m: UIMessage }) {
  const parts = m.parts ?? []
  return (
    <div className="flex flex-col gap-3">
      {parts.map((p, i) => {
        const type = p.type as string
        if (type === 'text') {
          const text = (p as { text?: string }).text ?? ''
          if (!text) return null
          return (
            <div
              key={i}
              className="prose prose-sm max-w-none text-sm leading-6 dark:prose-invert prose-p:my-1 prose-pre:my-2"
            >
              <ReactMarkdown>{text}</ReactMarkdown>
            </div>
          )
        }
        // AI SDK v6 emits parts like `tool-search_apis` and `tool-run_api` carrying state
        if (type.startsWith('tool-')) {
          const tp = p as unknown as {
            type: string
            toolCallId?: string
            state?: string
            input?: unknown
            output?: unknown
            errorText?: string
          }
          const toolName = tp.type.slice('tool-'.length)
          const partKey = [m.id, i, tp.type, tp.toolCallId ?? 'no-tool-call-id', tp.state ?? 'no-state'].join(':')
          return <ToolCard key={partKey} toolName={toolName} state={tp.state} input={tp.input} output={tp.output} errorText={tp.errorText} />
        }
        if (type === 'reasoning') {
          return null
        }
        return null
      })}
    </div>
  )
}
