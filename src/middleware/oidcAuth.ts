import crypto from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

type JwkKey = {
  kid?: string
  kty?: string
  alg?: string
  use?: string
  n?: string
  e?: string
}

type JwksResponse = {
  keys?: JwkKey[]
}

type AuthContext = {
  userId?: string | null
  resellerId?: string | null
  customerId?: string | null
  departmentId?: string | null
  roleScope?: string | null
  role?: string | null
  permissions?: string[] | null
}

type OidcOptions = {
  issuer?: string
  audience?: string
  jwksUrl?: string
  required?: boolean
  allowApiKey?: boolean
  cacheTtlMs?: number
  clockSkewSeconds?: number
}

type CacheEntry = {
  expiresAt: number
  keys: Map<string, JwkKey>
}

const jwksCache: CacheEntry = {
  expiresAt: 0,
  keys: new Map(),
}

function setAuthContext(req: FastifyRequest, ctx: AuthContext) {
  const holder = req as { cmpAuth?: AuthContext }
  holder.cmpAuth = { ...(holder.cmpAuth ?? {}), ...ctx }
}

function readHeader(req: FastifyRequest, name: string) {
  const key = name.toLowerCase()
  const value = req.headers[key]
  if (Array.isArray(value)) return value[0]
  return value ? String(value) : null
}

function getBearerToken(req: FastifyRequest) {
  const auth = readHeader(req, 'authorization')
  if (!auth) return null
  const parts = auth.split(' ')
  if (parts.length !== 2) return null
  if (parts[0].toLowerCase() !== 'bearer') return null
  return parts[1]
}

function base64UrlToBuffer(input: string) {
  const s = input.replaceAll('-', '+').replaceAll('_', '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(`${s}${pad}`, 'base64')
}

function decodeJson(part: string) {
  const buf = base64UrlToBuffer(part)
  return JSON.parse(buf.toString('utf8'))
}

async function loadJwks(jwksUrl: string, cacheTtlMs: number) {
  const now = Date.now()
  if (jwksCache.expiresAt > now && jwksCache.keys.size > 0) {
    return jwksCache
  }
  const res = await fetch(jwksUrl)
  if (!res.ok) {
    throw new Error('jwks_fetch_failed')
  }
  const json = (await res.json()) as JwksResponse
  const keys = new Map<string, JwkKey>()
  for (const key of json.keys ?? []) {
    if (key.kid) keys.set(String(key.kid), key)
  }
  jwksCache.keys = keys
  jwksCache.expiresAt = now + cacheTtlMs
  return jwksCache
}

function verifyRs256(token: string, jwk: JwkKey) {
  const [headerPart, payloadPart, sigPart] = token.split('.')
  if (!headerPart || !payloadPart || !sigPart) return false
  if (!jwk.n || !jwk.e) return false
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const data = Buffer.from(`${headerPart}.${payloadPart}`)
  const signature = base64UrlToBuffer(sigPart)
  return crypto.verify('RSA-SHA256', data, key, signature)
}

function normalizePermissions(payload: Record<string, unknown>) {
  if (Array.isArray(payload.permissions)) {
    return payload.permissions.map((p) => String(p))
  }
  const scope = payload.scope
  if (typeof scope === 'string') {
    return scope.split(' ').map((p) => p.trim()).filter((p) => p.length > 0)
  }
  return []
}

export function oidcAuth(options: OidcOptions = {}) {
  const issuer = options.issuer ?? process.env.OIDC_ISSUER ?? ''
  const audience = options.audience ?? process.env.OIDC_AUDIENCE ?? ''
  const jwksUrl = options.jwksUrl ?? process.env.OIDC_JWKS_URL ?? ''
  const required = options.required ?? true
  const allowApiKey = options.allowApiKey ?? true
  const cacheTtlMs = options.cacheTtlMs ?? (Number(process.env.OIDC_JWKS_CACHE_TTL_MS) || 10 * 60 * 1000)
  const clockSkewSeconds = options.clockSkewSeconds ?? (Number(process.env.OIDC_CLOCK_SKEW_SECONDS) || 60)
  return async function oidcGuard(req: FastifyRequest, reply: FastifyReply) {
    if (allowApiKey && readHeader(req, 'x-api-key')) return
    const token = getBearerToken(req)
    if (!token) {
      if (required) {
        reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Bearer token required.' })
      }
      return
    }
    if (!jwksUrl || !issuer || !audience) {
      reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'OIDC is not configured.' })
      return
    }
    const parts = token.split('.')
    if (parts.length !== 3) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid token.' })
      return
    }
    let headerJson: Record<string, unknown>
    let payloadJson: Record<string, unknown>
    try {
      headerJson = decodeJson(parts[0])
      payloadJson = decodeJson(parts[1])
    } catch {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid token.' })
      return
    }
    if (String(payloadJson.iss || '') !== issuer) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid issuer.' })
      return
    }
    const aud = payloadJson.aud
    const audOk = Array.isArray(aud) ? aud.map((a) => String(a)).includes(audience) : String(aud || '') === audience
    if (!audOk) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid audience.' })
      return
    }
    const now = Math.floor(Date.now() / 1000)
    const exp = typeof payloadJson.exp === 'number' ? payloadJson.exp : null
    if (exp !== null && now - clockSkewSeconds >= exp) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Token expired.' })
      return
    }
    const nbf = typeof payloadJson.nbf === 'number' ? payloadJson.nbf : null
    if (nbf !== null && now + clockSkewSeconds < nbf) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Token not active.' })
      return
    }
    const kid = String(headerJson.kid || '')
    const cache = await loadJwks(jwksUrl, cacheTtlMs)
    const jwk = cache.keys.get(kid)
    if (!jwk || !verifyRs256(token, jwk)) {
      jwksCache.expiresAt = 0
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid token signature.' })
      return
    }
    setAuthContext(req, {
      userId: payloadJson.userId ? String(payloadJson.userId) : payloadJson.sub ? String(payloadJson.sub) : null,
      resellerId: payloadJson.resellerId ? String(payloadJson.resellerId) : null,
      customerId: payloadJson.customerId ? String(payloadJson.customerId) : null,
      departmentId: payloadJson.departmentId ? String(payloadJson.departmentId) : null,
      roleScope: payloadJson.roleScope ? String(payloadJson.roleScope) : null,
      role: payloadJson.role ? String(payloadJson.role) : null,
      permissions: normalizePermissions(payloadJson),
    })
  }
}
