'use client'

import { useState } from 'react'
import { ChevronRight, ChevronDown, Zap, Database, AlertCircle, Loader2 } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn, fmtLatency, fmtMoney } from '@/lib/utils'

type Meta = { latencyMs?: number; costUsd?: number; cacheHit?: boolean }

function readMeta(output: unknown): Meta {
  if (!output || typeof output !== 'object') return {}
  const o = output as Record<string, unknown>
  const meta = o._meta as Record<string, unknown> | undefined
  if (!meta) return {}
  return {
    latencyMs: typeof meta.latencyMs === 'number' ? meta.latencyMs : undefined,
    costUsd: typeof meta.costUsd === 'number' ? meta.costUsd : undefined,
    cacheHit: typeof meta.cacheHit === 'boolean' ? meta.cacheHit : undefined,
  }
}

function readError(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  if (o.ok === false && o.error && typeof o.error === 'object') {
    const e = o.error as Record<string, unknown>
    const msg = typeof e.message === 'string' ? e.message : 'error'
    const steps = Array.isArray(e.suggestedNextSteps)
      ? (e.suggestedNextSteps as string[]).map((s, i) => `${i + 1}. ${s}`).join('\n')
      : ''
    return steps ? `${msg}\n\nNext steps:\n${steps}` : msg
  }
  return null
}

function shortInputSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  if (toolName === 'search_apis') {
    return typeof o.query === 'string' ? `"${o.query.slice(0, 60)}"` : ''
  }
  if (toolName === 'get_details') {
    const api = typeof o.api === 'string' ? o.api : '?'
    const path = typeof o.path === 'string' ? o.path : ''
    return `${api} · ${path}`
  }
  if (toolName === 'run_api') {
    const api = typeof o.api === 'string' ? o.api : typeof o.api_id === 'string' ? o.api_id : '?'
    const path = typeof o.path === 'string' ? o.path : typeof o.endpoint === 'string' ? o.endpoint : ''
    const bodyCount = o.body && typeof o.body === 'object' ? Object.keys(o.body as Record<string, unknown>).length : 0
    const queryCount =
      o.query && typeof o.query === 'object' ? Object.keys(o.query as Record<string, unknown>).length : 0
    const legacyCount =
      o.params && typeof o.params === 'object' ? Object.keys(o.params as Record<string, unknown>).length : 0
    const count = bodyCount + queryCount + legacyCount
    return `${api} · ${path}${count ? ` (${count} fields)` : ''}`
  }
  return ''
}

export function ToolCard({
  toolName,
  state,
  input,
  output,
  errorText,
}: {
  toolName: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
}) {
  const [open, setOpen] = useState(false)
  const meta = readMeta(output)
  const err = errorText ?? readError(output)
  const running = state === 'input-streaming' || state === 'input-available' || state === 'partial-call' || state === 'call'
  const cached = !!meta.cacheHit
  const cost = meta.costUsd ?? 0

  const borderClass = err
    ? 'border-red-500/40'
    : running
      ? 'border-blue-500/40'
      : cached
        ? 'border-emerald-500/40'
        : 'border-foreground/15'

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn('rounded-lg border bg-background text-sm', borderClass)}>
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-2 px-3 py-2 text-left">
            {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <ToolIcon name={toolName} running={running} err={!!err} />
            <span className="font-medium">{toolName}</span>
            <span className="truncate text-xs text-muted-foreground">{shortInputSummary(toolName, input)}</span>
            <div className="ml-auto flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              {running ? <span className="animate-pulse-soft">running…</span> : null}
              {meta.latencyMs != null ? <span>{fmtLatency(meta.latencyMs)}</span> : null}
              {!running ? <span>{cost === 0 ? '$0.000' : fmtMoney(cost)}</span> : null}
              {cached ? <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">cached</span> : null}
              {err ? <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-700 dark:text-red-300">error</span> : null}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border px-3 py-3 text-xs">
            <Section title="Input">
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-foreground/5 p-2 font-mono">
                {safeStringify(input)}
              </pre>
            </Section>
            {err ? (
              <Section title="Error">
                <div className="rounded border border-red-500/40 bg-red-500/10 p-2 font-mono text-red-700 dark:text-red-300">{err}</div>
              </Section>
            ) : (
              <Section title="Output">
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-foreground/5 p-2 font-mono">
                  {safeStringify(stripMeta(output))}
                </pre>
              </Section>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}

function ToolIcon({ name, running, err }: { name: string; running: boolean; err: boolean }) {
  if (err) return <AlertCircle className="h-4 w-4 text-red-500" />
  if (running) return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
  if (name === 'search_apis') return <Database className="h-4 w-4 text-foreground/60" />
  return <Zap className="h-4 w-4 text-foreground/60" />
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

function stripMeta(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output
  const rest = { ...(output as Record<string, unknown>) }
  delete rest._meta
  return rest
}
