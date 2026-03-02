import type { FastifyReply, FastifyRequest } from 'fastify'

export type RateLimitOptions = {
  windowMs: number
  max: number
  keyResolver?: (req: FastifyRequest) => string
}

type Bucket = {
  tokens: number
  lastRefill: number
}

const buckets = new Map<string, Bucket>()

function resolveKey(req: FastifyRequest, resolver?: (req: FastifyRequest) => string) {
  if (resolver) return resolver(req)
  const tenantKey = (req as { cmpAuth?: { customerId?: string | null; resellerId?: string | null } }).cmpAuth
  if (tenantKey?.customerId) return `customer:${tenantKey.customerId}`
  if (tenantKey?.resellerId) return `reseller:${tenantKey.resellerId}`
  return req.ip
}

export function createRateLimiter(options: RateLimitOptions) {
  const windowMs = Math.max(1000, Number(options.windowMs) || 60000)
  const max = Math.max(1, Number(options.max) || 60)
  const refillRate = max / windowMs
  return async function rateLimitGuard(req: FastifyRequest, reply: FastifyReply) {
    const key = resolveKey(req, options.keyResolver)
    const routePath = req.routeOptions?.url ?? req.url
    const routeKey = `${req.method}:${routePath}`
    const bucketKey = `${key}:${routeKey}`
    const now = Date.now()
    const bucket = buckets.get(bucketKey) ?? { tokens: max, lastRefill: now }
    const elapsed = Math.max(0, now - bucket.lastRefill)
    const refill = elapsed * refillRate
    bucket.tokens = Math.min(max, bucket.tokens + refill)
    bucket.lastRefill = now
    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillRate / 1000)
      reply.header('Retry-After', String(Math.max(1, retryAfter)))
      reply.status(429).send({ code: 'RATE_LIMITED', message: 'Too many requests.' })
      return
    }
    bucket.tokens -= 1
    buckets.set(bucketKey, bucket)
  }
}
