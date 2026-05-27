import { z } from 'zod'

/** Optional Upstash vars: invalid URL alone is ignored; both must be set together when using Redis. */
function optionalUpstashUrl() {
  return z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim()
      if (!trimmed) return undefined
      const parsed = z.string().url().safeParse(trimmed)
      if (!parsed.success) {
        console.warn(
          '[env] UPSTASH_REDIS_REST_URL is not a valid URL; Redis rate limiting will be disabled',
        )
        return undefined
      }
      return parsed.data
    })
}

function optionalUpstashToken() {
  return z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim()
      return trimmed || undefined
    })
}

const schema = z
  .object({
    DATABASE_URL: z.string().url(),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be >=32 chars'),
    AUTH_GITHUB_ID: z.string().min(1),
    AUTH_GITHUB_SECRET: z.string().min(1),
    AUTH_TRUST_HOST: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().min(1),
    ORTHOGONAL_API_KEY: z.string().min(1),
    ORTHOGONAL_API_BASE_URL: z.string().url(),
    UPSTASH_REDIS_REST_URL: optionalUpstashUrl(),
    UPSTASH_REDIS_REST_TOKEN: optionalUpstashToken(),
    BUDGET_USD_PER_SESSION: z.coerce.number().positive().default(0.5),
    DEFAULT_MODEL: z.string().default('claude-sonnet-4-5'),
    /** Cheaper model for automatic thread summaries on context rotation. */
    SUMMARY_MODEL: z.string().default('claude-haiku-4-5'),
    /** Max Claude tokens per conversation before auto-summary + new chat (helps stay under TPM). */
    CONTEXT_TOKENS_PER_CONVERSATION: z.coerce.number().int().positive().default(22_000),
    /** TTL for in-process cache of search_apis + get_details (seconds). */
    ORTHOGONAL_CACHE_TTL_SEC: z.coerce.number().int().positive().default(60),
    /** Consecutive upstream failures before circuit opens. */
    ORTHOGONAL_CIRCUIT_FAILURES: z.coerce.number().int().positive().default(3),
    /** How long circuit stays open before one probe call (seconds). */
    ORTHOGONAL_CIRCUIT_OPEN_SEC: z.coerce.number().int().positive().default(60),
    ORTHOGONAL_FAKE: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  })
  .superRefine((data, ctx) => {
    const hasUrl = Boolean(data.UPSTASH_REDIS_REST_URL)
    const hasToken = Boolean(data.UPSTASH_REDIS_REST_TOKEN)
    if (hasUrl !== hasToken) {
      ctx.addIssue({
        code: 'custom',
        message:
          'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set for rate limiting, or leave both unset',
        path: hasUrl ? ['UPSTASH_REDIS_REST_TOKEN'] : ['UPSTASH_REDIS_REST_URL'],
      })
    }
  })

// Convert empty strings to undefined so optional fields validate cleanly
const rawEnv: Record<string, string | undefined> = {}
for (const k of Object.keys(process.env)) {
  const v = process.env[k]
  rawEnv[k] = v === '' ? undefined : v
}
const parsed = schema.safeParse(rawEnv)
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors)
  throw new Error('Invalid environment configuration. See errors above.')
}

export const env = parsed.data
