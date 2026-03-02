import crypto from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { createSupabaseRestClient } from './supabaseRest.js'
import { apiKeyAuth } from './middleware/apiKeyAuth.js'
import { registerAuditLogHook } from './middleware/auditLog.js'
import { oidcAuth } from './middleware/oidcAuth.js'
import { tenantScope } from './middleware/tenantScope.js'
import { signJwtHs256, verifyJwtHs256 } from './jwt.js'
import { hashSecretScrypt, verifySecretScrypt } from './password.js'
import { parsePagination } from './utils/pagination.js'
import { registerSimPhase4Routes } from './routes/simPhase4.js'
import { registerPricePlanRoutes } from './routes/pricePlans.js'
import { registerPackageRoutes } from './routes/packages.js'
import { registerNetworkProfileRoutes } from './routes/networkProfiles.js'
import { registerSubscriptionRoutes } from './routes/subscriptions.js'
import { registerReconciliationRoutes } from './routes/reconciliation.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { registerEventRoutes } from './routes/events.js'
import { registerVendorMappingRoutes } from './routes/vendorMappings.js'
import { createSupplierAdapter } from './vendors/registry.js'
import { createWxzhonggengAdapter } from './vendors/wxzhonggeng.js'

type AuthContext = {
  userId?: string | null
  resellerId?: string | null
  customerId?: string | null
  departmentId?: string | null
  roleScope?: string | null
  role?: string | null
}

type TenantScope = {
  customerId?: string | null
  departmentId?: string | null
}

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string> }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  delete: (table: string, matchQueryString: string) => Promise<unknown>
}

function getAuthContext(req: FastifyRequest): AuthContext {
  const raw = (req as { cmpAuth?: AuthContext }).cmpAuth
  return raw ?? {}
}

function getRoleScope(req: FastifyRequest) {
  const v = getAuthContext(req).roleScope
  return v ? String(v) : null
}

function getEnterpriseIdFromReq(req: FastifyRequest) {
  const tenantScope = (req as { tenantScope?: TenantScope }).tenantScope
  const auth = getAuthContext(req) as AuthContext & { enterpriseId?: string | null }
  const v = tenantScope?.customerId ?? auth.enterpriseId ?? auth.customerId
  return v ? String(v) : null
}

function getDepartmentIdFromReq(req: FastifyRequest) {
  const tenantScope = (req as { tenantScope?: TenantScope }).tenantScope
  const auth = getAuthContext(req)
  const v = tenantScope?.departmentId ?? auth.departmentId
  return v ? String(v) : null
}

function buildSimTenantFilter(req: FastifyRequest, enterpriseId: string | null) {
  const parts: string[] = []
  if (enterpriseId) parts.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  if (getRoleScope(req) === 'department') {
    const departmentId = getDepartmentIdFromReq(req)
    if (departmentId) parts.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
  }
  return parts.length ? `&${parts.join('&')}` : ''
}

function normalizeIccid(value: unknown) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isValidIccid(value: unknown) {
  const s = normalizeIccid(value)
  return /^\d{18,20}$/.test(s)
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function getEnvTrim(name: string) {
  const v = process.env[name]
  if (v === undefined || v === null) return ''
  return String(v).trim()
}

function getEnvNumber(name: string, defaultValue: number) {
  const v = getEnvTrim(name)
  const n = Number(v)
  return Number.isFinite(n) ? n : defaultValue
}

function buildBaseUrl(req: FastifyRequest) {
  const rawHost = req.headers['x-forwarded-host'] ?? req.headers['host']
  const host = Array.isArray(rawHost) ? rawHost[0] : rawHost ? String(rawHost) : ''
  const rawProto = req.headers['x-forwarded-proto']
  const headerProto = rawProto ? String(Array.isArray(rawProto) ? rawProto[0] : rawProto).split(',')[0].trim() : req.protocol
  const publicIp = getEnvTrim('PUBLIC_IP')
  const port = getEnvTrim('PORT') || '3000'
  const proto = getEnvTrim('PUBLIC_PROTO') || headerProto
  const isLocalHost = host && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))
  if (publicIp && host && host.endsWith(`:${port}`) && !isLocalHost) {
    return `${proto}://${publicIp}:${port}`
  }
  const fallbackHost = host || `localhost:${port}`
  return `${headerProto}://${fallbackHost}`
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0
  const idx = Math.floor(p * (sorted.length - 1))
  return sorted[idx]
}

function buildHistogram(values: number[], buckets: number[]) {
  const counts = new Array(buckets.length).fill(0)
  let sum = 0
  for (const v of values) {
    sum += v
    for (let i = 0; i < buckets.length; i++) {
      if (v <= buckets[i]) {
        counts[i] += 1
      }
    }
  }
  return { counts, sum, count: values.length }
}

function getAdminApiKeyFromReq(req: FastifyRequest) {
  const raw = req.headers['x-api-key']
  if (Array.isArray(raw)) return raw[0] ? String(raw[0]) : null
  return raw ? String(raw) : null
}

function requireAdminApiKey(req: FastifyRequest, res: FastifyReply) {
  const expected = getEnvTrim('ADMIN_API_KEY')
  if (!expected) {
    sendError(res, 500, 'INTERNAL_ERROR', 'ADMIN_API_KEY is not configured.')
    return false
  }
  const actual = getAdminApiKeyFromReq(req)
  if (!actual || actual !== expected) {
    sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
    return false
  }
  return true
}

function getWxWebhookKey() {
  const v = getEnvTrim('WXZHONGGENG_WEBHOOK_KEY')
  return v ? v : null
}

function requireWxWebhookKey(req: FastifyRequest, res: FastifyReply) {
  const expected = getWxWebhookKey()
  if (!expected) {
    sendError(res, 500, 'INTERNAL_ERROR', 'WXZHONGGENG_WEBHOOK_KEY is not configured.')
    return false
  }
  const actual = getAdminApiKeyFromReq(req)
  if (!actual || actual !== expected) {
    sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
    return false
  }
  return true
}

function getCmpWebhookKey() {
  const v = getEnvTrim('CMP_WEBHOOK_KEY')
  return v ? v : null
}

function requireCmpWebhookKey(req: FastifyRequest, res: FastifyReply) {
  const expected = getCmpWebhookKey()
  if (!expected) {
    sendError(res, 500, 'INTERNAL_ERROR', 'CMP_WEBHOOK_KEY is not configured.')
    return false
  }
  const actual = getAdminApiKeyFromReq(req)
  if (!actual || actual !== expected) {
    sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
    return false
  }
  return true
}

const WX_WEBHOOK_MAX_AGE_MINUTES = getEnvNumber('WX_WEBHOOK_MAX_AGE_MINUTES', 60)
const WEBHOOK_MAX_FUTURE_SECONDS = getEnvNumber('WEBHOOK_MAX_FUTURE_SECONDS', 300)

function validateWebhookTimestamp(res: FastifyReply, occurredAt: string | null, maxAgeMinutes: number) {
  if (!occurredAt) {
    sendError(res, 400, 'BAD_REQUEST', 'eventTime is invalid.')
    return false
  }
  const ts = new Date(occurredAt).getTime()
  if (!Number.isFinite(ts)) {
    sendError(res, 400, 'BAD_REQUEST', 'eventTime is invalid.')
    return false
  }
  const now = Date.now()
  const maxAgeMs = Math.max(1, maxAgeMinutes) * 60 * 1000
  const maxFutureMs = Math.max(0, WEBHOOK_MAX_FUTURE_SECONDS) * 1000
  if (now - ts > maxAgeMs) {
    sendError(res, 409, 'WEBHOOK_REPLAY', 'eventTime is too old.')
    return false
  }
  if (ts - now > maxFutureMs) {
    sendError(res, 409, 'WEBHOOK_REPLAY', 'eventTime is too far in future.')
    return false
  }
  return true
}

async function isDuplicateEventByPayloadField({
  supabase,
  eventType,
  field,
  value,
}: {
  supabase: any
  eventType: string
  field: string
  value: string
}) {
  if (!supabase || !eventType || !field || !value) return false
  const rows = await supabase.select(
    'events',
    `select=event_id&event_type=eq.${encodeURIComponent(eventType)}&payload->>${field}=eq.${encodeURIComponent(value)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return Boolean(row?.event_id)
}

function randomClientSecret() {
  return crypto.randomBytes(24).toString('base64url')
}

function escapeCsv(value: unknown) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`
  }
  return s
}

const shareStore = new Map<
  string,
  {
    kind: string
    params: unknown
    tenantId: string | null
    visibility?: string | null
    expiresAt?: string | null
    createdAt?: string | null
    requestId?: string | null
  }
>()

function genShareCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function isSupabaseConfiguredForWrite() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function isAuthConfigured() {
  return Boolean(getEnvTrim('AUTH_TOKEN_SECRET') && getEnvTrim('AUTH_CLIENT_ID') && getEnvTrim('AUTH_CLIENT_SECRET'))
}

function isDbAuthConfigured() {
  return Boolean(getEnvTrim('AUTH_TOKEN_SECRET') && process.env.SUPABASE_SERVICE_ROLE_KEY && getEnvTrim('AUTH_USE_DB_CLIENTS') === '1')
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  reply.status(status).send({ code, message })
}

function getTraceId(reply: FastifyReply) {
  const value = (reply as { traceId?: string }).traceId
  if (value) return value
  const headerValue = reply.getHeader('X-Request-Id')
  return headerValue ? String(headerValue) : null
}

function readRequestBody(req: FastifyRequest, maxBytes: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.raw.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.raw.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    req.raw.on('error', reject)
  })
}

function parseMultipartFormData(buffer: Buffer, boundary: string) {
  const text = buffer.toString('utf8')
  const boundaryText = `--${boundary}`
  const parts = text.split(boundaryText)
  const fields: Record<string, unknown> = {}
  const files: Record<string, { filename: string; content: string }> = {}
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed || trimmed === '--') continue
    const idx = part.indexOf('\r\n\r\n')
    if (idx < 0) continue
    const headerRaw = part.slice(0, idx)
    let body = part.slice(idx + 4)
    if (body.endsWith('\r\n')) body = body.slice(0, -2)
    const headers = headerRaw.split('\r\n')
    const cdLine = headers.find((h) => h.toLowerCase().startsWith('content-disposition'))
    if (!cdLine) continue
    const nameMatch = cdLine.match(/name="([^"]+)"/i)
    if (!nameMatch) continue
    const name = nameMatch[1]
    const fileMatch = cdLine.match(/filename="([^"]*)"/i)
    if (fileMatch) {
      files[name] = { filename: fileMatch[1], content: body }
    } else {
      fields[name] = body
    }
  }
  return { fields, files }
}

function toIsoDateTime(value: unknown) {
  if (!value) return null
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function getTestExpiryCondition() {
  const v = getEnvTrim('TEST_EXPIRY_CONDITION')
  const s = v ? v.toUpperCase() : 'PERIOD_OR_QUOTA'
  if (s !== 'PERIOD_ONLY' && s !== 'QUOTA_ONLY' && s !== 'PERIOD_OR_QUOTA') return 'PERIOD_OR_QUOTA'
  return s
}

function getTestPeriodDays() {
  const n = getEnvNumber('TEST_PERIOD_DAYS', 14)
  return Math.max(1, n)
}

function getTestQuotaKb() {
  const n = getEnvNumber('TEST_QUOTA_KB', 102400)
  return Math.max(0, n)
}

function startOfDayUtc(date: Date) {
  const d = new Date(date)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

function addDaysUtc(date: Date, days: number) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function requireIccid(res: FastifyReply, value: unknown, label = 'iccid') {
  const iccid = normalizeIccid(value)
  if (!iccid || !isValidIccid(iccid)) {
    sendError(res, 400, 'BAD_REQUEST', `${label} is required and must be 18-20 digits.`)
    return null
  }
  return iccid
}

function ensureResellerRole(req: FastifyRequest, reply: FastifyReply, roles: Set<string>) {
  const auth = getAuthContext(req)
  if (!auth.roleScope && !auth.role) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
    return null
  }
  if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' as const }
  if (auth.roleScope === 'reseller' && auth.role && roles.has(auth.role)) return { ...auth, scope: 'reseller' as const }
  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

function ensureResellerAdmin(req: FastifyRequest, reply: FastifyReply) {
  return ensureResellerRole(req, reply, new Set(['reseller_admin']))
}

function ensureResellerSales(req: FastifyRequest, reply: FastifyReply) {
  return ensureResellerRole(req, reply, new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director']))
}

function ensurePlatformAdmin(req: FastifyRequest, reply: FastifyReply) {
  const auth = getAuthContext(req)
  if (!auth.roleScope && !auth.role) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
    return null
  }
  if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' as const }
  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

function registerAuthRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps

  const readString = (value: unknown) => {
    if (value === null || value === undefined) return null
    return String(value)
  }
  const getTokenTtlSeconds = () => {
    const ttlConfig = getEnvNumber('AUTH_TOKEN_TTL_SECONDS', 3600)
    return Math.min(86400, Math.max(60, ttlConfig))
  }
  const resolveEnterpriseIdFromEnv = async (reply: FastifyReply) => {
    let enterpriseId = getEnvTrim('AUTH_ENTERPRISE_ID')
    if (enterpriseId && !isValidUuid(enterpriseId) && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
        const rows = await supabase.select('packages', 'select=enterprise_id&limit=1')
        const row = Array.isArray(rows) ? rows[0] : null
        if (row && (row as any).enterprise_id && isValidUuid((row as any).enterprise_id)) {
          enterpriseId = String((row as any).enterprise_id)
        }
      } catch {}
      if (!isValidUuid(enterpriseId)) {
        enterpriseId = '00000000-0000-0000-0000-000000000000'
      }
    }
    return enterpriseId || null
  }

  const handleAuthToken = async (req: any, res: any) => {
    const { clientId, clientSecret } = req.body ?? {}
    if (!clientId || !clientSecret) {
      return sendError(res, 400, 'BAD_REQUEST', 'clientId and clientSecret are required.')
    }

    if (!isAuthConfigured() && !isDbAuthConfigured()) {
      const token = Buffer.from(`${clientId}:${clientSecret}:${Date.now()}`).toString('base64url')
      return res.json({
        accessToken: token,
        expiresIn: 3600,
        tokenType: 'Bearer',
      })
    }

    if (isAuthConfigured()) {
      const expectedClientId = getEnvTrim('AUTH_CLIENT_ID')
      const expectedClientSecret = getEnvTrim('AUTH_CLIENT_SECRET')
      if (clientId !== expectedClientId || clientSecret !== expectedClientSecret) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid client credentials.')
      }

      const ttlSeconds = getTokenTtlSeconds()
      const now = Math.floor(Date.now() / 1000)
      const enterpriseId = await resolveEnterpriseIdFromEnv(res)
      const payload = {
        iss: 'iot-cmp-api',
        sub: String(clientId),
        iat: now,
        exp: now + ttlSeconds,
        ...(enterpriseId ? { enterpriseId } : {}),
      }

      const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
      return res.json({
        accessToken: token,
        expiresIn: ttlSeconds,
        tokenType: 'Bearer',
      })
    }

    if (isDbAuthConfigured()) {
      try {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const rows = await supabase.select(
          'api_clients',
          `select=client_id,secret_hash,enterprise_id,status&client_id=eq.${encodeURIComponent(String(clientId))}&limit=1`
        )
        const row = Array.isArray(rows) ? rows[0] : null
        if (!row || (row as any).status !== 'ACTIVE') {
          return sendError(res, 401, 'UNAUTHORIZED', 'Invalid client credentials.')
        }
        const ok = verifySecretScrypt(String(clientSecret), String((row as any).secret_hash))
        if (!ok) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Invalid client credentials.')
        }

        const ttlSeconds = getTokenTtlSeconds()
        const now = Math.floor(Date.now() / 1000)
        const payload = {
          iss: 'iot-cmp-api',
          sub: String(clientId),
          iat: now,
          exp: now + ttlSeconds,
          enterpriseId: String((row as any).enterprise_id),
        }
        const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
        return res.json({
          accessToken: token,
          expiresIn: ttlSeconds,
          tokenType: 'Bearer',
        })
      } catch {
        const expectedClientId = getEnvTrim('AUTH_CLIENT_ID')
        const expectedClientSecret = getEnvTrim('AUTH_CLIENT_SECRET')
        if (isAuthConfigured() && clientId === expectedClientId && clientSecret === expectedClientSecret) {
          const ttlConfig = getEnvNumber('AUTH_TOKEN_TTL_SECONDS', 3600)
          const ttlSeconds = Math.min(86400, Math.max(60, ttlConfig))
          const now = Math.floor(Date.now() / 1000)
          const enterpriseId = getEnvTrim('AUTH_ENTERPRISE_ID')
          const payload = {
            iss: 'iot-cmp-api',
            sub: String(clientId),
            iat: now,
            exp: now + ttlSeconds,
            ...(enterpriseId ? { enterpriseId } : {}),
          }
          const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
          return res.json({
            accessToken: token,
            expiresIn: ttlSeconds,
            tokenType: 'Bearer',
          })
        }
        return sendError(res, 502, 'UPSTREAM_ERROR', 'Auth upstream error.')
      }
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Auth is misconfigured.')
  }

  const handleAuthLogin = async (req: any, res: any) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!email || !password) {
      return sendError(res, 400, 'BAD_REQUEST', 'email and password are required.')
    }
    const ttlSeconds = getTokenTtlSeconds()
    const now = Math.floor(Date.now() / 1000)

    if (!isAuthConfigured() && !isDbAuthConfigured()) {
      const token = Buffer.from(`${email}:${password}:${Date.now()}`).toString('base64url')
      return res.json({
        accessToken: token,
        expiresIn: ttlSeconds,
        tokenType: 'Bearer',
        user: {
          userId: email,
          email,
          role: 'customer_m2m',
          roleScope: 'customer',
          resellerId: null,
          customerId: null,
        },
      })
    }

    if (isAuthConfigured()) {
      const expectedClientId = getEnvTrim('AUTH_CLIENT_ID')
      const expectedClientSecret = getEnvTrim('AUTH_CLIENT_SECRET')
      if (email !== expectedClientId || password !== expectedClientSecret) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials.')
      }
      const enterpriseId = await resolveEnterpriseIdFromEnv(res)
      const roleScope = enterpriseId ? 'customer' : 'platform'
      const role = enterpriseId ? 'customer_m2m' : 'platform_admin'
      const payload = {
        iss: 'iot-cmp-api',
        sub: String(email),
        iat: now,
        exp: now + ttlSeconds,
        email,
        roleScope,
        role,
        ...(enterpriseId ? { enterpriseId, customerId: enterpriseId } : {}),
      }
      const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
      return res.json({
        accessToken: token,
        expiresIn: ttlSeconds,
        tokenType: 'Bearer',
        user: {
          userId: email,
          email,
          role,
          roleScope,
          resellerId: null,
          customerId: enterpriseId,
        },
      })
    }

    if (isDbAuthConfigured()) {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const rows = await supabase.select(
        'api_clients',
        `select=client_id,secret_hash,enterprise_id,status&client_id=eq.${encodeURIComponent(String(email))}&limit=1`
      )
      const row = Array.isArray(rows) ? rows[0] : null
      if (!row || (row as any).status !== 'ACTIVE') {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials.')
      }
      const ok = verifySecretScrypt(String(password), String((row as any).secret_hash))
      if (!ok) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials.')
      }
      const enterpriseId = readString((row as any).enterprise_id)
      const payload = {
        iss: 'iot-cmp-api',
        sub: String(email),
        iat: now,
        exp: now + ttlSeconds,
        email,
        roleScope: 'customer',
        role: 'customer_m2m',
        ...(enterpriseId ? { enterpriseId, customerId: enterpriseId } : {}),
      }
      const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
      return res.json({
        accessToken: token,
        expiresIn: ttlSeconds,
        tokenType: 'Bearer',
        user: {
          userId: email,
          email,
          role: 'customer_m2m',
          roleScope: 'customer',
          resellerId: null,
          customerId: enterpriseId,
        },
      })
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Auth is misconfigured.')
  }

  const handleAuthRefresh = async (req: any, res: any) => {
    const tokenFromBody = req.body?.refreshToken ? String(req.body.refreshToken) : null
    const authHeader = req.headers?.authorization ? String(req.headers.authorization) : ''
    const headerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null
    const refreshToken = tokenFromBody || headerToken
    if (!refreshToken) {
      return sendError(res, 400, 'BAD_REQUEST', 'refreshToken is required.')
    }
    const secret = getEnvTrim('AUTH_TOKEN_SECRET')
    if (!secret) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Auth is misconfigured.')
    }
    const verified = verifyJwtHs256(refreshToken, secret)
    if (!verified.ok || !verified.payload) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid refresh token.')
    }
    const payload = verified.payload
    const ttlSeconds = getTokenTtlSeconds()
    const now = Math.floor(Date.now() / 1000)
    const nextPayload = { ...payload, iat: now, exp: now + ttlSeconds }
    const accessToken = signJwtHs256(nextPayload, secret)
    const userId = readString((payload as any).userId) ?? readString((payload as any).sub)
    const email = readString((payload as any).email) ?? readString((payload as any).sub)
    const roleScope =
      readString((payload as any).roleScope) ?? (payload && (payload as any).enterpriseId ? 'customer' : 'platform')
    const role = readString((payload as any).role) ?? ((payload as any).enterpriseId ? 'customer_m2m' : 'platform_admin')
    const resellerId = readString((payload as any).resellerId)
    const customerId = readString((payload as any).customerId) ?? readString((payload as any).enterpriseId)
    res.json({
      accessToken,
      expiresIn: ttlSeconds,
      tokenType: 'Bearer',
      user: {
        userId: userId ?? '',
        email: email ?? '',
        role,
        roleScope,
        resellerId,
        customerId,
      },
    })
  }

  app.post('/auth/token', handleAuthToken)
  app.post(`${prefix}/auth/token`, handleAuthToken)
  app.post('/auth/login', handleAuthLogin)
  app.post(`${prefix}/auth/login`, handleAuthLogin)
  app.post('/auth/refresh', handleAuthRefresh)
  app.post(`${prefix}/auth/refresh`, handleAuthRefresh)
}

function registerAdminApiClientRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps

  app.get(`${prefix}/admin/api-clients`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId) : null
    const status = req.query?.status ? String(req.query.status) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const limitParam = req.query?.limit ?? req.query?.pageSize
    const { page, pageSize, offset } = parsePagination(
      { page: req.query?.page, pageSize: limitParam },
      { defaultPage: 1, defaultPageSize: 50, maxPageSize: 1000 }
    )

    const filters = []
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const orderField = (() => {
      const s = sortBy ? sortBy.toLowerCase() : ''
      if (s === 'createdat' || s === 'created_at') return 'created_at'
      if (s === 'rotatedat' || s === 'rotated_at') return 'rotated_at'
      return 'created_at'
    })()
    const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
    const orderQs = `&order=${orderField}.${orderDir}.nullslast,created_at.desc`

    const { data, total } = await supabase.selectWithCount(
      'api_clients',
      `select=client_id,enterprise_id,status,created_at,rotated_at${orderQs}&limit=${encodeURIComponent(
        String(pageSize)
      )}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const filterPairs: string[] = []
    if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
    if (status) filterPairs.push(`status=${status}`)
    if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
    if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
    filterPairs.push(`limit=${pageSize}`)
    filterPairs.push(`page=${page}`)
    res.header('X-Filters', filterPairs.join(';'))
    res.json({
      items: rows.map((r: any) => ({
        clientId: r.client_id,
        enterpriseId: r.enterprise_id,
        status: r.status,
        createdAt: r.created_at,
        rotatedAt: r.rotated_at,
      })),
      total: typeof total === 'number' ? total : rows.length,
    })
  })

  app.get(`${prefix}/admin/api-clients:csv`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId) : null
    const status = req.query?.status ? String(req.query.status) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const limitParam = req.query?.limit ?? req.query?.pageSize
    const { page, pageSize, offset } = parsePagination(
      { page: req.query?.page, pageSize: limitParam },
      { defaultPage: 1, defaultPageSize: 1000, maxPageSize: 1000 }
    )

    const filters = []
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const orderField = (() => {
      const s = sortBy ? sortBy.toLowerCase() : ''
      if (s === 'createdat' || s === 'created_at') return 'created_at'
      if (s === 'rotatedat' || s === 'rotated_at') return 'rotated_at'
      return 'created_at'
    })()
    const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
    const orderQs = `&order=${orderField}.${orderDir}.nullslast,created_at.desc`

    const { data } = await supabase.selectWithCount(
      'api_clients',
      `select=client_id,enterprise_id,status,created_at,rotated_at${orderQs}&limit=${encodeURIComponent(
        String(pageSize)
      )}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const headers = ['clientId', 'enterpriseId', 'status', 'createdAt', 'rotatedAt']
    const csvRows = [headers.map(escapeCsv).join(',')]
    for (const r of rows) {
      csvRows.push(
        [
          escapeCsv(r.client_id),
          escapeCsv(r.enterprise_id ?? ''),
          escapeCsv(r.status),
          escapeCsv(r.created_at ?? ''),
          escapeCsv(r.rotated_at ?? ''),
        ].join(',')
      )
    }
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', 'attachment; filename="api_clients.csv"')
    const filterPairs: string[] = []
    if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
    if (status) filterPairs.push(`status=${status}`)
    if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
    if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
    filterPairs.push(`limit=${pageSize}`)
    filterPairs.push(`page=${page}`)
    res.header('X-Filters', filterPairs.join(';'))
    res.send(`${csvRows.join('\n')}\n`)
  })

  app.post(`${prefix}/admin/api-clients/:clientId:rotate`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const clientId = String(req.params.clientId || '')
    if (!clientId) {
      return sendError(res, 400, 'BAD_REQUEST', 'clientId is required.')
    }
    const providedSecret = req.body?.clientSecret ? String(req.body.clientSecret) : null
    const newClientSecret = providedSecret ?? randomClientSecret()

    const rows = await supabase.select(
      'api_clients',
      `select=client_id,status&client_id=eq.${encodeURIComponent(clientId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `api_client ${clientId} not found.`)
    }

    const secretHash = hashSecretScrypt(newClientSecret)
    await supabase.update(
      'api_clients',
      `client_id=eq.${encodeURIComponent(clientId)}`,
      {
        secret_hash: secretHash,
        rotated_at: new Date().toISOString(),
        status: 'ACTIVE',
      },
      { returning: 'minimal' }
    )
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'ADMIN',
        action: 'ADMIN_API_CLIENT_ROTATE',
        target_type: 'API_CLIENT',
        target_id: clientId,
        request_id: getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.json({
      clientId,
      clientSecret: newClientSecret,
    })
  })

  app.post(`${prefix}/admin/api-clients/:clientId:deactivate`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const clientId = String(req.params.clientId || '')
    if (!clientId) {
      return sendError(res, 400, 'BAD_REQUEST', 'clientId is required.')
    }
    const rows = await supabase.select(
      'api_clients',
      `select=client_id,status&client_id=eq.${encodeURIComponent(clientId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `api_client ${clientId} not found.`)
    }
    await supabase.update(
      'api_clients',
      `client_id=eq.${encodeURIComponent(clientId)}`,
      {
        status: 'INACTIVE',
      },
      { returning: 'minimal' }
    )
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'ADMIN',
        action: 'ADMIN_API_CLIENT_DEACTIVATE',
        target_type: 'API_CLIENT',
        target_id: clientId,
        request_id: getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.json({
      clientId,
      status: 'INACTIVE',
    })
  })

  app.get(`${prefix}/admin/share-links`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId) : null
    const kind = req.query?.kind ? String(req.query.kind) : null
    const code = req.query?.code ? String(req.query.code) : null
    const requestId = req.query?.requestId ? String(req.query.requestId) : null
    const status = req.query?.status ? String(req.query.status).toLowerCase() : null
    const expiresFromIso = req.query?.expiresFrom ? toIsoDateTime(String(req.query.expiresFrom)) : null
    const expiresToIso = req.query?.expiresTo ? toIsoDateTime(String(req.query.expiresTo)) : null
    const codePrefix = req.query?.codePrefix ? String(req.query.codePrefix) : null
    const codeLike = req.query?.codeLike ? String(req.query.codeLike) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const limit = req.query?.limit ? Number(req.query.limit) : 50
    const page = req.query?.page ? Number(req.query.page) : 1
    const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
    const filters = []
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (kind) filters.push(`kind=eq.${encodeURIComponent(kind)}`)
    if (code) filters.push(`code=eq.${encodeURIComponent(code)}`)
    if (codePrefix) filters.push(`code=like.${encodeURIComponent(codePrefix + '%')}`)
    if (codeLike) filters.push(`code=ilike.${encodeURIComponent('%' + codeLike + '%')}`)
    if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
    const nowIso = new Date().toISOString()
    if (status === 'active') filters.push(`expires_at=gt.${encodeURIComponent(nowIso)}`)
    if (status === 'expired') filters.push(`expires_at=lte.${encodeURIComponent(nowIso)}`)
    if (expiresFromIso) filters.push(`expires_at=gte.${encodeURIComponent(expiresFromIso)}`)
    if (expiresToIso) filters.push(`expires_at=lte.${encodeURIComponent(expiresToIso)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const orderField = (() => {
      const s = sortBy ? sortBy.toLowerCase() : ''
      if (s === 'expiresat' || s === 'expires_at') return 'expires_at'
      if (s === 'createdat' || s === 'created_at') return 'created_at'
      if (s === 'code') return 'code'
      return 'created_at'
    })()
    const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
    const orderQs = `&order=${orderField}.${orderDir}`
    let data: any[] = []
    let total = 0
    try {
      const r = await supabase.selectWithCount(
        'share_links',
        `select=code,enterprise_id,kind,expires_at,created_at,request_id${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      data = Array.isArray(r.data) ? r.data : []
      total = typeof r.total === 'number' ? r.total : data.length
    } catch (err: any) {
      const msg = typeof err?.body === 'string' ? err.body : ''
      if (String(msg).includes("Could not find the table 'public.share_links'")) {
        data = []
        total = 0
      } else {
        throw err
      }
    }
    const rows = Array.isArray(data) ? data : []
    try {
      const mem = []
      for (const [c, e] of shareStore.entries()) {
        const now = Date.now()
        const exp = e.expiresAt ? new Date(e.expiresAt).getTime() : null
        if (exp && Number.isFinite(exp) && exp < now) continue
        if (enterpriseId && String(e.tenantId || '') !== enterpriseId) continue
        if (kind && String(e.kind || '') !== kind) continue
        if (code && String(c) !== code) continue
        if (codePrefix && !String(c).startsWith(codePrefix)) continue
        if (codeLike && !String(c).toLowerCase().includes(String(codeLike).toLowerCase())) continue
        if (requestId) continue
        if (status === 'active' && exp && exp <= now) continue
        if (status === 'expired' && exp && exp > now) continue
        if (expiresFromIso && exp && exp < new Date(expiresFromIso).getTime()) continue
        if (expiresToIso && exp && exp > new Date(expiresToIso).getTime()) continue
        mem.push({
          code: c,
          enterprise_id: e.tenantId ?? null,
          kind: e.kind,
          expires_at: e.expiresAt ?? null,
          created_at: e.createdAt ?? null,
          request_id: null,
        })
      }
      if (mem.length) {
        rows.push(...mem)
      }
    } catch {}
    const filterPairs: string[] = []
    function addFilter(k: string, v: string | null) { if (v && String(v).trim().length > 0) filterPairs.push(k + '=' + String(v).trim()) }
    addFilter('enterpriseId', enterpriseId)
    addFilter('kind', kind)
    addFilter('code', code)
    addFilter('codePrefix', codePrefix)
    addFilter('requestId', requestId)
    addFilter('status', status)
    addFilter('expiresFrom', expiresFromIso)
    addFilter('expiresTo', expiresToIso)
    addFilter('sortBy', sortBy)
    addFilter('sortOrder', sortOrder)
    addFilter('limit', String(limit))
    addFilter('page', String(page))
    const filtersSummary = filterPairs.join(', ')
    if (filtersSummary) res.header('X-Filters', filtersSummary)
    res.json({
      items: rows.map((r: any) => ({
        code: r.code,
        enterpriseId: r.enterprise_id ?? null,
        kind: r.kind,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        requestId: r.request_id ?? null,
        url: `${buildBaseUrl(req)}/v1/s/${r.code}`,
      })),
      total: typeof total === 'number' ? total : rows.length,
    })
  })

  app.get(`${prefix}/admin/share-links:csv`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId) : null
    const kind = req.query?.kind ? String(req.query.kind) : null
    const code = req.query?.code ? String(req.query.code) : null
    const requestId = req.query?.requestId ? String(req.query.requestId) : null
    const status = req.query?.status ? String(req.query.status).toLowerCase() : null
    const expiresFromIso = req.query?.expiresFrom ? toIsoDateTime(String(req.query.expiresFrom)) : null
    const expiresToIso = req.query?.expiresTo ? toIsoDateTime(String(req.query.expiresTo)) : null
    const codePrefix = req.query?.codePrefix ? String(req.query.codePrefix) : null
    const codeLike = req.query?.codeLike ? String(req.query.codeLike) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const limit = req.query?.limit ? Number(req.query.limit) : 1000
    const page = req.query?.page ? Number(req.query.page) : 1
    const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
    const filters = []
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (kind) filters.push(`kind=eq.${encodeURIComponent(kind)}`)
    if (code) filters.push(`code=eq.${encodeURIComponent(code)}`)
    if (codePrefix) filters.push(`code=like.${encodeURIComponent(codePrefix + '%')}`)
    if (codeLike) filters.push(`code=ilike.${encodeURIComponent('%' + codeLike + '%')}`)
    if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
    const nowIso = new Date().toISOString()
    if (status === 'active') filters.push(`expires_at=gt.${encodeURIComponent(nowIso)}`)
    if (status === 'expired') filters.push(`expires_at=lte.${encodeURIComponent(nowIso)}`)
    if (expiresFromIso) filters.push(`expires_at=gte.${encodeURIComponent(expiresFromIso)}`)
    if (expiresToIso) filters.push(`expires_at=lte.${encodeURIComponent(expiresToIso)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const orderField = (() => {
      const s = sortBy ? sortBy.toLowerCase() : ''
      if (s === 'expiresat' || s === 'expires_at') return 'expires_at'
      if (s === 'createdat' || s === 'created_at') return 'created_at'
      if (s === 'code') return 'code'
      return 'created_at'
    })()
    const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
    const orderQs = `&order=${orderField}.${orderDir}`
    let data: any[] = []
    try {
      const r = await supabase.selectWithCount(
        'share_links',
        `select=code,enterprise_id,kind,expires_at,created_at,request_id${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      data = Array.isArray(r.data) ? r.data : []
    } catch (err: any) {
      const msg = typeof err?.body === 'string' ? err.body : ''
      if (String(msg).includes("Could not find the table 'public.share_links'")) {
        data = []
      } else {
        throw err
      }
    }
    const rows = Array.isArray(data) ? data : []
    try {
      const mem = []
      for (const [c, e] of shareStore.entries()) {
        const now = Date.now()
        const exp = e.expiresAt ? new Date(e.expiresAt).getTime() : null
        if (exp && Number.isFinite(exp) && exp < now) continue
        if (enterpriseId && String(e.tenantId || '') !== enterpriseId) continue
        if (kind && String(e.kind || '') !== kind) continue
        if (code && String(c) !== code) continue
        if (codePrefix && !String(c).startsWith(codePrefix)) continue
        if (codeLike && !String(c).toLowerCase().includes(String(codeLike).toLowerCase())) continue
        if (requestId) continue
        if (status === 'active' && exp && exp <= now) continue
        if (status === 'expired' && exp && exp > now) continue
        if (expiresFromIso && exp && exp < new Date(expiresFromIso).getTime()) continue
        if (expiresToIso && exp && exp > new Date(expiresToIso).getTime()) continue
        mem.push({
          code: c,
          enterprise_id: e.tenantId ?? null,
          kind: e.kind,
          expires_at: e.expiresAt ?? null,
          created_at: e.createdAt ?? null,
          request_id: null,
        })
      }
      if (mem.length) {
        rows.push(...mem)
      }
    } catch {}
    const headers = ['code', 'enterpriseId', 'kind', 'expiresAt', 'createdAt', 'requestId', 'url']
    const csvRows = [headers.map(escapeCsv).join(',')]
    for (const r of rows) {
      csvRows.push([
        escapeCsv(r.code),
        escapeCsv(r.enterprise_id ?? ''),
        escapeCsv(r.kind),
        escapeCsv(r.expires_at ?? ''),
        escapeCsv(r.created_at ?? ''),
        escapeCsv(r.request_id ?? ''),
        escapeCsv(`${buildBaseUrl(req)}/v1/s/${r.code}`),
      ].join(','))
    }
    const filterPairs: string[] = []
    function addFilter(k: string, v: string | null) { if (v && String(v).trim().length > 0) filterPairs.push(k + '=' + String(v).trim()) }
    addFilter('enterpriseId', enterpriseId)
    addFilter('kind', kind)
    addFilter('code', code)
    addFilter('codePrefix', codePrefix)
    addFilter('requestId', requestId)
    addFilter('status', status)
    addFilter('expiresFrom', expiresFromIso)
    addFilter('expiresTo', expiresToIso)
    addFilter('sortBy', sortBy)
    addFilter('sortOrder', sortOrder)
    addFilter('limit', String(limit))
    addFilter('page', String(page))
    const filtersSummary = filterPairs.join(', ')
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', 'attachment; filename="share_links.csv"')
    if (filtersSummary) res.header('X-Filters', filtersSummary)
    res.send(`${csvRows.join('\n')}\n`)
  })

  app.post(`${prefix}/admin/share-links/:code:invalidate`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const code = String(req.params.code)
    let rows: any = null
    try {
      rows = await supabase.select(
        'share_links',
        `select=code,enterprise_id,kind,expires_at&code=eq.${encodeURIComponent(code)}&limit=1`
      )
    } catch (err: any) {
      const msg = typeof err?.body === 'string' ? err.body : ''
      if (String(msg).includes("Could not find the table 'public.share_links'")) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `share_link ${code} not found.`)
      }
      throw err
    }
    const link = Array.isArray(rows) ? rows[0] : null
    if (!link) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `share_link ${code} not found.`)
    }
    const nowIso = new Date().toISOString()
    try {
      await supabase.update('share_links', `code=eq.${encodeURIComponent(code)}`, {
        expires_at: nowIso,
      }, { returning: 'minimal' })
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: link.enterprise_id ?? null,
        action: 'ADMIN_SHARE_LINK_INVALIDATE',
        target_type: 'SHARE_LINK',
        target_id: code,
        request_id: getTraceId(res),
        source_ip: req.ip,
      }, { returning: 'minimal' })
    } catch (err: any) {
      const msg = typeof err?.body === 'string' ? err.body : ''
      if (String(msg).includes("Could not find the table 'public.share_links'")) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `share_link ${code} not found.`)
      }
      throw err
    }
    res.json({ code, expiresAt: nowIso, status: 'INVALIDATED' })
  })

  app.delete(`${prefix}/admin/share-links/:code`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const code = String(req.params.code)
    let rows: any = null
    try {
      rows = await supabase.select(
        'share_links',
        `select=code,enterprise_id,kind,expires_at&code=eq.${encodeURIComponent(code)}&limit=1`
      )
    } catch (err: any) {
      const msg = typeof err?.body === 'string' ? err.body : ''
      if (String(msg).includes("Could not find the table 'public.share_links'")) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `share_link ${code} not found.`)
      }
      throw err
    }
    const link = Array.isArray(rows) ? rows[0] : null
    if (!link) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `share_link ${code} not found.`)
    }
    try {
      await supabase.delete('share_links', `code=eq.${encodeURIComponent(code)}`)
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: link.enterprise_id ?? null,
        action: 'ADMIN_SHARE_LINK_DELETE',
        target_type: 'SHARE_LINK',
        target_id: code,
        request_id: getTraceId(res),
        source_ip: req.ip,
      }, { returning: 'minimal' })
    } catch (err: any) {
      const msg = typeof err?.body === 'string' ? err.body : ''
      if (String(msg).includes("Could not find the table 'public.share_links'")) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `share_link ${code} not found.`)
      }
      throw err
    }
    res.json({ code, deleted: true })
  })

  app.post(`${prefix}/admin/sims/:iccid:seed-usage`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const iccid = requireIccid(res, req.params.iccid)
    if (!iccid) return
    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,enterprise_id,supplier_id,apn&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    const usageDay = req.body?.usageDay ? String(req.body.usageDay).slice(0, 10) : new Date().toISOString().slice(0, 10)
    const visited = req.body?.visitedMccMnc ? String(req.body.visitedMccMnc) : '204-08'
    const totalKbReq = req.body?.totalKb !== undefined && req.body?.totalKb !== null ? Number(req.body.totalKb) : null
    const uplinkKbReq = req.body?.uplinkKb !== undefined && req.body?.uplinkKb !== null ? Number(req.body.uplinkKb) : null
    const downlinkKbReq = req.body?.downlinkKb !== undefined && req.body?.downlinkKb !== null ? Number(req.body.downlinkKb) : null
    let uplinkKb = uplinkKbReq ?? Math.floor(((totalKbReq ?? 200000) * 0.6))
    let downlinkKb = downlinkKbReq ?? Math.floor(((totalKbReq ?? 200000) * 0.4))
    let totalKb = totalKbReq ?? (uplinkKb + downlinkKb)
    if (!Number.isFinite(uplinkKb) || uplinkKb < 0) uplinkKb = 0
    if (!Number.isFinite(downlinkKb) || downlinkKb < 0) downlinkKb = 0
    if (!Number.isFinite(totalKb) || totalKb < 0) totalKb = uplinkKb + downlinkKb
    const match = `iccid=eq.${encodeURIComponent(iccid)}&usage_day=eq.${encodeURIComponent(usageDay)}&visited_mccmnc=eq.${encodeURIComponent(visited)}`
    const existing = await supabase.select('usage_daily_summary', `select=usage_id&${match}&limit=1`)
    if (Array.isArray(existing) && existing.length > 0) {
      const usageId = existing[0]?.usage_id
      await supabase.update('usage_daily_summary', `usage_id=eq.${encodeURIComponent(String(usageId))}`, {
        uplink_kb: Math.max(0, Math.floor(uplinkKb)),
        downlink_kb: Math.max(0, Math.floor(downlinkKb)),
        total_kb: Math.max(0, Math.floor(totalKb)),
        apn: sim.apn ?? null,
        rat: null,
        input_ref: getTraceId(res) ?? null,
      }, { returning: 'minimal' })
    } else {
      await supabase.insert('usage_daily_summary', {
        supplier_id: sim.supplier_id,
        enterprise_id: sim.enterprise_id ?? null,
        sim_id: sim.sim_id ?? null,
        iccid,
        usage_day: usageDay,
        visited_mccmnc: visited,
        uplink_kb: Math.max(0, Math.floor(uplinkKb)),
        downlink_kb: Math.max(0, Math.floor(downlinkKb)),
        total_kb: Math.max(0, Math.floor(totalKb)),
        apn: sim.apn ?? null,
        rat: null,
        input_ref: getTraceId(res) ?? null,
      }, { returning: 'minimal' })
    }
    await supabase.insert('audit_logs', {
      actor_role: 'ADMIN',
      tenant_id: sim.enterprise_id ?? null,
      action: 'ADMIN_SEED_USAGE',
      target_type: 'SIM',
      target_id: iccid,
      request_id: getTraceId(res),
      source_ip: req.ip,
      after_data: { iccid, usageDay, visited, uplinkKb, downlinkKb, totalKb },
    }, { returning: 'minimal' })
    res.json({
      iccid,
      usageDay,
      visitedMccMnc: visited,
      uplinkKb,
      downlinkKb,
      totalKb,
      seeded: true,
    })
  })

  app.post(`${prefix}/admin/sims:evaluate-test-expiry`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId) : null
    const filters = ['status=eq.TEST_READY']
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    const { data } = await supabase.selectWithCount(
      'sims',
      `select=sim_id,iccid,enterprise_id,status,last_status_change_at&${filters.join('&')}&order=last_status_change_at.asc`
    )
    const sims = Array.isArray(data) ? data : []
    const cond = getTestExpiryCondition()
    const periodDays = getTestPeriodDays()
    const quotaKbLimit = getTestQuotaKb()
    let processed = 0
    let activated = 0
    for (const sim of sims) {
      processed += 1
      let startTimeIso = sim.last_status_change_at ? new Date(sim.last_status_change_at).toISOString() : null
      if (!startTimeIso) {
        const hist = await supabase.select(
          'sim_state_history',
          `select=start_time&sim_id=eq.${encodeURIComponent(sim.sim_id)}&after_status=eq.TEST_READY&order=start_time.desc&limit=1`
        )
        const h = Array.isArray(hist) ? hist[0] : null
        startTimeIso = h?.start_time ? new Date(h.start_time).toISOString() : null
      }
      if (!startTimeIso) continue
      const startTime = new Date(startTimeIso)
      const expireByPeriod = Date.now() >= addDaysUtc(startTime, periodDays).getTime()
      let totalKb = 0
      const startDay = startOfDayUtc(startTime)
      const usageRows = await supabase.select(
        'usage_daily_summary',
        `select=total_kb,usage_day&iccid=eq.${encodeURIComponent(sim.iccid)}${sim.enterprise_id ? `&enterprise_id=eq.${encodeURIComponent(sim.enterprise_id)}` : ''}&usage_day=gte.${encodeURIComponent(startDay.toISOString().slice(0, 10))}`
      )
      if (Array.isArray(usageRows)) {
        for (const r of usageRows) totalKb += Number(r.total_kb ?? 0)
      }
      const expireByQuota = quotaKbLimit > 0 ? totalKb >= quotaKbLimit : false
      const shouldExpire = cond === 'PERIOD_ONLY' ? expireByPeriod : cond === 'QUOTA_ONLY' ? expireByQuota : (expireByPeriod || expireByQuota)
      if (!shouldExpire) continue
      const nowIso = new Date().toISOString()
      await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
        status: 'ACTIVATED',
        last_status_change_at: nowIso,
      }, { returning: 'minimal' })
      await supabase.insert('sim_state_history', {
        sim_id: sim.sim_id,
        before_status: 'TEST_READY',
        after_status: 'ACTIVATED',
        start_time: startTimeIso,
        end_time: nowIso,
        source: 'TEST_EXPIRY',
        request_id: getTraceId(res),
      }, { returning: 'minimal' })
      await supabase.insert('events', {
        event_type: 'SIM_STATUS_CHANGED',
        occurred_at: nowIso,
        tenant_id: sim.enterprise_id ?? null,
        request_id: getTraceId(res),
        payload: {
          iccid: sim.iccid,
          beforeStatus: 'TEST_READY',
          afterStatus: 'ACTIVATED',
          reason: 'TEST_EXPIRY',
          expiryBy: expireByPeriod && expireByQuota ? 'PERIOD_OR_QUOTA' : expireByPeriod ? 'PERIOD' : 'QUOTA',
          totalKb,
          periodDays,
          quotaKbLimit,
          startTime: startTimeIso,
          endTime: nowIso,
        },
      }, { returning: 'minimal' })
      activated += 1
    }
    await supabase.insert('audit_logs', {
      actor_role: 'ADMIN',
      tenant_id: enterpriseId ?? null,
      action: 'ADMIN_EVALUATE_TEST_EXPIRY',
      target_type: 'SIM_BATCH',
      target_id: enterpriseId ?? 'ALL',
      request_id: getTraceId(res),
      source_ip: req.ip,
      after_data: { processed, activated },
    }, { returning: 'minimal' })
    res.json({ processed, activated, remaining: sims.length - activated })
  })
}

function registerBillFileRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole?: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps

  app.get(`${prefix}/bills/:billId/files`, async (req: any, res: any) => {
    const billId = String(req.params.billId)
    const baseUrl = buildBaseUrl(req)
    res.json({
      pdfUrl: null,
      csvUrl: `${baseUrl}${prefix}/bills/${billId}/files/csv`,
    })
  })

  app.get(`${prefix}/bills/:billId/files/csv`, async (req: any, res: any) => {
    const enterpriseId = getEnterpriseIdFromReq(req)
    const supabase = enterpriseId
      ? createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      : createSupabaseRestClient({ traceId: getTraceId(res) })
    const billId = String(req.params.billId)
    const limitParam = req.query?.limit ?? req.query?.pageSize
    const { page, pageSize, offset } = parsePagination(
      { page: req.query?.page, pageSize: limitParam },
      { defaultPage: 1, defaultPageSize: 2000, maxPageSize: 10000 }
    )
    if (enterpriseId) {
      const bills = await supabase.select('bills', `select=bill_id&bill_id=eq.${encodeURIComponent(billId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`)
      if (!Array.isArray(bills) || bills.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
      }
    }
    const rows = await supabase.select(
      'bill_line_items',
      `select=line_item_id,item_type,amount,metadata,created_at&bill_id=eq.${encodeURIComponent(billId)}&order=line_item_id.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
    )
    const items = Array.isArray(rows) ? rows : []
    const header = [
      'lineItemId',
      'itemType',
      'amount',
      'calculationId',
      'iccid',
      'visitedMccMnc',
      'chargedKb',
      'ratePerKb',
      'inputRef',
      'createdAt',
    ]
    const lines = [header.join(',')]
    for (const it of items) {
      const meta = it.metadata ?? {}
      lines.push(
        [
          it.line_item_id,
          it.item_type,
          it.amount,
          meta.calculationId,
          meta.iccid,
          meta.visitedMccMnc,
          meta.chargedKb,
          meta.ratePerKb,
          meta.inputRef,
          it.created_at,
        ]
          .map(escapeCsv)
          .join(',')
      )
    }
    const csv = `${lines.join('\n')}\n`
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', `attachment; filename="bill-${billId}.csv"`)
    res.header('X-Filters', `billId=${billId};limit=${pageSize};page=${page}`)
    res.send(csv)
  })

  async function getBillReconciliationSummary(req: any, res: any) {
    const enterpriseId = getEnterpriseIdFromReq(req)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const billId = String(req.params.billId)
    const rows = await supabase.select(
      'bills',
      `select=bill_id,enterprise_id,reseller_id,status,currency,total_amount,period_start,period_end&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
    )
    const bill = Array.isArray(rows) ? rows[0] : null
    if (!bill) {
      sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
      return null
    }
    if (enterpriseId) {
      if (String(bill.enterprise_id ?? '') !== String(enterpriseId)) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
        return null
      }
    } else {
      const auth = getAuthContext(req)
      const roleScope = getRoleScope(req)
      const role = auth?.role ? String(auth.role) : null
      if (roleScope === 'platform' || role === 'platform_admin') {
      } else if (roleScope === 'reseller' && role === 'reseller_admin') {
        if (String(bill.reseller_id ?? '') !== String((auth as any).resellerId ?? '')) {
          sendError(res, 403, 'FORBIDDEN', 'billId is out of reseller scope.')
          return null
        }
      } else if (roleScope === 'customer') {
        const scopedEnterpriseId = getEnterpriseIdFromReq(req)
        if (!scopedEnterpriseId || String(bill.enterprise_id ?? '') !== String(scopedEnterpriseId)) {
          sendError(res, 403, 'FORBIDDEN', 'billId is out of enterprise scope.')
          return null
        }
      } else {
        sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
        return null
      }
    }
    const lineItemRows = await supabase.select(
      'bill_line_items',
      `select=item_type,amount&bill_id=eq.${encodeURIComponent(billId)}`
    )
    const lineItems = Array.isArray(lineItemRows) ? lineItemRows : []
    const byTypeMap = new Map<string, { itemType: string; count: number; amount: number }>()
    let lineItemsAmount = 0
    let negativeLineItems = 0
    let zeroLineItems = 0
    for (const it of lineItems) {
      const type = it?.item_type ? String(it.item_type) : 'UNKNOWN'
      const amount = Number(it?.amount ?? 0)
      if (amount < 0) negativeLineItems += 1
      if (amount === 0) zeroLineItems += 1
      lineItemsAmount += amount
      const current = byTypeMap.get(type) ?? { itemType: type, count: 0, amount: 0 }
      current.count += 1
      current.amount = Number((Number(current.amount ?? 0) + amount).toFixed(2))
      byTypeMap.set(type, current)
    }
    const billAmount = Number(bill.total_amount ?? 0)
    const lineItemsTotal = Number(lineItemsAmount.toFixed(2))
    const deltaAmount = Number((lineItemsTotal - billAmount).toFixed(2))
    const noteItemRows = await supabase.select(
      'adjustment_note_items',
      `select=note_id,amount&metadata->>billId=eq.${encodeURIComponent(billId)}`
    )
    const noteItems = Array.isArray(noteItemRows) ? noteItemRows : []
    const noteIds = Array.from(new Set(noteItems.map((n: any) => n?.note_id).filter(Boolean).map((v: any) => String(v))))
    let notes: any[] = []
    if (noteIds.length) {
      const idList = noteIds.map((id: string) => encodeURIComponent(id)).join(',')
      const noteRows = await supabase.select(
        'adjustment_notes',
        `select=note_id,note_type,status,total_amount,currency,created_at&note_id=in.(${idList})`
      )
      notes = Array.isArray(noteRows) ? noteRows : []
    }
    const statusMap = new Map<string, { status: string; count: number; amount: number }>()
    const typeMap = new Map<string, { type: string; count: number; amount: number }>()
    let totalAdjustmentAmount = 0
    for (const note of notes) {
      const status = note?.status ? String(note.status) : 'UNKNOWN'
      const type = note?.note_type ? String(note.note_type) : 'UNKNOWN'
      const amount = Number(note?.total_amount ?? 0)
      totalAdjustmentAmount += amount
      const statusEntry = statusMap.get(status) ?? { status, count: 0, amount: 0 }
      statusEntry.count += 1
      statusEntry.amount = Number((Number(statusEntry.amount ?? 0) + amount).toFixed(2))
      statusMap.set(status, statusEntry)
      const typeEntry = typeMap.get(type) ?? { type, count: 0, amount: 0 }
      typeEntry.count += 1
      typeEntry.amount = Number((Number(typeEntry.amount ?? 0) + amount).toFixed(2))
      typeMap.set(type, typeEntry)
    }
    return {
      billId: bill.bill_id ?? billId,
      enterpriseId: bill.enterprise_id ?? null,
      resellerId: bill.reseller_id ?? null,
      status: bill.status ?? null,
      currency: bill.currency ?? null,
      periodStart: bill.period_start ?? null,
      periodEnd: bill.period_end ?? null,
      totals: {
        billAmount,
        lineItemsAmount: lineItemsTotal,
        deltaAmount,
        lineItemsCount: lineItems.length,
        negativeLineItems,
        zeroLineItems,
      },
      byItemType: Array.from(byTypeMap.values()),
      adjustments: {
        totalNotes: notes.length,
        totalAmount: Number(totalAdjustmentAmount.toFixed(2)),
        byStatus: Array.from(statusMap.values()),
        byType: Array.from(typeMap.values()),
        notes: notes.map((note) => ({
          noteId: note.note_id ?? null,
          type: note.note_type ?? null,
          status: note.status ?? null,
          totalAmount: Number(note.total_amount ?? 0),
          currency: note.currency ?? null,
          createdAt: note.created_at ?? null,
        })),
      },
    }
  }

  app.get(`${prefix}/bills/:billId/reconciliation`, async (req: any, res: any) => {
    const summary = await getBillReconciliationSummary(req, res)
    if (!summary) return
    res.send(summary)
  })

  app.get(`${prefix}/bills/:billId/reconciliation\\:csv`, async (req: any, res: any) => {
    const summary = await getBillReconciliationSummary(req, res)
    if (!summary) return
    const rows = [['section', 'name', 'count', 'amount']]
    const toCell = (value: unknown) => (value === null || value === undefined ? '' : String(value))
    rows.push(['summary', 'billAmount', '', toCell(summary.totals.billAmount)])
    rows.push(['summary', 'lineItemsAmount', '', toCell(summary.totals.lineItemsAmount)])
    rows.push(['summary', 'deltaAmount', '', toCell(summary.totals.deltaAmount)])
    rows.push(['summary', 'lineItemsCount', toCell(summary.totals.lineItemsCount), ''])
    rows.push(['summary', 'negativeLineItems', toCell(summary.totals.negativeLineItems), ''])
    rows.push(['summary', 'zeroLineItems', toCell(summary.totals.zeroLineItems), ''])
    rows.push(['summary', 'adjustmentNotes', toCell(summary.adjustments.totalNotes), ''])
    rows.push(['summary', 'adjustmentAmount', '', toCell(summary.adjustments.totalAmount)])
    for (const item of summary.byItemType) {
      rows.push(['itemType', toCell(item.itemType), toCell(item.count), toCell(item.amount)])
    }
    for (const item of summary.adjustments.byStatus) {
      rows.push(['adjustmentStatus', toCell(item.status), toCell(item.count), toCell(item.amount)])
    }
    for (const item of summary.adjustments.byType) {
      rows.push(['adjustmentType', toCell(item.type), toCell(item.count), toCell(item.amount)])
    }
    const csv = `${rows.map((row) => row.map(escapeCsv).join(',')).join('\n')}\n`
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', `attachment; filename="bill-${summary.billId}-reconciliation.csv"`)
    res.header('X-Filters', `billId=${summary.billId}`)
    res.send(csv)
  })
}

function registerResellerRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const mapStatusToStorage = (status: unknown) => {
    const v = status ? String(status).toUpperCase() : ''
    if (v === 'ACTIVE') return 'active'
    if (v === 'SUSPENDED') return 'suspended'
    if (v === 'DEACTIVATED') return 'deactivated'
    return null
  }
  const mapStatusFromStorage = (status: unknown) => {
    const v = status ? String(status).toLowerCase() : ''
    if (v === 'deactivated') return 'DEACTIVATED'
    if (v === 'suspended') return 'SUSPENDED'
    return 'ACTIVE'
  }
  const requirePlatform = (req: FastifyRequest, res: FastifyReply) => {
    const roleScope = getRoleScope(req)
    const role = getAuthContext(req).role ? String(getAuthContext(req).role) : null
    if (!roleScope && !role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return false
    }
    if (roleScope === 'platform' || role === 'platform_admin') return true
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return false
  }

  app.post(`${prefix}/resellers`, async (req: any, res: any) => {
    if (!requirePlatform(req, res)) return
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const currency = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : ''
    const contactEmail = typeof req.body?.contactEmail === 'string' ? req.body.contactEmail.trim() : ''
    const contactPhone = typeof req.body?.contactPhone === 'string' ? req.body.contactPhone.trim() : null
    const branding = req.body?.brandingConfig && typeof req.body.brandingConfig === 'object' ? req.body.brandingConfig : null
    const logoUrl = branding?.logoUrl ? String(branding.logoUrl) : null
    const primaryColor = branding?.primaryColor ? String(branding.primaryColor) : null
    const customDomain = branding?.customDomain ? String(branding.customDomain) : null

    if (!name || name.length < 2 || name.length > 100) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name must be 2-100 characters.')
    }
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'currency must be ISO 4217 code.')
    }
    if (!contactEmail || !emailRegex.test(contactEmail)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'contactEmail must be valid.')
    }
    if (contactPhone && contactPhone.length > 50) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'contactPhone is too long.')
    }

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const existing = await supabase.select('resellers', `select=id&name=eq.${encodeURIComponent(name)}&limit=1`)
    if (Array.isArray(existing) && existing.length > 0) {
      return sendError(res, 409, 'DUPLICATE_NAME', 'Reseller name already exists.')
    }

    const createdBy = getAuthContext(req).userId ? String(getAuthContext(req).userId) : null
    const inserted = await supabase.insert('resellers', {
      name,
      status: 'active',
      contact_email: contactEmail,
      contact_phone: contactPhone,
      created_by: createdBy,
    })
    const reseller = Array.isArray(inserted) ? inserted[0] : null
    if (!reseller) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create reseller.')
    }
    await supabase.insert('reseller_branding', {
      reseller_id: reseller.id,
      brand_name: name,
      logo_url: logoUrl,
      primary_color: primaryColor,
      custom_domain: customDomain,
      currency,
    }, { returning: 'minimal' })

    res.status(201).json({
      resellerId: reseller.id,
      name: reseller.name,
      currency,
      status: 'ACTIVE',
      brandingConfig: {
        logoUrl,
        primaryColor,
        customDomain,
      },
      createdAt: reseller.created_at,
    })
  })

  app.get(`${prefix}/resellers`, async (req: any, res: any) => {
    if (!requirePlatform(req, res)) return
    const statusInput = req.query?.status ? String(req.query.status) : null
    const storageStatus = statusInput ? mapStatusToStorage(statusInput) : null
    if (statusInput && !storageStatus) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, DEACTIVATED, or SUSPENDED.')
    }
    const { page, pageSize, offset } = parsePagination(req.query ?? {}, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const filters: string[] = []
    if (storageStatus) filters.push(`status=eq.${encodeURIComponent(storageStatus)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const { data, total } = await supabase.selectWithCount(
      'resellers',
      `select=id,name,status,created_at,updated_at&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    let brandingMap = new Map()
    if (rows.length) {
      const idList = rows.map((r: any) => encodeURIComponent(String(r.id))).join(',')
      const brandRows = await supabase.select(
        'reseller_branding',
        `select=reseller_id,brand_name,logo_url,custom_domain,primary_color,secondary_color,currency&reseller_id=in.(${idList})`
      )
      const list = Array.isArray(brandRows) ? brandRows : []
      brandingMap = new Map(list.map((b: any) => [String(b.reseller_id), b]))
    }
    res.json({
      items: rows.map((r: any) => {
        const branding = brandingMap.get(String(r.id)) ?? null
        return {
          resellerId: r.id,
          name: r.name,
          currency: branding?.currency ?? null,
          status: mapStatusFromStorage(r.status),
          brandingConfig: {
            logoUrl: branding?.logo_url ?? null,
            primaryColor: branding?.primary_color ?? null,
            customDomain: branding?.custom_domain ?? null,
          },
          createdAt: r.created_at,
        }
      }),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  app.get(`${prefix}/resellers/:resellerId`, async (req: any, res: any) => {
    const roleScope = getRoleScope(req)
    const role = getAuthContext(req).role ? String(getAuthContext(req).role) : null
    if (!roleScope && !role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const resellerId = String(req.params.resellerId || '')
    if (!resellerId) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    const isPlatform = roleScope === 'platform' || role === 'platform_admin'
    if (!isPlatform) {
      if (roleScope !== 'reseller') {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      const ownResellerId = getAuthContext(req).resellerId ? String(getAuthContext(req).resellerId) : null
      if (!ownResellerId || ownResellerId !== resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'resellers',
      `select=id,name,status,contact_email,contact_phone,created_at,updated_at&id=eq.${encodeURIComponent(resellerId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    }
    const brandingRows = await supabase.select(
      'reseller_branding',
      `select=reseller_id,logo_url,custom_domain,primary_color,secondary_color,currency&reseller_id=eq.${encodeURIComponent(resellerId)}&limit=1`
    )
    const branding = Array.isArray(brandingRows) ? brandingRows[0] : null
    res.json({
      resellerId: row.id,
      name: row.name,
      currency: branding?.currency ?? null,
      status: mapStatusFromStorage(row.status),
      brandingConfig: {
        logoUrl: branding?.logo_url ?? null,
        primaryColor: branding?.primary_color ?? null,
        customDomain: branding?.custom_domain ?? null,
      },
      createdAt: row.created_at,
    })
  })

  app.patch(`${prefix}/resellers/:resellerId`, async (req: any, res: any) => {
    if (!requirePlatform(req, res)) return
    const resellerId = String(req.params.resellerId || '')
    if (!resellerId) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : null
    const contactEmail = typeof req.body?.contactEmail === 'string' ? req.body.contactEmail.trim() : null
    const contactPhone = typeof req.body?.contactPhone === 'string' ? req.body.contactPhone.trim() : null
    const branding = req.body?.brandingConfig && typeof req.body.brandingConfig === 'object' ? req.body.brandingConfig : null
    const logoUrl = branding?.logoUrl ? String(branding.logoUrl) : null
    const primaryColor = branding?.primaryColor ? String(branding.primaryColor) : null
    const customDomain = branding?.customDomain ? String(branding.customDomain) : null

    if (name !== null && (name.length < 2 || name.length > 100)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name must be 2-100 characters.')
    }
    if (contactEmail !== null && contactEmail && !emailRegex.test(contactEmail)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'contactEmail must be valid.')
    }
    if (contactPhone !== null && contactPhone && contactPhone.length > 50) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'contactPhone is too long.')
    }
    if (!name && !branding && !contactEmail && !contactPhone) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No updates specified.')
    }

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const existing = await supabase.select(
      'resellers',
      `select=id,name,status,contact_email,contact_phone,created_at,updated_at&id=eq.${encodeURIComponent(resellerId)}&limit=1`
    )
    const reseller = Array.isArray(existing) ? existing[0] : null
    if (!reseller) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    }
    if (name) {
      const dup = await supabase.select(
        'resellers',
        `select=id&name=eq.${encodeURIComponent(name)}&id=neq.${encodeURIComponent(resellerId)}&limit=1`
      )
      if (Array.isArray(dup) && dup.length > 0) {
        return sendError(res, 409, 'DUPLICATE_NAME', 'Reseller name already exists.')
      }
    }
    const nowIso = new Date().toISOString()
    const resellerPatch: Record<string, unknown> = { updated_at: nowIso }
    if (name) resellerPatch.name = name
    if (contactEmail !== null) resellerPatch.contact_email = contactEmail || null
    if (contactPhone !== null) resellerPatch.contact_phone = contactPhone || null
    await supabase.update('resellers', `id=eq.${encodeURIComponent(resellerId)}`, resellerPatch, { returning: 'minimal' })
    if (branding || name) {
      const rows = await supabase.select(
        'reseller_branding',
        `select=branding_id,reseller_id&reseller_id=eq.${encodeURIComponent(resellerId)}&limit=1`
      )
      const existingBranding = Array.isArray(rows) ? rows[0] : null
      const brandingPatch: Record<string, unknown> = {}
      if (logoUrl !== null) brandingPatch.logo_url = logoUrl
      if (primaryColor !== null) brandingPatch.primary_color = primaryColor
      if (customDomain !== null) brandingPatch.custom_domain = customDomain
      if (name) brandingPatch.brand_name = name
      if (existingBranding) {
        if (Object.keys(brandingPatch).length > 0) {
          await supabase.update('reseller_branding', `branding_id=eq.${encodeURIComponent(existingBranding.branding_id)}`, brandingPatch, { returning: 'minimal' })
        }
      } else {
        await supabase.insert('reseller_branding', {
          reseller_id: resellerId,
          brand_name: name ?? reseller.name,
          logo_url: logoUrl,
          primary_color: primaryColor,
          custom_domain: customDomain,
        }, { returning: 'minimal' })
      }
    }
    res.json({
      resellerId,
      name: name ?? reseller.name,
      status: mapStatusFromStorage(reseller.status),
      updatedAt: nowIso,
    })
  })

  app.post(`${prefix}/resellers/:resellerId\\:change-status`, async (req: any, res: any) => {
    if (!requirePlatform(req, res)) return
    const resellerId = String(req.params.resellerId || '')
    if (!resellerId) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    const statusInput = req.body?.status ? String(req.body.status) : null
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    const storageStatus = statusInput ? mapStatusToStorage(statusInput) : null
    if (!storageStatus) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, DEACTIVATED, or SUSPENDED.')
    }
    if (!reason) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'reason is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'resellers',
      `select=id,status&id=eq.${encodeURIComponent(resellerId)}&limit=1`
    )
    const reseller = Array.isArray(rows) ? rows[0] : null
    if (!reseller) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    }
    const previousStatus = mapStatusFromStorage(reseller.status)
    const nowIso = new Date().toISOString()
    await supabase.update('resellers', `id=eq.${encodeURIComponent(resellerId)}`, {
      status: storageStatus,
      updated_at: nowIso,
    }, { returning: 'minimal' })
    res.json({
      resellerId,
      status: mapStatusFromStorage(storageStatus),
      previousStatus,
      changedAt: nowIso,
    })
  })
}

function registerEnterpriseRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps
  const normalizeStatus = (status: unknown) => {
    const v = status ? String(status).toUpperCase() : ''
    if (v === 'ACTIVE') return 'ACTIVE'
    if (v === 'SUSPENDED') return 'SUSPENDED'
    if (v === 'INACTIVE') return 'INACTIVE'
    return null
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const getAuth = (req: FastifyRequest) => ({
    roleScope: getRoleScope(req),
    role: getAuthContext(req).role ? String(getAuthContext(req).role) : null,
    resellerId: getAuthContext(req).resellerId ? String(getAuthContext(req).resellerId) : null,
    customerId: getAuthContext(req).customerId ? String(getAuthContext(req).customerId) : null,
    userId: getAuthContext(req).userId ? String(getAuthContext(req).userId) : null,
  })
  const resellerAllRoles = new Set(['reseller_admin', 'reseller_finance'])
  const resellerAssignedRoles = new Set(['reseller_sales_director', 'reseller_sales'])
  const ensurePlatformOrResellerAdmin = (req: FastifyRequest, res: FastifyReply) => {
    const auth = getAuth(req)
    if (!auth.roleScope && !auth.role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' as const }
    if (auth.roleScope === 'reseller' && auth.role === 'reseller_admin') return { ...auth, scope: 'reseller' as const }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  app.post(`${prefix}/enterprises`, async (req: any, res: any) => {
    const auth = ensurePlatformOrResellerAdmin(req, res)
    if (!auth) return
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const resellerIdRaw = req.body?.resellerId ? String(req.body.resellerId) : null
    const autoSuspendEnabled = typeof req.body?.autoSuspendEnabled === 'boolean' ? req.body.autoSuspendEnabled : false
    const contactEmail = typeof req.body?.contactEmail === 'string' ? req.body.contactEmail.trim() : ''
    const contactPhone = typeof req.body?.contactPhone === 'string' ? req.body.contactPhone.trim() : null
    if (!name || name.length < 2 || name.length > 200) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name must be 2-200 characters.')
    }
    if (!contactEmail) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'contactEmail is required.')
    }
    if (!emailRegex.test(contactEmail)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'contactEmail is invalid.')
    }
    const resellerId = auth.scope === 'reseller' ? auth.resellerId : resellerIdRaw
    if (!resellerId) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'resellerId is required.')
    }
    if (auth.scope === 'reseller' && resellerId !== auth.resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const resellerRows = await supabase.select(
      'tenants',
      `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
    )
    if (!Array.isArray(resellerRows) || resellerRows.length === 0) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    }
    const inserted = await supabase.insert('tenants', {
      parent_id: resellerId,
      tenant_type: 'ENTERPRISE',
      name,
      enterprise_status: 'ACTIVE',
      auto_suspend_enabled: autoSuspendEnabled,
    })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create enterprise.')
    }
    await supabase.insert('audit_logs', {
      actor_user_id: auth.userId,
      actor_role: auth.role,
      tenant_id: row.tenant_id,
      action: 'ENTERPRISE_CREATED',
      target_type: 'ENTERPRISE',
      target_id: row.tenant_id,
      request_id: getTraceId(res),
      source_ip: req.ip,
      after_data: {
        name,
        resellerId,
        autoSuspendEnabled,
        contactEmail: contactEmail || null,
        contactPhone,
      },
    }, { returning: 'minimal' })
    res.status(201).json({
      enterpriseId: row.tenant_id,
      name: row.name,
      resellerId,
      status: 'ACTIVE',
      autoSuspendEnabled: row.auto_suspend_enabled,
      contactEmail: contactEmail || null,
      contactPhone,
      createdAt: row.created_at,
    })
  })

  app.get(`${prefix}/enterprises`, async (req: any, res: any) => {
    const auth = getAuth(req)
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const isPlatform = auth.roleScope === 'platform' || auth.role === 'platform_admin'
    const isReseller = auth.roleScope === 'reseller'
    if (!isPlatform && !isReseller) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const statusInput = req.query?.status ? String(req.query.status) : null
    const status = statusInput ? normalizeStatus(statusInput) : null
    if (statusInput && !status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, INACTIVE, or SUSPENDED.')
    }
    const queryResellerId = req.query?.resellerId ? String(req.query.resellerId) : null
    const resellerId = isReseller ? auth.resellerId : queryResellerId
    if (isReseller && !resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
    }
    const { page, pageSize, offset } = parsePagination(req.query ?? {}, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const filters = ['tenant_type=eq.ENTERPRISE']
    if (status) filters.push(`enterprise_status=eq.${encodeURIComponent(status)}`)
    if (resellerId) filters.push(`parent_id=eq.${encodeURIComponent(resellerId)}`)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (isReseller) {
      if (resellerAssignedRoles.has(auth.role || '')) {
        if (!auth.userId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller user required.')
        }
        const resellerIdValue = resellerId as string
        const assignmentRows = await supabase.select(
          'reseller_enterprise_assignments',
          `select=enterprise_id&user_id=eq.${encodeURIComponent(auth.userId)}&reseller_id=eq.${encodeURIComponent(resellerIdValue)}`
        )
        const assignments = Array.isArray(assignmentRows) ? assignmentRows.map((r: any) => String(r.enterprise_id)) : []
        if (assignments.length === 0) {
          return res.json({ items: [], total: 0, page, pageSize })
        }
        filters.push(`tenant_id=in.(${assignments.map((id) => encodeURIComponent(id)).join(',')})`)
      } else if (!resellerAllRoles.has(auth.role || '')) {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
    }
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const { data, total } = await supabase.selectWithCount(
      'tenants',
      `select=tenant_id,parent_id,name,enterprise_status,auto_suspend_enabled,created_at&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    res.json({
      items: rows.map((r: any) => ({
        enterpriseId: r.tenant_id,
        name: r.name,
        resellerId: r.parent_id,
        status: r.enterprise_status,
        autoSuspendEnabled: r.auto_suspend_enabled,
        createdAt: r.created_at,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  app.get(`${prefix}/enterprises/:enterpriseId`, async (req: any, res: any) => {
    const auth = getAuth(req)
    const enterpriseId = String(req.params.enterpriseId || '')
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id,name,enterprise_status,auto_suspend_enabled,created_at&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    }
    if (auth.roleScope === 'platform' || auth.role === 'platform_admin') {
    } else if (auth.roleScope === 'reseller') {
      if (!auth.resellerId || String(row.parent_id || '') !== auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      if (resellerAssignedRoles.has(auth.role || '')) {
        if (!auth.userId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller user required.')
        }
        const assignmentRows = await supabase.select(
          'reseller_enterprise_assignments',
          `select=enterprise_id&user_id=eq.${encodeURIComponent(auth.userId)}&reseller_id=eq.${encodeURIComponent(auth.resellerId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
        )
        if (!Array.isArray(assignmentRows) || assignmentRows.length === 0) {
          return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
        }
      } else if (!resellerAllRoles.has(auth.role || '')) {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
    } else if (auth.roleScope === 'customer' || auth.roleScope === 'department') {
      if (!auth.customerId || auth.customerId !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise scope required.')
      }
    } else {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    res.json({
      enterpriseId: row.tenant_id,
      name: row.name,
      resellerId: row.parent_id,
      status: row.enterprise_status,
      autoSuspendEnabled: row.auto_suspend_enabled,
      createdAt: row.created_at,
    })
  })

  app.post(`${prefix}/enterprises/:enterpriseId\\:change-status`, async (req: any, res: any) => {
    const auth = ensurePlatformOrResellerAdmin(req, res)
    if (!auth) return
    const enterpriseId = String(req.params.enterpriseId || '')
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    const statusInput = req.body?.status ? String(req.body.status) : null
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    const status = statusInput ? normalizeStatus(statusInput) : null
    if (!status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, INACTIVE, or SUSPENDED.')
    }
    if (!reason) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'reason is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id,enterprise_status&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    }
    if (auth.scope === 'reseller' && String(row.parent_id || '') !== auth.resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
    }
    const previousStatus = row.enterprise_status
    const nowIso = new Date().toISOString()
    await supabase.update('tenants', `tenant_id=eq.${encodeURIComponent(enterpriseId)}`, {
      enterprise_status: status,
      updated_at: nowIso,
    }, { returning: 'minimal' })
    await supabase.insert('events', {
      event_type: 'ENTERPRISE_STATUS_CHANGED',
      occurred_at: nowIso,
      tenant_id: enterpriseId,
      actor_user_id: auth.userId,
      request_id: getTraceId(res),
      payload: {
        previousStatus,
        status,
        reason,
        changedBy: auth.userId,
      },
    }, { returning: 'minimal' })
    await supabase.insert('audit_logs', {
      actor_user_id: auth.userId,
      actor_role: auth.role,
      tenant_id: enterpriseId,
      action: 'ENTERPRISE_STATUS_CHANGED',
      target_type: 'ENTERPRISE',
      target_id: enterpriseId,
      request_id: getTraceId(res),
      source_ip: req.ip,
      before_data: { status: previousStatus },
      after_data: { status, reason },
    }, { returning: 'minimal' })
    res.json({
      enterpriseId,
      status,
      previousStatus,
      changedAt: nowIso,
    })
  })
}

function registerDepartmentRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps
  const getAuth = (req: FastifyRequest) => ({
    roleScope: getRoleScope(req),
    role: getAuthContext(req).role ? String(getAuthContext(req).role) : null,
    resellerId: getAuthContext(req).resellerId ? String(getAuthContext(req).resellerId) : null,
    customerId: getAuthContext(req).customerId ? String(getAuthContext(req).customerId) : null,
    departmentId: getAuthContext(req).departmentId ? String(getAuthContext(req).departmentId) : null,
    userId: getAuthContext(req).userId ? String(getAuthContext(req).userId) : null,
  })
  const ensureEnterpriseAccess = async (supabase: SupabaseClient, auth: ReturnType<typeof getAuth>, enterpriseId: string) => {
    if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ok: true }
    const enterpriseRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
    if (!enterprise) return { ok: false, error: 'not_found' as const }
    if (auth.roleScope === 'reseller') {
      if (!auth.resellerId || String((enterprise as any).parent_id || '') !== auth.resellerId) return { ok: false, error: 'forbidden' as const }
      if (auth.role !== 'reseller_admin') return { ok: false, error: 'forbidden' as const }
      return { ok: true }
    }
    if (auth.roleScope === 'customer') {
      if (!auth.customerId || auth.customerId !== enterpriseId) return { ok: false, error: 'forbidden' as const }
      if (auth.role !== 'customer_admin') return { ok: false, error: 'forbidden' as const }
      return { ok: true }
    }
    return { ok: false, error: 'forbidden' as const }
  }

  app.post(`${prefix}/enterprises/:enterpriseId/departments`, async (req: any, res: any) => {
    const auth = getAuth(req)
    const enterpriseId = String(req.params.enterpriseId || '')
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name || name.length < 2 || name.length > 100) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name must be 2-100 characters.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const access = await ensureEnterpriseAccess(supabase, auth, enterpriseId)
    if (!access.ok) {
      if (access.error === 'not_found') return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const inserted = await supabase.insert('tenants', {
      parent_id: enterpriseId,
      tenant_type: 'DEPARTMENT',
      name,
    })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create department.')
    }
    await supabase.insert('audit_logs', {
      actor_user_id: auth.userId,
      actor_role: auth.role,
      tenant_id: enterpriseId,
      action: 'DEPARTMENT_CREATED',
      target_type: 'DEPARTMENT',
      target_id: row.tenant_id,
      request_id: getTraceId(res),
      source_ip: req.ip,
      after_data: { name },
    }, { returning: 'minimal' })
    res.status(201).json({
      departmentId: row.tenant_id,
      enterpriseId,
      name: row.name,
      createdAt: row.created_at,
    })
  })

  app.get(`${prefix}/enterprises/:enterpriseId/departments`, async (req: any, res: any) => {
    const auth = getAuth(req)
    const enterpriseId = String(req.params.enterpriseId || '')
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.roleScope === 'customer' || auth.roleScope === 'department') {
      if (!auth.customerId || auth.customerId !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise scope required.')
      }
    }
    const { page, pageSize, offset } = parsePagination(req.query ?? {}, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
    if (!enterprise) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    }
    if (auth.roleScope === 'reseller') {
      if (!auth.resellerId || String((enterprise as any).parent_id || '') !== auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
    }
    const { data, total } = await supabase.selectWithCount(
      'tenants',
      `select=tenant_id,name,created_at&tenant_type=eq.DEPARTMENT&parent_id=eq.${encodeURIComponent(enterpriseId)}&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
    )
    const rows = Array.isArray(data) ? data : []
    res.json({
      items: rows.map((r: any) => ({
        departmentId: r.tenant_id,
        enterpriseId,
        name: r.name,
        createdAt: r.created_at,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  app.get(`${prefix}/departments/:departmentId`, async (req: any, res: any) => {
    const auth = getAuth(req)
    const departmentId = String(req.params.departmentId || '')
    if (!departmentId) {
      return sendError(res, 400, 'BAD_REQUEST', 'departmentId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id,name,created_at&tenant_id=eq.${encodeURIComponent(departmentId)}&tenant_type=eq.DEPARTMENT&limit=1`
    )
    const dept = Array.isArray(rows) ? rows[0] : null
    if (!dept) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `department ${departmentId} not found.`)
    }
    const enterpriseId = String((dept as any).parent_id || '')
    if (auth.roleScope === 'customer' || auth.roleScope === 'department') {
      if (!auth.customerId || auth.customerId !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise scope required.')
      }
    } else if (auth.roleScope === 'reseller') {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise || !auth.resellerId || String((enterprise as any).parent_id || '') !== auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    res.json({
      departmentId: dept.tenant_id,
      enterpriseId,
      name: dept.name,
      createdAt: dept.created_at,
    })
  })
}

function registerSupplierRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps
  const normalizeStatus = (status: unknown) => {
    const value = status ? String(status).toUpperCase() : ''
    if (value === 'ACTIVE') return 'ACTIVE'
    if (value === 'SUSPENDED') return 'SUSPENDED'
    return null
  }

  app.post(`${prefix}/operators`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const mcc = typeof req.body?.mcc === 'string' ? req.body.mcc.trim() : ''
    const mnc = typeof req.body?.mnc === 'string' ? req.body.mnc.trim() : ''
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const gsmaOverride = Boolean(req.body?.gsmaOverride)
    if (!/^\d{3}$/.test(mcc)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'mcc must be 3 digits.')
    }
    if (!/^\d{2,3}$/.test(mnc)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'mnc must be 2-3 digits.')
    }
    if (!name) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const dup = await supabase.select(
      'carriers',
      `select=carrier_id&mcc=eq.${encodeURIComponent(mcc)}&mnc=eq.${encodeURIComponent(mnc)}&limit=1`
    )
    if (Array.isArray(dup) && dup.length > 0) {
      return sendError(res, 409, 'DUPLICATE_OPERATOR', 'Operator already exists.')
    }
    const inserted = await supabase.insert('carriers', {
      mcc,
      mnc,
      name,
    })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create operator.')
    }
    if (gsmaOverride) {
      await supabase.insert(
        'audit_logs',
        {
          actor_user_id: auth.userId ?? null,
          actor_role: auth.role ?? 'platform_admin',
          action: 'OPERATOR_GSMA_OVERRIDE',
          target_type: 'OPERATOR',
          target_id: row.carrier_id,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { mcc, mnc, name, gsmaOverride: true },
        },
        { returning: 'minimal' }
      )
    }
    res.status(201).json({
      operatorId: row.carrier_id,
      mcc: row.mcc,
      mnc: row.mnc,
      name: row.name,
    })
  })

  app.post(`${prefix}/suppliers`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const statusInput = req.body?.status ? String(req.body.status) : null
    const status = statusInput ? normalizeStatus(statusInput) : 'ACTIVE'
    const operatorIds = Array.isArray(req.body?.operatorIds) ? req.body.operatorIds.map((id: unknown) => String(id)) : []
    if (!name) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name is required.')
    }
    if (statusInput && !status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE or SUSPENDED.')
    }
    if (operatorIds.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorIds is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const existing = await supabase.select('suppliers', `select=supplier_id&name=eq.${encodeURIComponent(name)}&limit=1`)
    if (Array.isArray(existing) && existing.length > 0) {
      return sendError(res, 409, 'DUPLICATE_NAME', 'Supplier name already exists.')
    }
    const operatorFilter = operatorIds.map((id: string) => encodeURIComponent(id)).join(',')
    const operatorRows = await supabase.select('carriers', `select=carrier_id&carrier_id=in.(${operatorFilter})`)
    const operators = Array.isArray(operatorRows) ? operatorRows : []
    if (operators.length !== operatorIds.length) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorIds contains invalid operator id.')
    }
    const inserted = await supabase.insert('suppliers', { name, status })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create supplier.')
    }
    await supabase.insert(
      'supplier_carriers',
      operatorIds.map((operatorId: string) => ({ supplier_id: row.supplier_id, carrier_id: operatorId })),
      { returning: 'minimal' }
    )
    res.status(201).json({
      supplierId: row.supplier_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      operatorIds,
    })
  })

  app.get(`${prefix}/suppliers`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const statusInput = req.query.status ? String(req.query.status) : null
    const status = statusInput ? normalizeStatus(statusInput) : null
    if (statusInput && !status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE or SUSPENDED.')
    }
    const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const filters: string[] = []
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const { data, total } = await supabase.selectWithCount(
      'suppliers',
      `select=supplier_id,name,status,created_at&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    res.json({
      items: rows.map((r: any) => ({
        supplierId: r.supplier_id,
        name: r.name,
        status: r.status,
        createdAt: r.created_at,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  app.get(`${prefix}/suppliers/:supplierId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supplierId = String(req.params.supplierId || '')
    if (!supplierId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'suppliers',
      `select=supplier_id,name,status,created_at&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
    }
    res.json({
      supplierId: row.supplier_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
    })
  })

  app.get(`${prefix}/suppliers/:supplierId/capabilities`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supplierId = String(req.params.supplierId || '')
    if (!supplierId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
    }
    let adapter
    try {
      adapter = createSupplierAdapter({ supplierId })
    } catch {
      return sendError(res, 404, 'ADAPTER_NOT_FOUND', 'Supplier adapter not found.')
    }
    res.json({
      supplierId,
      supplierKey: adapter.supplierKey,
      capabilities: adapter.capabilities,
    })
  })

  app.patch(`${prefix}/suppliers/:supplierId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supplierId = String(req.params.supplierId || '')
    if (!supplierId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : null
    const statusInput = req.body?.status ? String(req.body.status) : null
    const status = statusInput ? normalizeStatus(statusInput) : null
    if (name !== null && !name) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name is required.')
    }
    if (statusInput && !status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE or SUSPENDED.')
    }
    if (name === null && status === null) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No updates specified.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'suppliers',
      `select=supplier_id,name,status,created_at&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
    }
    if (name) {
      const dup = await supabase.select(
        'suppliers',
        `select=supplier_id&name=eq.${encodeURIComponent(name)}&supplier_id=neq.${encodeURIComponent(supplierId)}&limit=1`
      )
      if (Array.isArray(dup) && dup.length > 0) {
        return sendError(res, 409, 'DUPLICATE_NAME', 'Supplier name already exists.')
      }
    }
    const patch: Record<string, unknown> = {}
    if (name) patch.name = name
    if (status) patch.status = status
    await supabase.update('suppliers', `supplier_id=eq.${encodeURIComponent(supplierId)}`, patch, { returning: 'minimal' })
    const nowIso = new Date().toISOString()
    res.json({
      supplierId,
      name: name ?? row.name,
      status: status ?? row.status,
      updatedAt: nowIso,
    })
  })

  app.post(`${prefix}/suppliers/:supplierId\\:change-status`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supplierId = String(req.params.supplierId || '')
    if (!supplierId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
    }
    const statusInput = req.body?.status ? String(req.body.status) : null
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    const status = statusInput ? normalizeStatus(statusInput) : null
    if (!status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE or SUSPENDED.')
    }
    if (!reason) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'reason is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'suppliers',
      `select=supplier_id,status&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
    }
    const previousStatus = row.status
    const nowIso = new Date().toISOString()
    await supabase.update('suppliers', `supplier_id=eq.${encodeURIComponent(supplierId)}`, { status }, { returning: 'minimal' })
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'PLATFORM',
        action: 'SUPPLIER_STATUS_CHANGED',
        target_type: 'SUPPLIER',
        target_id: supplierId,
        request_id: getTraceId(res),
        source_ip: req.ip,
        before_data: { status: previousStatus },
        after_data: { status, reason },
      },
      { returning: 'minimal' }
    )
    res.json({
      supplierId,
      status,
      previousStatus,
      changedAt: nowIso,
    })
  })
}

function registerUserRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const resellerRoles = new Set(['reseller_admin', 'reseller_sales_director', 'reseller_sales', 'reseller_finance'])
  const enterpriseRoles = new Set(['customer_admin', 'customer_ops'])

  app.post(`${prefix}/resellers/:resellerId/users`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const resellerId = String(req.params.resellerId || '')
    if (!resellerId) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin' || !auth.resellerId || auth.resellerId !== resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : ''
    const roleInput = typeof req.body?.role === 'string' ? req.body.role.trim() : ''
    const role = roleInput ? roleInput.toLowerCase() : ''
    const assignedEnterpriseIds = Array.isArray(req.body?.assignedEnterpriseIds)
      ? req.body.assignedEnterpriseIds.map((id: unknown) => String(id))
      : []
    if (!emailRegex.test(email)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'email is invalid.')
    }
    if (!displayName) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'displayName is required.')
    }
    if (!resellerRoles.has(role)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'role is invalid for reseller users.')
    }
    if ((role === 'reseller_sales' || role === 'reseller_sales_director') && assignedEnterpriseIds.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'assignedEnterpriseIds is required for sales roles.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const tenantRows = await supabase.select(
      'tenants',
      `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
    )
    if (!Array.isArray(tenantRows) || tenantRows.length === 0) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    }
    if (assignedEnterpriseIds.length > 0) {
      const enterpriseFilter = assignedEnterpriseIds.map((id: string) => encodeURIComponent(id)).join(',')
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=in.(${enterpriseFilter})&tenant_type=eq.ENTERPRISE`
      )
      const enterprises = Array.isArray(enterpriseRows) ? enterpriseRows : []
      if (enterprises.length !== assignedEnterpriseIds.length) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'assignedEnterpriseIds contains invalid enterprise id.')
      }
      if (enterprises.some((e: any) => String(e.parent_id || '') !== resellerId)) {
        return sendError(res, 403, 'FORBIDDEN', 'assignedEnterpriseIds must belong to reseller.')
      }
    }
    const inserted = await supabase.insert('users', {
      tenant_id: resellerId,
      email,
      display_name: displayName,
      status: 'ACTIVE',
    })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create user.')
    }
    await supabase.insert('user_roles', { user_id: row.user_id, role_name: role }, { returning: 'minimal' })
    if (assignedEnterpriseIds.length > 0) {
      await supabase.insert(
        'reseller_enterprise_assignments',
        assignedEnterpriseIds.map((enterpriseId: string) => ({
          user_id: row.user_id,
          reseller_id: resellerId,
          enterprise_id: enterpriseId,
        })),
        { returning: 'minimal' }
      )
    }
    await supabase.insert(
      'audit_logs',
      {
        actor_user_id: auth.userId,
        actor_role: auth.role,
        tenant_id: resellerId,
        action: 'RESELLER_USER_CREATED',
        target_type: 'USER',
        target_id: row.user_id,
        request_id: getTraceId(res),
        source_ip: req.ip,
        after_data: {
          email,
          displayName,
          role,
          assignedEnterpriseIds,
        },
      },
      { returning: 'minimal' }
    )
    res.status(201).json({
      userId: row.user_id,
      resellerId,
      email: row.email,
      displayName: row.display_name,
      role,
      status: row.status,
      assignedEnterpriseIds,
      createdAt: row.created_at,
    })
  })

  app.get(`${prefix}/resellers/:resellerId/users`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const resellerId = String(req.params.resellerId || '')
    if (!resellerId) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin' || !auth.resellerId || auth.resellerId !== resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { data, total } = await supabase.selectWithCount(
      'users',
      `select=user_id,email,display_name,status,created_at&tenant_id=eq.${encodeURIComponent(resellerId)}&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
    )
    const rows = Array.isArray(data) ? data : []
    const userIds = rows.map((r: any) => String(r.user_id))
    const roles = userIds.length > 0
      ? await supabase.select(
          'user_roles',
          `select=user_id,role_name&user_id=in.(${userIds.map((id: string) => encodeURIComponent(id)).join(',')})`
        )
      : []
    const roleMap = new Map()
    for (const r of Array.isArray(roles) ? roles : []) {
      if (!roleMap.has((r as any).user_id)) roleMap.set((r as any).user_id, (r as any).role_name)
    }
    res.json({
      items: rows.map((r: any) => ({
        userId: r.user_id,
        resellerId,
        email: r.email,
        displayName: r.display_name,
        role: roleMap.get(r.user_id) ?? null,
        status: r.status,
        createdAt: r.created_at,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  app.post(`${prefix}/enterprises/:enterpriseId/users`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const enterpriseId = String(req.params.enterpriseId || '')
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.roleScope === 'customer') {
      if (auth.role !== 'customer_admin' || !auth.customerId || auth.customerId !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise admin required.')
      }
    } else if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin') {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : ''
    const roleInput = typeof req.body?.role === 'string' ? req.body.role.trim() : ''
    const role = roleInput ? roleInput.toLowerCase() : ''
    const departmentId = req.body?.departmentId ? String(req.body.departmentId) : null
    if (!emailRegex.test(email)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'email is invalid.')
    }
    if (!displayName) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'displayName is required.')
    }
    if (!enterpriseRoles.has(role)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'role is invalid for enterprise users.')
    }
    if (role === 'customer_ops' && !departmentId) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'departmentId is required for customer_ops.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
    if (!enterprise) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    }
    if (auth.roleScope === 'reseller' && (!auth.resellerId || String((enterprise as any).parent_id || '') !== auth.resellerId)) {
      return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
    }
    if (departmentId) {
      const deptRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(departmentId)}&tenant_type=eq.DEPARTMENT&limit=1`
      )
      const dept = Array.isArray(deptRows) ? deptRows[0] : null
      if (!dept || String((dept as any).parent_id || '') !== enterpriseId) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'departmentId is invalid.')
      }
    }
    const inserted = await supabase.insert('users', {
      tenant_id: enterpriseId,
      email,
      display_name: displayName,
      status: 'ACTIVE',
    })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create user.')
    }
    await supabase.insert('user_roles', { user_id: row.user_id, role_name: role }, { returning: 'minimal' })
    await supabase.insert(
      'audit_logs',
      {
        actor_user_id: auth.userId,
        actor_role: auth.role,
        tenant_id: enterpriseId,
        action: 'ENTERPRISE_USER_CREATED',
        target_type: 'USER',
        target_id: row.user_id,
        request_id: getTraceId(res),
        source_ip: req.ip,
        after_data: {
          email,
          displayName,
          role,
          departmentId,
        },
      },
      { returning: 'minimal' }
    )
    res.status(201).json({
      userId: row.user_id,
      enterpriseId,
      email: row.email,
      displayName: row.display_name,
      role,
      status: row.status,
      departmentId,
      createdAt: row.created_at,
    })
  })
}

function registerAuditLogRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: {
    createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => SupabaseClient
    getTraceId: (reply: FastifyReply) => string | null
    sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  }
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps

  app.get(`${prefix}/audit-logs`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const isPlatform = auth.roleScope === 'platform' || auth.role === 'platform_admin'
    const isResellerAdmin = auth.roleScope === 'reseller' && auth.role === 'reseller_admin'
    if (!isPlatform && !isResellerAdmin) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const actor = req.query.actor ? String(req.query.actor) : null
    const action = req.query.action ? String(req.query.action) : null
    const from = req.query.from ? String(req.query.from) : null
    const to = req.query.to ? String(req.query.to) : null
    const queryResellerId = req.query.resellerId ? String(req.query.resellerId) : null
    const resellerId = isResellerAdmin ? auth.resellerId : queryResellerId
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const tenantIds: string[] = []
    if (resellerId) {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE`
      )
      const enterprises = Array.isArray(enterpriseRows) ? enterpriseRows : []
      tenantIds.push(resellerId, ...enterprises.map((r: any) => String(r.tenant_id)))
    }
    const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const filters: string[] = []
    if (actor) filters.push(`actor_user_id=eq.${encodeURIComponent(actor)}`)
    if (action) filters.push(`action=eq.${encodeURIComponent(action)}`)
    if (from) filters.push(`created_at=gte.${encodeURIComponent(from)}`)
    if (to) filters.push(`created_at=lte.${encodeURIComponent(to)}`)
    if (tenantIds.length > 0) {
      filters.push(`tenant_id=in.(${tenantIds.map((id) => encodeURIComponent(id)).join(',')})`)
    }
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const { data, total } = await supabase.selectWithCount(
      'audit_logs',
      `select=audit_id,actor_user_id,actor_role,tenant_id,action,target_type,target_id,before_data,after_data,request_id,created_at,source_ip&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    res.json({
      items: rows.map((r: any) => ({
        logId: r.audit_id,
        actor: r.actor_user_id,
        actorRole: r.actor_role,
        tenantScope: r.tenant_id,
        action: r.action,
        target: r.target_type ? `${r.target_type}:${r.target_id ?? ''}` : r.target_id,
        before: r.before_data,
        after: r.after_data,
        requestId: r.request_id,
        timestamp: r.created_at,
        sourceIp: r.source_ip,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })
}

async function resolveEnterpriseForReseller(req: FastifyRequest, reply: FastifyReply, supabase: SupabaseClient, enterpriseId: string | null) {
  const auth = getAuthContext(req)
  if (auth.roleScope !== 'reseller') return enterpriseId
  const resellerId = auth.resellerId
  if (!resellerId) {
    sendError(reply, 403, 'FORBIDDEN', 'Reseller scope required.')
    return null
  }
  if (!enterpriseId) {
    sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required for reseller scope.')
    return null
  }
  const rows = await supabase.select('tenants', `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`)
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || String((row as any).parent_id || '') !== String(resellerId)) {
    sendError(reply, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
    return null
  }
  return enterpriseId
}

async function resolveDepartmentForEnterprise(req: FastifyRequest, reply: FastifyReply, supabase: SupabaseClient, enterpriseId: string | null, departmentId: string | null) {
  if (!departmentId) return null
  if (!isValidUuid(departmentId)) {
    sendError(reply, 400, 'BAD_REQUEST', 'departmentId must be a valid uuid.')
    return null
  }
  if (!enterpriseId) {
    sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required when filtering by departmentId.')
    return null
  }
  const rows = await supabase.select('tenants', `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(departmentId)}&tenant_type=eq.DEPARTMENT&limit=1`)
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || String((row as any).parent_id || '') !== String(enterpriseId)) {
    sendError(reply, 403, 'FORBIDDEN', 'departmentId is out of enterprise scope.')
    return null
  }
  return departmentId
}

async function pushSimStatusToUpstream({
  iccid,
  status,
  traceId,
  supplierId,
}: {
  iccid: string
  status: string
  traceId?: string | null
  supplierId?: string | null
}) {
  if (!supplierId) {
    return { ok: false, skipped: true, reason: 'MISSING_SUPPLIER' }
  }
  let adapter
  try {
    adapter = createSupplierAdapter({ supplierId })
  } catch {
    return { ok: false, skipped: true, reason: 'ADAPTER_NOT_FOUND' }
  }
  if (status === 'ACTIVATED') {
    return adapter.activateSim({
      iccid,
      idempotencyKey: traceId ? `${traceId}:${iccid}:ACTIVATE` : `sim:${iccid}:activate:${Date.now()}`,
    })
  }
  if (status === 'DEACTIVATED' || status === 'RETIRED') {
    return adapter.suspendSim({
      iccid,
      idempotencyKey: traceId ? `${traceId}:${iccid}:SUSPEND` : `sim:${iccid}:suspend:${Date.now()}`,
    })
  }
  return { ok: true, skipped: true }
}

export function createApp() {
  const app = Fastify()
  registerAuditLogHook(app)
  app.addHook('onRequest', async (_req, reply) => {
    const traceId = `req_${crypto.randomUUID().replaceAll('-', '')}`
    ;(reply as { traceId?: string }).traceId = traceId
    reply.header('X-Request-Id', traceId)
  })
  const metrics = {
    count: 0,
    errorCount: 0,
    rateLimitedCount: 0,
    authFailureCount: 0,
    durations: [] as number[],
    maxSamples: 1000,
    byLabel: new Map<string, { count: number; durations: number[] }>(),
  }
  const alertTypes = [
    'POOL_USAGE_HIGH',
    'OUT_OF_PROFILE_SURGE',
    'SILENT_SIM',
    'UNEXPECTED_ROAMING',
    'CDR_DELAY',
    'UPSTREAM_DISCONNECT',
    'WEBHOOK_DELIVERY_FAILED',
  ]
  const alertStatuses = ['OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED']
  const alertSeverities = ['P0', 'P1', 'P2', 'P3']
  const alertMetricsCache: {
    expiresAt: number
    value: null | {
      window: string
      byTypeStatus: Array<{ alertType: string; status: string; count: number }>
      bySeverity: Array<{ severity: string; count: number }>
      alertEventCount: number
    }
  } = {
    expiresAt: 0,
    value: null,
  }
  const alertMetricsTtlMs = 60000
  const alertMetricsWindowMs = 24 * 60 * 60 * 1000

  async function countAlerts({
    supabase,
    sinceIso,
    alertType,
    status,
    severity,
  }: {
    supabase: ReturnType<typeof createSupabaseRestClient>
    sinceIso: string
    alertType?: string
    status?: string
    severity?: string
  }) {
    const filters = [`created_at=gte.${encodeURIComponent(sinceIso)}`]
    if (alertType) filters.push(`alert_type=eq.${encodeURIComponent(alertType)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (severity) filters.push(`severity=eq.${encodeURIComponent(severity)}`)
    const query = `select=alert_id&limit=1&${filters.join('&')}`
    try {
      const { total } = await supabase.selectWithCount('alerts', query)
      return typeof total === 'number' ? total : 0
    } catch (err: any) {
      const body = err?.body ? String(err.body) : String(err?.message ?? '')
      if (body.includes('invalid input value for enum alert_type')) {
        return 0
      }
      throw err
    }
  }

  async function countAlertEvents({
    supabase,
    sinceIso,
  }: {
    supabase: ReturnType<typeof createSupabaseRestClient>
    sinceIso: string
  }) {
    const query = `select=event_id&limit=1&event_type=eq.ALERT_TRIGGERED&occurred_at=gte.${encodeURIComponent(sinceIso)}`
    const { total } = await supabase.selectWithCount('events', query)
    return typeof total === 'number' ? total : 0
  }

  async function loadAlertMetrics(traceId: string | null) {
    const now = Date.now()
    if (alertMetricsCache.value && alertMetricsCache.expiresAt > now) {
      return alertMetricsCache.value
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId })
    const sinceIso = new Date(now - alertMetricsWindowMs).toISOString()
    const typeStatusTasks = alertTypes.flatMap((alertType) =>
      alertStatuses.map(async (status) => ({
        alertType,
        status,
        count: await countAlerts({ supabase, sinceIso, alertType, status }),
      }))
    )
    const severityTasks = alertSeverities.map(async (severity) => ({
      severity,
      count: await countAlerts({ supabase, sinceIso, severity }),
    }))
    const [byTypeStatus, bySeverity, alertEventCount] = await Promise.all([
      Promise.all(typeStatusTasks),
      Promise.all(severityTasks),
      countAlertEvents({ supabase, sinceIso }),
    ])
    const value = {
      window: '24h',
      byTypeStatus,
      bySeverity,
      alertEventCount,
    }
    alertMetricsCache.value = value
    alertMetricsCache.expiresAt = now + alertMetricsTtlMs
    return value
  }
  app.addHook('onRequest', async (req) => {
    ;(req as { cmpMetricsStart?: number }).cmpMetricsStart = Date.now()
  })
  app.addHook('onResponse', async (req, reply) => {
    const start = (req as { cmpMetricsStart?: number }).cmpMetricsStart
    const dur = typeof start === 'number' ? Date.now() - start : 0
    metrics.count += 1
    metrics.durations.push(dur)
    if (metrics.durations.length > metrics.maxSamples) metrics.durations.shift()
    const sc = reply.statusCode
    if (sc === 429) metrics.rateLimitedCount += 1
    if (sc === 401) metrics.authFailureCount += 1
    if (sc >= 500) metrics.errorCount += 1
    const method = String(req.method || 'GET')
    const path = String(req.url || '/').split('?')[0]
    const route = path.startsWith('/v1/bills') ? '/v1/bills'
      : path.startsWith('/v1/sims') ? '/v1/sims'
      : path.startsWith('/v1/jobs') ? '/v1/jobs'
      : path.startsWith('/bills') ? '/bills'
      : path.startsWith('/sims') ? '/sims'
      : path.startsWith('/jobs') ? '/jobs'
      : path.startsWith('/v1/auth/token') ? '/v1/auth/token'
      : path.startsWith('/auth/token') ? '/auth/token'
      : path.startsWith('/v1/admin') ? '/v1/admin'
      : path.startsWith('/admin') ? '/admin'
      : 'other'
    const statusClass = `${Math.floor(sc / 100)}xx`
    const key = `${method}|${route}|${statusClass}`
    const prev = metrics.byLabel.get(key) ?? { count: 0, durations: [] }
    prev.count += 1
    prev.durations.push(dur)
    if (prev.durations.length > metrics.maxSamples) prev.durations.shift()
    metrics.byLabel.set(key, prev)
  })
  const apiKeyGuard = apiKeyAuth()
  const oidcGuard = oidcAuth({ allowApiKey: false })
  const tenantScopeGuard = tenantScope()
  app.addHook('onRequest', async (req, reply) => {
    const url = String(req.url || '')
    const path = url.split('?')[0]
    if (
      path === '/health' ||
      path === '/ready' ||
      path === '/metrics' ||
      path === '/openapi.yaml' ||
      path === '/v1/openapi.yaml' ||
      path === '/docs' ||
      path === '/v1/docs' ||
      path === '/docs/assets/swagger-ui-bundle.js' ||
      path === '/docs/assets/swagger-ui.css' ||
      path === '/v1/docs/assets/swagger-ui-bundle.js' ||
      path === '/v1/docs/assets/swagger-ui.css' ||
      path === '/favicon.ico' ||
      path === '/auth/token' ||
      path === '/v1/auth/token' ||
      path === '/auth/login' ||
      path === '/v1/auth/login' ||
      path === '/auth/refresh' ||
      path === '/v1/auth/refresh' ||
      path === '/v1/cmp/webhook/sim-status-changed' ||
      path === '/v1/wx/webhook/sim-online' ||
      path === '/v1/wx/webhook/sim-status-changed' ||
      path === '/v1/wx/webhook/traffic-alert' ||
      path === '/v1/wx/webhook/product-order' ||
      path.startsWith('/v1/s/')
    ) {
      return
    }
    const rawApiKey = req.headers['x-api-key']
    const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey ? String(rawApiKey) : null
    const adminKey = process.env.ADMIN_API_KEY ? String(process.env.ADMIN_API_KEY) : null
    if (apiKey && adminKey && apiKey === adminKey) {
      ;(req as { cmpAuth?: AuthContext }).cmpAuth = { roleScope: 'platform', role: 'platform_admin' }
    } else if (apiKey) {
      await apiKeyGuard(req, reply)
      if (reply.sent) return
    } else {
      await oidcGuard(req, reply)
      if (reply.sent) return
    }
    await tenantScopeGuard(req, reply)
  })
  registerAuthRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerAdminApiClientRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerAdminApiClientRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerBillFileRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerBillFileRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerResellerRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerEnterpriseRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerDepartmentRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerSupplierRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerUserRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerAuditLogRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerSimPhase4Routes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      getDepartmentIdFromReq,
      buildSimTenantFilter,
      ensureResellerAdmin,
      ensureResellerSales,
      resolveEnterpriseForReseller,
      resolveDepartmentForEnterprise,
      normalizeIccid,
      isValidIccid,
      isValidUuid,
      readRequestBody,
      parseMultipartFormData,
      toIsoDateTime,
      pushSimStatusToUpstream,
    },
  })
  registerPricePlanRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      ensureResellerAdmin,
      ensureResellerSales,
      resolveEnterpriseForReseller,
      isValidUuid,
    },
  })
  registerPackageRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      ensureResellerAdmin,
      ensureResellerSales,
      resolveEnterpriseForReseller,
      isValidUuid,
    },
  })
  registerNetworkProfileRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      ensureResellerAdmin,
      ensureResellerSales,
      isValidUuid,
    },
  })
  registerSubscriptionRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      ensureResellerSales,
      resolveEnterpriseForReseller,
      getRoleScope,
      getEnterpriseIdFromReq,
      buildSimTenantFilter,
      isValidUuid,
    },
  })
  registerWebhookRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      resolveEnterpriseForReseller,
      isValidUuid,
    },
  })
  registerEventRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      resolveEnterpriseForReseller,
      isValidUuid,
    },
  })
  registerReconciliationRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      ensurePlatformAdmin,
      isValidUuid,
    },
  })
  registerVendorMappingRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      ensurePlatformAdmin,
      isValidUuid,
    },
  })
  app.post('/v1/wx/webhook/sim-online', async (req: any, res: any) => {
    if (!requireWxWebhookKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const iccid = requireIccid(res, req.body?.iccid)
    const messageType = String(req.body?.messageType || '').trim()
    const msisdn = String(req.body?.msisdn || '').trim()
    const sign = String(req.body?.sign || '').trim()
    const uuid = String(req.body?.uuid || '').trim()
    const data = req.body?.data ?? {}
    const mncList = String(data?.mncList || '').trim()
    const eventTime = String(data?.eventTime || '').trim()
    const mcc = String(data?.mcc || '').trim()
    const occurredAt = eventTime ? toIsoDateTime(eventTime) : new Date().toISOString()
    if (!iccid) return
    if (!messageType || !msisdn || !sign || !uuid || !mncList || !eventTime || !mcc) {
      return sendError(res, 400, 'BAD_REQUEST', 'messageType, msisdn, sign, uuid, data.mncList, data.eventTime, data.mcc are required.')
    }
    if (!validateWebhookTimestamp(res, occurredAt, WX_WEBHOOK_MAX_AGE_MINUTES)) return
    const isDuplicate = await isDuplicateEventByPayloadField({
      supabase,
      eventType: 'SIM_ONLINE',
      field: 'uuid',
      value: uuid,
    })
    if (isDuplicate) {
      return res.json({ success: true, duplicate: true })
    }
    const rows = await supabase.select('sims', `select=sim_id,iccid,enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      const demoList = (process.env.DEMO_SIMS || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      if (demoList.includes(iccid)) {
        return res.json({ success: true, demo: true })
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    await supabase.insert('events', {
      event_type: 'SIM_ONLINE',
      occurred_at: occurredAt,
      tenant_id: sim.enterprise_id ?? null,
      request_id: getTraceId(res),
      payload: { iccid, messageType, msisdn, mncList, mcc, eventTime, uuid },
    }, { returning: 'minimal' })
    await supabase.insert('audit_logs', {
      actor_role: 'SYSTEM',
      tenant_id: sim.enterprise_id ?? null,
      action: 'WX_WEBHOOK_SIM_ONLINE',
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: getTraceId(res),
      source_ip: req.ip,
    }, { returning: 'minimal' })
    res.json({ success: true })
  })
  app.post('/v1/wx/webhook/sim-status-changed', async (req: any, res: any) => {
    if (!requireWxWebhookKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const iccid = requireIccid(res, req.body?.iccid)
    const messageType = String(req.body?.messageType || '').trim()
    const msisdn = String(req.body?.msisdn || '').trim()
    const sign = String(req.body?.sign || '').trim()
    const uuid = String(req.body?.uuid || '').trim()
    const data = req.body?.data ?? {}
    const toStatus = String(data?.toStatus || '').trim()
    const fromStatus = String(data?.fromStatus || '').trim()
    const eventTime = String(data?.eventTime || '').trim()
    const transactionId = String(data?.transactionId || '').trim()
    const occurredAt = eventTime ? toIsoDateTime(eventTime) : new Date().toISOString()
    if (!iccid) return
    if (!messageType || !msisdn || !sign || !uuid || !toStatus || !fromStatus || !eventTime || !transactionId) {
      return sendError(res, 400, 'BAD_REQUEST', 'messageType, msisdn, sign, uuid, data.toStatus, data.fromStatus, data.eventTime, data.transactionId are required.')
    }
    if (!validateWebhookTimestamp(res, occurredAt, WX_WEBHOOK_MAX_AGE_MINUTES)) return
    const isDuplicate = await isDuplicateEventByPayloadField({
      supabase,
      eventType: 'WX_SIM_STATUS_CHANGED',
      field: 'transactionId',
      value: transactionId,
    })
    if (isDuplicate) {
      return res.json({ success: true, duplicate: true })
    }
    const rows = await supabase.select('sims', `select=sim_id,iccid,enterprise_id,upstream_status,upstream_info&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      const demoList = (process.env.DEMO_SIMS || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      if (demoList.includes(iccid)) {
        return res.json({ success: true, demo: true })
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
      upstream_status: toStatus,
      upstream_info: {
        toStatus,
        fromStatus,
        transactionId,
        eventTime: occurredAt,
      },
    }, { returning: 'minimal' })
    await supabase.insert('events', {
      event_type: 'WX_SIM_STATUS_CHANGED',
      occurred_at: occurredAt,
      tenant_id: sim.enterprise_id ?? null,
      request_id: getTraceId(res),
      payload: {
        iccid,
        messageType,
        msisdn,
        toStatus,
        fromStatus,
        transactionId,
        eventTime: occurredAt,
        uuid,
      },
    }, { returning: 'minimal' })
    await supabase.insert('audit_logs', {
      actor_role: 'SYSTEM',
      tenant_id: sim.enterprise_id ?? null,
      action: 'WX_WEBHOOK_SIM_STATUS_CHANGED',
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: getTraceId(res),
      source_ip: req.ip,
    }, { returning: 'minimal' })
    res.json({ success: true })
  })
  app.post('/v1/wx/webhook/traffic-alert', async (req: any, res: any) => {
    if (!requireWxWebhookKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const iccid = requireIccid(res, req.body?.iccid)
    const messageType = String(req.body?.messageType || '').trim()
    const msisdn = String(req.body?.msisdn || '').trim()
    const sign = String(req.body?.sign || '').trim()
    const uuid = String(req.body?.uuid || '').trim()
    const data = req.body?.data ?? {}
    const thresholdReached = String(data?.thresholdReached || '').trim()
    const eventTime = String(data?.eventTime || '').trim()
    const limit = String(data?.limit || '').trim()
    const eventName = String(data?.eventName || '').trim()
    const balanceAmount = String(data?.balanceAmount || '').trim()
    const addOnID = String(data?.addOnID || '').trim()
    const occurredAt = eventTime ? toIsoDateTime(eventTime) : new Date().toISOString()
    if (!iccid) return
    if (!messageType || !msisdn || !sign || !uuid || !thresholdReached || !eventTime || !limit || !eventName || !balanceAmount || !addOnID) {
      return sendError(res, 400, 'BAD_REQUEST', 'messageType, msisdn, sign, uuid, data.thresholdReached, data.eventTime, data.limit, data.eventName, data.balanceAmount, data.addOnID are required.')
    }
    if (!validateWebhookTimestamp(res, occurredAt, WX_WEBHOOK_MAX_AGE_MINUTES)) return
    const isDuplicate = await isDuplicateEventByPayloadField({
      supabase,
      eventType: 'TRAFFIC_ALERT',
      field: 'uuid',
      value: uuid,
    })
    if (isDuplicate) {
      return res.json({ success: true, duplicate: true })
    }
    const rows = await supabase.select('sims', `select=sim_id,iccid,enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      const demoList = (process.env.DEMO_SIMS || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      if (demoList.includes(iccid)) {
        return res.json({ success: true, demo: true })
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    await supabase.insert('events', {
      event_type: 'TRAFFIC_ALERT',
      occurred_at: occurredAt,
      tenant_id: sim.enterprise_id ?? null,
      request_id: getTraceId(res),
      payload: { iccid, messageType, msisdn, thresholdReached, eventTime, limit, eventName, balanceAmount, addOnID, uuid },
    }, { returning: 'minimal' })
    await supabase.insert('audit_logs', {
      actor_role: 'SYSTEM',
      tenant_id: sim.enterprise_id ?? null,
      action: 'WX_WEBHOOK_TRAFFIC_ALERT',
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: getTraceId(res),
      source_ip: req.ip,
    }, { returning: 'minimal' })
    res.json({ success: true })
  })
  app.post('/v1/wx/webhook/product-order', async (req: any, res: any) => {
    if (!requireWxWebhookKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const iccid = requireIccid(res, req.body?.iccid)
    const messageType = String(req.body?.messageType || '').trim()
    const msisdn = String(req.body?.msisdn || '').trim()
    const sign = String(req.body?.sign || '').trim()
    const uuid = String(req.body?.uuid || '').trim()
    const data = req.body?.data ?? {}
    const addOnId = String(data?.addOnId || '').trim()
    const addOnType = String(data?.addOnType || '').trim()
    const startDate = String(data?.startDate || '').trim()
    const transactionId = String(data?.transactionId || '').trim()
    const expirationDate = String(data?.expirationDate || '').trim()
    const occurredAt = startDate ? toIsoDateTime(startDate) : new Date().toISOString()
    if (!iccid) return
    if (!messageType || !msisdn || !sign || !uuid || !addOnId || !addOnType || !startDate || !transactionId || !expirationDate) {
      return sendError(res, 400, 'BAD_REQUEST', 'messageType, msisdn, sign, uuid, data.addOnId, data.addOnType, data.startDate, data.transactionId, data.expirationDate are required.')
    }
    if (!validateWebhookTimestamp(res, occurredAt, WX_WEBHOOK_MAX_AGE_MINUTES)) return
    const isDuplicate = await isDuplicateEventByPayloadField({
      supabase,
      eventType: 'PRODUCT_ORDERED',
      field: 'transactionId',
      value: transactionId,
    })
    if (isDuplicate) {
      return res.json({ success: true, duplicate: true })
    }
    const rows = await supabase.select('sims', `select=sim_id,iccid,enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      const demoList = (process.env.DEMO_SIMS || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      if (demoList.includes(iccid)) {
        return res.json({ success: true, demo: true })
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    await supabase.insert('events', {
      event_type: 'PRODUCT_ORDERED',
      occurred_at: occurredAt,
      tenant_id: sim.enterprise_id ?? null,
      request_id: getTraceId(res),
      payload: { iccid, messageType, msisdn, addOnId, addOnType, startDate, transactionId, expirationDate, uuid },
    }, { returning: 'minimal' })
    await supabase.insert('audit_logs', {
      actor_role: 'SYSTEM',
      tenant_id: sim.enterprise_id ?? null,
      action: 'WX_WEBHOOK_PRODUCT_ORDERED',
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: getTraceId(res),
      source_ip: req.ip,
    }, { returning: 'minimal' })
    res.json({ success: true })
  })
  app.post('/v1/share-links', async (req: any, res: any) => {
    const enterpriseId = getEnterpriseIdFromReq(req)
    if (!enterpriseId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
    }
    const baseUrl = buildBaseUrl(req)
    const kind = String(req.body?.kind || '')
    const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : null
    const visibility = req.body?.visibility ? String(req.body.visibility) : 'tenant'
    const ttlHoursNumber = Number(req.body?.ttlHours)
    const ttlHours = Number.isFinite(ttlHoursNumber) && ttlHoursNumber > 0 ? Math.min(ttlHoursNumber, 24 * 30) : 24 * 7
    if (!['packages', 'packageVersions'].includes(kind) || !params) {
      return sendError(res, 400, 'BAD_REQUEST', 'kind and params are required.')
    }
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString()
    const code = genShareCode()
    const entry = { kind, params, tenantId: enterpriseId, visibility, expiresAt, createdAt: now.toISOString() }
    if (isSupabaseConfiguredForWrite()) {
      try {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        await supabase.insert('share_links', {
          code,
          kind,
          params,
          tenant_id: enterpriseId,
          visibility,
          expires_at: expiresAt,
          created_at: entry.createdAt,
          created_by_role: 'ENTERPRISE',
        }, { returning: 'minimal' })
        return res.json({ code, url: `${baseUrl}/v1/s/${code}` })
      } catch {}
    }
    shareStore.set(code, entry)
    res.json({ code, url: `${baseUrl}/v1/s/${code}` })
  })
  app.get('/v1/s/:code.json', async (req: any, res: any) => {
    const enterpriseId = getEnterpriseIdFromReq(req)
    const code = String(req.params?.code || '')
    let row: any = null
    if (isSupabaseConfiguredForWrite()) {
      try {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const rows = await supabase.select('share_links', `select=code,kind,params,tenant_id,visibility,expires_at&code=eq.${encodeURIComponent(code)}&limit=1`)
        row = Array.isArray(rows) ? rows[0] : null
      } catch {}
    }
    const entry = row ? {
      kind: row.kind,
      params: row.params,
      tenantId: row.tenant_id ?? null,
      visibility: row.visibility || 'tenant',
      expiresAt: row.expires_at ?? null,
    } : shareStore.get(code)
    if (!entry) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'share code not found.')
    }
    if (entry.expiresAt) {
      const t = new Date(entry.expiresAt).getTime()
      if (Number.isFinite(t) && t < Date.now()) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'share code expired.')
      }
    }
    const vis = String(entry.visibility || 'tenant')
    if (vis === 'tenant') {
      if (!enterpriseId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required to open this link.')
      }
      if (String(entry.tenantId || '') !== String(enterpriseId)) {
        return sendError(res, 403, 'FORBIDDEN', 'This link belongs to a different tenant.')
      }
    }
    res.json({ kind: entry.kind, params: entry.params })
  })
  app.get('/v1/s/:code', async (req: any, res: any) => {
    const enterpriseId = getEnterpriseIdFromReq(req)
    const baseUrl = buildBaseUrl(req)
    const code = String(req.params?.code || '')
    let row: any = null
    if (isSupabaseConfiguredForWrite()) {
      try {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const rows = await supabase.select('share_links', `select=code,tenant_id,visibility,expires_at&code=eq.${encodeURIComponent(code)}&limit=1`)
        row = Array.isArray(rows) ? rows[0] : null
      } catch {}
    }
    const entry = row ? {
      tenantId: row.tenant_id ?? null,
      visibility: row.visibility || 'tenant',
      expiresAt: row.expires_at ?? null,
    } : shareStore.get(code)
    if (!entry) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'share code not found.')
    }
    if (entry.expiresAt) {
      const t = new Date(entry.expiresAt).getTime()
      if (Number.isFinite(t) && t < Date.now()) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'share code expired.')
      }
    }
    const vis = String(entry.visibility || 'tenant')
    if (vis === 'tenant') {
      if (!enterpriseId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required to open this link.')
      }
      if (String(entry.tenantId || '') !== String(enterpriseId)) {
        return sendError(res, 403, 'FORBIDDEN', 'This link belongs to a different tenant.')
      }
    }
    res.redirect(`${baseUrl}/v1/docs?shareCode=${encodeURIComponent(code)}`)
  })
  app.post('/v1/cmp/webhook/sim-status-changed', async (req: any, res: any) => {
    if (!requireCmpWebhookKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const iccid = requireIccid(res, req.body?.iccid)
    const newStatus = String(req.body?.status || '')
    if (!iccid) return
    if (!newStatus || !['INVENTORY', 'TEST_READY', 'ACTIVATED', 'DEACTIVATED', 'RETIRED'].includes(newStatus)) {
      return sendError(res, 400, 'BAD_REQUEST', 'status must be INVENTORY, TEST_READY, ACTIVATED, DEACTIVATED, or RETIRED.')
    }
    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,status,enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    if (sim.status === newStatus) {
      return res.json({ success: true, changed: false })
    }
    const nowIso = new Date().toISOString()
    await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
      status: newStatus,
      last_status_change_at: nowIso,
    }, { returning: 'minimal' })
    await supabase.insert('sim_state_history', {
      sim_id: sim.sim_id,
      before_status: sim.status,
      after_status: newStatus,
      start_time: nowIso,
      source: 'CMP_WEBHOOK',
      request_id: getTraceId(res),
    }, { returning: 'minimal' })
    await supabase.insert('events', {
      event_type: 'SIM_STATUS_CHANGED',
      occurred_at: nowIso,
      tenant_id: sim.enterprise_id ?? null,
      request_id: getTraceId(res),
      payload: {
        iccid: sim.iccid,
        beforeStatus: sim.status,
        afterStatus: newStatus,
        reason: 'CMP_WEBHOOK',
      },
    }, { returning: 'minimal' })
    await supabase.insert('audit_logs', {
      actor_role: 'SYSTEM',
      tenant_id: sim.enterprise_id ?? null,
      action: 'CMP_WEBHOOK_SIM_STATUS_CHANGED',
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: getTraceId(res),
      source_ip: req.ip,
    }, { returning: 'minimal' })
    res.json({ success: true, changed: true })
  })
  app.get('/ready', async (_req, res) => {
    const details: {
      config: {
        supabaseUrl: boolean
        supabaseAnonKey: boolean
        wxzhonggengUrl: boolean
        wxzhonggengTokenUrl: boolean
      }
      upstream: {
        supabase: boolean | null
        wxzhonggeng: boolean | null
      }
    } = {
      config: {
        supabaseUrl: Boolean(process.env.SUPABASE_URL),
        supabaseAnonKey: Boolean(process.env.SUPABASE_ANON_KEY),
        wxzhonggengUrl: Boolean(process.env.WXZHONGGENG_URL),
        wxzhonggengTokenUrl: Boolean(process.env.WXZHONGGENG_TOKEN_URL),
      },
      upstream: {
        supabase: null,
        wxzhonggeng: null,
      },
    }
    const supabaseConfigured = details.config.supabaseUrl && details.config.supabaseAnonKey
    let upstreamReady = null
    if (supabaseConfigured) {
      try {
        const supabase = createSupabaseRestClient({ traceId: getTraceId(res) })
        await supabase.selectWithCount('sims', 'select=sim_id&limit=1')
        upstreamReady = true
      } catch {
        upstreamReady = false
      }
      details.upstream.supabase = upstreamReady
    }
    const wxConfigured = details.config.wxzhonggengUrl && details.config.wxzhonggengTokenUrl
    if (wxConfigured) {
      try {
        const client = createWxzhonggengAdapter()
        const ok = await client.ping()
        details.upstream.wxzhonggeng = ok === true
      } catch {
        details.upstream.wxzhonggeng = false
      }
    }
    const ok = supabaseConfigured ? upstreamReady === true : true
    res.status(ok ? 200 : 503).send({ ok, details })
  })

  async function serveOpenApiYaml(req: FastifyRequest, res: FastifyReply) {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const yamlPath = path.resolve(here, '..', 'iot-cmp-api.yaml')
    const baseUrl = buildBaseUrl(req)
    const original = await readFile(yamlPath, 'utf8')
    const localServersBlock = `servers:\n  - url: ${baseUrl}/v1\n    description: Local Server\n`
    let yaml = original.replaceAll('\r\n', '\n')
    const m = yaml.match(/(^|\n)servers:\n([\s\S]*?)(\nsecurity:\n)/)
    if (m) {
      yaml = yaml.replace(m[0], `${m[1]}${localServersBlock}${m[3]}`)
    } else {
      yaml = `${localServersBlock}\n${original}`
    }
    res.header('Content-Type', 'application/yaml; charset=utf-8').send(yaml)
  }

  function serveDocs(req: FastifyRequest, res: FastifyReply) {
    const baseUrl = buildBaseUrl(req)
    const openapiUrl = `${baseUrl}/v1/openapi.yaml`
    const tokenUrl = `${baseUrl}/auth/token`
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API Docs</title>
    <link rel="stylesheet" href="${baseUrl}/v1/docs/assets/swagger-ui.css" />
    <style>
      body { margin: 0; }
      .cmp-toolbar {
        padding: 10px 16px;
        border-bottom: 1px solid #e5e7eb;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
      }
      .cmp-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .cmp-row input { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; min-width: 240px; }
      .cmp-row button { padding: 6px 10px; border: 1px solid #111827; background: #111827; color: #fff; border-radius: 6px; cursor: pointer; }
      .cmp-row button.secondary { background: #fff; color: #111827; }
      .cmp-hint { margin-top: 8px; color: #4b5563; font-size: 12px; }
      .cmp-status { margin-left: 8px; font-size: 12px; color: #111827; }
    </style>
  </head>
  <body>
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>Auth</strong>
        <input id="clientId" placeholder="AUTH_CLIENT_ID" />
        <input id="clientSecret" placeholder="AUTH_CLIENT_SECRET" type="password" />
        <button id="getToken">Get Token</button>
        <button id="clearToken" class="secondary">Clear</button>
        <button id="validateToken" class="secondary">Validate Token</button>
        <span id="status" class="cmp-status"></span>
      </div>
      <div class="cmp-hint">Uses <code>${tokenUrl}</code> and pre-fills Swagger "BearerAuth" automatically. Token is stored in <code>localStorage</code> for this origin.</div>
    </div>
    <div id="swagger-ui"></div>
    <script src="${baseUrl}/v1/docs/assets/swagger-ui-bundle.js"></script>
    <script>
      const STORAGE_KEY = 'cmp_bearer_token'
      const statusEl = document.getElementById('status')
      const clientIdInput = document.getElementById('clientId')
      const clientSecretInput = document.getElementById('clientSecret')
      const getTokenBtn = document.getElementById('getToken')
      const clearTokenBtn = document.getElementById('clearToken')
      const validateTokenBtn = document.getElementById('validateToken')

      function setStatus(text) {
        statusEl.textContent = text || ''
      }

      function getStoredToken() {
        try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
      }

      function setStoredToken(token) {
        try { localStorage.setItem(STORAGE_KEY, token) } catch {}
      }

      function clearStoredToken() {
        try { localStorage.removeItem(STORAGE_KEY) } catch {}
      }

      function preauthorizeIfPossible(ui) {
        const token = getStoredToken()
        if (token) {
          try {
            ui.preauthorizeApiKey('BearerAuth', token)
            setStatus('Authorized')
          } catch {
            setStatus('Token stored (manual authorize may be needed)')
          }
        }
      }

      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(openapiUrl)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout',
        onComplete: function() {
          preauthorizeIfPossible(window.ui)
        }
      })

      async function postJson(url, body) {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        })
        const text = await r.text()
        const json = text ? JSON.parse(text) : {}
        if (!r.ok) {
          throw new Error(json?.message || text || ('Request failed: ' + r.status))
        }
        return json
      }

      async function handleGetToken() {
        const clientId = clientIdInput.value.trim()
        const clientSecret = clientSecretInput.value.trim()
        if (!clientId || !clientSecret) {
          setStatus('Missing clientId or clientSecret')
          return
        }
        setStatus('Requesting token...')
        try {
          const result = await postJson('${tokenUrl}', { clientId, clientSecret })
          const token = result?.accessToken || result?.token
          if (!token) {
            setStatus('No token in response')
            return
          }
          setStoredToken(token)
          setStatus('Token stored')
          try {
            window.ui.preauthorizeApiKey('BearerAuth', token)
            setStatus('Authorized')
          } catch {}
        } catch (err) {
          setStatus(err?.message || String(err))
        }
      }

      async function handleValidateToken() {
        const token = getStoredToken()
        if (!token) {
          setStatus('No token to validate')
          return
        }
        try {
          const payload = token.split('.')[1]
          const json = JSON.parse(atob(payload))
          if (!json?.exp) {
            setStatus('Token missing exp')
            return
          }
          const exp = Number(json.exp) * 1000
          const now = Date.now()
          if (now >= exp) {
            setStatus('Token expired')
          } else {
            const remaining = Math.max(0, Math.floor((exp - now) / 1000))
            setStatus('Token valid (' + remaining + 's remaining)')
          }
        } catch {
          setStatus('Token parse failed')
        }
      }

      function handleClearToken() {
        clearStoredToken()
        setStatus('Cleared token')
      }

      getTokenBtn.addEventListener('click', handleGetToken)
      clearTokenBtn.addEventListener('click', handleClearToken)
      validateTokenBtn.addEventListener('click', handleValidateToken)
    </script>
  </body>
</html>`
    res.header('Content-Type', 'text/html; charset=utf-8').send(html)
  }

  app.get('/openapi.yaml', serveOpenApiYaml)
  app.get('/v1/openapi.yaml', serveOpenApiYaml)
  app.get('/metrics', async (_req, res) => {
    const sorted = metrics.durations.slice().sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const p99 = percentile(sorted, 0.99)
    const out: string[] = []
    out.push(`# HELP cmp_requests_total Total number of HTTP requests`)
    out.push(`# TYPE cmp_requests_total counter`)
    out.push(`cmp_requests_total ${metrics.count}`)
    out.push(`# HELP cmp_requests_errors_total Total number of 5xx responses`)
    out.push(`# TYPE cmp_requests_errors_total counter`)
    out.push(`cmp_requests_errors_total ${metrics.errorCount}`)
    out.push(`# HELP cmp_requests_rate_limited_total Total number of 429 responses`)
    out.push(`# TYPE cmp_requests_rate_limited_total counter`)
    out.push(`cmp_requests_rate_limited_total ${metrics.rateLimitedCount}`)
    out.push(`# HELP cmp_auth_failures_total Total number of auth failures (401)`)
    out.push(`# TYPE cmp_auth_failures_total counter`)
    out.push(`cmp_auth_failures_total ${metrics.authFailureCount}`)
    out.push(`# HELP cmp_latency_ms Summary of request durations in milliseconds`)
    out.push(`# TYPE cmp_latency_ms summary`)
    out.push(`cmp_latency_ms{quantile="0.5"} ${p50}`)
    out.push(`cmp_latency_ms{quantile="0.95"} ${p95}`)
    out.push(`cmp_latency_ms{quantile="0.99"} ${p99}`)
    const buckets = [50, 100, 200, 500, 1000, 2000, 5000]
    const hist = buildHistogram(metrics.durations, buckets)
    out.push(`# HELP cmp_latency_ms_bucket Latency histogram buckets`)
    out.push(`# TYPE cmp_latency_ms_bucket histogram`)
    for (let i = 0; i < buckets.length; i++) {
      out.push(`cmp_latency_ms_bucket{le="${buckets[i]}"} ${hist.counts[i]}`)
    }
    out.push(`cmp_latency_ms_bucket{le="+Inf"} ${hist.count}`)
    out.push(`cmp_latency_ms_sum ${hist.sum}`)
    out.push(`cmp_latency_ms_count ${hist.count}`)
    out.push(`# HELP cmp_requests_labeled_total Total requests by method/route/status_class`)
    out.push(`# TYPE cmp_requests_labeled_total counter`)
    for (const [key, val] of metrics.byLabel.entries()) {
      const [method, route, statusClass] = key.split('|')
      out.push(`cmp_requests_labeled_total{method="${method}",route="${route}",status_class="${statusClass}"} ${val.count}`)
      const s = val.durations.slice().sort((a, b) => a - b)
      const q50 = percentile(s, 0.5)
      const q95 = percentile(s, 0.95)
      const q99 = percentile(s, 0.99)
      out.push(`cmp_latency_ms_labeled{method="${method}",route="${route}",status_class="${statusClass}",quantile="0.5"} ${q50}`)
      out.push(`cmp_latency_ms_labeled{method="${method}",route="${route}",status_class="${statusClass}",quantile="0.95"} ${q95}`)
      out.push(`cmp_latency_ms_labeled{method="${method}",route="${route}",status_class="${statusClass}",quantile="0.99"} ${q99}`)
    }
    let alertMetrics = null
    try {
      alertMetrics = await loadAlertMetrics(getTraceId(res))
    } catch {
      alertMetrics = null
    }
    if (alertMetrics) {
      out.push(`# HELP cmp_alerts_window_total Alerts by type and status in last 24h`)
      out.push(`# TYPE cmp_alerts_window_total gauge`)
      for (const row of alertMetrics.byTypeStatus) {
        out.push(
          `cmp_alerts_window_total{alert_type="${row.alertType}",status="${row.status}",window="${alertMetrics.window}"} ${row.count}`
        )
      }
      out.push(`# HELP cmp_alerts_severity_window_total Alerts by severity in last 24h`)
      out.push(`# TYPE cmp_alerts_severity_window_total gauge`)
      for (const row of alertMetrics.bySeverity) {
        out.push(`cmp_alerts_severity_window_total{severity="${row.severity}",window="${alertMetrics.window}"} ${row.count}`)
      }
      out.push(`# HELP cmp_alert_events_window_total Alert events in last 24h`)
      out.push(`# TYPE cmp_alert_events_window_total gauge`)
      out.push(
        `cmp_alert_events_window_total{event_type="ALERT_TRIGGERED",window="${alertMetrics.window}"} ${alertMetrics.alertEventCount}`
      )
    }
    res.header('Content-Type', 'text/plain; charset=utf-8').send(`${out.join('\n')}\n`)
  })
  app.get('/docs', serveDocs)
  app.get('/v1/docs', serveDocs)
  app.get('/favicon.ico', async (_req, res) => res.status(204).send())
  {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const swaggerDist = path.resolve(here, '..', 'node_modules', 'swagger-ui-dist')
    app.get('/v1/docs/assets/swagger-ui-bundle.js', async (_req, res) => {
      try {
        const jsPath = path.resolve(swaggerDist, 'swagger-ui-bundle.js')
        const content = await readFile(jsPath, 'utf8')
        res.header('Content-Type', 'application/javascript; charset=utf-8').send(content)
      } catch {
        res.status(404).send()
      }
    })
    app.get('/docs/assets/swagger-ui-bundle.js', async (_req, res) => {
      try {
        const jsPath = path.resolve(swaggerDist, 'swagger-ui-bundle.js')
        const content = await readFile(jsPath, 'utf8')
        res.header('Content-Type', 'application/javascript; charset=utf-8').send(content)
      } catch {
        res.status(404).send()
      }
    })
    app.get('/v1/docs/assets/swagger-ui.css', async (_req, res) => {
      try {
        const cssPath = path.resolve(swaggerDist, 'swagger-ui.css')
        const content = await readFile(cssPath, 'utf8')
        res.header('Content-Type', 'text/css; charset=utf-8').send(content)
      } catch {
        res.status(404).send()
      }
    })
    app.get('/docs/assets/swagger-ui.css', async (_req, res) => {
      try {
        const cssPath = path.resolve(swaggerDist, 'swagger-ui.css')
        const content = await readFile(cssPath, 'utf8')
        res.header('Content-Type', 'text/css; charset=utf-8').send(content)
      } catch {
        res.status(404).send()
      }
    })
  }
  app.get('/health', async () => ({ ok: true }))
  return app
}
