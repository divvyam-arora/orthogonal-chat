import { auth } from '@/auth'
import { signInWithGithubAction } from '@/lib/auth-actions'
import { AppShell } from '@/components/chat/app-shell'

export default async function HomePage() {
  const session = await auth()

  if (!session?.user) {
    return <SignInScreen />
  }

  return (
    <AppShell
      user={{
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      }}
    />
  )
}

function SignInScreen() {
  return (
    <div className="flex h-dvh items-center justify-center px-6">
      <div className="mx-auto w-full max-w-sm rounded-lg border border-foreground/15 bg-background p-6 text-center shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Orthogonal Chat</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Natural-language access to any API. Sign in to start a chat — your history sticks across devices.
        </p>
        <form action={signInWithGithubAction} className="mt-6">
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-4 w-4 fill-current"
            >
              <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.7.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.73 18.27.5 12 .5Z" />
            </svg>
            Sign in with GitHub
          </button>
        </form>
      </div>
    </div>
  )
}
