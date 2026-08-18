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
import { requestPasswordReset, resetPasswordWithToken } from './services/passwordReset.js'
import { parsePagination } from './utils/pagination.js'
import { registerSimPhase4Routes } from './routes/simPhase4.js'
import { registerSimDiagnosticsRoutes } from './routes/simDiagnostics.js'
import { registerJobRoutes } from './routes/jobs.js'
import { registerPricePlanRoutes } from './routes/pricePlans.js'
import { registerPackageRoutes } from './routes/packages.js'
import { registerRatingFallbackPackageRoutes } from './routes/ratingFallbackPackages.js'
import { registerPackageModuleRoutes } from './routes/packageModules.js'
import { registerNetworkProfileRoutes } from './routes/networkProfiles.js'
import { registerSubscriptionRoutes } from './routes/subscriptions.js'
import { registerReconciliationRoutes } from './routes/reconciliation.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { registerEventRoutes } from './routes/events.js'
import { registerAlertRoutes } from './routes/alerts.js'
import { registerAlertConfigRoutes } from './routes/alertConfigs.js'
import { registerAlertConfigurationRoutes } from './routes/alertConfigurations.js'
import { registerVendorMappingRoutes } from './routes/vendorMappings.js'
import { registerPublicInfoRoutes } from './routes/publicInfos.js'
import { registerUpstreamIntegrationRoutes } from './routes/upstreamIntegrations.js'
import { registerUpstreamWebhookEventRoutes } from './routes/upstreamWebhookEvents.js'
import { registerBillingRoutes } from './routes/billing.js'
import { registerBillRoutes } from './routes/bills.js'
import { registerAdjustmentNoteRoutes } from './routes/adjustmentNotes.js'
import { registerReportRoutes } from './routes/reports.js'
import { registerAdminObservabilityRoutes } from './routes/adminObservability.js'
import { registerAdminTestReadyExpiryRoutes } from './routes/adminTestReadyExpiry.js'
import { registerAdminSimBackdateTestStartRoutes } from './routes/adminSimBackdateTestStart.js'
import { registerAdminWxRoutes } from './routes/adminWx.js'
import { getEnterpriseDunningSummary } from './services/dunning.js'
import { validateInboundWebhookGate } from './services/inboundWebhookGate.js'
import { resolveInboundWebhookHandler } from './services/inboundWebhookDispatch.js'
import type { WxInboundWebhookDeps } from './services/wxzhonggengInboundWebhook.js'
import { createSupplierAdapter } from './vendors/registry.js'
import { loadUpstreamIntegrationRuntime } from './services/upstreamIntegration.js'
import { buildReadyProbeResponse } from './services/readyProbe.js'
import { resolveEventScopeColumns, sanitizeEventPayload } from './services/eventEmitter.js'
import { rewriteColonCatalogUrl } from './colonUrlRewrite.js'
import { getInboundWebhookKeyFromReq } from './utils/inboundWebhookAuth.js'
import { buildEventsSwaggerLinkageScript } from './swagger/buildEventsSwaggerLinkageScript.js'

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

