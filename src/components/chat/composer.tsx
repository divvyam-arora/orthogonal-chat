'use client'

import { useState, useRef, type KeyboardEvent } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import { ArrowUp, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Composer({
  onSend,
  disabled,
  isStreaming,
  onStop,
}: {
  onSend: (text: string) => void
  disabled: boolean
  isStreaming: boolean
  onStop: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!isStreaming) submit()
    } else if (e.key === 'Escape' && isStreaming) {
      onStop()
    }
  }

  return (
    <div className="border-t border-border bg-background p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <TextareaAutosize
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          maxRows={8}
          minRows={1}
          placeholder={disabled ? 'Budget reached — start a new chat' : 'Ask anything…'}
          disabled={disabled}
          className={cn(
            'flex-1 resize-none rounded-md border border-foreground/15 bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-foreground/30 focus:ring-2 focus:ring-ring',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-foreground/15 hover:bg-foreground/5"
            aria-label="Stop"
            title="Stop (Esc)"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={disabled || !text.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-foreground text-background disabled:opacity-30"
            aria-label="Send"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
