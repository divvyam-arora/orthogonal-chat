'use client'

import ReactMarkdown from 'react-markdown'

export function MessageContinuity({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
      <p className="mb-2 font-medium text-amber-900 dark:text-amber-200">
        Continued from previous chat
      </p>
      <p className="mb-2 text-xs text-muted-foreground">
        The prior thread reached the context limit. Here is a summary so you can keep going without
        losing the thread.
      </p>
      <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1">
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    </div>
  )
}
