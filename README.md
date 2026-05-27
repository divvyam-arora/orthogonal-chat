# Orthogonal Chat

Anonymous AI chat that lets users discover and call any API in the Orthogonal catalog using natural language.

- **Frontend & backend:** Next.js 16 App Router (Node runtime, Fluid Compute on Vercel)
- **AI:** Anthropic Claude via Vercel AI SDK
- **Tools:** `search_apis`, `get_details`, `run_api` (Orthogonal upstream)
- **Persistence:** Postgres (Neon) + Drizzle ORM, keyed by GitHub user id
- **Auth:** NextAuth v5 (Auth.js) — GitHub OAuth, JWT sessions
- **Cache / rate-limit:** Upstash Redis (optional)

This is the **1-day MVP build**. See `../docs/pre-dev/orthogonal-chat/mvp-1day-plan.md` for the deferred items.

---

## 1. Quick start (local)

```bash
# 1. Install deps
npm install

# 2. Provision a Neon Postgres database
#    https://console.neon.tech → new project → copy the connection string
#    Then fill DATABASE_URL in .env.local

# 3. Create a GitHub OAuth app (used for sign-in)
#    https://github.com/settings/developers → New OAuth App
#    Homepage URL:                http://localhost:3000
#    Authorization callback URL:  http://localhost:3000/api/auth/callback/github
#    Copy Client ID -> AUTH_GITHUB_ID
#    Generate a new client secret -> AUTH_GITHUB_SECRET

# 4. Fill .env.local
#    DATABASE_URL          — Neon connection string
#    AUTH_SECRET           — 32+ random chars (run: openssl rand -base64 32)
#    AUTH_GITHUB_ID        — from step 3
#    AUTH_GITHUB_SECRET    — from step 3
#    ANTHROPIC_API_KEY     — from console.anthropic.com
#    ORTHOGONAL_API_KEY    — from orthogonal.dev (or set ORTHOGONAL_FAKE=true)

# 5. Run database migrations
npm run db:migrate

# 6. Start dev server
npm run dev
# open http://localhost:3000 → sign in with GitHub
```

### Run without Orthogonal credentials

Set `ORTHOGONAL_FAKE=true` in `.env.local`. The fake client returns canned data for CoinGecko, Open-Meteo, LibreTranslate, and REST Countries — enough for a demo.

---

## 2. Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `DATABASE_URL` | yes | Neon Postgres connection string |
| `AUTH_SECRET` | yes | 32+ chars; signs JWT session cookies (`openssl rand -base64 32`) |
| `AUTH_GITHUB_ID` | yes | GitHub OAuth app Client ID |
| `AUTH_GITHUB_SECRET` | yes | GitHub OAuth app Client Secret |
| `AUTH_TRUST_HOST` | yes (Vercel) | Set to `true` when deployed behind a proxy |
| `ANTHROPIC_API_KEY` | yes | Claude API key |
| `ORTHOGONAL_API_KEY` | yes | Orthogonal upstream API key |
| `ORTHOGONAL_API_BASE_URL` | yes | Default `https://api.orthogonal.com` |
| `ORTHOGONAL_FAKE` | no | `true` to use the bundled fake client |
| `UPSTASH_REDIS_REST_URL` | no | Enables rate limiting if both Redis vars are set |
| `UPSTASH_REDIS_REST_TOKEN` | no | — |
| `BUDGET_USD_PER_SESSION` | no | Default `0.50` |
| `DEFAULT_MODEL` | no | Default `claude-sonnet-4-5` |

See `.env.example` for the full template.

---

## 3. Project layout

```
src/
  app/
    layout.tsx, page.tsx, globals.css
    api/
      chat/route.ts                          ← SSE streaming endpoint
      conversations/route.ts                  ← list / create
      conversations/[id]/messages/route.ts    ← history
      usage/route.ts                          ← session cost/token totals
  components/
    chat/                                    ← app shell + chat UI
    ui/                                      ← button, collapsible primitives
  lib/
    ai/orthogonal.ts                         ← upstream client (real + fake)
    ai/tools.ts                              ← search_apis, run_api tool defs
    db/schema.ts, db/index.ts, db/queries.ts
    pricing.ts                               ← model cost table
    redis.ts                                 ← Upstash + ratelimit
    session.ts                               ← iron-session helpers
    env.ts                                   ← zod-validated env
  middleware.ts                              ← issues anonymous cookie
drizzle/
  0000_*.sql                                 ← initial migration
  migrate.ts                                 ← migration runner
```

