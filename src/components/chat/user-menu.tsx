'use client'

import type { AppShellUser } from './app-shell'
import { signOutAction } from '@/lib/auth-actions'

export function UserMenu({ user }: { user: AppShellUser }) {
  const label = user.name?.trim() || user.email?.trim() || 'You'
  const initial = (user.name?.trim()?.[0] ?? user.email?.trim()?.[0] ?? '?').toUpperCase()

  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex items-center gap-2 rounded-full border border-foreground/15 bg-background py-1 pl-1 pr-3">
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.image}
            alt=""
            className="h-6 w-6 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground/10 font-medium">
            {initial}
          </div>
        )}
        <span className="max-w-[140px] truncate" title={label}>
          {label}
        </span>
      </div>
      <form action={signOutAction}>
        <button
          type="submit"
          className="rounded-md border border-foreground/15 bg-background px-2 py-1 text-muted-foreground hover:bg-foreground/5"
        >
          Sign out
        </button>
      </form>
    </div>
  )
}
