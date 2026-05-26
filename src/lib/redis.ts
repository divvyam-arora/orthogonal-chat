import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { env } from './env'

let redisClient: Redis | null = null
let ratelimitClient: Ratelimit | null = null

function maybeRedis(): Redis | null {
  if (redisClient) return redisClient
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null
  redisClient = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  })
  return redisClient
}

export function getRatelimit(): Ratelimit | null {
  if (ratelimitClient) return ratelimitClient
  const r = maybeRedis()
  if (!r) return null
  ratelimitClient = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(20, '5 m'),
    analytics: false,
    prefix: 'orthchat',
  })
  return ratelimitClient
}
