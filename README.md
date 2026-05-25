# Orthogonal Chat

Anonymous AI chat that lets users discover and call any API in the Orthogonal catalog using natural language.

- **Frontend & backend:** Next.js 16 App Router (Node runtime, Fluid Compute on Vercel)
- **AI:** Anthropic Claude via Vercel AI SDK
- **Tools:** `search_apis`, `run_api` (Orthogonal upstream)
- **Persistence:** Postgres (Neon) + Drizzle ORM
- **Cache / rate-limit:** Upstash Redis (optional)
- **Sessions:** Anonymous, sealed cookie (iron-session)

This is the **1-day MVP build**. See `../docs/pre-dev/orthogonal-chat/mvp-1day-plan.md` for the deferred items.

---

## 1. Quick start (local)

```bash
# 1. Install deps (already done if you ran create-next-app)
npm install

# 2. Provision a Neon Postgres database
#    https://console.neon.tech → new project → copy the connection string
#    Then fill DATABASE_URL in .env.local

# 3. Set required env vars in .env.local
#    SESSION_SECRET   — 32+ random chars (run: openssl rand -base64 32)
#    ANTHROPIC_API_KEY — from console.anthropic.com
#    ORTHOGONAL_API_KEY — from orthogonal.dev (or leave + set ORTHOGONAL_FAKE=true)
#    UPSTASH_REDIS_REST_URL / TOKEN — optional, rate-limiting only

# 4. Run database migrations
npm run db:migrate

# 5. Start dev server
npm run dev
# open http://localhost:3000
```

### Run without Orthogonal credentials

Set `ORTHOGONAL_FAKE=true` in `.env.local`. The fake client returns canned data for CoinGecko, Open-Meteo, LibreTranslate, and REST Countries — enough for a demo.

---

## 2. Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `DATABASE_URL` | yes | Neon Postgres connection string |
| `SESSION_SECRET` | yes | 32+ chars; used to seal session cookies |
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
# Follow prompts; add env vars in the dashboard before promoting to production
```

**Required Vercel settings:**

- Plan: **Pro** (Hobby's 60-second function timeout is insufficient for AI tool chains)
- Fluid Compute: enabled (default on new projects in 2026)
- Environment variables: all from §2 above

**After first deploy, run migrations once against the prod DB:**

```bash
DATABASE_URL=<prod-neon-url> npm run db:migrate
```

---

## 5. Verification (smoke test)

1. Visit `/` in a private window → cookie set silently, empty state with 3 example prompts.
2. Click *"Find an API for current Bitcoin price"* → tool card appears for `search_apis` → tool card appears for `run_api` → assistant streams a price.
3. Header meter shows non-zero `$x.xxx / $0.50`.
4. Reload → conversation in sidebar, click to reload → history restored.
5. Click **+ New chat** → empty thread.
6. (If Upstash configured) Spam 21+ messages in 5 min → 429 surfaced in UI.
7. (Override) Set `BUDGET_USD_PER_SESSION=0.001` → composer disables after first reply.

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
- Vercel deploy

**Deferred (post-MVP):**
- `get_endpoint_details`, `fetch_full_result` tools
- Conversation summarization cascade (tool digesting + rolling summary + hard floor)
- Request coalescing (single-flight)
- Circuit breaker per `api_id`
- Cache TTL matrix
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
| No circuit breaker | Upstream errors surface in tool cards; user retries |
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
