'use client'

import type { UIMessage } from 'ai'

export function MessageUser({ m }: { m: UIMessage }) {
  const text = (m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('\n')
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-foreground/5 px-4 py-2 text-sm leading-6 whitespace-pre-wrap">
        {text}
      </div>
    </div>
  )
}
