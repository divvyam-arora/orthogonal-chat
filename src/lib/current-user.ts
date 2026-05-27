import { auth } from '@/auth'
import { upsertUser } from '@/lib/db/queries'

export class UnauthenticatedError extends Error {
  constructor() {
    super('unauthenticated')
    this.name = 'UnauthenticatedError'
  }
}

/**
 * Returns the signed-in user's stable id (GitHub `sub`), upserting their
 * profile row in `users` on first call. Throws `UnauthenticatedError` when
 * the request has no session — callers should map that to HTTP 401.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth()
  if (!session?.user?.id) {
    throw new UnauthenticatedError()
  }
  const { id, email, name, image } = session.user
  await upsertUser({ id, email, name, image })
  return id
}
