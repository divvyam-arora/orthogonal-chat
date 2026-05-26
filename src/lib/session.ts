import { getIronSession, type SessionOptions } from 'iron-session'
import { cookies } from 'next/headers'
import { env } from './env'

export type SessionData = {
  sessionId?: string
  createdAt?: number
}

export const sessionOptions: SessionOptions = {
  password: env.SESSION_SECRET,
  cookieName: 'orthchat_session',
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  },
}

export async function getSession() {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, sessionOptions)
}

export async function getOrCreateSessionId() {
  const session = await getSession()
  if (!session.sessionId) {
    session.sessionId = crypto.randomUUID()
    session.createdAt = Date.now()
    await session.save()
  }
  return session.sessionId
}