function buildSimTenantFilter(
  req: FastifyRequest,
  enterpriseId: string | null,
  options?: { mode?: 'default' | 'lifecycle' },
) {
  const mode = options?.mode ?? 'default'
  const roleScope = getRoleScope(req)
  const parts: string[] = []

  if (mode === 'lifecycle' && (roleScope === 'reseller' || roleScope === 'platform')) {
    if (enterpriseId) {
      parts.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    }
    return parts.length ? `&${parts.join('&')}` : ''
  }

  if (enterpriseId) parts.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  if (roleScope === 'department') {
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

/** Plaintext password for `POST .../users` create; hashed with `hashSecretScrypt` into `users.password_hash`. */
function readCreateUserPassword(body: Record<string, unknown> | undefined | null): { ok: true; password: string } | { ok: false; message: string } {
  const raw = body?.password
  if (typeof raw !== 'string') return { ok: false, message: 'password is required.' }
  const password = raw
  if (password.length < 8) return { ok: false, message: 'password must be at least 8 characters.' }
  if (password.length > 256) return { ok: false, message: 'password must be at most 256 characters.' }
  return { ok: true, password }
}

/** New password for `POST .../auth/change-password` (self-service). */
function readChangePasswordNewPassword(body: Record<string, unknown> | undefined | null): { ok: true; password: string } | { ok: false; message: string } {
  const raw = body?.newPassword
  if (typeof raw !== 'string') return { ok: false, message: 'newPassword is required.' }
  const password = raw
  if (password.length < 8) return { ok: false, message: 'newPassword must be at least 8 characters.' }
  if (password.length > 256) return { ok: false, message: 'newPassword must be at most 256 characters.' }
  return { ok: true, password }
}

/** Map reseller ref to RESELLER `tenants.tenant_id` (parent of ENTERPRISE). Ref MUST be tenant UUID — not `resellers.id`. */
type ResellerEnterpriseResolve =
  | { ok: true; parentTenantId: string; resellerRowId: string | null }
  | { ok: false; reason: 'not_found' | 'deactivated' }

async function resolveResellerForEnterpriseScope(supabase: SupabaseClient, ref: string): Promise<ResellerEnterpriseResolve> {
  const r = String(ref || '').trim()
  if (!r) return { ok: false, reason: 'not_found' }

  const tenantRows = await supabase.select(
    'tenants',
    `select=tenant_id&tenant_id=eq.${encodeURIComponent(r)}&tenant_type=eq.RESELLER&limit=1`
  )
  if (!Array.isArray(tenantRows) || !(tenantRows[0] as { tenant_id?: string })?.tenant_id) {
    return { ok: false, reason: 'not_found' }
  }
  const tid = String((tenantRows[0] as { tenant_id: string }).tenant_id)
  const resRows = await supabase.select('resellers', `select=id,status&tenant_id=eq.${encodeURIComponent(tid)}&limit=1`)
  const resRow = Array.isArray(resRows) ? (resRows[0] as { id?: string; status?: string } | undefined) : undefined
  if (resRow && String(resRow.status || '').toUpperCase() === 'DEACTIVATED') {
    return { ok: false, reason: 'deactivated' }
  }
  return {
    ok: true,
    parentTenantId: tid,
    resellerRowId: resRow?.id ? String(resRow.id) : null,
  }
}

function isMissingTableError(err: any, tableName: string) {
  const code = String(err?.code ?? err?.body?.code ?? '')
  const message = String(err?.body?.message ?? err?.message ?? err?.body ?? '')
  const marker = `public.${tableName}`
  return (code === 'PGRST205' || message.includes('Could not find the table')) && message.includes(marker)
}

function getEnvTrim(name: string) {
  const v = process.env[name]
  if (v === undefined || v === null) return ''
  return String(v).trim()
}

function getEnvNumber(name: string, defaultValue: number) {
  const v = getEnvTrim(name)
  if (!v) return defaultValue
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : defaultValue
}

function buildBaseUrl(req: FastifyRequest) {
  const rawHost = req.headers['x-forwarded-host'] ?? req.headers['host']
  const host = Array.isArray(rawHost) ? rawHost[0] : rawHost ? String(rawHost) : ''
  const rawProto = req.headers['x-forwarded-proto']
  const headerProto = rawProto ? String(Array.isArray(rawProto) ? rawProto[0] : rawProto).split(',')[0].trim() : req.protocol
  const publicIp = getEnvTrim('PUBLIC_IP')
  const port = getEnvTrim('PORT') || '3000'
  const proto = getEnvTrim('PUBLIC_PROTO') || headerProto || 'http'
  const isLocalHost = host && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))
  if (publicIp && host && host.endsWith(`:${port}`) && !isLocalHost) {
    return `${proto}://${publicIp}:${port}`
  }
  const fallbackHost = host || `localhost:${port}`
  return `${proto}://${fallbackHost}`
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

function isPlatformAdminRequest(req: FastifyRequest) {
  const auth = getAuthContext(req)
  const roleScope = auth.roleScope ? String(auth.roleScope) : ''
  const role = auth.role ? String(auth.role) : ''
  return roleScope === 'platform' || role === 'platform_admin'
}

function requireAdminApiKey(req: FastifyRequest, res: FastifyReply) {
  const actual = getAdminApiKeyFromReq(req)
  const expected = getEnvTrim('ADMIN_API_KEY')

  // Channel 1: static admin API key.
  if (actual) {
    if (expected && actual === expected) return true
    sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
    return false
  }

  // Channel 2: platform admin bearer token.
  if (isPlatformAdminRequest(req)) return true

  sendError(res, 403, 'FORBIDDEN', 'Platform admin credentials required.')
  return false
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

function isAuthConfigured() {
  return Boolean(getEnvTrim('AUTH_TOKEN_SECRET') && getEnvTrim('AUTH_CLIENT_ID') && getEnvTrim('AUTH_CLIENT_SECRET'))
}

function isDbAuthConfigured() {
  return Boolean(getEnvTrim('AUTH_TOKEN_SECRET') && process.env.SUPABASE_SERVICE_ROLE_KEY && getEnvTrim('AUTH_USE_DB_CLIENTS') === '1')
}

/** Env-based M2M (`AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET`): same claims as `/auth/login` client-credentials mode. */
function buildEnvM2mTokenClaims(clientId: string, now: number, ttlSeconds: number, enterpriseId: string | null) {
  const roleScope = enterpriseId ? 'customer' : 'platform'
  const role = enterpriseId ? 'customer_m2m' : 'platform_admin'
  return {
    iss: 'iot-cmp-api',
    sub: String(clientId),
    iat: now,
    exp: now + ttlSeconds,
    email: String(clientId),
    roleScope,
    role,
    ...(enterpriseId ? { enterpriseId, customerId: enterpriseId } : {}),
  }
}

function envM2mTokenResponse(
  clientId: string,
  payload: Record<string, unknown>,
  ttlSeconds: number,
  enterpriseId: string | null,
) {
  const role = String(payload.role)
  const roleScope = String(payload.roleScope)
  return {
    accessToken: signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET')),
    expiresIn: ttlSeconds,
    tokenType: 'Bearer',
    user: {
      userId: clientId,
      email: clientId,
      role,
      roleScope,
      resellerId: null,
      customerId: enterpriseId,
    },
  }
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  reply.status(status).send({ code, message, traceId: getTraceId(reply) })
}

function getTraceId(reply: FastifyReply) {
  const value = (reply as { traceId?: string }).traceId
  if (value) return value
  const headerValue = reply.getHeader('X-Request-Id')
  return headerValue ? String(headerValue) : null
}

const MULTIPART_BODY_LIMIT_BYTES = 50 * 1024 * 1024

function readRequestBody(req: FastifyRequest, maxBytes: number) {
  const maybeBody = (req as { body?: unknown }).body
  if (Buffer.isBuffer(maybeBody)) {
    if (maybeBody.length > maxBytes) {
      return Promise.reject(new Error('PAYLOAD_TOO_LARGE'))
    }
    return Promise.resolve(maybeBody)
  }
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
  if (auth.roleScope === 'customer') {
    sendError(reply, 403, 'FORBIDDEN', 'Customer tokens are not permitted for this operation.')
    return null
  }
  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

function ensureResellerAdmin(req: FastifyRequest, reply: FastifyReply) {
  return ensureResellerRole(req, reply, new Set(['reseller_admin']))
}

function ensureResellerSales(req: FastifyRequest, reply: FastifyReply) {
  return ensureResellerRole(req, reply, new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director']))
}

function ensureSubscriptionAccess(req: FastifyRequest, reply: FastifyReply) {
  const auth = getAuthContext(req)
  if (!auth.roleScope && !auth.role) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
    return null
  }
  if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' as const }
  if (
    auth.roleScope === 'reseller' &&
    auth.role &&
    new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director']).has(auth.role)
  ) {
    return { ...auth, scope: 'reseller' as const }
  }
  if (auth.roleScope === 'customer') return { ...auth, scope: 'customer' as const }
  if (auth.roleScope === 'department') return { ...auth, scope: 'department' as const }
  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
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
      return res.send({
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
      const payload = buildEnvM2mTokenClaims(String(clientId), now, ttlSeconds, enterpriseId)
      return res.send(envM2mTokenResponse(String(clientId), payload, ttlSeconds, enterpriseId))
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
        const enterpriseId = String((row as any).enterprise_id)
        const payload = {
          iss: 'iot-cmp-api',
          sub: String(clientId),
          iat: now,
          exp: now + ttlSeconds,
          email: String(clientId),
          roleScope: 'customer',
          role: 'customer_m2m',
          enterpriseId,
          customerId: enterpriseId,
        }
        const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
        return res.send({
          accessToken: token,
          expiresIn: ttlSeconds,
          tokenType: 'Bearer',
          user: {
            userId: String(clientId),
            email: String(clientId),
            role: 'customer_m2m',
            roleScope: 'customer',
            resellerId: null,
            customerId: enterpriseId,
          },
        })
      } catch {
        const expectedClientId = getEnvTrim('AUTH_CLIENT_ID')
        const expectedClientSecret = getEnvTrim('AUTH_CLIENT_SECRET')
        if (isAuthConfigured() && clientId === expectedClientId && clientSecret === expectedClientSecret) {
          const ttlSeconds = getTokenTtlSeconds()
          const now = Math.floor(Date.now() / 1000)
          const enterpriseId = await resolveEnterpriseIdFromEnv(res)
          const payload = buildEnvM2mTokenClaims(String(clientId), now, ttlSeconds, enterpriseId)
          return res.send(envM2mTokenResponse(String(clientId), payload, ttlSeconds, enterpriseId))
        }
        return sendError(res, 502, 'UPSTREAM_ERROR', 'Auth upstream error.')
      }
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Auth is misconfigured.')
  }

  // ── Helper: determine roleScope from role name ──────────────────────
  const roleScopeFromRole = (roleName: string): string => {
    if (!roleName) return 'customer'
    if (roleName === 'platform_admin') return 'platform'
    if (roleName.startsWith('reseller_')) return 'reseller'
    if (roleName.startsWith('customer_')) return 'customer'
    return 'customer'
  }

  // ── Mode B helper: authenticate user via email + password ──────────
  const INVALID_USER_LOGIN_MESSAGE = 'Invalid email or password.'

  const authenticateUserByPassword = async (req: any, res: any, email: string, password: string) => {
    const secret = getEnvTrim('AUTH_TOKEN_SECRET')
    if (!secret) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Auth is misconfigured.')
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Database auth is not configured.')
    }

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })

    // Step 1: Look up user by email
    const userRows = await supabase.select(
      'users',
      `select=user_id,tenant_id,email,display_name,status,password_hash&email=eq.${encodeURIComponent(email)}&limit=1`
    )
    const user = Array.isArray(userRows) ? userRows[0] : null
    if (!user) {
      return sendError(res, 401, 'UNAUTHORIZED', INVALID_USER_LOGIN_MESSAGE)
    }

    // Step 2: User must be ACTIVE
    if ((user as any).status !== 'ACTIVE') {
      return sendError(res, 401, 'UNAUTHORIZED', '账户已停用')
    }

    // Step 3: Verify password hash exists and matches
    if (!(user as any).password_hash) {
      return sendError(res, 401, 'UNAUTHORIZED', INVALID_USER_LOGIN_MESSAGE)
    }
    const passwordOk = verifySecretScrypt(String(password), String((user as any).password_hash))
    if (!passwordOk) {
      return sendError(res, 401, 'UNAUTHORIZED', INVALID_USER_LOGIN_MESSAGE)
    }

    const userId = String((user as any).user_id)
    const tenantId = String((user as any).tenant_id)
    const displayName = readString((user as any).display_name)

    // Step 4: Load user's role from user_roles table
    const roleRows = await supabase.select(
      'user_roles',
      `select=role_name&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    )
    const roleRow = Array.isArray(roleRows) ? roleRows[0] : null
    const role = roleRow ? String((roleRow as any).role_name) : 'customer_ops'
    const roleScope = roleScopeFromRole(role)

    // Step 5: Resolve resellerId and customerId from tenant hierarchy
    let resellerId: string | null = null
    let customerId: string | null = null

    // Load the tenant to determine its type
    const tenantRows = await supabase.select(
      'tenants',
      `select=tenant_id,tenant_type,parent_id,enterprise_status&tenant_id=eq.${encodeURIComponent(tenantId)}&limit=1`
    )
    const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null

    if (tenant) {
      const tenantType = String((tenant as any).tenant_type)

      if (tenantType === 'RESELLER') {
        resellerId = tenantId

        const resellerRows = await supabase.select(
          'resellers',
          `select=status&tenant_id=eq.${encodeURIComponent(tenantId)}&limit=1`
        )
        const reseller = Array.isArray(resellerRows) ? resellerRows[0] : null
        if (reseller && (reseller as any).status === 'SUSPENDED') {
          return sendError(res, 401, 'UNAUTHORIZED', '账户已停用')
        }
      } else if (tenantType === 'ENTERPRISE') {
        customerId = tenantId
        if ((tenant as any).parent_id) {
          resellerId = String((tenant as any).parent_id)
          const resellerRows = await supabase.select(
            'resellers',
            `select=status&tenant_id=eq.${encodeURIComponent(resellerId)}&limit=1`
          )
          const reseller = Array.isArray(resellerRows) ? resellerRows[0] : null
          if (reseller && (reseller as any).status === 'SUSPENDED') {
            return sendError(res, 401, 'UNAUTHORIZED', '账户已停用')
          }
        }

        if ((tenant as any).enterprise_status === 'SUSPENDED' || (tenant as any).enterprise_status === 'INACTIVE') {
          return sendError(res, 401, 'UNAUTHORIZED', '账户已停用')
        }
      } else if (tenantType === 'DEPARTMENT') {
        if ((tenant as any).parent_id) {
          customerId = String((tenant as any).parent_id)

          const parentRows = await supabase.select(
            'tenants',
            `select=enterprise_status&tenant_id=eq.${encodeURIComponent(customerId)}&limit=1`
          )
          const parentTenant = Array.isArray(parentRows) ? parentRows[0] : null
          if (parentTenant && ((parentTenant as any).enterprise_status === 'SUSPENDED' || (parentTenant as any).enterprise_status === 'INACTIVE')) {
            return sendError(res, 401, 'UNAUTHORIZED', '账户已停用')
          }

          const entParentRows = await supabase.select(
            'tenants',
            `select=parent_id&tenant_id=eq.${encodeURIComponent(customerId)}&tenant_type=eq.ENTERPRISE&limit=1`
          )
          const entT = Array.isArray(entParentRows) ? entParentRows[0] : null
          if (entT && (entT as any).parent_id) {
            resellerId = String((entT as any).parent_id)
            const resellerRows = await supabase.select(
              'resellers',
              `select=status&tenant_id=eq.${encodeURIComponent(resellerId)}&limit=1`
            )
            const reseller = Array.isArray(resellerRows) ? resellerRows[0] : null
            if (reseller && (reseller as any).status === 'SUSPENDED') {
              return sendError(res, 401, 'UNAUTHORIZED', '账户已停用')
            }
          }
        }
      }
    }

    // Step 6: Sign JWT
    const ttlSeconds = getTokenTtlSeconds()
    const now = Math.floor(Date.now() / 1000)

    const payload = {
      iss: 'iot-cmp-api',
      sub: userId,
      iat: now,
      exp: now + ttlSeconds,
      userId,
      email,
      role,
      roleScope,
      ...(resellerId ? { resellerId } : {}),
      ...(customerId ? { customerId } : {}),
    }
    const token = signJwtHs256(payload, secret)

    return res.send({
      accessToken: token,
      expiresIn: ttlSeconds,
      tokenType: 'Bearer',
      user: {
        userId,
        email,
        displayName,
        role,
        roleScope,
        resellerId,
        customerId,
      },
    })
  }

  const handleAuthLogin = async (req: any, res: any) => {
    const body = req.body ?? {}
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
    const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret : ''
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    // ── Mode detection ───────────────────────────────────────────────
    const isM2M = Boolean(clientId && clientSecret)
    const isUserLogin = Boolean(email && password)

    if (!isM2M && !isUserLogin) {
      return sendError(res, 400, 'BAD_REQUEST', 'Provide either {email, password} or {clientId, clientSecret}.')
    }

    // ── Mode B: User-password login ──────────────────────────────────
    if (isUserLogin && !isM2M) {
      try {
        return await authenticateUserByPassword(req, res, email, password)
      } catch (err: any) {
        console.error('[auth/login] user login error:', err?.message ?? err)
        return sendError(res, 401, 'UNAUTHORIZED', INVALID_USER_LOGIN_MESSAGE)
      }
    }

    // ── Mode A: M2M client credentials (existing behavior) ──────────
    const ttlSeconds = getTokenTtlSeconds()
    const now = Math.floor(Date.now() / 1000)

    if (!isAuthConfigured() && !isDbAuthConfigured()) {
      const token = Buffer.from(`${clientId}:${clientSecret}:${Date.now()}`).toString('base64url')
      return res.send({
        accessToken: token,
        expiresIn: ttlSeconds,
        tokenType: 'Bearer',
        user: {
          userId: clientId,
          email: clientId,
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
      if (clientId !== expectedClientId || clientSecret !== expectedClientSecret) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials.')
      }
      const enterpriseId = await resolveEnterpriseIdFromEnv(res)
      const payload = buildEnvM2mTokenClaims(String(clientId), now, ttlSeconds, enterpriseId)
      return res.send(envM2mTokenResponse(String(clientId), payload, ttlSeconds, enterpriseId))
    }

    if (isDbAuthConfigured()) {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const rows = await supabase.select(
        'api_clients',
        `select=client_id,secret_hash,enterprise_id,status&client_id=eq.${encodeURIComponent(String(clientId))}&limit=1`
      )
      const row = Array.isArray(rows) ? rows[0] : null
      if (!row || (row as any).status !== 'ACTIVE') {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials.')
      }
      const ok = verifySecretScrypt(String(clientSecret), String((row as any).secret_hash))
      if (!ok) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials.')
      }
      const enterpriseId = readString((row as any).enterprise_id)
      let resellerId: string | null = null
      if (enterpriseId) {
        try {
          const entRows = await supabase.select(
            'tenants',
            `select=parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
          )
          const entRow = Array.isArray(entRows) ? entRows[0] : null
          if (entRow && (entRow as any).parent_id) {
            resellerId = String((entRow as any).parent_id)
          }
        } catch {}
      }
      const payload = {
        iss: 'iot-cmp-api',
        sub: String(clientId),
        iat: now,
        exp: now + ttlSeconds,
        email: clientId,
        roleScope: 'customer',
        role: 'customer_m2m',
        ...(enterpriseId ? { enterpriseId, customerId: enterpriseId } : {}),
        ...(resellerId ? { resellerId } : {}),
      }
      const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
      return res.send({
        accessToken: token,
        expiresIn: ttlSeconds,
        tokenType: 'Bearer',
        user: {
          userId: clientId,
          email: clientId,
          role: 'customer_m2m',
          roleScope: 'customer',
          resellerId,
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
    res.send({
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

  const handleAuthChangePassword = async (req: any, res: any) => {
    const auth = getAuthContext(req as FastifyRequest)
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.role === 'customer_m2m') {
      return sendError(res, 403, 'FORBIDDEN', 'Machine accounts cannot change password via this endpoint.')
    }
    const userId = auth.userId && isValidUuid(auth.userId) ? String(auth.userId).trim() : null
    if (!userId) {
      return sendError(res, 403, 'FORBIDDEN', 'Interactive user session with userId is required.')
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const newPw = readChangePasswordNewPassword(body)
    if (!currentPassword) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'currentPassword is required.')
    }
    if (!newPw.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', newPw.message)
    }
    if (currentPassword === newPw.password) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'newPassword must differ from currentPassword.')
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Database auth is not configured.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const userRows = await supabase.select(
      'users',
      `select=user_id,tenant_id,password_hash,status&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    )
    const user = Array.isArray(userRows) ? userRows[0] : null
    if (!user) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'User not found.')
    }
    if ((user as any).status !== 'ACTIVE') {
      return sendError(res, 403, 'FORBIDDEN', 'Account is not active.')
    }
    if (!(user as any).password_hash) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No password is set for this account.')
    }
    if (!verifySecretScrypt(currentPassword, String((user as any).password_hash))) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Current password is incorrect.')
    }
    await supabase.update(
      'users',
      `user_id=eq.${encodeURIComponent(userId)}`,
      { password_hash: hashSecretScrypt(newPw.password) },
      { returning: 'minimal' }
    )
    await supabase.insert(
      'audit_logs',
      {
        actor_user_id: userId,
        actor_role: auth.role,
        tenant_id: (user as any).tenant_id,
        action: 'PASSWORD_CHANGED',
        target_type: 'USER',
        target_id: userId,
        request_id: getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    return res.send({ ok: true })
  }

  const handleAuthForgotPassword = async (req: any, res: any) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Database auth is not configured.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const includeDevResetUrl =
      String(process.env.NODE_ENV || '').toLowerCase() !== 'production' &&
      String(process.env.MAIL_DEV_LOG ?? 'true').toLowerCase() !== 'false'
    const result = await requestPasswordReset({
      supabase,
      email: body.email,
      requestIp: req.ip ? String(req.ip) : null,
      includeDevResetUrl,
    })
    return res.send({
      ok: true,
      message: result.message,
      ...(result.devResetUrl ? { devResetUrl: result.devResetUrl } : {}),
    })
  }

  const handleAuthResetPassword = async (req: any, res: any) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const newPw = readChangePasswordNewPassword(body)
    if (!newPw.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', newPw.message)
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Database auth is not configured.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await resetPasswordWithToken({
      supabase,
      token: body.token,
      newPassword: newPw.password,
    })
    if (!result.ok) {
      return sendError(res, result.status, result.code, result.message)
    }
    return res.send({ ok: true })
  }

  app.post('/auth/token', handleAuthToken)
  app.post(`${prefix}/auth/token`, handleAuthToken)
  app.post('/auth/login', handleAuthLogin)
  app.post(`${prefix}/auth/login`, handleAuthLogin)
  app.post('/auth/refresh', handleAuthRefresh)
  app.post(`${prefix}/auth/refresh`, handleAuthRefresh)
  app.post('/auth/change-password', handleAuthChangePassword)
  app.post(`${prefix}/auth/change-password`, handleAuthChangePassword)
  app.post('/auth/forgot-password', handleAuthForgotPassword)
  app.post(`${prefix}/auth/forgot-password`, handleAuthForgotPassword)
  app.post('/auth/reset-password', handleAuthResetPassword)
  app.post(`${prefix}/auth/reset-password`, handleAuthResetPassword)
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

  app.post(`${prefix}/admin/api-clients`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const clientId = req.body?.clientId ? String(req.body.clientId).trim() : ''
    const enterpriseId = req.body?.enterpriseId ? String(req.body.enterpriseId).trim() : ''
    if (!clientId) {
      return sendError(res, 400, 'BAD_REQUEST', 'clientId is required.')
    }
    if (!enterpriseId || !isValidUuid(enterpriseId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'enterpriseId must be a valid uuid.')
    }
    const enterpriseRows = await supabase.select(
      'tenants',
      `select=tenant_id,name&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
    if (!enterprise) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    }
    const enterpriseName = (enterprise as { name?: string | null }).name
      ? String((enterprise as { name?: string | null }).name)
      : null
    const providedSecret = req.body?.clientSecret ? String(req.body.clientSecret) : null
    const clientSecret = providedSecret ?? randomClientSecret()
    if (!clientSecret || clientSecret.length < 8) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'clientSecret must be at least 8 characters.')
    }
    const existing = await supabase.select(
      'api_clients',
      `select=client_id&client_id=eq.${encodeURIComponent(clientId)}&limit=1`
    )
    if (Array.isArray(existing) && existing.length > 0) {
      return sendError(res, 409, 'DUPLICATE_CLIENT_ID', 'clientId already exists.')
    }
    const secretHash = hashSecretScrypt(clientSecret)
    const inserted = await supabase.insert(
      'api_clients',
      {
        client_id: clientId,
        secret_hash: secretHash,
        enterprise_id: enterpriseId,
        status: 'ACTIVE',
      }
    )
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create api client.')
    }
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'ADMIN',
        action: 'ADMIN_API_CLIENT_CREATE',
        target_type: 'API_CLIENT',
        target_id: clientId,
        tenant_id: enterpriseId,
        request_id: getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.status(201).send({
      clientId,
      clientSecret,
      enterpriseId,
      name: enterpriseName,
      status: 'ACTIVE',
      createdAt: row.created_at ?? null,
    })
  })

  app.get(`${prefix}/admin/api-clients`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId).trim() : null
    const status = req.query?.status ? String(req.query.status) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const { page, pageSize, offset } = parsePagination(
      { page: req.query?.page, pageSize: req.query?.pageSize },
      { defaultPage: 1, defaultPageSize: 50, maxPageSize: 100 }
    )

    if (enterpriseId) {
      if (!isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'enterpriseId must be a valid uuid.')
      }
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      }
    }

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
    filterPairs.push(`pageSize=${pageSize}`)
    filterPairs.push(`page=${page}`)
    res.header('X-Filters', filterPairs.join(';'))
    res.send({
      items: rows.map((r: any) => ({
        clientId: r.client_id,
        enterpriseId: r.enterprise_id,
        status: r.status,
        createdAt: r.created_at,
        rotatedAt: r.rotated_at,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  app.get(`${prefix}/admin/api-clients::csv`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId) : null
    const status = req.query?.status ? String(req.query.status) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const { page, pageSize, offset } = parsePagination(
      { page: req.query?.page, pageSize: req.query?.pageSize },
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
    filterPairs.push(`pageSize=${pageSize}`)
    filterPairs.push(`page=${page}`)
    res.header('X-Filters', filterPairs.join(';'))
    res.send(`${csvRows.join('\n')}\n`)
  })

  app.post(`${prefix}/admin/api-clients/:clientId/rotate`, async (req: any, res: any) => {
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
      `select=client_id,enterprise_id,status&client_id=eq.${encodeURIComponent(clientId)}&limit=1`
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
        tenant_id: row.enterprise_id ?? null,
        request_id: getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.send({
      clientId,
      clientSecret: newClientSecret,
    })
  })

  app.post(`${prefix}/admin/api-clients/:clientId/deactivate`, async (req: any, res: any) => {
    if (!requireAdminApiKey(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const clientId = String(req.params.clientId || '')
    if (!clientId) {
      return sendError(res, 400, 'BAD_REQUEST', 'clientId is required.')
    }
    const rows = await supabase.select(
      'api_clients',
      `select=client_id,enterprise_id,status&client_id=eq.${encodeURIComponent(clientId)}&limit=1`
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
        tenant_id: row.enterprise_id ?? null,
        request_id: getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.send({
      clientId,
      status: 'INACTIVE',
    })
  })

}

function registerBillReconciliationRoutes({
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

  app.get(`${prefix}/bills/:billId/reconciliation::csv`, async (req: any, res: any) => {
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
    if (v === 'ACTIVE') return 'ACTIVE'
    if (v === 'SUSPENDED') return 'SUSPENDED'
    if (v === 'DEACTIVATED') return 'DEACTIVATED'
    return null
  }
  const mapStatusFromStorage = (status: unknown) => {
    const v = status ? String(status).toLowerCase() : ''
    if (v === 'deactivated') return 'DEACTIVATED'
    if (v === 'suspended') return 'SUSPENDED'
    return 'ACTIVE'
  }
  /** Path param MUST be RESELLER `tenants.tenant_id` (never `resellers.id`). */
  const resellerRowFilter = (resellerTenantId: string) => `tenant_id=eq.${encodeURIComponent(resellerTenantId)}`
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
    const tenantInserted = await supabase.insert('tenants', {
      tenant_type: 'RESELLER',
      name,
      enterprise_status: 'ACTIVE',
      code: `R-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    })
    const tenantRow = Array.isArray(tenantInserted) ? tenantInserted[0] : null
    const tenantId = tenantRow?.tenant_id ? String(tenantRow.tenant_id) : null
    if (!tenantId) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create reseller tenant.')
    }
    const inserted = await supabase.insert('resellers', {
      tenant_id: tenantId,
      name,
      status: 'ACTIVE',
      contact_email: contactEmail,
      contact_phone: contactPhone,
      created_by: createdBy,
    })
    const reseller = Array.isArray(inserted) ? inserted[0] : null
    if (!reseller) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create reseller.')
    }
    await supabase.insert('reseller_branding', {
      reseller_id: tenantId,
      brand_name: name,
      logo_url: logoUrl,
      primary_color: primaryColor,
      custom_domain: customDomain,
      currency,
    }, { returning: 'minimal' })

    const auth = getAuthContext(req)
    await supabase.insert('audit_logs', {
      actor_user_id: auth.userId ? String(auth.userId) : null,
      actor_role: auth.role ? String(auth.role) : null,
      tenant_id: tenantId,
      action: 'RESELLER_CREATED',
      target_type: 'RESELLER',
      target_id: String(reseller.id),
      request_id: getTraceId(res),
      source_ip: req.ip,
      before_data: null,
      after_data: {
        name,
        currency,
        contactEmail,
        contactPhone,
        brandingConfig: { logoUrl, primaryColor, customDomain },
      },
    }, { returning: 'minimal' })

    res.code(201).send({
      resellerId: tenantId,
      resellerRecordId: String(reseller.id),
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
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    if (statusInput && !storageStatus) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, DEACTIVATED, or SUSPENDED.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
    }
    const { page, pageSize, offset } = parsePagination(req.query ?? {}, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const filters: string[] = []
    if (storageStatus) filters.push(`status=eq.${encodeURIComponent(storageStatus)}`)
    if (operatorId) {
      const simRows = await supabase.select(
        'sims',
        `select=enterprise_id&operator_id=eq.${encodeURIComponent(operatorId)}`
      )
      const enterpriseIds = Array.from(
        new Set((Array.isArray(simRows) ? simRows : []).map((row: any) => row.enterprise_id).filter(Boolean).map((id: any) => String(id)))
      )
      if (enterpriseIds.length === 0) {
        return res.send({ items: [], total: 0, page, pageSize })
      }
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_type=eq.ENTERPRISE&tenant_id=in.(${enterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`
      )
      const resellerIds = Array.from(
        new Set(
          (Array.isArray(enterpriseRows) ? enterpriseRows : [])
            .map((row: any) => row.parent_id)
            .filter(Boolean)
            .map((id: any) => String(id))
        )
      )
      if (resellerIds.length === 0) {
        return res.send({ items: [], total: 0, page, pageSize })
      }
      filters.push(`tenant_id=in.(${resellerIds.map((id) => encodeURIComponent(id)).join(',')})`)
    }
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const { data, total } = await supabase.selectWithCount(
      'resellers',
      `select=id,tenant_id,name,status,created_at,updated_at&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    let brandingMap = new Map()
    if (rows.length) {
      const idList = rows.map((r: any) => encodeURIComponent(String(r.tenant_id))).join(',')
      const brandRows = await supabase.select(
        'reseller_branding',
        `select=reseller_id,brand_name,logo_url,custom_domain,primary_color,secondary_color,currency&reseller_id=in.(${idList})`
      )
      const list = Array.isArray(brandRows) ? brandRows : []
      brandingMap = new Map(list.map((b: any) => [String(b.reseller_id), b]))
    }
    res.send({
      items: rows.map((r: any) => {
        const branding = brandingMap.get(String(r.tenant_id)) ?? null
        return {
          resellerId: String(r.tenant_id),
          resellerRecordId: String(r.id),
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
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
    }
    const isPlatform = roleScope === 'platform' || role === 'platform_admin'
    const ownResellerTenantId = getAuthContext(req).resellerId ? String(getAuthContext(req).resellerId) : null
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'resellers',
      `select=id,tenant_id,name,status,contact_email,contact_phone,created_at,updated_at&${resellerRowFilter(resellerId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    }
    if (!isPlatform) {
      if (roleScope !== 'reseller') {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      const ownsResellerRow = Boolean(ownResellerTenantId) && ownResellerTenantId === String(row.tenant_id)
      if (!ownsResellerRow) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
    }
    if (operatorId) {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_type=eq.ENTERPRISE&parent_id=eq.${encodeURIComponent(String(row.tenant_id))}`
      )
      const enterpriseIds = Array.from(
        new Set((Array.isArray(enterpriseRows) ? enterpriseRows : []).map((r: any) => String(r.tenant_id)))
      )
      if (enterpriseIds.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      const simRows = await supabase.select(
        'sims',
        `select=sim_id&operator_id=eq.${encodeURIComponent(operatorId)}&enterprise_id=in.(${enterpriseIds.map((id) => encodeURIComponent(id)).join(',')})&limit=1`
      )
      if (!Array.isArray(simRows) || simRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
    }
    const brandingRows = await supabase.select(
      'reseller_branding',
      `select=reseller_id,logo_url,custom_domain,primary_color,secondary_color,currency&reseller_id=eq.${encodeURIComponent(String(row.tenant_id))}&limit=1`
    )
    const branding = Array.isArray(brandingRows) ? brandingRows[0] : null
    res.send({
      resellerId: String(row.tenant_id),
      resellerRecordId: String(row.id),
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
      `select=id,tenant_id,name,status,contact_email,contact_phone,created_at,updated_at&${resellerRowFilter(resellerId)}&limit=1`
    )
    const reseller = Array.isArray(existing) ? existing[0] : null
    if (!reseller) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    }
    const resellerRowId = String(reseller.id)
    const resellerTenantId = String(reseller.tenant_id)
    if (name) {
      const dup = await supabase.select(
        'resellers',
        `select=id&name=eq.${encodeURIComponent(name)}&id=neq.${encodeURIComponent(resellerRowId)}&limit=1`
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
    await supabase.update('resellers', `id=eq.${encodeURIComponent(resellerRowId)}`, resellerPatch, { returning: 'minimal' })
    if (branding || name) {
      const rows = await supabase.select(
        'reseller_branding',
        `select=branding_id,reseller_id&reseller_id=eq.${encodeURIComponent(resellerTenantId)}&limit=1`
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
          reseller_id: resellerTenantId,
          brand_name: name ?? reseller.name,
          logo_url: logoUrl,
          primary_color: primaryColor,
          custom_domain: customDomain,
        }, { returning: 'minimal' })
      }
    }
    const auth = getAuthContext(req)
    await supabase.insert('audit_logs', {
      actor_user_id: auth.userId ? String(auth.userId) : null,
      actor_role: auth.role ? String(auth.role) : null,
      tenant_id: resellerTenantId,
      action: 'RESELLER_UPDATED',
      target_type: 'RESELLER',
      target_id: resellerRowId,
      request_id: getTraceId(res),
      source_ip: req.ip,
      before_data: {
        name: reseller.name,
        contactEmail: reseller.contact_email,
        contactPhone: reseller.contact_phone,
      },
      after_data: {
        name: name ?? reseller.name,
        contactEmail: contactEmail !== null ? (contactEmail || null) : reseller.contact_email,
        contactPhone: contactPhone !== null ? (contactPhone || null) : reseller.contact_phone,
        brandingConfig: branding ? { logoUrl, primaryColor, customDomain } : undefined,
      },
    }, { returning: 'minimal' })

    res.send({
      resellerId: resellerTenantId,
      resellerRecordId: resellerRowId,
      name: name ?? reseller.name,
      status: mapStatusFromStorage(reseller.status),
      updatedAt: nowIso,
    })
  })

  const changeResellerStatusHandler = async (req: any, res: any) => {
    if (!requirePlatform(req, res)) return
    const resellerIdFromParam = req.params?.resellerId ? String(req.params.resellerId).trim() : ''
    const routePath = String(req.routeOptions?.url || '')
    const requestPath = String(req.url || '').split('?')[0]
    const resellerIdFromColonPath = routePath.endsWith(':resellerId\\:change-status')
      ? (requestPath.match(/\/resellers\/([^/]+):change-status$/)?.[1] ?? '')
      : ''
    const resellerId = resellerIdFromParam || resellerIdFromColonPath
    if (!resellerId) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    const statusInput = req.body?.status ? String(req.body.status) : null
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    const storageStatus = statusInput ? mapStatusToStorage(statusInput) : null
    if (!storageStatus) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, DEACTIVATED, or SUSPENDED.')
    }
    if (!reason) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'reason is required.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'resellers',
      `select=id,tenant_id,status&${resellerRowFilter(resellerId)}&limit=1`
    )
    const reseller = Array.isArray(rows) ? rows[0] : null
    if (!reseller) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    }
    const resellerRowId = String(reseller.id)
    const resellerTenantId = String(reseller.tenant_id)
    if (operatorId) {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_type=eq.ENTERPRISE&parent_id=eq.${encodeURIComponent(resellerTenantId)}`
      )
      const enterpriseIds = Array.from(
        new Set((Array.isArray(enterpriseRows) ? enterpriseRows : []).map((r: any) => String(r.tenant_id)))
      )
      if (enterpriseIds.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      const simRows = await supabase.select(
        'sims',
        `select=sim_id&operator_id=eq.${encodeURIComponent(operatorId)}&enterprise_id=in.(${enterpriseIds.map((id) => encodeURIComponent(id)).join(',')})&limit=1`
      )
      if (!Array.isArray(simRows) || simRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
    }
    const previousStatus = mapStatusFromStorage(reseller.status)
    const nowIso = new Date().toISOString()
    await supabase.update('resellers', `id=eq.${encodeURIComponent(resellerRowId)}`, {
      status: storageStatus,
      updated_at: nowIso,
    }, { returning: 'minimal' })
    const auth = getAuthContext(req)
    await supabase.insert('audit_logs', {
      actor_user_id: auth.userId ? String(auth.userId) : null,
      actor_role: auth.role ? String(auth.role) : null,
      tenant_id: resellerTenantId,
      action: 'RESELLER_STATUS_CHANGED',
      target_type: 'RESELLER',
      target_id: resellerRowId,
      request_id: getTraceId(res),
      source_ip: req.ip,
      before_data: { status: previousStatus },
      after_data: { status: mapStatusFromStorage(storageStatus), reason },
    }, { returning: 'minimal' })
    res.send({
      resellerId: resellerTenantId,
      resellerRecordId: resellerRowId,
      status: mapStatusFromStorage(storageStatus),
      previousStatus,
      changedAt: nowIso,
    })
  }
  app.post(`${prefix}/resellers/:resellerId/change-status`, changeResellerStatusHandler)
  app.post(`${prefix}/resellers/:resellerId\\:change-status`, changeResellerStatusHandler)
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
    const rawTenant =
      req.body?.resellerId !== undefined && req.body.resellerId !== null && String(req.body.resellerId).trim() !== ''
        ? String(req.body.resellerId).trim()
        : null
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
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const resellerRef = auth.scope === 'reseller' ? String(auth.resellerId || '') : String(rawTenant || '')
    if (!resellerRef) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'resellerId is required.')
    }
    if (auth.scope === 'reseller' && rawTenant) {
      const ra = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      const rb = await resolveResellerForEnterpriseScope(supabase, rawTenant)
      if (!ra.ok || !rb.ok || ra.parentTenantId !== rb.parentTenantId) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match your reseller scope.')
      }
    }
    const resolved = await resolveResellerForEnterpriseScope(supabase, resellerRef)
    if (!resolved.ok) {
      if (resolved.reason === 'deactivated') {
        return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerRef} not found.`)
    }
    const parentTenantId = resolved.parentTenantId
    const resellerRowId = resolved.resellerRowId
    if (!resellerRowId) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Reseller record missing; cannot link enterprise to customers.')
    }
    const dup = await supabase.select(
      'customers',
      `select=tenant_id&reseller_tenant_id=eq.${encodeURIComponent(parentTenantId)}&name=eq.${encodeURIComponent(name)}&limit=1`
    )
    if (Array.isArray(dup) && dup.length > 0) {
      return sendError(res, 409, 'DUPLICATE_NAME', 'Enterprise name already exists under this reseller.')
    }
    const inserted = await supabase.insert('tenants', {
      parent_id: parentTenantId,
      tenant_type: 'ENTERPRISE',
      name,
      enterprise_status: 'ACTIVE',
      auto_suspend_enabled: autoSuspendEnabled,
    })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create enterprise.')
    }
    const actorUserUuid = auth.userId && isValidUuid(auth.userId) ? String(auth.userId).trim() : null
    try {
      await supabase.insert(
        'customers',
        {
          tenant_id: row.tenant_id,
          reseller_id: resellerRowId,
          reseller_tenant_id: parentTenantId,
          name,
          status: 'ACTIVE',
          auto_suspend_enabled: autoSuspendEnabled,
          created_by: actorUserUuid,
        },
        { returning: 'minimal' }
      )
    } catch (e: any) {
      try {
        await supabase.delete('tenants', `tenant_id=eq.${encodeURIComponent(String(row.tenant_id))}`)
      } catch {
        /* best-effort rollback */
      }
      const dup = e?.code === 'DUPLICATE' || Number(e?.status) === 409
      if (dup) {
        return sendError(res, 409, 'DUPLICATE_NAME', 'Enterprise name already exists under this reseller.')
      }
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create customer record for enterprise.')
    }
    await supabase.insert('audit_logs', {
      actor_user_id: actorUserUuid,
      actor_role: auth.role,
      tenant_id: row.tenant_id,
      action: 'ENTERPRISE_CREATED',
      target_type: 'ENTERPRISE',
      target_id: row.tenant_id,
      request_id: getTraceId(res),
      source_ip: req.ip,
      after_data: {
        name,
        resellerId: parentTenantId,
        autoSuspendEnabled,
        contactEmail: contactEmail || null,
        contactPhone,
      },
    }, { returning: 'minimal' })
    res.code(201).send({
      enterpriseId: row.tenant_id,
      name: row.name,
      resellerId: parentTenantId,
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
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    if (statusInput && !status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, INACTIVE, or SUSPENDED.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
    }
    const queryResellerId =
      req.query.resellerId !== undefined && req.query.resellerId !== null && String(req.query.resellerId).trim() !== ''
        ? String(req.query.resellerId).trim()
        : null
    const authResellerId = auth.resellerId ? String(auth.resellerId).trim() : null
    if (isReseller && queryResellerId && authResellerId && queryResellerId !== authResellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'resellerId is out of scope.')
    }
    const resellerId = isReseller ? authResellerId : queryResellerId
    if (isReseller && !resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
    }
    const { page, pageSize, offset } = parsePagination(req.query ?? {}, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let parentTenantFilter: string | null = null
    if (resellerId) {
      const rr = await resolveResellerForEnterpriseScope(supabase, resellerId)
      if (!rr.ok) {
        if (rr.reason === 'deactivated') {
          return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
        }
        if (isReseller) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        }
        return res.send({ items: [], total: 0, page, pageSize })
      }
      parentTenantFilter = rr.parentTenantId
    }
    const filters = ['tenant_type=eq.ENTERPRISE']
    if (status) filters.push(`enterprise_status=eq.${encodeURIComponent(status)}`)
    if (parentTenantFilter) filters.push(`parent_id=eq.${encodeURIComponent(parentTenantFilter)}`)
    if (operatorId) {
      const simRows = await supabase.select(
        'sims',
        `select=enterprise_id&operator_id=eq.${encodeURIComponent(operatorId)}`
      )
      const enterpriseIds = Array.from(
        new Set((Array.isArray(simRows) ? simRows : []).map((row: any) => row.enterprise_id).filter(Boolean).map((id: any) => String(id)))
      )
      if (enterpriseIds.length === 0) {
        return res.send({ items: [], total: 0, page, pageSize })
      }
      if (parentTenantFilter) {
        const scopedRows = await supabase.select(
          'tenants',
          `select=tenant_id&tenant_type=eq.ENTERPRISE&parent_id=eq.${encodeURIComponent(parentTenantFilter)}&tenant_id=in.(${enterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`
        )
        const scopedIds = Array.from(
          new Set((Array.isArray(scopedRows) ? scopedRows : []).map((row: any) => String(row.tenant_id)))
        )
        if (scopedIds.length === 0) {
          return res.send({ items: [], total: 0, page, pageSize })
        }
        filters.push(`tenant_id=in.(${scopedIds.map((id) => encodeURIComponent(id)).join(',')})`)
      } else {
        filters.push(`tenant_id=in.(${enterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
      }
    }
    if (isReseller) {
      if (resellerAssignedRoles.has(auth.role || '')) {
        if (!auth.userId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller user required.')
        }
        const assignmentParentId = parentTenantFilter as string
        const assignmentRows = await supabase.select(
          'reseller_enterprise_assignments',
          `select=enterprise_id&user_id=eq.${encodeURIComponent(auth.userId)}&reseller_id=eq.${encodeURIComponent(assignmentParentId)}`
        )
        const assignments = Array.isArray(assignmentRows) ? assignmentRows.map((r: any) => String(r.enterprise_id)) : []
        if (assignments.length === 0) {
          return res.send({ items: [], total: 0, page, pageSize })
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
    res.send({
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
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
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
    if (operatorId) {
      const simRows = await supabase.select(
        'sims',
        `select=sim_id&operator_id=eq.${encodeURIComponent(operatorId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
      )
      if (!Array.isArray(simRows) || simRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      }
    }
    if (auth.roleScope === 'platform' || auth.role === 'platform_admin') {
    } else if (auth.roleScope === 'reseller') {
      if (!auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      const rrEnt = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rrEnt.ok) {
        if (rrEnt.reason === 'deactivated') {
          return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
        }
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      if (String(row.parent_id || '') !== rrEnt.parentTenantId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      if (resellerAssignedRoles.has(auth.role || '')) {
        if (!auth.userId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller user required.')
        }
        const assignmentRows = await supabase.select(
          'reseller_enterprise_assignments',
          `select=enterprise_id&user_id=eq.${encodeURIComponent(auth.userId)}&reseller_id=eq.${encodeURIComponent(rrEnt.parentTenantId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
        )
        if (!Array.isArray(assignmentRows) || assignmentRows.length === 0) {
          return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
        }
      } else if (!resellerAllRoles.has(auth.role || '')) {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
    } else if (auth.roleScope === 'customer' || auth.roleScope === 'department') {
      if (!auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId.trim().toLowerCase()) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise scope required.')
      }
    } else {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    res.send({
      enterpriseId: row.tenant_id,
      name: row.name,
      resellerId: row.parent_id,
      status: row.enterprise_status,
      autoSuspendEnabled: row.auto_suspend_enabled,
      createdAt: row.created_at,
    })
  })

  app.get(`${prefix}/enterprises/:enterpriseId/overdue-summary`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const enterpriseIdParam = String(req.params.enterpriseId || '').trim()
    if (!isValidUuid(enterpriseIdParam)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = enterpriseIdParam
    if (auth.scope === 'reseller') {
      const resolved = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam)
      if (!resolved) return
      enterpriseId = resolved
    }
    const result = await getEnterpriseDunningSummary({ supabase, enterpriseId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    const { dunningStatus, nextAction, ...summary } = result.value
    const riskMap: Record<string, string> = {
      NORMAL: 'NORMAL',
      OVERDUE_WARNING: 'WARNING',
      SUSPENDED: 'HIGH',
      SERVICE_INTERRUPTED: 'CRITICAL',
    }
    const actionMap: Record<string, string> = {
      OVERDUE_REMINDER: 'OFFLINE_REMINDER_RECOMMENDED',
      MANUAL_REVIEW: 'MANUAL_REVIEW_RECOMMENDED',
    }
    res.send({
      ...summary,
      overdueRiskLevel: riskMap[String(dunningStatus || '')] ?? 'NORMAL',
      recommendedAction: nextAction ? (actionMap[String(nextAction)] ?? String(nextAction)) : null,
    })
  })

  const changeEnterpriseStatusHandler = async (req: any, res: any) => {
    const auth = ensurePlatformOrResellerAdmin(req, res)
    if (!auth) return
    const rawParams = req.params ?? {}
    const enterpriseIdFromParams =
      rawParams.enterpriseId
      ?? rawParams['enterpriseId:change-status']
      ?? rawParams.enterpriseStatusKey
    const enterpriseIdFromUrlMatch = String(req.raw?.url ?? '').match(/\/enterprises\/([^/:]+):change-status(?:\?|$)/)?.[1] ?? ''
    const enterpriseId = String(enterpriseIdFromParams || enterpriseIdFromUrlMatch || '')
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    const statusInput = req.body?.status ? String(req.body.status) : null
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    const status = statusInput ? normalizeStatus(statusInput) : null
    if (!status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, INACTIVE, or SUSPENDED.')
    }
    if (!reason) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'reason is required.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
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
    if (operatorId) {
      const simRows = await supabase.select(
        'sims',
        `select=sim_id&operator_id=eq.${encodeURIComponent(operatorId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
      )
      if (!Array.isArray(simRows) || simRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      }
    }
    if (auth.scope === 'reseller') {
      if (!auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      const rrCs = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rrCs.ok) {
        if (rrCs.reason === 'deactivated') {
          return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
        }
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      if (String(row.parent_id || '') !== rrCs.parentTenantId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
    }
    const previousStatus = row.enterprise_status
    const nowIso = new Date().toISOString()
    await supabase.update('tenants', `tenant_id=eq.${encodeURIComponent(enterpriseId)}`, {
      enterprise_status: status,
      updated_at: nowIso,
    }, { returning: 'minimal' })
    const enterpriseEventScope = await resolveEventScopeColumns(supabase, {
      enterpriseId,
      resellerId: row.parent_id ?? null,
    })
    await supabase.insert('events', {
      event_type: 'ENTERPRISE_STATUS_CHANGED',
      occurred_at: nowIso,
      enterprise_id: enterpriseEventScope.enterpriseId,
      reseller_id: enterpriseEventScope.resellerId,
      actor_user_id: auth.userId,
      request_id: getTraceId(res),
      payload: sanitizeEventPayload({
        previousStatus,
        status,
        reason,
        changedBy: auth.userId,
      }),
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
    res.send({
      enterpriseId,
      status,
      previousStatus,
      changedAt: nowIso,
      changedBy: auth.userId,
      reason,
    })
  }
  app.post(`${prefix}/enterprises/:enterpriseId/change-status`, changeEnterpriseStatusHandler)
  app.post(`${prefix}/enterprises/:enterpriseId\\:change-status`, changeEnterpriseStatusHandler)
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
      if (!auth.resellerId) return { ok: false, error: 'forbidden' as const }
      const rr = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rr.ok) return { ok: false, error: 'forbidden' as const }
      if (String((enterprise as any).parent_id || '') !== rr.parentTenantId) return { ok: false, error: 'forbidden' as const }
      if (auth.role !== 'reseller_admin') return { ok: false, error: 'forbidden' as const }
      return { ok: true }
    }
    if (auth.roleScope === 'customer') {
      if (!auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId.trim().toLowerCase()) return { ok: false, error: 'forbidden' as const }
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
    const parentDepartmentId = req.body?.parentDepartmentId ? String(req.body.parentDepartmentId) : null
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const access = await ensureEnterpriseAccess(supabase, auth, enterpriseId)
    if (!access.ok) {
      if (access.error === 'not_found') return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    let parentId = enterpriseId
    if (parentDepartmentId) {
      const parentDeptRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(parentDepartmentId)}&tenant_type=eq.DEPARTMENT&limit=1`
      )
      const parentDept = Array.isArray(parentDeptRows) ? parentDeptRows[0] : null
      if (!parentDept || String((parentDept as any).parent_id || '') !== enterpriseId) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'parentDepartmentId is invalid or does not belong to this enterprise.')
      }
      parentId = parentDepartmentId
    }
    const inserted = await supabase.insert('tenants', {
      parent_id: parentId,
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
      after_data: { name, parentDepartmentId },
    }, { returning: 'minimal' })
    res.code(201).send({
      departmentId: row.tenant_id,
      enterpriseId,
      parentDepartmentId: parentDepartmentId ?? null,
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
      if (!auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId.trim().toLowerCase()) {
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
      if (!auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      const rrDep = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rrDep.ok || String((enterprise as any).parent_id || '') !== rrDep.parentTenantId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
    }
    const { data, total } = await supabase.selectWithCount(
      'tenants',
      `select=tenant_id,name,created_at&tenant_type=eq.DEPARTMENT&parent_id=eq.${encodeURIComponent(enterpriseId)}&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
    )
    const rows = Array.isArray(data) ? data : []
    res.send({
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
      if (!auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId.trim().toLowerCase()) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise scope required.')
      }
    } else if (auth.roleScope === 'reseller') {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      const rrDept = auth.resellerId ? await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId)) : null
      if (
        !enterprise ||
        !auth.resellerId ||
        !rrDept?.ok ||
        String((enterprise as any).parent_id || '') !== rrDept.parentTenantId
      ) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    res.send({
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
  /** Path / JWT reseller ref MUST be `tenants.tenant_id` for the RESELLER (not `resellers.id`). */
  const resellerRefRowFilter = (resellerTenantId: string) => `tenant_id=eq.${encodeURIComponent(resellerTenantId)}`

  /** `reseller_suppliers.reseller_id` is RESELLER `tenants.tenant_id`; JWT MUST use same UUID. */
  const resellerSupplierBindingExists = async (
    supabase: ReturnType<typeof createSupabaseRestClient>,
    supplierId: string,
    jwtResellerId: string
  ): Promise<'yes' | 'no' | 'schema'> => {
    try {
      const jwt = String(jwtResellerId || '').trim()
      if (!jwt) return 'no'
      const q1 = await supabase.select(
        'reseller_suppliers',
        `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&reseller_id=eq.${encodeURIComponent(jwt)}&limit=1`
      )
      if (Array.isArray(q1) && q1.length > 0) return 'yes'
      return 'no'
    } catch (error: unknown) {
      const message = String((error as { message?: string })?.message ?? '')
      if (message.includes("Could not find the table 'public.reseller_suppliers'")) {
        return 'schema'
      }
      return 'no'
    }
  }

  /** Single canonical reseller scope id for queries (RESELLER `tenants.tenant_id`). */
  const resellerSupplierBindingResellerIdsForQuery = async (
    _supabase: ReturnType<typeof createSupabaseRestClient>,
    jwtResellerId: string
  ): Promise<string[]> => {
    const jwt = String(jwtResellerId || '').trim()
    return jwt ? [jwt] : []
  }

  /** PostgREST: prefer or=(reseller_id.eq.a,...) over in.(a,b) for uuid lists (avoids parser edge cases). */
  const resellerSuppliersResellerIdFilter = (bindingIds: string[]): string => {
    const ids = Array.from(new Set(bindingIds.map((id) => String(id).trim()).filter(Boolean)))
    if (ids.length === 0) return 'reseller_id=is.null'
    if (ids.length === 1) return `reseller_id=eq.${encodeURIComponent(ids[0])}`
    const inner = ids.map((id) => `reseller_id.eq.${encodeURIComponent(id)}`).join(',')
    return `or=(${inner})`
  }

  app.get(`${prefix}/operators`, async (req: any, res: any) => {
    const ctx = getAuthContext(req)
    if (!ctx.roleScope && !ctx.role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return
    }
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    const mcc = req.query?.mcc ? String(req.query.mcc).trim() : ''
    const mnc = req.query?.mnc ? String(req.query.mnc).trim() : ''
    const name = req.query?.name ? String(req.query.name).trim() : ''
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
    }
    if (mcc && !/^\d{3}$/.test(mcc)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'mcc must be 3 digits.')
    }
    if (mnc && !/^\d{2,3}$/.test(mnc)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'mnc must be 2-3 digits.')
    }
    const { page, pageSize, offset } = parsePagination(req.query ?? {}, {
      defaultPage: 1,
      defaultPageSize: 20,
      maxPageSize: 1000,
    })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const isPlatform = ctx.roleScope === 'platform' || ctx.role === 'platform_admin'
    let allowedBusinessOperatorIds: string[] | null = null
    if (!isPlatform) {
      if (ctx.roleScope !== 'reseller') {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      const ra = ensureResellerAdmin(req, res)
      if (!ra) return
      if (!ctx.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      try {
        const bindingIds = await resellerSupplierBindingResellerIdsForQuery(supabase, String(ctx.resellerId))
        const rsFilter = resellerSuppliersResellerIdFilter(bindingIds)
        const rsRows = await supabase.select('reseller_suppliers', `select=supplier_id&${rsFilter}`)
        const supplierSet = new Set<string>()
        for (const row of Array.isArray(rsRows) ? rsRows : []) {
          const sid = (row as { supplier_id?: string })?.supplier_id ? String((row as { supplier_id?: string }).supplier_id) : ''
          if (sid) supplierSet.add(sid)
        }
        const supplierIds = Array.from(supplierSet)
        if (supplierIds.length === 0) {
          res.send({ items: [], total: 0, page, pageSize })
          return
        }
        const sidIn = supplierIds.map((id) => encodeURIComponent(id)).join(',')
        const opRows = await supabase.select(
          'operators',
          `select=business_operator_id&supplier_id=in.(${sidIn})&business_operator_id=not.is.null`
        )
        const boSet = new Set<string>()
        for (const row of Array.isArray(opRows) ? opRows : []) {
          const bid = (row as { business_operator_id?: string })?.business_operator_id
            ? String((row as { business_operator_id?: string }).business_operator_id)
            : ''
          if (bid) boSet.add(bid)
        }
        allowedBusinessOperatorIds = Array.from(boSet)
        if (allowedBusinessOperatorIds.length === 0) {
          res.send({ items: [], total: 0, page, pageSize })
          return
        }
      } catch (error: unknown) {
        const message = String((error as { message?: string })?.message ?? '')
        if (message.includes("Could not find the table 'public.reseller_suppliers'")) {
          return sendError(res, 503, 'SCHEMA_NOT_READY', 'reseller_suppliers table is not available yet.')
        }
        throw error
      }
    }
    const filters: string[] = []
    if (allowedBusinessOperatorIds) {
      if (operatorId) {
        if (!allowedBusinessOperatorIds.includes(operatorId)) {
          res.send({ items: [], total: 0, page, pageSize })
          return
        }
        filters.push(`operator_id=eq.${encodeURIComponent(operatorId)}`)
      } else {
        const enc = allowedBusinessOperatorIds.map((id) => encodeURIComponent(id)).join(',')
        filters.push(`operator_id=in.(${enc})`)
      }
    } else if (operatorId) {
      filters.push(`operator_id=eq.${encodeURIComponent(operatorId)}`)
    }
    if (mcc) filters.push(`mcc=eq.${encodeURIComponent(mcc)}`)
    if (mnc) filters.push(`mnc=eq.${encodeURIComponent(mnc)}`)
    if (name) filters.push(`name=ilike.*${encodeURIComponent(name)}*`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const { data, total } = await supabase.selectWithCount(
      'business_operators',
      `select=operator_id,mcc,mnc,name&order=name.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    res.send({
      items: rows.map((row: any) => ({
        operatorId: row.operator_id,
        mcc: row.mcc,
        mnc: row.mnc,
        name: row.name,
      })),
      total: total ?? rows.length,
      page,
      pageSize,
    })
  })

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
      'business_operators',
      `select=operator_id&mcc=eq.${encodeURIComponent(mcc)}&mnc=eq.${encodeURIComponent(mnc)}&limit=1`
    )
    if (Array.isArray(dup) && dup.length > 0) {
      return sendError(res, 409, 'DUPLICATE_OPERATOR', 'Operator already exists.')
    }
    const inserted = await supabase.insert('business_operators', {
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
          target_id: row.operator_id,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { mcc, mnc, name, gsmaOverride: true },
        },
        { returning: 'minimal' }
      )
    }
    res.code(201).send({
      operatorId: row.operator_id,
      mcc: row.mcc,
      mnc: row.mnc,
      name: row.name,
    })
  })

  app.patch(`${prefix}/operators/:operatorId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const operatorId = String(req.params.operatorId || '').trim()
    if (!isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
    }
    const patch: Record<string, any> = {}
    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim()
      if (!name) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'name is required.')
      }
      patch.name = name
    }
    if (!Object.keys(patch).length) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No fields to update.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const updated = await supabase.update(
      'business_operators',
      `operator_id=eq.${encodeURIComponent(operatorId)}`,
      patch
    )
    const row = Array.isArray(updated) ? updated[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'Operator not found.')
    }
    res.send({
      operatorId: row.operator_id,
      mcc: row.mcc,
      mnc: row.mnc,
      name: row.name,
    })
  })

  app.post(`${prefix}/resellers/:resellerId/suppliers`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const resellerId = String(req.params.resellerId || '').trim()
    const supplierId = typeof req.body?.supplierId === 'string' ? req.body.supplierId.trim() : ''
    if (!isValidUuid(resellerId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    if (!isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    try {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      if (auth.scope === 'reseller') {
        const allowed = await resellerSupplierBindingResellerIdsForQuery(supabase, String(auth.resellerId))
        if (!allowed.includes(resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'resellerId is out of scope.')
        }
      }
      const resellerRows = await supabase.select(
        'resellers',
        `select=id,tenant_id&${resellerRefRowFilter(resellerId)}&limit=1`
      )
      const resellerRow = Array.isArray(resellerRows)
        ? (resellerRows[0] as { id?: string; tenant_id?: string } | undefined)
        : undefined
      if (!resellerRow?.id) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      const storeResellerKey = resellerRow.tenant_id ? String(resellerRow.tenant_id) : String(resellerRow.id)
      const bindingIds = await resellerSupplierBindingResellerIdsForQuery(supabase, resellerId)
      const supplierRows = await supabase.select(
        'suppliers',
        `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
      )
      if (!Array.isArray(supplierRows) || supplierRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
      }
      // FR-042a: each supplier binds to at most one reseller (exclusive).
      const existingAnyRows = await supabase.select(
        'reseller_suppliers',
        `select=reseller_id,supplier_id,created_at&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
      )
      const existingAny = Array.isArray(existingAnyRows) ? existingAnyRows[0] : null
      if (existingAny?.reseller_id) {
        const boundResellerId = String(existingAny.reseller_id)
        const sameReseller =
          boundResellerId === storeResellerKey ||
          (Array.isArray(bindingIds) && bindingIds.includes(boundResellerId))
        if (sameReseller) {
          return sendError(res, 409, 'ALREADY_BOUND', 'supplierId is already bound to resellerId.')
        }
        return sendError(
          res,
          409,
          'SUPPLIER_BOUND_TO_OTHER_RESELLER',
          'supplierId is already exclusively bound to another reseller.'
        )
      }
      const insertedRows = await supabase.insert(
        'reseller_suppliers',
        { reseller_id: storeResellerKey, supplier_id: supplierId },
        { returning: 'representation' }
      )
      const row = Array.isArray(insertedRows) ? insertedRows[0] : null
      if (!row) {
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to bind supplier.')
      }
      res.code(201).send({
        resellerId: storeResellerKey,
        supplierId: row.supplier_id,
        boundAt: row.created_at ?? null,
      })
    } catch (error: any) {
      const message = String(error?.message ?? '')
      if (message.includes("Could not find the table 'public.reseller_suppliers'")) {
        return sendError(res, 503, 'SCHEMA_NOT_READY', 'reseller_suppliers table is not available yet.')
      }
      if (
        message.includes('uq_reseller_suppliers_supplier_id') ||
        message.includes('duplicate key') ||
        message.includes('23505')
      ) {
        return sendError(
          res,
          409,
          'SUPPLIER_BOUND_TO_OTHER_RESELLER',
          'supplierId is already exclusively bound to another reseller.'
        )
      }
      const status = Number(error?.status) || 500
      const code = error?.code ? String(error.code) : 'INTERNAL_ERROR'
      const errorMessage = message || 'Failed to bind supplier.'
      return sendError(res, status, code, errorMessage)
    }
  })

  app.get(`${prefix}/resellers/:resellerId/suppliers`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const resellerId = String(req.params.resellerId || '').trim()
    if (!isValidUuid(resellerId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    try {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      if (auth.scope === 'reseller') {
        const allowed = await resellerSupplierBindingResellerIdsForQuery(supabase, String(auth.resellerId))
        if (!allowed.includes(resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'resellerId is out of scope.')
        }
      }
      const resellerRows = await supabase.select(
        'resellers',
        `select=id,tenant_id&${resellerRefRowFilter(resellerId)}&limit=1`
      )
      if (!Array.isArray(resellerRows) || resellerRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      const resellerRow = resellerRows[0] as { id?: string; tenant_id?: string }
      const pathStoreKey = resellerRow.tenant_id ? String(resellerRow.tenant_id) : String(resellerRow.id)
      const bindingIds = await resellerSupplierBindingResellerIdsForQuery(supabase, resellerId)
      const rsFilter = resellerSuppliersResellerIdFilter(bindingIds)
      const linksRows = await supabase.select(
        'reseller_suppliers',
        `select=supplier_id,created_at&${rsFilter}&order=created_at.desc`
      )
      const links = Array.isArray(linksRows) ? linksRows : []
      const supplierIds = Array.from(new Set(links.map((r: any) => (r?.supplier_id ? String(r.supplier_id) : '')).filter(Boolean)))
      const supplierMap = new Map<string, any>()
      if (supplierIds.length) {
        const supplierFilter = supplierIds.map((id: string) => encodeURIComponent(id)).join(',')
        const supplierRows = await supabase.select(
          'suppliers',
          `select=supplier_id,name,status,created_at&supplier_id=in.(${supplierFilter})`
        )
        for (const row of Array.isArray(supplierRows) ? supplierRows : []) {
          const id = row?.supplier_id ? String(row.supplier_id) : ''
          if (id) supplierMap.set(id, row)
        }
      }
      const items = links.map((link: any) => {
        const id = link?.supplier_id ? String(link.supplier_id) : null
        const supplier = id ? supplierMap.get(id) : null
        return {
          supplierId: id,
          name: supplier?.name ?? null,
          status: supplier?.status ?? null,
          createdAt: supplier?.created_at ?? null,
          boundAt: link?.created_at ?? null,
        }
      }).filter((item: any) => item.supplierId)
      res.header('Cache-Control', 'no-store')
      res.send({
        resellerId: pathStoreKey,
        items,
        total: items.length,
      })
    } catch (error: any) {
      const message = String(error?.message ?? '')
      if (message.includes("Could not find the table 'public.reseller_suppliers'")) {
        return sendError(res, 503, 'SCHEMA_NOT_READY', 'reseller_suppliers table is not available yet.')
      }
      const status = Number(error?.status) || 500
      const code = error?.code ? String(error.code) : 'INTERNAL_ERROR'
      const errorMessage = message || 'Failed to list reseller suppliers.'
      return sendError(res, status, code, errorMessage)
    }
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
    const operatorRows = await supabase.select('business_operators', `select=operator_id,name&operator_id=in.(${operatorFilter})`)
    const operators = Array.isArray(operatorRows) ? operatorRows : []
    if (operators.length !== operatorIds.length) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorIds contains invalid operator id.')
    }
    const inserted = await supabase.insert('suppliers', { name, status })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create supplier.')
    }
    const operatorMap = new Map(operators.map((operator: any) => [String(operator.operator_id), operator]))
    const operatorPayloads = operatorIds.map((operatorId: string) => ({
      business_operator_id: operatorId,
      supplier_id: row.supplier_id,
      name: operatorMap.get(operatorId)?.name ?? null,
    }))
    const insertedOperators = await supabase.insert('operators', operatorPayloads, { returning: 'representation' })
    const createdOperators = Array.isArray(insertedOperators) ? insertedOperators : []
    res.code(201).send({
      supplierId: row.supplier_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      operatorIds: createdOperators.map((operator: any) => String(operator.operator_id)).filter(Boolean),
    })
  })

  app.post(`${prefix}/suppliers/:supplierId/operators`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    try {
      const supplierId = String(req.params.supplierId || '').trim()
      const operatorId = typeof req.body?.operatorId === 'string' ? req.body.operatorId.trim() : ''
      if (!supplierId) {
        return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
      }
      if (!operatorId || !isValidUuid(operatorId)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const supplierRows = await supabase.select(
        'suppliers',
        `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
      )
      const supplier = Array.isArray(supplierRows) ? supplierRows[0] : null
      if (!supplier?.supplier_id) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
      }
      const businessRows = await supabase.select(
        'business_operators',
        `select=operator_id,name&operator_id=eq.${encodeURIComponent(operatorId)}&limit=1`
      )
      const businessOperator = Array.isArray(businessRows) ? businessRows[0] : null
      if (!businessOperator?.operator_id) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `operator ${operatorId} not found.`)
      }
      const existingRows = await supabase.select(
        'operators',
        `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&business_operator_id=eq.${encodeURIComponent(operatorId)}&limit=1`
      )
      const legacyExistingRows = await supabase.select(
        'operators',
        `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(operatorId)}&limit=1`
      )
      const existing = Array.isArray(existingRows) ? existingRows[0] : null
      const legacyExisting = Array.isArray(legacyExistingRows) ? legacyExistingRows[0] : null
      if (existing?.operator_id || legacyExisting?.operator_id) {
        return sendError(res, 409, 'ALREADY_BOUND', 'operatorId is already bound to supplierId.')
      }
      const inserted = await supabase.insert(
        'operators',
        {
          business_operator_id: operatorId,
          supplier_id: supplierId,
          name: (businessOperator as any)?.name ?? null,
        },
        { returning: 'representation' }
      )
      const row = Array.isArray(inserted) ? inserted[0] : null
      if (!row?.operator_id) {
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to bind operator.')
      }
      res.code(201).send({
        supplierId,
        operatorId,
        supplierOperatorId: row.operator_id,
      })
    } catch {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to bind operator.')
    }
  })

  app.get(`${prefix}/suppliers`, async (req: any, res: any) => {
    const ctx = getAuthContext(req)
    if (!ctx.roleScope && !ctx.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const isPlatform = ctx.roleScope === 'platform' || ctx.role === 'platform_admin'
    if (!isPlatform) {
      const ra = ensureResellerAdmin(req, res)
      if (!ra) return
      if (!ctx.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
    }
    const statusInput = req.query.status ? String(req.query.status) : null
    const status = statusInput ? normalizeStatus(statusInput) : null
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    if (statusInput && !status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE or SUSPENDED.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
    }
    const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let rows: any[] = []
    let total = 0
    if (isPlatform) {
      const filters: string[] = []
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (operatorId) {
        const operatorRows = await supabase.select(
          'operators',
          `select=operator_id,supplier_id,business_operator_id&or=(business_operator_id.eq.${encodeURIComponent(operatorId)},operator_id.eq.${encodeURIComponent(operatorId)})&limit=1`
        )
        const operator = Array.isArray(operatorRows) ? operatorRows[0] : null
        if (!operator?.supplier_id) {
          return res.send({ items: [], total: 0, page, pageSize })
        }
        filters.push(`supplier_id=eq.${encodeURIComponent(String(operator.supplier_id))}`)
      }
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data, total: t } = await supabase.selectWithCount(
        'suppliers',
        `select=supplier_id,name,status,created_at&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      rows = Array.isArray(data) ? data : []
      total = typeof t === 'number' ? t : rows.length
    } else {
      try {
        const bindingIds = await resellerSupplierBindingResellerIdsForQuery(supabase, String(ctx.resellerId))
        const resellerRsFilter = resellerSuppliersResellerIdFilter(bindingIds)
        if (operatorId) {
          const operatorRows = await supabase.select(
            'operators',
            `select=operator_id,supplier_id,business_operator_id&or=(business_operator_id.eq.${encodeURIComponent(operatorId)},operator_id.eq.${encodeURIComponent(operatorId)})&limit=1`
          )
          const operator = Array.isArray(operatorRows) ? operatorRows[0] : null
          if (!operator?.supplier_id) {
            return res.send({ items: [], total: 0, page, pageSize })
          }
          const sid = String(operator.supplier_id)
          const bindCheck = await supabase.select(
            'reseller_suppliers',
            `select=supplier_id&${resellerRsFilter}&supplier_id=eq.${encodeURIComponent(sid)}&limit=1`
          )
          if (!Array.isArray(bindCheck) || bindCheck.length === 0) {
            return res.send({ items: [], total: 0, page, pageSize })
          }
          const filters: string[] = [`supplier_id=eq.${encodeURIComponent(sid)}`]
          if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
          const filterQs = `&${filters.join('&')}`
          const { data, total: supplierListTotal } = await supabase.selectWithCount(
            'suppliers',
            `select=supplier_id,name,status,created_at&order=created_at.desc&limit=1&offset=0${filterQs}`
          )
          const found = Array.isArray(data) ? data : []
          const itemTotal = typeof supplierListTotal === 'number' ? supplierListTotal : found.length
          if (page > 1) {
            rows = []
            total = itemTotal
          } else {
            rows = found
            total = itemTotal
          }
        } else {
          const linkRows = await supabase.select(
            'reseller_suppliers',
            `select=supplier_id&${resellerRsFilter}`
          )
          const boundSid = new Set<string>()
          for (const l of Array.isArray(linkRows) ? linkRows : []) {
            const sid = (l as { supplier_id?: string })?.supplier_id
              ? String((l as { supplier_id?: string }).supplier_id)
              : ''
            if (sid) boundSid.add(sid)
          }
          const supplierIdList = Array.from(boundSid)
          if (supplierIdList.length === 0) {
            rows = []
            total = 0
          } else {
            const idIn = supplierIdList.map((id: string) => encodeURIComponent(id)).join(',')
            const filters: string[] = [`supplier_id=in.(${idIn})`]
            if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
            const filterQs = `&${filters.join('&')}`
            const { data, total: t } = await supabase.selectWithCount(
              'suppliers',
              `select=supplier_id,name,status,created_at&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
            )
            rows = Array.isArray(data) ? data : []
            total = typeof t === 'number' ? t : rows.length
          }
        }
      } catch (error: unknown) {
        const message = String((error as { message?: string })?.message ?? '')
        if (message.includes("Could not find the table 'public.reseller_suppliers'")) {
          return sendError(res, 503, 'SCHEMA_NOT_READY', 'reseller_suppliers table is not available yet.')
        }
        throw error
      }
    }
    const supplierIds = rows.map((r: any) => r?.supplier_id).filter(Boolean).map((v: unknown) => String(v))
    const operatorMap = new Map<string, Array<{ operatorId: string | null; name: string | null; mcc: string | null; mnc: string | null }>>()
    if (supplierIds.length) {
      const idFilter = supplierIds.map((id: string) => encodeURIComponent(id)).join(',')
      const linkRows = await supabase.select(
        'operators',
        `select=operator_id,supplier_id,business_operator_id,name&supplier_id=in.(${idFilter})`
      )
      const links = Array.isArray(linkRows) ? linkRows : []
      const linkedOperatorIds = [
        ...new Set(links.map((link: any) => String(link?.business_operator_id ?? link?.operator_id ?? '')).filter(Boolean)),
      ]
      const operatorInfoMap = new Map<string, any>()
      if (linkedOperatorIds.length) {
        const operatorFilter = linkedOperatorIds.map((id: string) => encodeURIComponent(id)).join(',')
        const operatorRows = await supabase.select(
          'business_operators',
          `select=operator_id,name,mcc,mnc&operator_id=in.(${operatorFilter})`
        )
        const operatorInfos = Array.isArray(operatorRows) ? operatorRows : []
        for (const info of operatorInfos) {
          const infoId = info?.operator_id ? String(info.operator_id) : ''
          if (infoId) operatorInfoMap.set(infoId, info)
        }
      }
      for (const link of links) {
        const supplierKey = link?.supplier_id ? String(link.supplier_id) : null
        if (!supplierKey) continue
        if (!operatorMap.has(supplierKey)) operatorMap.set(supplierKey, [])
        const linkedOperatorId = link?.business_operator_id
          ? String(link.business_operator_id)
          : (link?.operator_id ? String(link.operator_id) : null)
        if (!linkedOperatorId) continue
        const operatorInfo = linkedOperatorId ? operatorInfoMap.get(linkedOperatorId) : null
        operatorMap.get(supplierKey)?.push({
          operatorId: linkedOperatorId,
          name: operatorInfo?.name ?? link?.name ?? null,
          mcc: operatorInfo?.mcc ?? null,
          mnc: operatorInfo?.mnc ?? null,
        })
      }
    }
    res.send({
      items: rows.map((r: any) => ({
        operators: operatorMap.get(String(r.supplier_id)) ?? [],
        operatorIds: (operatorMap.get(String(r.supplier_id)) ?? []).map((o: any) => o.operatorId).filter(Boolean),
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
    const ctx = getAuthContext(req)
    if (!ctx.roleScope && !ctx.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const isPlatform = ctx.roleScope === 'platform' || ctx.role === 'platform_admin'
    let resellerRead = false
    if (!isPlatform) {
      const ra = ensureResellerAdmin(req, res)
      if (!ra) return
      if (!ctx.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      resellerRead = true
    }
    const rawParams = req.params ?? {}
    const supplierIdFromParams = rawParams.supplierId
      ?? rawParams['supplierId:change-status']
      ?? rawParams.supplierStatusKey
    const supplierIdFromUrlMatch = String(req.raw?.url ?? '').match(/\/suppliers\/([^/:]+):change-status(?:\?|$)/)?.[1] ?? ''
    const supplierIdRaw = String(supplierIdFromParams || supplierIdFromUrlMatch || '')
    const supplierIdDecoded = decodeURIComponent(supplierIdRaw)
    const supplierId = supplierIdDecoded.match(/[0-9a-fA-F-]{36}/)?.[0] ?? ''
    if (!supplierId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
    }
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (resellerRead) {
      const bound = await resellerSupplierBindingExists(supabase, supplierId, String(ctx.resellerId))
      if (bound === 'schema') {
        return sendError(res, 503, 'SCHEMA_NOT_READY', 'reseller_suppliers table is not available yet.')
      }
      if (bound !== 'yes') {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
      }
    }
    const rows = await supabase.select(
      'suppliers',
      `select=supplier_id,name,status,created_at&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
    }
    if (operatorId) {
      const operatorRows = await supabase.select(
        'operators',
        `select=operator_id&or=(business_operator_id.eq.${encodeURIComponent(operatorId)},operator_id.eq.${encodeURIComponent(operatorId)})&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
      )
      if (!Array.isArray(operatorRows) || operatorRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
      }
    }
    const linkRows = await supabase.select(
      'operators',
      `select=operator_id,supplier_id,business_operator_id,name&supplier_id=eq.${encodeURIComponent(supplierId)}`
    )
    const links = Array.isArray(linkRows) ? linkRows : []
    const linkedOperatorIds = [...new Set(links.map((link: any) => String(link?.business_operator_id ?? link?.operator_id ?? '')).filter(Boolean))]
    const operatorInfoMap = new Map<string, any>()
    if (linkedOperatorIds.length) {
      const operatorFilter = linkedOperatorIds.map((id: string) => encodeURIComponent(id)).join(',')
      const operatorRows = await supabase.select(
        'business_operators',
        `select=operator_id,name,mcc,mnc&operator_id=in.(${operatorFilter})`
      )
      const operatorInfos = Array.isArray(operatorRows) ? operatorRows : []
      for (const info of operatorInfos) {
        const infoId = info?.operator_id ? String(info.operator_id) : ''
        if (infoId) operatorInfoMap.set(infoId, info)
      }
    }
    const operators = links.map((link: any) => {
      const linkedOperatorId = link?.business_operator_id
        ? String(link.business_operator_id)
        : (link?.operator_id ? String(link.operator_id) : null)
      if (!linkedOperatorId) return null
      const operatorInfo = operatorInfoMap.get(linkedOperatorId)
      return {
        operatorId: linkedOperatorId,
        name: operatorInfo?.name ?? link?.name ?? null,
        mcc: operatorInfo?.mcc ?? null,
        mnc: operatorInfo?.mnc ?? null,
      }
    }).filter(Boolean)
    res.send({
      supplierId: row.supplier_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      operators,
      operatorIds: operators.map((operator: any) => operator.operatorId).filter(Boolean),
    })
  })

  app.get(`${prefix}/suppliers/:supplierId/capabilities`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const rawParams = req.params ?? {}
    const supplierIdRaw = String(
      rawParams.supplierId
      ?? rawParams['supplierId:change-status']
      ?? rawParams.supplierStatusKey
      ?? req.raw?.url
      ?? ''
    )
    const supplierId = supplierIdRaw.match(/[0-9a-fA-F-]{36}/)?.[0] ?? ''
    if (!supplierId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
    }
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    if (!operatorId || !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId query parameter is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let adapter
    try {
      adapter = await createSupplierAdapter({ supabase, supplierId, operatorId })
    } catch {
      return sendError(res, 404, 'ADAPTER_NOT_FOUND', 'Supplier adapter not found.')
    }
    res.send({
      supplierId,
      operatorId,
      supplierKey: adapter.supplierKey,
      capabilities: adapter.capabilities,
    })
  })

  app.patch(`${prefix}/suppliers/:supplierId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const rawParams = req.params ?? {}
    const supplierIdRaw = String(
      rawParams.supplierId
      ?? rawParams['supplierId:change-status']
      ?? rawParams.supplierStatusKey
      ?? req.raw?.url
      ?? ''
    )
    const supplierId = supplierIdRaw.match(/[0-9a-fA-F-]{36}/)?.[0] ?? ''
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
    res.send({
      supplierId,
      name: name ?? row.name,
      status: status ?? row.status,
      updatedAt: nowIso,
    })
  })

  const changeSupplierStatusHandler = async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const rawParams = req.params ?? {}
    const supplierIdRaw = String(
      rawParams.supplierId
      ?? rawParams['supplierId:change-status']
      ?? rawParams.supplierStatusKey
      ?? req.raw?.url
      ?? ''
    )
    const supplierId = supplierIdRaw.match(/[0-9a-fA-F-]{36}/)?.[0] ?? ''
    if (!supplierId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
    }
    const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
    const statusInput = req.body?.status ? String(req.body.status) : null
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    const status = statusInput ? normalizeStatus(statusInput) : null
    if (!status) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE or SUSPENDED.')
    }
    if (!reason) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'reason is required.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
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
    if (operatorId) {
      const operatorRows = await supabase.select(
        'operators',
        `select=operator_id&operator_id=eq.${encodeURIComponent(operatorId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
      )
      if (!Array.isArray(operatorRows) || operatorRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
      }
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
    res.send({
      supplierId,
      status,
      previousStatus,
      changedAt: nowIso,
    })
  }

  app.post(`${prefix}/suppliers/:supplierId(^[^/]+):change-status`, changeSupplierStatusHandler)
  // Backward compatibility with legacy slash-style path.
  app.post(`${prefix}/suppliers/:supplierId/change-status`, changeSupplierStatusHandler)
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

  /** Reseller_admin on enterprise user routes: JWT → `resolve`; match `enterprise.parent_id`; honor DEACTIVATED → 403 `RESELLER_INACTIVE`. */
  const assertResellerAdminOwnsEnterpriseParent = async (
    supabase: SupabaseClient,
    reply: FastifyReply,
    auth: ReturnType<typeof getAuthContext>,
    enterpriseParentId: string
  ): Promise<boolean> => {
    if (auth.roleScope !== 'reseller') return true
    if (!auth.resellerId) {
      sendError(reply, 403, 'FORBIDDEN', 'Reseller scope required.')
      return false
    }
    const rr = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
    if (!rr.ok) {
      if (rr.reason === 'deactivated') {
        sendError(reply, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
      } else {
        sendError(reply, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      return false
    }
    if (String(enterpriseParentId || '') !== rr.parentTenantId) {
      sendError(reply, 403, 'FORBIDDEN', 'Reseller scope required.')
      return false
    }
    return true
  }

  app.post(`${prefix}/resellers/:resellerId/users`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const resellerIdParam = String(req.params.resellerId || '').trim()
    if (!resellerIdParam) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    const displayName = (typeof req.body?.name === 'string' ? req.body.name.trim() : '') || (typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '')
    const roleInput = typeof req.body?.role === 'string' ? req.body.role.trim() : ''
    const role = roleInput ? roleInput.toLowerCase() : ''
    const assignedEnterpriseIds = Array.isArray(req.body?.assignedEnterpriseIds)
      ? req.body.assignedEnterpriseIds.map((id: unknown) => String(id)).filter((id: string) => id.trim() !== '')
      : []
    if (!emailRegex.test(email)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'email is invalid.')
    }
    if (!displayName) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name (or displayName) is required.')
    }
    if (!resellerRoles.has(role)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'role is invalid for reseller users.')
    }
    const pwRes = readCreateUserPassword(req.body)
    if (!pwRes.ok) return sendError(res, 400, 'VALIDATION_ERROR', pwRes.message)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rrPath = await resolveResellerForEnterpriseScope(supabase, resellerIdParam)
    if (!rrPath.ok) {
      if (rrPath.reason === 'deactivated') {
        return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerIdParam} not found.`)
    }
    const tenantKey = rrPath.parentTenantId
    if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin' || !auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
      const rrAuth = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rrAuth.ok || rrAuth.parentTenantId !== tenantKey) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
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
      if (enterprises.some((e: any) => String(e.parent_id || '') !== tenantKey)) {
        return sendError(res, 403, 'FORBIDDEN', 'assignedEnterpriseIds must belong to reseller.')
      }
    }
    const inserted = await supabase.insert('users', {
      tenant_id: tenantKey,
      email,
      display_name: displayName,
      status: 'ACTIVE',
      password_hash: hashSecretScrypt(pwRes.password),
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
          reseller_id: tenantKey,
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
        tenant_id: tenantKey,
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
    res.code(201).send({
      userId: row.user_id,
      resellerId: tenantKey,
      email: row.email,
      name: row.display_name,
      displayName: row.display_name,
      role,
      status: row.status,
      assignedEnterpriseIds,
      createdAt: row.created_at,
    })
  })

  app.post(`${prefix}/resellers/:resellerId/users/:userId/assign-enterprises`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const resellerIdParam = String(req.params.resellerId || '').trim()
    const userId = String(req.params.userId || '')
    if (!resellerIdParam) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    if (!userId) {
      return sendError(res, 400, 'BAD_REQUEST', 'userId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rrPath = await resolveResellerForEnterpriseScope(supabase, resellerIdParam)
    if (!rrPath.ok) {
      if (rrPath.reason === 'deactivated') {
        return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerIdParam} not found.`)
    }
    const tenantKey = rrPath.parentTenantId
    if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin' || !auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
      const rrAuth = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rrAuth.ok || rrAuth.parentTenantId !== tenantKey) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const assignedEnterpriseIds: string[] | null = Array.isArray(req.body?.assignedEnterpriseIds)
      ? req.body.assignedEnterpriseIds.map((id: unknown) => String(id))
      : null
    const assignmentModeInput = typeof req.body?.mode === 'string' ? req.body.mode.trim().toLowerCase() : ''
    const assignmentMode = assignmentModeInput || 'replace'
    if (assignmentMode !== 'replace' && assignmentMode !== 'append') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'mode must be replace or append.')
    }
    if (!assignedEnterpriseIds) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'assignedEnterpriseIds is required.')
    }
    const userRows = await supabase.select(
      'users',
      `select=user_id,tenant_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    )
    const userRow = Array.isArray(userRows) ? userRows[0] : null
    if (!userRow || String((userRow as any).tenant_id || '') !== tenantKey) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `user ${userId} not found.`)
    }
    const existingAssignments = await supabase.select(
      'reseller_enterprise_assignments',
      `select=enterprise_id&user_id=eq.${encodeURIComponent(userId)}&reseller_id=eq.${encodeURIComponent(tenantKey)}`
    )
    const previousAssignedEnterpriseIds = Array.isArray(existingAssignments)
      ? existingAssignments.map((row: any) => String(row.enterprise_id))
      : []
    const normalizedAssignedEnterpriseIds = Array.from(new Set(assignedEnterpriseIds))
    const finalAssignedEnterpriseIds = assignmentMode === 'append'
      ? Array.from(new Set([...previousAssignedEnterpriseIds, ...normalizedAssignedEnterpriseIds]))
      : normalizedAssignedEnterpriseIds
    if (finalAssignedEnterpriseIds.length > 0) {
      const enterpriseFilter = finalAssignedEnterpriseIds.map((id: string) => encodeURIComponent(id)).join(',')
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=in.(${enterpriseFilter})&tenant_type=eq.ENTERPRISE`
      )
      const enterprises = Array.isArray(enterpriseRows) ? enterpriseRows : []
      if (enterprises.length !== finalAssignedEnterpriseIds.length) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'assignedEnterpriseIds contains invalid enterprise id.')
      }
      if (enterprises.some((e: any) => String(e.parent_id || '') !== tenantKey)) {
        return sendError(res, 403, 'FORBIDDEN', 'assignedEnterpriseIds must belong to reseller.')
      }
    }
    await supabase.delete(
      'reseller_enterprise_assignments',
      `user_id=eq.${encodeURIComponent(userId)}&reseller_id=eq.${encodeURIComponent(tenantKey)}`
    )
    if (finalAssignedEnterpriseIds.length > 0) {
      await supabase.insert(
        'reseller_enterprise_assignments',
        finalAssignedEnterpriseIds.map((enterpriseId: string) => ({
          user_id: userId,
          reseller_id: tenantKey,
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
        tenant_id: tenantKey,
        action: 'RESELLER_USER_ENTERPRISES_ASSIGNED',
        target_type: 'USER',
        target_id: userId,
        request_id: getTraceId(res),
        source_ip: req.ip,
        before_data: {
          assignedEnterpriseIds: previousAssignedEnterpriseIds,
        },
        after_data: {
          assignedEnterpriseIds: finalAssignedEnterpriseIds,
          mode: assignmentMode,
        },
      },
      { returning: 'minimal' }
    )
    res.send({
      userId,
      resellerId: tenantKey,
      assignedEnterpriseIds: finalAssignedEnterpriseIds,
    })
  })

  app.delete(`${prefix}/resellers/:resellerId/users/:userId/assign-enterprises`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const resellerIdParam = String(req.params.resellerId || '').trim()
    const userId = String(req.params.userId || '')
    if (!resellerIdParam) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    if (!userId) {
      return sendError(res, 400, 'BAD_REQUEST', 'userId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rrPath = await resolveResellerForEnterpriseScope(supabase, resellerIdParam)
    if (!rrPath.ok) {
      if (rrPath.reason === 'deactivated') {
        return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerIdParam} not found.`)
    }
    const tenantKey = rrPath.parentTenantId
    if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin' || !auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
      const rrAuth = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rrAuth.ok || rrAuth.parentTenantId !== tenantKey) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const userRows = await supabase.select(
      'users',
      `select=user_id,tenant_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    )
    const userRow = Array.isArray(userRows) ? userRows[0] : null
    if (!userRow || String((userRow as any).tenant_id || '') !== tenantKey) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `user ${userId} not found.`)
    }
    const existingAssignments = await supabase.select(
      'reseller_enterprise_assignments',
      `select=enterprise_id&user_id=eq.${encodeURIComponent(userId)}&reseller_id=eq.${encodeURIComponent(tenantKey)}`
    )
    const previousAssignedEnterpriseIds = Array.isArray(existingAssignments)
      ? existingAssignments.map((row: any) => String(row.enterprise_id))
      : []
    await supabase.delete(
      'reseller_enterprise_assignments',
      `user_id=eq.${encodeURIComponent(userId)}&reseller_id=eq.${encodeURIComponent(tenantKey)}`
    )
    await supabase.insert(
      'audit_logs',
      {
        actor_user_id: auth.userId,
        actor_role: auth.role,
        tenant_id: tenantKey,
        action: 'RESELLER_USER_ENTERPRISES_CLEARED',
        target_type: 'USER',
        target_id: userId,
        request_id: getTraceId(res),
        source_ip: req.ip,
        before_data: {
          assignedEnterpriseIds: previousAssignedEnterpriseIds,
        },
        after_data: {
          assignedEnterpriseIds: [],
        },
      },
      { returning: 'minimal' }
    )
    res.send({
      userId,
      resellerId: tenantKey,
      assignedEnterpriseIds: [],
    })
  })

  app.get(`${prefix}/resellers/:resellerId/users/:userId/enterprises`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const resellerIdParam = String(req.params.resellerId || '').trim()
    const userId = String(req.params.userId || '').trim()
    if (!resellerIdParam) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    if (!userId) {
      return sendError(res, 400, 'BAD_REQUEST', 'userId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rrPath = await resolveResellerForEnterpriseScope(supabase, resellerIdParam)
    if (!rrPath.ok) {
      if (rrPath.reason === 'deactivated') {
        return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerIdParam} not found.`)
    }
    const tenantKey = rrPath.parentTenantId
    if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin' || !auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
      const rrAuth = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rrAuth.ok || rrAuth.parentTenantId !== tenantKey) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const userRows = await supabase.select(
      'users',
      `select=user_id,tenant_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    )
    const userRow = Array.isArray(userRows) ? userRows[0] : null
    if (!userRow || String((userRow as any).tenant_id || '') !== tenantKey) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `user ${userId} not found.`)
    }
    const roleRows = await supabase.select(
      'user_roles',
      `select=role_name&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    )
    const targetRole = Array.isArray(roleRows) && roleRows[0] ? String((roleRows[0] as any).role_name || '').toLowerCase() : ''
    if (!resellerRoles.has(targetRole)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'target user is not a reseller user.')
    }

    const { page, pageSize, offset } = parsePagination(req.query ?? {}, {
      defaultPage: 1,
      defaultPageSize: 20,
      maxPageSize: 100,
    })

    let enterpriseRows: any[] = []
    if (targetRole === 'reseller_admin') {
      const rows = await supabase.select(
        'tenants',
        `select=tenant_id,name,enterprise_status,auto_suspend_enabled,created_at,updated_at&parent_id=eq.${encodeURIComponent(tenantKey)}&tenant_type=eq.ENTERPRISE&order=created_at.desc`
      )
      enterpriseRows = Array.isArray(rows) ? rows : []
    } else {
      const assignedRows = await supabase.select(
        'reseller_enterprise_assignments',
        `select=enterprise_id&user_id=eq.${encodeURIComponent(userId)}&reseller_id=eq.${encodeURIComponent(tenantKey)}`
      )
      const assignedIds = Array.isArray(assignedRows)
        ? Array.from(new Set(assignedRows.map((row: any) => String(row.enterprise_id || '')).filter(Boolean)))
        : []
      if (assignedIds.length > 0) {
        const idFilter = assignedIds.map((id: string) => encodeURIComponent(id)).join(',')
        const rows = await supabase.select(
          'tenants',
          `select=tenant_id,name,enterprise_status,auto_suspend_enabled,created_at,updated_at&tenant_id=in.(${idFilter})&tenant_type=eq.ENTERPRISE&parent_id=eq.${encodeURIComponent(tenantKey)}&order=created_at.desc`
        )
        enterpriseRows = Array.isArray(rows) ? rows : []
      }
    }

    const total = enterpriseRows.length
    const pagedRows = enterpriseRows.slice(offset, offset + pageSize)

    res.send({
      userId,
      resellerId: tenantKey,
      enterprises: pagedRows.map((row: any) => ({
        enterpriseId: row.tenant_id,
        name: row.name,
        enterprise_status: row.enterprise_status,
        auto_suspend_enabled: row.auto_suspend_enabled,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      total,
      page,
      pageSize,
    })
  })

  app.get(`${prefix}/resellers/:resellerId/users`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const resellerIdParam = String(req.params.resellerId || '').trim()
    if (!resellerIdParam) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rrPath = await resolveResellerForEnterpriseScope(supabase, resellerIdParam)
    if (!rrPath.ok) {
      if (rrPath.reason === 'deactivated') {
        return sendError(res, 403, 'RESELLER_INACTIVE', 'Reseller is deactivated.')
      }
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerIdParam} not found.`)
    }
    const tenantKey = rrPath.parentTenantId
    if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin' || !auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
      const rrAuth = await resolveResellerForEnterpriseScope(supabase, String(auth.resellerId))
      if (!rrAuth.ok || rrAuth.parentTenantId !== tenantKey) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const { data, total } = await supabase.selectWithCount(
      'users',
      `select=user_id,email,display_name,status,created_at&tenant_id=eq.${encodeURIComponent(tenantKey)}&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
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
    res.send({
      items: rows.map((r: any) => ({
        userId: r.user_id,
        resellerId: tenantKey,
        email: r.email,
        name: r.display_name,
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

  app.get(`${prefix}/enterprises/:enterpriseId/users`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const enterpriseId = String(req.params.enterpriseId || '')
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.roleScope === 'customer') {
      if (auth.role !== 'customer_admin' || !auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId.trim().toLowerCase()) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise admin required.')
      }
    } else if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin') {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
    if (!enterprise) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    }
    if (!(await assertResellerAdminOwnsEnterpriseParent(supabase, res, auth, String((enterprise as any).parent_id || '')))) return
    const { data, total } = await supabase.selectWithCount(
      'users',
      `select=user_id,email,display_name,status,created_at&tenant_id=eq.${encodeURIComponent(enterpriseId)}&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
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
    res.send({
      items: rows.map((r: any) => ({
        userId: r.user_id,
        enterpriseId,
        email: r.email,
        name: r.display_name,
        displayName: r.display_name,
        role: roleMap.get(r.user_id) ?? null,
        status: r.status,
        departmentId: null,
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
      if (auth.role !== 'customer_admin' || !auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId.trim().toLowerCase()) {
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
    const displayName = (typeof req.body?.name === 'string' ? req.body.name.trim() : '') || (typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '')
    const roleInput = typeof req.body?.role === 'string' ? req.body.role.trim() : ''
    const role = roleInput ? roleInput.toLowerCase() : ''
    const legacyDepartmentId =
      typeof req.body?.departmentId === 'string' ? String(req.body.departmentId).trim() : ''
    const assignedDepartmentIds = Array.isArray(req.body?.assignedDepartmentIds)
      ? req.body.assignedDepartmentIds.map((id: unknown) => String(id)).filter((id: string) => id.trim() !== '')
      : legacyDepartmentId
        ? [legacyDepartmentId]
        : []
    if (!emailRegex.test(email)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'email is invalid.')
    }
    if (!displayName) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name (or displayName) is required.')
    }
    if (!enterpriseRoles.has(role)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'role is invalid for enterprise users.')
    }
    const pwRes = readCreateUserPassword(req.body)
    if (!pwRes.ok) return sendError(res, 400, 'VALIDATION_ERROR', pwRes.message)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
    if (!enterprise) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    }
    if (!(await assertResellerAdminOwnsEnterpriseParent(supabase, res, auth, String((enterprise as any).parent_id || '')))) return
    if (assignedDepartmentIds.length > 0) {
      const departmentFilter = assignedDepartmentIds.map((id: string) => encodeURIComponent(id)).join(',')
      const departmentRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=in.(${departmentFilter})&tenant_type=eq.DEPARTMENT`
      )
      const departments = Array.isArray(departmentRows) ? departmentRows : []
      if (departments.length !== assignedDepartmentIds.length) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'assignedDepartmentIds contains invalid department id.')
      }
      if (departments.some((d: any) => String(d.parent_id || '') !== enterpriseId)) {
        return sendError(res, 403, 'FORBIDDEN', 'assignedDepartmentIds must belong to enterprise.')
      }
    }
    const inserted = await supabase.insert('users', {
      tenant_id: enterpriseId,
      email,
      display_name: displayName,
      status: 'ACTIVE',
      password_hash: hashSecretScrypt(pwRes.password),
    })
    const row = Array.isArray(inserted) ? inserted[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create user.')
    }
    await supabase.insert('user_roles', { user_id: row.user_id, role_name: role }, { returning: 'minimal' })
    if (assignedDepartmentIds.length > 0) {
      await supabase.insert(
        'enterprise_user_departments',
        assignedDepartmentIds.map((departmentId: string) => ({
          user_id: row.user_id,
          enterprise_id: enterpriseId,
          department_id: departmentId,
        })),
        { returning: 'minimal' }
      )
    }
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
          assignedDepartmentIds,
        },
      },
      { returning: 'minimal' }
    )
    res.code(201).send({
      userId: row.user_id,
      enterpriseId,
      email: row.email,
      name: row.display_name,
      displayName: row.display_name,
      role,
      status: row.status,
      assignedDepartmentIds,
      createdAt: row.created_at,
    })
  })

  app.post(`${prefix}/enterprises/:enterpriseId/users/:userId/assign-departments`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const enterpriseId = String(req.params.enterpriseId || '').trim().toLowerCase()
    const userId = String(req.params.userId || '').trim().toLowerCase()
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    if (!userId) {
      return sendError(res, 400, 'BAD_REQUEST', 'userId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.roleScope === 'customer') {
      if (auth.role !== 'customer_admin' || !auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise admin required.')
      }
    } else if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin') {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const assignedDepartmentIds: string[] | null = Array.isArray(req.body?.assignedDepartmentIds)
      ? req.body.assignedDepartmentIds.map((id: unknown) => String(id))
      : null
    const assignmentModeInput = typeof req.body?.mode === 'string' ? req.body.mode.trim().toLowerCase() : ''
    const assignmentMode = assignmentModeInput || 'replace'
    if (assignmentMode !== 'replace' && assignmentMode !== 'append') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'mode must be replace or append.')
    }
    if (!assignedDepartmentIds) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'assignedDepartmentIds is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    try {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      }
      if (!(await assertResellerAdminOwnsEnterpriseParent(supabase, res, auth, String((enterprise as any).parent_id || '')))) return
      const userRows = await supabase.select(
        'users',
        `select=user_id,tenant_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
      )
      const userRow = Array.isArray(userRows) ? userRows[0] : null
      if (!userRow || String((userRow as any).tenant_id || '') !== enterpriseId) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `user ${userId} not found.`)
      }
      const existingAssignments = await supabase.select(
        'enterprise_user_departments',
        `select=department_id&user_id=eq.${encodeURIComponent(userId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`
      )
      const previousAssignedDepartmentIds = Array.isArray(existingAssignments)
        ? existingAssignments.map((row: any) => String(row.department_id))
        : []
      const normalizedAssignedDepartmentIds = Array.from(new Set(assignedDepartmentIds))
      const finalAssignedDepartmentIds = assignmentMode === 'append'
        ? Array.from(new Set([...previousAssignedDepartmentIds, ...normalizedAssignedDepartmentIds]))
        : normalizedAssignedDepartmentIds
      if (finalAssignedDepartmentIds.length > 0) {
        const departmentFilter = finalAssignedDepartmentIds.map((id: string) => encodeURIComponent(id)).join(',')
        const departmentRows = await supabase.select(
          'tenants',
          `select=tenant_id,parent_id&tenant_id=in.(${departmentFilter})&tenant_type=eq.DEPARTMENT`
        )
        const departments = Array.isArray(departmentRows) ? departmentRows : []
        if (departments.length !== finalAssignedDepartmentIds.length) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'assignedDepartmentIds contains invalid department id.')
        }
        if (departments.some((d: any) => String(d.parent_id || '') !== enterpriseId)) {
          return sendError(res, 403, 'FORBIDDEN', 'assignedDepartmentIds must belong to enterprise.')
        }
      }
      await supabase.delete(
        'enterprise_user_departments',
        `user_id=eq.${encodeURIComponent(userId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`
      )
      if (finalAssignedDepartmentIds.length > 0) {
        await supabase.insert(
          'enterprise_user_departments',
          finalAssignedDepartmentIds.map((departmentId: string) => ({
            user_id: userId,
            enterprise_id: enterpriseId,
            department_id: departmentId,
          })),
          { returning: 'minimal' }
        )
      }
      await supabase.insert(
        'audit_logs',
        {
          actor_user_id: auth.userId,
          actor_role: auth.role,
          tenant_id: enterpriseId,
          action: 'ENTERPRISE_USER_DEPARTMENTS_ASSIGNED',
          target_type: 'USER',
          target_id: userId,
          request_id: getTraceId(res),
          source_ip: req.ip,
          before_data: {
            assignedDepartmentIds: previousAssignedDepartmentIds,
          },
          after_data: {
            assignedDepartmentIds: finalAssignedDepartmentIds,
            mode: assignmentMode,
          },
        },
        { returning: 'minimal' }
      )
      res.send({
        userId,
        enterpriseId,
        assignedDepartmentIds: finalAssignedDepartmentIds,
      })
    } catch (err: any) {
      if (isMissingTableError(err, 'enterprise_user_departments')) {
        return sendError(
          res,
          503,
          'SCHEMA_NOT_READY',
          'enterprise_user_departments table is missing. Apply migration 0040_add_enterprise_user_departments.sql.'
        )
      }
      if (typeof err?.status === 'number' && typeof err?.code === 'string' && typeof err?.message === 'string') {
        return sendError(res, err.status, err.code, err.message)
      }
      throw err
    }
  })

  app.delete(`${prefix}/enterprises/:enterpriseId/users/:userId/assign-departments`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const enterpriseId = String(req.params.enterpriseId || '').trim().toLowerCase()
    const userId = String(req.params.userId || '').trim().toLowerCase()
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    if (!userId) {
      return sendError(res, 400, 'BAD_REQUEST', 'userId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.roleScope === 'customer') {
      if (auth.role !== 'customer_admin' || !auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise admin required.')
      }
    } else if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin') {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    try {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      }
      if (!(await assertResellerAdminOwnsEnterpriseParent(supabase, res, auth, String((enterprise as any).parent_id || '')))) return
      const userRows = await supabase.select(
        'users',
        `select=user_id,tenant_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
      )
      const userRow = Array.isArray(userRows) ? userRows[0] : null
      if (!userRow || String((userRow as any).tenant_id || '') !== enterpriseId) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `user ${userId} not found.`)
      }
      const existingAssignments = await supabase.select(
        'enterprise_user_departments',
        `select=department_id&user_id=eq.${encodeURIComponent(userId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`
      )
      const previousAssignedDepartmentIds = Array.isArray(existingAssignments)
        ? existingAssignments.map((row: any) => String(row.department_id))
        : []
      await supabase.delete(
        'enterprise_user_departments',
        `user_id=eq.${encodeURIComponent(userId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`
      )
      await supabase.insert(
        'audit_logs',
        {
          actor_user_id: auth.userId,
          actor_role: auth.role,
          tenant_id: enterpriseId,
          action: 'ENTERPRISE_USER_DEPARTMENTS_CLEARED',
          target_type: 'USER',
          target_id: userId,
          request_id: getTraceId(res),
          source_ip: req.ip,
          before_data: {
            assignedDepartmentIds: previousAssignedDepartmentIds,
          },
          after_data: {
            assignedDepartmentIds: [],
          },
        },
        { returning: 'minimal' }
      )
      res.send({
        userId,
        enterpriseId,
        assignedDepartmentIds: [],
      })
    } catch (err: any) {
      if (isMissingTableError(err, 'enterprise_user_departments')) {
        return sendError(
          res,
          503,
          'SCHEMA_NOT_READY',
          'enterprise_user_departments table is missing. Apply migration 0040_add_enterprise_user_departments.sql.'
        )
      }
      if (typeof err?.status === 'number' && typeof err?.code === 'string' && typeof err?.message === 'string') {
        return sendError(res, err.status, err.code, err.message)
      }
      throw err
    }
  })

  app.get(`${prefix}/enterprises/:enterpriseId/users/:userId/departments`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    const enterpriseId = String(req.params.enterpriseId || '').trim().toLowerCase()
    const userId = String(req.params.userId || '').trim().toLowerCase()
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    if (!userId) {
      return sendError(res, 400, 'BAD_REQUEST', 'userId is required.')
    }
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (auth.roleScope === 'customer') {
      if (auth.role !== 'customer_admin' || !auth.customerId || String(auth.customerId).trim().toLowerCase() !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise admin required.')
      }
    } else if (auth.roleScope === 'reseller') {
      if (auth.role !== 'reseller_admin') {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller admin required.')
      }
    } else if (!(auth.roleScope === 'platform' || auth.role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }

    const { page, pageSize, offset } = parsePagination(req.query ?? {}, {
      defaultPage: 1,
      defaultPageSize: 20,
      maxPageSize: 100,
    })

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    try {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      }
      if (!(await assertResellerAdminOwnsEnterpriseParent(supabase, res, auth, String((enterprise as any).parent_id || '')))) return
      const userRows = await supabase.select(
        'users',
        `select=user_id,tenant_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
      )
      const userRow = Array.isArray(userRows) ? userRows[0] : null
      if (!userRow || String((userRow as any).tenant_id || '') !== enterpriseId) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `user ${userId} not found.`)
      }
      const roleRows = await supabase.select(
        'user_roles',
        `select=role_name&user_id=eq.${encodeURIComponent(userId)}&limit=1`
      )
      const targetRole = Array.isArray(roleRows) && roleRows[0] ? String((roleRows[0] as any).role_name || '').toLowerCase() : ''
      if (!enterpriseRoles.has(targetRole)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'target user is not an enterprise user.')
      }

      let departmentRows: any[] = []
      if (targetRole === 'customer_admin') {
        const rows = await supabase.select(
          'tenants',
          `select=tenant_id,name,created_at,updated_at&parent_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.DEPARTMENT&order=created_at.desc`
        )
        departmentRows = Array.isArray(rows) ? rows : []
      } else {
        const assignedRows = await supabase.select(
          'enterprise_user_departments',
          `select=department_id&user_id=eq.${encodeURIComponent(userId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`
        )
        const assignedIds = Array.isArray(assignedRows)
          ? Array.from(new Set(assignedRows.map((row: any) => String(row.department_id || '')).filter(Boolean)))
          : []
        if (assignedIds.length > 0) {
          const idFilter = assignedIds.map((id: string) => encodeURIComponent(id)).join(',')
          const rows = await supabase.select(
            'tenants',
            `select=tenant_id,name,created_at,updated_at&tenant_id=in.(${idFilter})&tenant_type=eq.DEPARTMENT&parent_id=eq.${encodeURIComponent(enterpriseId)}&order=created_at.desc`
          )
          departmentRows = Array.isArray(rows) ? rows : []
        }
      }

      const total = departmentRows.length
      const pagedRows = departmentRows.slice(offset, offset + pageSize)

      res.send({
        userId,
        enterpriseId,
        departments: pagedRows.map((row: any) => ({
          departmentId: row.tenant_id,
          name: row.name,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
        total,
        page,
        pageSize,
      })
    } catch (err: any) {
      if (isMissingTableError(err, 'enterprise_user_departments')) {
        return sendError(
          res,
          503,
          'SCHEMA_NOT_READY',
          'enterprise_user_departments table is missing. Apply migration 0040_add_enterprise_user_departments.sql.'
        )
      }
      if (typeof err?.status === 'number' && typeof err?.code === 'string' && typeof err?.message === 'string') {
        return sendError(res, err.status, err.code, err.message)
      }
      throw err
    }
  })
}

export function registerAuditLogRoutes({
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

  async function queryAuditLogs(req: any, res: any, pagination: { defaultPageSize: number; maxPageSize: number }) {
    const auth = getAuthContext(req)
    if (!auth.roleScope && !auth.role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    const isPlatform = auth.roleScope === 'platform' || auth.role === 'platform_admin'
    const isResellerAdmin = auth.roleScope === 'reseller' && auth.role === 'reseller_admin'
    if (!isPlatform && !isResellerAdmin) {
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return null
    }
    if (isResellerAdmin && !auth.resellerId) {
      sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      return null
    }
    const actorEmail = req.query.actorEmail ? String(req.query.actorEmail).trim() : null
    const action = req.query.action ? String(req.query.action) : null
    const from = req.query.from ? String(req.query.from) : null
    const to = req.query.to ? String(req.query.to) : null
    const queryResellerId = req.query.resellerId ? String(req.query.resellerId).trim() : null
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (queryResellerId && !isValidUuid(queryResellerId)) {
      sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      return null
    }
    if (isResellerAdmin && queryResellerId && queryResellerId !== auth.resellerId) {
      sendError(res, 403, 'FORBIDDEN', 'resellerId is out of token scope.')
      return null
    }
    const resellerId = isResellerAdmin ? auth.resellerId : queryResellerId
    const tenantIds: string[] = []
    if (resellerId) {
      const resellerRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
      )
      const reseller = Array.isArray(resellerRows) ? resellerRows[0] : null
      if (!reseller) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
        return null
      }
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE`
      )
      const enterprises = Array.isArray(enterpriseRows) ? enterpriseRows : []
      tenantIds.push(resellerId, ...enterprises.map((r: any) => String(r.tenant_id)))
    }
    const { page, pageSize, offset } = parsePagination(req.query, {
      defaultPage: 1,
      defaultPageSize: pagination.defaultPageSize,
      maxPageSize: pagination.maxPageSize,
    })
    const filters: string[] = []
    const actorEmailUserIds: string[] = []
    if (actorEmail) {
      const userRows = await supabase.select(
        'users',
        `select=user_id,email,tenant_id&email=eq.${encodeURIComponent(actorEmail)}`,
      )
      const users = Array.isArray(userRows) ? userRows : []
      if (users.length === 0) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `actorEmail ${actorEmail} not found.`)
        return null
      }
      const scopedUsers = isPlatform
        ? users
        : users.filter((user: any) => tenantIds.includes(String(user.tenant_id || '')))
      if (scopedUsers.length === 0) {
        sendError(res, 403, 'FORBIDDEN', 'actorEmail is out of reseller scope.')
        return null
      }
      actorEmailUserIds.push(
        ...scopedUsers
          .map((user: any) => String(user.user_id || '').trim())
          .filter((userId: string) => userId.length > 0),
      )
      filters.push(`actor_user_id=in.(${actorEmailUserIds.map((id) => encodeURIComponent(id)).join(',')})`)
    }
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
    const actorUserIds = Array.from(new Set(
      rows
        .map((r: any) => String(r.actor_user_id || '').trim())
        .filter((id: string) => id.length > 0)
    ))
    const actorEmailByUserId = new Map<string, string>()
    if (actorUserIds.length > 0) {
      const userRows = await supabase.select(
        'users',
        `select=user_id,email&user_id=in.(${actorUserIds.map((id) => encodeURIComponent(id)).join(',')})`,
      )
      const users = Array.isArray(userRows) ? userRows : []
      for (const user of users) {
        const userId = String((user as any).user_id || '').trim()
        const email = String((user as any).email || '').trim()
        if (userId && email) actorEmailByUserId.set(userId, email)
      }
    }
    const items = rows.map((r: any) => ({
        logId: r.audit_id,
        actorUserId: r.actor_user_id,
        actorEmail: r.actor_user_id ? actorEmailByUserId.get(String(r.actor_user_id)) ?? null : null,
        actorLabel: r.actor_user_id
          ? actorEmailByUserId.get(String(r.actor_user_id)) ?? String(r.actor_user_id)
          : (r.actor_role ? String(r.actor_role) : 'SYSTEM'),
        actorRole: r.actor_role,
        tenantScope: r.tenant_id,
        action: r.action,
        target: r.target_type ? `${r.target_type}:${r.target_id ?? ''}` : r.target_id,
        before: r.before_data,
        after: r.after_data,
        requestId: r.request_id,
        timestamp: r.created_at,
        sourceIp: r.source_ip,
      }))
    return {
      items,
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    }
  }

  app.get(`${prefix}/audit-logs`, async (req: any, res: any) => {
    const result = await queryAuditLogs(req, res, { defaultPageSize: 20, maxPageSize: 20 })
    if (!result) return
    res.send(result)
  })

  app.get(`${prefix}/audit-logs::csv`, async (req: any, res: any) => {
    const result = await queryAuditLogs(req, res, { defaultPageSize: 100, maxPageSize: 1000 })
    if (!result) return
    const headers = [
      'auditId',
      'createdAt',
      'actorLabel',
      'actorEmail',
      'actorUserId',
      'actorRole',
      'tenantId',
      'action',
      'targetType',
      'targetId',
      'requestId',
      'sourceIp',
      'beforeData',
      'afterData',
    ]
    const csvRows = [headers.map(escapeCsv).join(',')]
    for (const item of result.items) {
      const target = item.target ? String(item.target) : ''
      const targetParts = target.split(':')
      const targetType = targetParts.length > 1 ? targetParts[0] : ''
      const targetId = targetParts.length > 1 ? targetParts.slice(1).join(':') : target
      csvRows.push([
        item.logId,
        item.timestamp,
        item.actorLabel,
        item.actorEmail ?? '',
        item.actorUserId ?? '',
        item.actorRole ?? '',
        item.tenantScope ?? '',
        item.action ?? '',
        targetType,
        targetId,
        item.requestId ?? '',
        item.sourceIp ?? '',
        item.before == null ? '' : JSON.stringify(item.before),
        item.after == null ? '' : JSON.stringify(item.after),
      ].map(escapeCsv).join(','))
    }
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', 'attachment; filename="audit-logs.csv"')
    res.send(`\uFEFF${csvRows.join('\n')}\n`)
  })
}

async function resolveEnterpriseForReseller(req: FastifyRequest, reply: FastifyReply, supabase: SupabaseClient, enterpriseId: string | null) {
  const auth = getAuthContext(req)
  if (auth.roleScope !== 'reseller') return enterpriseId
  const resellerRef = auth.resellerId
  if (!resellerRef) {
    sendError(reply, 403, 'FORBIDDEN', 'Reseller scope required.')
    return null
  }
  if (!enterpriseId) {
    sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required for reseller scope.')
    return null
  }
  const resolved = await resolveResellerForEnterpriseScope(supabase, String(resellerRef))
  if (!resolved.ok) {
    if (resolved.reason === 'deactivated') {
      sendError(reply, 403, 'FORBIDDEN', 'Reseller account is deactivated.')
      return null
    }
    sendError(reply, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
    return null
  }
  const parentTenantId = resolved.parentTenantId
  const rows = await supabase.select('tenants', `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`)
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) {
    sendError(reply, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    return null
  }
  if (String((row as any).parent_id || '') !== String(parentTenantId)) {
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
  operatorId,
  supabase: supabaseClient,
}: {
  iccid: string
  status: string
  traceId?: string | null
  supplierId?: string | null
  operatorId?: string | null
  supabase?: ReturnType<typeof createSupabaseRestClient> | null
}) {
  if (!supplierId) {
    return { ok: false, skipped: true, reason: 'MISSING_SUPPLIER' }
  }
  if (!operatorId) {
    return { ok: false, skipped: true, reason: 'MISSING_OPERATOR' }
  }
  let adapter
  try {
    adapter = await createSupplierAdapter({
      supabase: supabaseClient ?? undefined,
      supplierId,
      operatorId,
    })
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
  const app = Fastify({
    bodyLimit: MULTIPART_BODY_LIMIT_BYTES,
    rewriteUrl: (req) => rewriteColonCatalogUrl(req.url ?? '/'),
  })
  app.addContentTypeParser(
    /^multipart\/form-data(;.*)?$/i,
    { parseAs: 'buffer', bodyLimit: MULTIPART_BODY_LIMIT_BYTES },
    (_req, body, done) => {
      done(null, body)
    },
  )
  registerAuditLogHook(app)
  app.addHook('onRequest', async (_req, reply) => {
    const traceId = `req_${crypto.randomUUID().replaceAll('-', '')}`
    ;(reply as { traceId?: string }).traceId = traceId
    reply.header('X-Request-Id', traceId)
  })
  app.setErrorHandler((error, _req, reply) => {
    const err = error as any
    if (err?.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      reply.status(400).send({
        code: 'BAD_REQUEST',
        message: 'Request body must be valid JSON.',
        traceId: getTraceId(reply),
      })
      return
    }
    if (err?.validation?.length) {
      const issue = err.validation[0]
      const fieldPath = String(issue?.instancePath || '').replace(/\//g, '.').replace(/^\./, '')
      const message = fieldPath ? `${fieldPath} ${String(issue?.message || 'is invalid.')}` : String(issue?.message || 'Request validation failed.')
      reply.status(400).send({
        code: 'BAD_REQUEST',
        message,
        traceId: getTraceId(reply),
      })
      return
    }
    const status = Number(err?.statusCode ?? err?.status ?? 500)
    const isClientError = Number.isFinite(status) && status >= 400 && status < 500
    reply.status(isClientError ? status : 500).send({
      code: isClientError ? String(err?.code || 'BAD_REQUEST') : 'INTERNAL_ERROR',
      message: isClientError ? String(err?.message || 'Bad request.') : 'Internal server error.',
      traceId: getTraceId(reply),
    })
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
      path === '/auth/forgot-password' ||
      path === '/v1/auth/forgot-password' ||
      path === '/auth/reset-password' ||
      path === '/v1/auth/reset-password' ||
      path === '/v1/cmp/webhook/sim-status-changed' ||
      /^\/v1\/suppliers\/[^/]+\/operators\/[^/]+\/webhooks\/[^/]+\/[^/]+$/.test(path) ||
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
  registerAdminObservabilityRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
      isValidUuid,
    },
  })
  registerAdminObservabilityRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
      isValidUuid,
    },
  })
  registerAdminTestReadyExpiryRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
      isValidUuid,
    },
  })
  registerAdminTestReadyExpiryRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
      isValidUuid,
    },
  })
  registerAdminSimBackdateTestStartRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
      requireIccid,
    },
  })
  registerAdminSimBackdateTestStartRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
      requireIccid,
    },
  })
  registerAdminWxRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
      requireIccid,
      isValidUuid,
      toIsoDateTime,
    },
  })
  registerAdminWxRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
      requireIccid,
      isValidUuid,
      toIsoDateTime,
    },
  })
  registerBillRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getEnterpriseIdFromReq,
      getRoleScope,
      isValidUuid,
    },
  })
  registerBillRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getEnterpriseIdFromReq,
      getRoleScope,
      isValidUuid,
    },
  })
  registerBillReconciliationRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerBillReconciliationRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
    },
  })
  registerBillingRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      isValidUuid,
    },
  })
  registerBillingRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      isValidUuid,
    },
  })
  registerReportRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      isValidUuid,
    },
  })
  registerReportRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      isValidUuid,
    },
  })
  registerAdjustmentNoteRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
    },
  })
  registerAdjustmentNoteRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
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
      ensureSubscriptionAccess,
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
  registerSimDiagnosticsRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      getDepartmentIdFromReq,
      normalizeIccid,
      isValidIccid,
    },
  })
  registerSimDiagnosticsRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      getDepartmentIdFromReq,
      normalizeIccid,
      isValidIccid,
    },
  })
  registerJobRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      isValidUuid,
    },
  })
  // Legacy Express also mounted `GET /jobs/:jobId` without the `/v1` prefix.
  registerJobRoutes({
    app,
    prefix: '',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      isValidUuid,
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
      getEnterpriseIdFromReq,
      toIsoDateTime,
    },
  })
  registerRatingFallbackPackageRoutes({
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
  registerPackageModuleRoutes({
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
      readRequestBody,
      parseMultipartFormData,
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
      readRequestBody,
      parseMultipartFormData,
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
  registerAlertRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      isValidUuid,
    },
  })
  registerAlertConfigRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
      isValidUuid,
    },
  })
  registerAlertConfigurationRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getRoleScope,
      getEnterpriseIdFromReq,
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
  registerPublicInfoRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      getAuthContext,
      ensurePlatformAdmin,
      isValidUuid,
    },
  })
  registerUpstreamIntegrationRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      ensurePlatformAdmin,
      isValidUuid,
      buildBaseUrl,
    },
  })
  registerUpstreamWebhookEventRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient,
      getTraceId,
      sendError,
      requireAdminAccess: requireAdminApiKey,
    },
  })
  const wxInboundWebhookDeps: WxInboundWebhookDeps = {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    requireIccid,
    validateWebhookTimestamp,
    isDuplicateEventByPayloadField,
    toIsoDateTime,
    wxWebhookMaxAgeMinutes: WX_WEBHOOK_MAX_AGE_MINUTES,
  }
  app.post(
    '/v1/suppliers/:supplierId/operators/:operatorId/webhooks/:adapterType/:eventKey',
    async (req: any, res: any) => {
      const supplierId = String(req.params?.supplierId ?? '').trim()
      const operatorId = String(req.params?.operatorId ?? '').trim()
      const adapterType = String(req.params?.adapterType ?? '').trim().toLowerCase()
      const eventKey = String(req.params?.eventKey ?? '').trim()
      if (!isValidUuid(supplierId) || !isValidUuid(operatorId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'supplierId and operatorId must be valid UUIDs.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const gate = await validateInboundWebhookGate({
        supabase,
        supplierId,
        operatorId,
        adapterType,
        eventKey,
        traceId: getTraceId(res),
        sourceIp: req.ip,
      })
      if (!gate.ok) {
        return sendError(res, gate.status, gate.code, gate.message)
      }
      const actual = getInboundWebhookKeyFromReq(req)
      if (!actual) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid webhookKey.')
      }
      if (actual !== gate.integration.webhookKey) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid webhookKey.')
      }
      const handler = resolveInboundWebhookHandler(wxInboundWebhookDeps, adapterType, eventKey)
      if (!handler) {
        return sendError(res, 404, 'NOT_FOUND', `No inbound webhook handler for ${adapterType}/${eventKey}.`)
      }
      return handler(req, res)
    }
  )
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
      `select=sim_id,iccid,status,enterprise_id,reseller_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    if (sim.status === newStatus) {
      return res.send({ success: true, changed: false })
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
    const cmpWebhookEventScope = await resolveEventScopeColumns(supabase, {
      enterpriseId: sim.enterprise_id ?? null,
      resellerId: sim.reseller_id ?? null,
    })
    await supabase.insert('events', {
      event_type: 'SIM_STATUS_CHANGED',
      occurred_at: nowIso,
      enterprise_id: cmpWebhookEventScope.enterpriseId,
      reseller_id: cmpWebhookEventScope.resellerId,
      request_id: getTraceId(res),
      payload: sanitizeEventPayload({
        iccid: sim.iccid,
        beforeStatus: sim.status,
        afterStatus: newStatus,
        reason: 'CMP_WEBHOOK',
      }),
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
    res.send({ success: true, changed: true })
  })
  const readyHandler = async (req: FastifyRequest, res: FastifyReply) => {
    if (!ensurePlatformAdmin(req, res)) return
    const supabaseConfigured = Boolean(process.env.SUPABASE_URL) && Boolean(process.env.SUPABASE_ANON_KEY)
    const hasServiceRoleKey = Boolean(String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim())
    const supabase = supabaseConfigured
      ? createSupabaseRestClient({
          useServiceRole: hasServiceRoleKey,
          traceId: getTraceId(res),
        })
      : null
    const result = await buildReadyProbeResponse(supabase, { hasServiceRoleKey })
    res.status(result.ok ? 200 : 503).send(result)
  }
  app.get('/ready', readyHandler)
  app.get('/v1/ready', readyHandler)

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

  /** Swagger UI uses operationsSorter; YAML path order alone is ignored when sorter is "alpha". */
  const INTEGRATION_SWAGGER_OPERATIONS_ORDER = [
    'post /upstream-integrations',
    'get /upstream-integrations',
    'get /upstream-integrations/{integrationId}',
    'patch /upstream-integrations/{integrationId}',
    'delete /upstream-integrations/{integrationId}',
  ]

  /** Keep in sync with tools/add_webhooks_x_sort_order.mjs */
  const OUTBOUND_WEBHOOKS_SWAGGER_OPERATIONS_ORDER = [
    'get /outbound-webhook-events',
    'post /webhook-subscriptions',
    'get /webhook-subscriptions',
    'get /webhook-subscriptions/{webhookId}',
    'patch /webhook-subscriptions/{webhookId}',
    'post /webhook-subscriptions/{webhookId}:deprecate',
    'get /webhook-subscriptions/{webhookId}/deliveries',
    'post /webhook-deliveries/{deliveryId}/retry',
  ]

  const INBOUND_WEBHOOKS_SWAGGER_OPERATIONS_ORDER = [
    'get /upstream-webhook-events',
    'post /suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/subscription',
    'post /suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/update-location',
    'post /suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/sim-status-changed',
    'post /suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/traffic-alert',
  ]

  const NETWORK_PROFILES_SWAGGER_OPERATIONS_ORDER = [
    'post /apn-profiles',
    'get /apn-profiles',
    'get /apn-profiles/{apnProfileId}',
    'post /apn-profiles/{apnProfileId}:publish',
    'post /apn-profiles/{apnProfileId}:deprecate',
    'post /roaming-profiles',
    'post /roaming-profiles:import-csv',
    'get /roaming-profiles',
    'get /roaming-profiles/{roamingProfileId}',
    'get /roaming-profiles/{roamingProfileId}:export-csv',
    'post /roaming-profiles/{roamingProfileId}:publish',
    'post /roaming-profiles/{roamingProfileId}:deprecate',
  ]

  const COVERED_NETWORK_PROFILES_SWAGGER_OPERATIONS_ORDER = [
    'post /covered-network-profiles',
    'get /covered-network-profiles',
    'get /covered-network-profiles/{coveredNetworkProfileId}',
    'patch /covered-network-profiles/{coveredNetworkProfileId}',
    'post /covered-network-profiles/{coveredNetworkProfileId}:publish',
    'post /covered-network-profiles/{coveredNetworkProfileId}:deprecate',
  ]

  const CARRIER_SERVICES_SWAGGER_OPERATIONS_ORDER = [
    'post /carrier-services',
    'get /carrier-services',
    'get /carrier-services/{carrierServiceId}',
    'put /carrier-services/{carrierServiceId}',
    'post /carrier-services/{carrierServiceId}:publish',
    'post /carrier-services/{carrierServiceId}:deprecate',
    'post /carrier-services:validate',
  ]

  const COMMERCIAL_TERMS_SWAGGER_OPERATIONS_ORDER = [
    'post /commercial-terms',
    'get /commercial-terms',
    'get /commercial-terms/{commercialTermsId}',
    'put /commercial-terms/{commercialTermsId}',
    'post /commercial-terms/{commercialTermsId}:publish',
    'post /commercial-terms/{commercialTermsId}:deprecate',
    'post /commercial-terms:validate',
  ]

  const CONTROL_POLICIES_SWAGGER_OPERATIONS_ORDER = [
    'post /control-policies',
    'get /control-policies',
    'get /control-policies/{controlPolicyId}',
    'put /control-policies/{controlPolicyId}',
    'post /control-policies/{controlPolicyId}:publish',
    'post /control-policies/{controlPolicyId}:deprecate',
    'post /control-policies:validate',
  ]

  const PRICE_PLANS_SWAGGER_OPERATIONS_ORDER = [
    'post /enterprises/{enterpriseId}/price-plans',
    'get /enterprises/{enterpriseId}/price-plans',
    'get /price-plans/{pricePlanId}',
    'put /price-plans/{pricePlanId}',
    'post /price-plans/{pricePlanId}:publish',
    'post /price-plans/{pricePlanId}:deprecate',
  ]

  const PACKAGES_SWAGGER_OPERATIONS_ORDER = [
    'post /enterprises/{enterpriseId}/packages',
    'get /enterprises/{enterpriseId}/packages',
    'get /enterprises/{enterpriseId}/packages:csv',
    'get /packages/{packageId}',
    'put /packages/{packageId}',
    'post /packages/{packageId}:publish',
    'post /packages/{packageId}:deprecate',
    'get /packages',
  ]

  const ENTERPRISES_SWAGGER_OPERATIONS_ORDER = [
    'get /enterprises',
    'get /enterprises/{enterpriseId}',
    'post /enterprises',
    'post /enterprises/{enterpriseId}:change-status',
  ]

  const USERS_SWAGGER_OPERATIONS_ORDER = [
    'post /resellers/{resellerId}/users',
    'get /resellers/{resellerId}/users',
    'post /resellers/{resellerId}/users/{userId}/assign-enterprises',
    'delete /resellers/{resellerId}/users/{userId}/assign-enterprises',
    'get /resellers/{resellerId}/users/{userId}/enterprises',
    'post /enterprises/{enterpriseId}/users',
    'get /enterprises/{enterpriseId}/users',
    'post /enterprises/{enterpriseId}/users/{userId}/assign-departments',
    'delete /enterprises/{enterpriseId}/users/{userId}/assign-departments',
    'get /enterprises/{enterpriseId}/users/{userId}/departments',
  ]

  const BILLING_SWAGGER_OPERATIONS_ORDER = [
    'get /bills',
    'get /bills:csv',
    'get /bills/{billId}',
    'get /bills/{billId}:csv',
    'get /bills/{billId}/line-items',
    'get /bills/{billId}/line-items:csv',
    'post /billing:generate',
    'post /bills/{billId}:publish',
    'post /bills/{billId}:adjust',
    'get /adjustment-notes',
    'post /adjustment-notes/{noteId}:approve',
    'post /bills/{billId}:mark-paid',
    'post /bills/{billId}:write-off',
    'post /bills/{billId}:void',
    'get /enterprises/{enterpriseId}/overdue-summary',
  ]

  const SIMS_SWAGGER_OPERATIONS_ORDER = [
    'post /sims/import-jobs',
    'get /sims',
    'get /sims:csv',
    'get /enterprises/{enterpriseId}/sims',
    'get /enterprises/{enterpriseId}/sims:csv',
    'post /sims:assign-inventory-to-enterprise',
    'post /sims:assign-to-department',
    'get /sims/{iccid}',
    'patch /sims/{iccid}',
    'post /sims:batch-status-change',
    'get /sims/{iccid}/subscriptions',
    'get /sims/{iccid}/usage',
    'get /sims/{iccid}/usage:csv',
    'get /sims/{iccid}/quota-balance',
    'post /sims:batch-deactivate',
  ]

  const ALERTS_SWAGGER_OPERATIONS_ORDER = [
    'get /alerts',
    'get /alerts:csv',
    'get /alerts/{alertId}',
    'post /alerts/{alertId}:acknowledge',
    'get /alerts/summary',
    'get /alerts/trends',
  ]

  const ALERT_CONFIGURATIONS_SWAGGER_OPERATIONS_ORDER = [
    'get /alert-types',
    'patch /alert-types/{alertType}',
    'get /alert-config-profiles',
    'post /alert-config-profiles',
    'get /alert-config-profiles/effective',
    'get /alert-config-profiles/{profileId}',
    'put /alert-config-profiles/{profileId}',
  ]

  const REPORTS_SWAGGER_OPERATIONS_ORDER = [
    'get /reports/sim-summary',
    'get /reports/usage-trend',
    'get /reports/top-sims',
    'get /reports/anomaly-sims',
    'get /reports/deactivation-reasons',
  ]

  const PUBLIC_INFOS_SWAGGER_OPERATIONS_ORDER = [
    'get /public-infos',
    'post /admin/public-infos',
    'patch /admin/public-infos/{publicInfoId}',
    'delete /admin/public-infos/{publicInfoId}',
  ]

  const SUPPLIERS_SWAGGER_OPERATIONS_ORDER = [
    'post /operators',
    'get /operators',
    'get /operators/{operatorId}',
    'patch /operators/{operatorId}',
    'post /suppliers',
    'get /suppliers',
    'get /suppliers/{supplierId}',
    'patch /suppliers/{supplierId}',
    'post /suppliers/{supplierId}:change-status',
    'post /suppliers/{supplierId}/operators',
    'post /resellers/{resellerId}/suppliers',
    'delete /resellers/{resellerId}/suppliers/{supplierId}',
  ]

  const ADMIN_SWAGGER_OPERATIONS_ORDER = [
    'post /admin/api-clients',
    'post /admin/api-clients/{clientId}/deactivate',
    'post /admin/api-clients/{clientId}/rotate',
    'get /admin/api-clients',
    'get /admin/api-clients:csv',
    'get /admin/audits',
    'get /admin/audits:csv',
    'get /admin/events',
    'get /admin/events:csv',
    'get /admin/jobs',
    'get /admin/jobs:csv',
    'post /admin/jobs:test-ready-expiry-run',
    'post /admin/sims/{iccid}:backdate-test-start',
    'get /admin/wx/sims/{iccid}/status',
    'post /admin/jobs:wx-sync-daily-usage',
    'post /admin/jobs:wx-sync-sim-info-batch',
  ]

  function serveDocs(req: FastifyRequest, res: FastifyReply) {
    const baseUrl = buildBaseUrl(req)
    const openapiUrl = `${baseUrl}/v1/openapi.yaml`
    const integrationOrderJson = JSON.stringify(INTEGRATION_SWAGGER_OPERATIONS_ORDER)
    const carrierServicesOrderJson = JSON.stringify(CARRIER_SERVICES_SWAGGER_OPERATIONS_ORDER)
    const commercialTermsOrderJson = JSON.stringify(COMMERCIAL_TERMS_SWAGGER_OPERATIONS_ORDER)
    const controlPoliciesOrderJson = JSON.stringify(CONTROL_POLICIES_SWAGGER_OPERATIONS_ORDER)
    const networkProfilesOrderJson = JSON.stringify(NETWORK_PROFILES_SWAGGER_OPERATIONS_ORDER)
    const coveredNetworkProfilesOrderJson = JSON.stringify(COVERED_NETWORK_PROFILES_SWAGGER_OPERATIONS_ORDER)
    const pricePlansOrderJson = JSON.stringify(PRICE_PLANS_SWAGGER_OPERATIONS_ORDER)
    const packagesOrderJson = JSON.stringify(PACKAGES_SWAGGER_OPERATIONS_ORDER)
    const enterprisesOrderJson = JSON.stringify(ENTERPRISES_SWAGGER_OPERATIONS_ORDER)
    const usersOrderJson = JSON.stringify(USERS_SWAGGER_OPERATIONS_ORDER)
    const billingOrderJson = JSON.stringify(BILLING_SWAGGER_OPERATIONS_ORDER)
    const simsOrderJson = JSON.stringify(SIMS_SWAGGER_OPERATIONS_ORDER)
    const alertsOrderJson = JSON.stringify(ALERTS_SWAGGER_OPERATIONS_ORDER)
    const alertConfigurationsOrderJson = JSON.stringify(ALERT_CONFIGURATIONS_SWAGGER_OPERATIONS_ORDER)
    const reportsOrderJson = JSON.stringify(REPORTS_SWAGGER_OPERATIONS_ORDER)
    const publicInfosOrderJson = JSON.stringify(PUBLIC_INFOS_SWAGGER_OPERATIONS_ORDER)
    const adminOrderJson = JSON.stringify(ADMIN_SWAGGER_OPERATIONS_ORDER)
    const webhooksOrderJson = JSON.stringify(OUTBOUND_WEBHOOKS_SWAGGER_OPERATIONS_ORDER)
    const inboundWebhooksOrderJson = JSON.stringify(INBOUND_WEBHOOKS_SWAGGER_OPERATIONS_ORDER)
    const eventsSwaggerLinkageScript = buildEventsSwaggerLinkageScript()
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API Docs</title>
    <link rel="stylesheet" href="${baseUrl}/v1/docs/assets/swagger-ui.css" />
    <style>
      body { margin: 0; }
      /* Level-1 business groups in Swagger UI (native UI has only tag + operation). */
      .cmp-tag-group {
        margin: 12px 0 18px;
        border: 1px solid #d0d7de;
        border-radius: 8px;
        background: #f6f8fa;
        overflow: hidden;
      }
      .cmp-tag-group > summary {
        list-style: none;
        cursor: pointer;
        padding: 12px 16px;
        font-size: 16px;
        font-weight: 700;
        color: #1f2328;
        background: #eef2f6;
        border-bottom: 1px solid #d0d7de;
        user-select: none;
      }
      .cmp-tag-group > summary::-webkit-details-marker { display: none; }
      .cmp-tag-group > summary::before {
        content: '▸';
        display: inline-block;
        margin-right: 8px;
        transition: transform 0.12s ease;
      }
      .cmp-tag-group[open] > summary::before { transform: rotate(90deg); }
      .cmp-tag-group-body {
        padding: 4px 8px 10px;
        background: #fff;
      }
      .cmp-tag-group-body .opblock-tag-section { margin: 0; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${baseUrl}/v1/docs/assets/swagger-ui-bundle.js"></script>
    <script>${eventsSwaggerLinkageScript}</script>
    <script>
      ;(function initSwaggerUiSafely() {
        try {
          if (typeof SwaggerUIBundle === 'function') {
            var integrationOpsOrder = ${integrationOrderJson}
            var networkProfilesOpsOrder = ${networkProfilesOrderJson}
            var coveredNetworkProfilesOpsOrder = ${coveredNetworkProfilesOrderJson}
            var carrierServicesOpsOrder = ${carrierServicesOrderJson}
            var commercialTermsOpsOrder = ${commercialTermsOrderJson}
            var controlPoliciesOpsOrder = ${controlPoliciesOrderJson}
            var pricePlansOpsOrder = ${pricePlansOrderJson}
            var packagesOpsOrder = ${packagesOrderJson}
            var enterprisesOpsOrder = ${enterprisesOrderJson}
            var usersOpsOrder = ${usersOrderJson}
            var billingOpsOrder = ${billingOrderJson}
            var simsOpsOrder = ${simsOrderJson}
            var alertsOpsOrder = ${alertsOrderJson}
            var alertConfigurationsOpsOrder = ${alertConfigurationsOrderJson}
            var reportsOpsOrder = ${reportsOrderJson}
            var publicInfosOpsOrder = ${publicInfosOrderJson}
            var adminOpsOrder = ${adminOrderJson}
            var webhooksOpsOrder = ${webhooksOrderJson}
            var inboundWebhooksOpsOrder = ${inboundWebhooksOrderJson}
            var swaggerTagOrder = [
              'Authentication', 'Suppliers', 'Resellers', 'Enterprises', 'Departments', 'Users',
              'Integration', 'Outbound Webhooks', 'Inbound Webhooks',
              'NetworkProfiles', 'CarrierService', 'CommercialTerms', 'ControlPolicy',
              'CoveredNetworkProfiles', 'PricePlans', 'Packages', 'Rating Fallback Packages',
              'SIMs', 'Subscriptions', 'Billing',
              'Jobs', 'Diagnostics', 'Events', 'Alerts', 'Alert Configurations',
              'Reports', 'Reconciliation', 'AuditLogs',
              'Admin',
              'PublicInfos'
            ]
            var swaggerTagGroups = [
              { name: 'Business Entity Management', tags: ['Authentication', 'Suppliers', 'Resellers', 'Enterprises', 'Departments', 'Users'] },
              { name: 'Integration Management', tags: ['Integration', 'Outbound Webhooks', 'Inbound Webhooks'] },
              { name: 'Package Management', tags: ['NetworkProfiles', 'CarrierService', 'CommercialTerms', 'ControlPolicy', 'CoveredNetworkProfiles', 'PricePlans', 'Packages', 'Rating Fallback Packages'] },
              { name: 'SIM, Subscription and Billing', tags: ['SIMs', 'Subscriptions', 'Billing'] },
              { name: 'Operation Management', tags: ['Jobs', 'Diagnostics', 'Events', 'Alerts', 'Alert Configurations', 'Reports', 'Reconciliation', 'AuditLogs'] },
              { name: 'Admin', tags: ['Admin'] },
              { name: 'PublicInfos', tags: ['PublicInfos'] }
            ]
            function swaggerOpKey(op) {
              var method = (op.get ? op.get('method') : op.method) || ''
              var path = (op.get ? op.get('path') : op.path) || ''
              return String(method).toLowerCase() + ' ' + path
            }
            function swaggerOpSortOrder(op) {
              var operation = op.get ? op.get('operation') : null
              if (operation && operation.get) {
                var x = operation.get('x-sort-order')
                if (x != null && x !== '') return Number(x)
              }
              var key = swaggerOpKey(op)
              var wi = webhooksOpsOrder.indexOf(key)
              if (wi !== -1) return wi
              var iwi = inboundWebhooksOpsOrder.indexOf(key)
              if (iwi !== -1) return iwi
              var ii = integrationOpsOrder.indexOf(key)
              if (ii !== -1) return ii
              var ni = networkProfilesOpsOrder.indexOf(key)
              if (ni !== -1) return ni
              var cni = coveredNetworkProfilesOpsOrder.indexOf(key)
              if (cni !== -1) return cni
              var ci = carrierServicesOpsOrder.indexOf(key)
              if (ci !== -1) return ci
              var cti = commercialTermsOpsOrder.indexOf(key)
              if (cti !== -1) return cti
              var cpi = controlPoliciesOpsOrder.indexOf(key)
              if (cpi !== -1) return cpi
              var pi = pricePlansOpsOrder.indexOf(key)
              if (pi !== -1) return pi
              var pkgi = packagesOpsOrder.indexOf(key)
              if (pkgi !== -1) return pkgi
              var ei = enterprisesOpsOrder.indexOf(key)
              if (ei !== -1) return ei
              var ui = usersOpsOrder.indexOf(key)
              if (ui !== -1) return ui
              var bi = billingOpsOrder.indexOf(key)
              if (bi !== -1) return bi
              var si = simsOpsOrder.indexOf(key)
              if (si !== -1) return si
              var ai = alertsOpsOrder.indexOf(key)
              if (ai !== -1) return ai
              var aci = alertConfigurationsOpsOrder.indexOf(key)
              if (aci !== -1) return aci
              var ri = reportsOpsOrder.indexOf(key)
              if (ri !== -1) return ri
              var pii = publicInfosOpsOrder.indexOf(key)
              if (pii !== -1) return pii
              var adi = adminOpsOrder.indexOf(key)
              return adi === -1 ? null : adi
            }
            function applySwaggerTagGroups() {
              if (document.querySelector('.cmp-tag-group')) return
              var sections = Array.prototype.slice.call(document.querySelectorAll('.swagger-ui .opblock-tag-section'))
              if (!sections.length) return
              var parent = sections[0].parentElement
              if (!parent) return
              var byTag = {}
              sections.forEach(function(sec) {
                var el = sec.querySelector('[data-tag]') || sec.querySelector('.opblock-tag')
                var name = el && el.getAttribute('data-tag')
                if (!name && el) {
                  var clone = el.cloneNode(true)
                  var small = clone.querySelector && clone.querySelector('small')
                  if (small) small.remove()
                  name = String(clone.textContent || '').trim()
                }
                if (name) byTag[name] = sec
              })
              var root = document.createElement('div')
              root.id = 'cmp-tag-groups-root'
              parent.insertBefore(root, sections[0])
              swaggerTagGroups.forEach(function(group) {
                var details = document.createElement('details')
                details.className = 'cmp-tag-group'
                details.open = false
                var summary = document.createElement('summary')
                summary.textContent = group.name
                details.appendChild(summary)
                var body = document.createElement('div')
                body.className = 'cmp-tag-group-body'
                details.appendChild(body)
                var moved = 0
                group.tags.forEach(function(tagName) {
                  var sec = byTag[tagName]
                  if (!sec) return
                  body.appendChild(sec)
                  moved += 1
                })
                if (moved > 0) root.appendChild(details)
              })
            }
            window.ui = SwaggerUIBundle({
              url: ${JSON.stringify(openapiUrl)},
              dom_id: '#swagger-ui',
              deepLinking: true,
              docExpansion: 'none',
              tagsSorter: function(a, b) {
                var ia = swaggerTagOrder.indexOf(a)
                var ib = swaggerTagOrder.indexOf(b)
                if (ia === -1 && ib === -1) return a < b ? -1 : a > b ? 1 : 0
                if (ia === -1) return 1
                if (ib === -1) return -1
                return ia - ib
              },
              operationsSorter: function(a, b) {
                var oa = swaggerOpSortOrder(a)
                var ob = swaggerOpSortOrder(b)
                if (oa != null && ob != null) return oa - ob
                if (oa != null) return -1
                if (ob != null) return 1
                var pa = swaggerOpKey(a)
                var pb = swaggerOpKey(b)
                return pa < pb ? -1 : pa > pb ? 1 : 0
              },
              presets: [SwaggerUIBundle.presets.apis],
              layout: 'BaseLayout',
              onComplete: function() {
                if (typeof window.__cmpRefreshEventsSwaggerParams === 'function') {
                  window.__cmpRefreshEventsSwaggerParams()
                }
                setTimeout(applySwaggerTagGroups, 0)
                setTimeout(applySwaggerTagGroups, 250)
              },
            })
          }
        } catch (e) {}
      })()
    </script>
  </body>
</html>`
    res
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(html)
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

