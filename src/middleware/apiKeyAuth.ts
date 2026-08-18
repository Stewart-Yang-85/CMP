import type { FastifyReply, FastifyRequest } from 'fastify'
import { createSupabaseRestClient } from '../supabaseRest.js'
import { verifySecretScrypt } from '../password.js'

type AuthContext = {
  customerId?: string | null
  resellerId?: string | null
  roleScope?: string | null
  role?: string | null
  userId?: string | null
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

export type ApiKeyAuthOptions = {
  headerKey?: string
  headerSecret?: string
}

export function apiKeyAuth(options: ApiKeyAuthOptions = {}) {
  const headerKey = options.headerKey ?? 'x-api-key'
  const headerSecret = options.headerSecret ?? 'x-api-secret'
  return async function apiKeyGuard(req: FastifyRequest, reply: FastifyReply) {
    const apiKey = readHeader(req, headerKey)
    const apiSecret = readHeader(req, headerSecret)
    if (!apiKey || !apiSecret) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'API key required.' })
      return
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true })
    const rows = await supabase.select(
      'customers',
      `select=tenant_id,reseller_tenant_id,api_secret_hash,status&api_key=eq.${encodeURIComponent(apiKey)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    const custStatus = row ? String((row as any).status || '').toUpperCase() : ''
    if (!row || custStatus !== 'ACTIVE') {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid API key.' })
      return
    }
    if (!verifySecretScrypt(String(apiSecret), String((row as any).api_secret_hash))) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid API secret.' })
      return
    }
    const enterpriseTenantId = (row as any).tenant_id != null ? String((row as any).tenant_id) : null
    const resellerTenantId =
      (row as any).reseller_tenant_id != null ? String((row as any).reseller_tenant_id) : null
    setAuthContext(req, {
      userId: null,
      resellerId: resellerTenantId,
      customerId: enterpriseTenantId,
      roleScope: 'customer',
      role: 'customer_m2m',
    })
  }
}