---

## 4. Deploy to Vercel

```bash
# Either: connect this repo via the Vercel dashboard → import
# Or: from this directory
npx vercel
```

**Required Vercel settings:**

- Plan: **Pro** if you want full multi-tool replies (Hobby's 60s cap can kill long chains). On Hobby, drop `maxDuration` in `src/app/api/chat/route.ts` to `60`.
- Fluid Compute: enabled (default on new projects in 2026).
- Environment variables: all from §2 above. **Don't forget `AUTH_TRUST_HOST=true`** so Auth.js trusts the Vercel proxy.
- Add a **second** GitHub OAuth app (or extend the existing one) with the production callback:
  - Homepage URL: `https://<your-app>.vercel.app`
  - Callback URL: `https://<your-app>.vercel.app/api/auth/callback/github`

**After first deploy, run migrations once against the prod DB:**

```bash
DATABASE_URL=<prod-neon-url> npm run db:migrate
```

**History "empty"?** It's keyed to the signed-in GitHub user id (stable, survives cookie clears and device changes). Sign in with the same GitHub account and your chats come back. If a row's `user_id` doesn't match yours, the app correctly hides it.

---

## 5. Verification (smoke test)

1. Visit `/` in a private window → "Sign in with GitHub" screen.
2. Sign in → empty state with 3 example prompts and your name/avatar in the header.
3. Click *"Find an API for current Bitcoin price"* → tool card for `search_apis` → tool card for `run_api` → assistant streams a price.
4. Header meter shows non-zero `$x.xxx / $0.50`.
5. Reload → conversation in sidebar, click to reload → history restored.
6. Click **+ New chat** → empty thread. Click **Sign out** → back to sign-in screen. Sign in again → previous chats reappear.
7. (If Upstash configured) Spam 21+ messages in 5 min → 429 surfaced in UI.
8. (Override) Set `BUDGET_USD_PER_SESSION=0.001` → composer disables after first reply.

---

## 6. Scope (what's in vs out)

**In v1 (this codebase):**
- Anonymous cookie session
- Sidebar with past conversations + New chat
- Streaming assistant replies via SSE
- Two tools: `search_apis`, `run_api`
- Persistence (sessions, conversations, messages, tool_results)
- Cost meter + hard token/budget cap
- Optional rate limit (when Upstash configured)
- Short TTL cache for `search_apis` / `get_details` (60s default, in-process)
- Per-endpoint circuit breaker (fail fast after repeated 5xx/timeouts)
- Vercel deploy

**Deferred (post-MVP):**
- `get_endpoint_details`, `fetch_full_result` tools
- Conversation summarization cascade (tool digesting + rolling summary + hard floor)
- Request coalescing (single-flight)
- Redis-backed cache + circuit breaker (multi-instance)
- Tool-card polish variants (coalesced badge, retry button, circuit-open card)
- Cost breakdown popover, soft 70% warning banner
- Conversation rename/delete UI, auto-titling via cheap model
- Mobile responsive drawer
- Animations
- Resume-on-reconnect

See `../docs/pre-dev/orthogonal-chat/` for the full PRD, design validation, feature map, and 1-day MVP plan.

---

## 7. Known limitations (demo Q&A)

| Limitation | Workaround |
|-----------|------------|
| No coalescing | Don't fire concurrent identical calls |
| In-process cache/breaker only | Per Vercel instance; Redis for multi-instance prod |
| No summarization | Keep demo conversations short (<20 turns) |
| Tool errors no retry button | User resends prompt |
| Sidebar list is read-only (no delete/rename UI) | Manual DB op if needed |
| No light/dark toggle | System default only |

---

## 8. Scripts

- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run start` — start built server
- `npm run lint` — ESLint
- `npm run db:generate` — generate Drizzle migration SQL from schema
- `npm run db:push` — push schema directly (dev only — bypasses migrations)
- `npm run db:migrate` — apply migrations to `DATABASE_URL`
