import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import { env } from '@/lib/env'

/**
 * NextAuth v5 (Auth.js) — GitHub OAuth + JWT sessions.
 *
 * No database adapter: the session is a sealed JWT cookie. We persist app data
 * (conversations, messages) in Neon keyed by `user.id` (GitHub user id from `token.sub`).
 *
 * Required env (validated in @/lib/env):
 *   AUTH_SECRET           — 32+ chars (run: openssl rand -base64 32)
 *   AUTH_GITHUB_ID        — GitHub OAuth app Client ID
 *   AUTH_GITHUB_SECRET    — GitHub OAuth app Client Secret
 *   AUTH_TRUST_HOST=true  — set on Vercel when behind a proxy
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: env.AUTH_SECRET,
  trustHost: env.AUTH_TRUST_HOST === 'true' || process.env.NODE_ENV !== 'production',
  providers: [
    GitHub({
      clientId: env.AUTH_GITHUB_ID,
      clientSecret: env.AUTH_GITHUB_SECRET,
    }),
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    /**
     * Pin the JWT subject to the provider's stable user id (GitHub's numeric
     * user id) on the initial sign-in. Without this Auth.js v5 mints a fresh
     * UUID per sign-in, so a user's `users.id` would change every time they
     * signed out and back in — orphaning their conversations.
     */
    async jwt({ token, account }) {
      if (account?.providerAccountId) {
        token.sub = String(account.providerAccountId)
      }
      return token
    },
    async session({ session, token }) {
      if (token?.sub && session.user) {
        ;(session.user as { id?: string }).id = token.sub
      }
      return session
    },
  },
})

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      name?: string | null
      email?: string | null
      image?: string | null
    }
  }
}
