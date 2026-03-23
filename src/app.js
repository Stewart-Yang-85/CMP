import express from 'express'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'
import { createSupabaseRestClient } from './supabaseRest.js'
import { signJwtHs256, verifyJwtHs256 } from './jwt.js'
import { verifySecretScrypt } from './password.js'
import { hashSecretScrypt } from './password.js'
import { createWxzhonggengClient } from './vendors/wxzhonggeng.js'
import { createSupplierAdapter, negotiateChangePlanStrategy } from './vendors/registry.js'
import { parsePagination } from './utils/pagination.js'
import { registerSimPhase4Routes } from './routes/simPhase4.js'
import { registerPricePlanRoutes } from './routes/pricePlans.js'
import { registerPackageRoutes } from './routes/packages.js'
import { registerPackageModuleRoutes } from './routes/packageModules.js'
import { registerNetworkProfileRoutes } from './routes/networkProfiles.js'
import { registerReconciliationRoutes } from './routes/reconciliation.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { registerEventRoutes } from './routes/events.js'
import { registerVendorMappingRoutes } from './routes/vendorMappings.js'
import { createSubscription, switchSubscription, cancelSubscription, listSimSubscriptions, listSubscriptions, getSubscription } from './services/subscription.js'
import { parseSimIdentifier } from './services/simLifecycle.js'
import { runBillingGenerate } from './services/billingGenerate.js'
import { createAdjustmentNote, approveAdjustmentNote, listAdjustmentNotes } from './services/adjustmentNote.js'
import { transitionBillStatus } from './services/billStatusMachine.js'
import { getEnterpriseDunningSummary, resolveDunningForEnterprise } from './services/dunning.js'
import { getConnectivityStatus, getLocation, getLocationHistory, requestResetConnection } from './services/connectivity.js'
import { listAlerts, acknowledgeAlert } from './services/alerting.js'
import { emitEvent } from './services/eventEmitter.js'

function getBearerToken(req) {
  const value = req.headers.authorization
  if (!value) return null
  const parts = value.split(' ')
  if (parts.length !== 2) return null
  if (parts[0].toLowerCase() !== 'bearer') return null
  return parts[1]
}

function base64UrlDecodeToString(input) {
  const s = String(input).replaceAll('-', '+').replaceAll('_', '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(`${s}${pad}`, 'base64').toString('utf8')
}

function base64UrlDecodeToBuffer(input) {
  const s = String(input).replaceAll('-', '+').replaceAll('_', '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(`${s}${pad}`, 'base64')
}

function decodeJwtPart(part) {
  return JSON.parse(base64UrlDecodeToString(part))
}

function getTraceId(res) {
  return res?.locals?.traceId ?? null
}

function sendError(res, status, code, message) {
  res.status(status).json({
    code,
    message,
    traceId: getTraceId(res),
  })
}

function safeHeaderValue(value) {
  return encodeURIComponent(String(value ?? '')).replace(/%0D|%0A|%00/gi, '')
}

function setXFilters(res, value) {
  res.setHeader('X-Filters', safeHeaderValue(value))
}

function getEnvTrim(name) {
  const v = process.env[name]
  if (!v) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function parseCsvEnv(name) {
  const v = getEnvTrim(name)
  if (!v) return []
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function getEnvNumber(name, defaultValue) {
  const v = getEnvTrim(name)
  if (!v) return defaultValue
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : defaultValue
}

const jwksCache = { expiresAt: 0, keys: new Map() }

async function loadJwks(jwksUrl, cacheTtlMs) {
  const now = Date.now()
  if (jwksCache.expiresAt > now && jwksCache.keys.size > 0) {
    return jwksCache
  }
  const res = await fetch(jwksUrl)
  if (!res.ok) {
    throw new Error('jwks_fetch_failed')
  }
  const json = await res.json()
  const keys = new Map()
  for (const key of json.keys ?? []) {
    if (key.kid) keys.set(String(key.kid), key)
  }
  jwksCache.keys = keys
  jwksCache.expiresAt = now + cacheTtlMs
  return jwksCache
}

function verifyRs256(token, jwk) {
  const [headerPart, payloadPart, sigPart] = token.split('.')
  if (!headerPart || !payloadPart || !sigPart) return false
  if (!jwk?.n || !jwk?.e) return false
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const data = Buffer.from(`${headerPart}.${payloadPart}`)
  const signature = base64UrlDecodeToBuffer(sigPart)
  return crypto.verify('RSA-SHA256', data, key, signature)
}

function normalizePermissions(payload) {
  if (Array.isArray(payload?.permissions)) {
    return payload.permissions.map((p) => String(p))
  }
  if (typeof payload?.scope === 'string') {
    return payload.scope.split(' ').map((p) => p.trim()).filter((p) => p.length > 0)
  }
  return []
}

async function verifyOidcAccessToken(token) {
  const issuer = getEnvTrim('OIDC_ISSUER')
  const audience = getEnvTrim('OIDC_AUDIENCE')
  const jwksUrl = getEnvTrim('OIDC_JWKS_URL')
  if (!issuer || !audience || !jwksUrl) {
    return { ok: false, error: 'oidc_not_configured' }
  }
  const parts = String(token).split('.')
  if (parts.length !== 3) return { ok: false, error: 'invalid_format' }
  let headerJson
  let payloadJson
  try {
    headerJson = decodeJwtPart(parts[0])
    payloadJson = decodeJwtPart(parts[1])
  } catch {
    return { ok: false, error: 'invalid_json' }
  }
  if (String(payloadJson.iss || '') !== issuer) return { ok: false, error: 'invalid_issuer' }
  const aud = payloadJson.aud
  const audOk = Array.isArray(aud) ? aud.map((a) => String(a)).includes(audience) : String(aud || '') === audience
  if (!audOk) return { ok: false, error: 'invalid_audience' }
  const now = Math.floor(Date.now() / 1000)
  const skew = getEnvNumber('OIDC_CLOCK_SKEW_SECONDS', 60)
  const exp = typeof payloadJson.exp === 'number' ? payloadJson.exp : null
  if (exp !== null && now - skew >= exp) return { ok: false, error: 'expired' }
  const nbf = typeof payloadJson.nbf === 'number' ? payloadJson.nbf : null
  if (nbf !== null && now + skew < nbf) return { ok: false, error: 'not_active' }
  const kid = String(headerJson.kid || '')
  const cacheTtlMs = getEnvNumber('OIDC_JWKS_CACHE_TTL_MS', 10 * 60 * 1000)
  const cache = await loadJwks(jwksUrl, cacheTtlMs)
  const jwk = cache.keys.get(kid)
  if (!jwk || !verifyRs256(token, jwk)) {
    jwksCache.expiresAt = 0
    return { ok: false, error: 'invalid_signature' }
  }
  return { ok: true, payload: payloadJson }
}

function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function isMissingTableError(err, tableName) {
  const code = String(err?.code ?? err?.body?.code ?? '')
  const message = String(err?.body?.message ?? err?.message ?? err?.body ?? '')
  const marker = `public.${tableName}`
  return (code === 'PGRST205' || message.includes('Could not find the table')) && message.includes(marker)
}

function normalizeIccid(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isValidIccid(value) {
  const s = normalizeIccid(value)
  return /^\d{18,20}$/.test(s)
}

function requireIccid(res, value, label = 'iccid') {
  const iccid = normalizeIccid(value)
  if (!iccid || !isValidIccid(iccid)) {
    sendError(res, 400, 'BAD_REQUEST', `${label} is required and must be 18-20 digits.`)
    return null
  }
  return iccid
}

function requireIccidList(res, value, label = 'iccids') {
  const list = Array.isArray(value) ? value.map((v) => normalizeIccid(v)).filter((v) => v.length > 0) : []
  if (!list.length || list.some((v) => !isValidIccid(v))) {
    sendError(res, 400, 'BAD_REQUEST', `${label} is required and must be 18-20 digit strings.`)
    return null
  }
  return list
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function parseMultipartFormData(buffer, boundary) {
  const text = buffer.toString('utf8')
  const boundaryText = `--${boundary}`
  const parts = text.split(boundaryText)
  const fields = {}
  const files = {}
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

function createRateLimiter({ windowMs, max, keyResolver }) {
  const store = new Map()
  return function (req, res, next) {
    if (req.method === 'OPTIONS') return next()
    const key = keyResolver(req) ?? 'global'
    const now = Date.now()
    const info = store.get(key)
    if (!info || now >= info.resetAt) {
      const resetAt = now + windowMs
      store.set(key, { count: 1, resetAt })
      res.setHeader('X-RateLimit-Limit', String(max))
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - 1)))
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)))
      return next()
    }
    if (info.count >= max) {
      const retryAfter = Math.max(0, Math.ceil((info.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      res.setHeader('X-RateLimit-Limit', String(max))
      res.setHeader('X-RateLimit-Remaining', '0')
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(info.resetAt / 1000)))
      return sendError(res, 429, 'TOO_MANY_REQUESTS', 'Rate limit exceeded.')
    }
    info.count += 1
    res.setHeader('X-RateLimit-Limit', String(max))
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - info.count)))
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(info.resetAt / 1000)))
    return next()
  }
}

function isOriginAllowed(origin, allowOrigins) {
  if (!origin) return false
  if (allowOrigins.includes('*')) return true
  return allowOrigins.includes(origin)
}

function isAuthConfigured() {
  return Boolean(getEnvTrim('AUTH_TOKEN_SECRET') && getEnvTrim('AUTH_CLIENT_ID') && getEnvTrim('AUTH_CLIENT_SECRET'))
}

function isDbAuthConfigured() {
  return Boolean(getEnvTrim('AUTH_TOKEN_SECRET') && process.env.SUPABASE_SERVICE_ROLE_KEY && getEnvTrim('AUTH_USE_DB_CLIENTS') === '1')
}

function verifyAccessToken(token) {
  const secret = getEnvTrim('AUTH_TOKEN_SECRET')
  if (!secret) return { ok: false, error: 'missing_secret' }
  return verifyJwtHs256(token, secret)
}

function getRoleScope(req) {
  const v = req?.cmpAuth?.roleScope
  return v ? String(v) : null
}

function isBillCsvDownloadWithToken(req) {
  const path = String(req.originalUrl || req.url || req.path || '').split('?')[0]
  return /\/bills\/[^/]+\/files\/csv$/.test(path) && req.query?.downloadToken
}

function requireRoleScopes(scopes) {
  return function (req, res, next) {
    if (isBillCsvDownloadWithToken(req)) return next()
    const roleScope = getRoleScope(req)
    if (!roleScope) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (roleScope === 'platform') return next()
    if (!scopes.includes(roleScope)) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    return next()
  }
}

function getEnterpriseIdFromRequest(req) {
  if (req?.params?.enterpriseId) return String(req.params.enterpriseId)
  if (req?.query?.enterpriseId) return String(req.query.enterpriseId)
  if (req?.body?.enterpriseId) return String(req.body.enterpriseId)
  return null
}

function requireEnterpriseScope() {
  return async function (req, res, next) {
    if (isBillCsvDownloadWithToken(req)) return next()
    const roleScope = getRoleScope(req)
    if (!roleScope) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    if (roleScope === 'platform') return next()
    if (roleScope === 'customer') {
      const customerId = req?.tenantScope?.customerId ?? req?.cmpAuth?.customerId ?? req?.cmpAuth?.enterpriseId
      if (!customerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Customer scope required.')
      }
      req.tenantScope = { ...(req.tenantScope ?? {}), customerId: String(customerId) }
      return next()
    }
    if (roleScope === 'department') {
      const customerId = req?.tenantScope?.customerId ?? req?.cmpAuth?.customerId ?? req?.cmpAuth?.enterpriseId
      const departmentId = req?.tenantScope?.departmentId ?? req?.cmpAuth?.departmentId
      if (!customerId || !departmentId) {
        return sendError(res, 403, 'FORBIDDEN', 'Department scope required.')
      }
      req.tenantScope = { ...(req.tenantScope ?? {}), customerId: String(customerId), departmentId: String(departmentId) }
      return next()
    }
    if (roleScope === 'reseller') {
      const resellerId = req?.cmpAuth?.resellerId
      if (!resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      const enterpriseId = getEnterpriseIdFromRequest(req)
      if (!enterpriseId) {
        req.tenantScope = { ...(req.tenantScope ?? {}), resellerId: String(resellerId) }
        return next()
      }
      try {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const rows = await supabase.select(
          'tenants',
          `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
        )
        const row = Array.isArray(rows) ? rows[0] : null
        if (!row || String(row.parent_id || '') !== String(resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
        }
        req.tenantScope = { ...(req.tenantScope ?? {}), resellerId: String(resellerId), customerId: String(enterpriseId) }
        return next()
      } catch {
        return sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
      }
    }
    return sendError(res, 403, 'FORBIDDEN', 'Unsupported role scope.')
  }
}

const basePermissions = [
  'bills.list',
  'bills.read',
  'bills.export',
  'bills.mark_paid',
  'bills.adjust',
  'sims.list',
  'sims.read',
  'sims.export',
  'sims.reset_connection',
  'sims.connectivity.read',
  'sims.location.read',
  'sims.location.history',
  'subscriptions.list',
  'subscriptions.read',
  'subscriptions.create',
  'subscriptions.switch',
  'subscriptions.cancel',
  'jobs.read',
  'catalog.packages.list',
  'catalog.packages.export',
  'catalog.package_versions.list',
  'price_plans.read',
  'share.read',
  'share.create',
  'alerts.read',
  'alerts.acknowledge',
  'reports.read',
]

const defaultPermissionsByRoleScope = {
  customer: basePermissions.slice(),
  department: [
    'bills.list',
    'bills.read',
    'bills.export',
    'sims.list',
    'sims.read',
    'sims.export',
    'sims.connectivity.read',
    'sims.location.read',
    'sims.location.history',
    'subscriptions.list',
    'subscriptions.read',
    'jobs.read',
    'catalog.packages.list',
    'catalog.packages.export',
    'catalog.package_versions.list',
    'price_plans.read',
    'share.read',
    'alerts.read',
    'alerts.acknowledge',
    'reports.read',
  ],
  reseller: [
    'bills.list',
    'bills.read',
    'bills.export',
    'bills.mark_paid',
    'bills.adjust',
    'sims.list',
    'sims.read',
    'sims.export',
    'sims.connectivity.read',
    'sims.location.read',
    'sims.location.history',
    'sims.import',
    'sims.create',
    'sims.activate',
    'sims.deactivate',
    'sims.reactivate',
    'sims.retire',
    'sims.batch_deactivate',
    'subscriptions.list',
    'subscriptions.read',
    'subscriptions.create',
    'subscriptions.switch',
    'subscriptions.cancel',
    'jobs.read',
    'catalog.packages.list',
    'catalog.packages.export',
    'catalog.package_versions.list',
    'price_plans.read',
    'share.read',
    'share.create',
    'alerts.read',
    'alerts.acknowledge',
    'reports.read',
  ],
}

const rolePermissionCache = new Map()
const rolePermissionCacheTtlMs = Number(process.env.RBAC_ROLE_CACHE_TTL_MS || '300000')

function normalizeRoleScopeForDb(roleScope) {
  if (!roleScope) return null
  if (roleScope === 'department') return 'customer'
  return roleScope
}

function getRoleCacheKey(role, roleScope) {
  return `${roleScope ?? 'any'}:${role}`
}

function normalizeHeaderFlag(value) {
  if (!value) return false
  const v = String(value).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function shouldBypassRbacCache(req) {
  const h = req?.headers ?? {}
  return normalizeHeaderFlag(h['x-rbac-refresh']) || normalizeHeaderFlag(h['x-rbac-cache-bypass'])
}

function getTenantCacheKey(auth) {
  const roleScope = auth?.roleScope ? String(auth.roleScope) : null
  if (roleScope === 'platform') return 'platform'
  if (roleScope === 'reseller') return auth?.resellerId ? `reseller:${String(auth.resellerId)}` : 'reseller'
  if (roleScope === 'department') {
    const customerId = auth?.customerId ? String(auth.customerId) : ''
    const departmentId = auth?.departmentId ? String(auth.departmentId) : ''
    return `department:${customerId}:${departmentId}`
  }
  if (roleScope === 'customer') return auth?.customerId ? `customer:${String(auth.customerId)}` : 'customer'
  return 'unknown'
}

async function resolveRolePermissions(role, roleScope, tenantKey, bypassCache) {
  const scope = normalizeRoleScopeForDb(roleScope)
  const cacheKey = `${tenantKey}:${getRoleCacheKey(role, scope)}`
  if (!bypassCache) {
    const cached = rolePermissionCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.permissions.slice()
    }
  }
  try {
    const supabase = createSupabaseRestClient({ useServiceRole: true })
    const roleQuery = [
      'select=id,code,scope',
      `code=eq.${encodeURIComponent(role)}`,
      scope ? `scope=eq.${encodeURIComponent(scope)}` : null,
      'limit=1',
    ].filter(Boolean).join('&')
    const roles = await supabase.select('roles', roleQuery, { suppressMissingColumns: true })
    const roleRow = Array.isArray(roles) && roles.length > 0 ? roles[0] : null
    const roleId = roleRow ? String(roleRow.id ?? roleRow.role_id ?? '') : ''
    if (!roleId) return null
    const rolePermissions = await supabase.select(
      'role_permissions',
      `select=permission_id&role_id=eq.${encodeURIComponent(roleId)}`,
      { suppressMissingColumns: true }
    )
    const permissionIds = Array.isArray(rolePermissions)
      ? rolePermissions.map((r) => r.permission_id).filter(Boolean).map((id) => String(id))
      : []
    if (!permissionIds.length) {
      rolePermissionCache.set(cacheKey, { expiresAt: Date.now() + rolePermissionCacheTtlMs, permissions: [] })
      return []
    }
    const idFilter = permissionIds.map((id) => encodeURIComponent(id)).join(',')
    const permissionRows = await supabase.select('permissions', `select=code&id=in.(${idFilter})`, { suppressMissingColumns: true })
    let codes = Array.isArray(permissionRows)
      ? permissionRows.map((p) => p.code).filter(Boolean).map((code) => String(code))
      : []
    if (!codes.length) {
      const fallbackRows = await supabase.select('permissions', `select=code&permission_id=in.(${idFilter})`, { suppressMissingColumns: true })
      codes = Array.isArray(fallbackRows)
        ? fallbackRows.map((p) => p.code).filter(Boolean).map((code) => String(code))
        : []
    }
    rolePermissionCache.set(cacheKey, { expiresAt: Date.now() + rolePermissionCacheTtlMs, permissions: codes })
    return codes
  } catch {
    return null
  }
}

async function getEffectivePermissions(req) {
  const auth = req?.cmpAuth ?? {}
  const current = Array.isArray(auth.permissions) ? auth.permissions.map((p) => String(p)) : []
  if (current.length) return current
  const roleScope = getRoleScope(req)
  const role = auth.role ? String(auth.role) : null
  if (role) {
    const tenantKey = getTenantCacheKey(auth)
    const bypassCache = shouldBypassRbacCache(req)
    const rolePermissions = await resolveRolePermissions(role, roleScope, tenantKey, bypassCache)
    if (rolePermissions !== null && rolePermissions.length > 0) return rolePermissions
  }
  const defaults = roleScope && defaultPermissionsByRoleScope[roleScope] ? defaultPermissionsByRoleScope[roleScope] : []
  return defaults.slice()
}

async function hasPermission(req, permission) {
  const roleScope = getRoleScope(req)
  const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
  if (roleScope === 'platform' || role === 'platform_admin') return true
  // Reseller 出账：当前仅 reseller_admin；后续可改为 DB RBAC 的 billing.generate 权限集
  if (permission === 'billing.generate' && roleScope === 'reseller' && role === 'reseller_admin') return true
  const perms = await getEffectivePermissions(req)
  return perms.includes(permission)
}

function resolvePermissionForRequest(req) {
  const method = String(req.method || 'GET').toUpperCase()
  const rawPath = String(req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`)
  const path = rawPath.split('?')[0]
  if (path.startsWith('/v1/admin') || path.startsWith('/admin')) return null
  if (path.startsWith('/v1/s/')) return 'share.read'
  if (path.startsWith('/v1/share-links')) {
    if (method === 'POST') return 'share.create'
    return 'share.read'
  }
  if (path.endsWith('/sims/import-jobs') || path.endsWith('/v1/sims/import-jobs')) return 'sims.import'
  if (path.includes('/sims:batch-deactivate')) return 'sims.batch_deactivate'
  if (/\/sims\/[^/]+:activate$/.test(path)) return 'sims.activate'
  if (/\/sims\/[^/]+:deactivate$/.test(path)) return 'sims.deactivate'
  if (/\/sims\/[^/]+:reactivate$/.test(path)) return 'sims.reactivate'
  if (/\/sims\/[^/]+:retire$/.test(path)) return 'sims.retire'
  if (/\/sims\/[^/]+\/state-history$/.test(path)) return 'sims.read'
  if (path.includes('/subscriptions:switch')) return 'subscriptions.switch'
  if (/\/subscriptions\/[^/]+:cancel$/.test(path)) return 'subscriptions.cancel'
  if (/\/sims\/[^/]+\/subscriptions$/.test(path)) return 'subscriptions.list'
  if (path.startsWith('/v1/subscriptions') || path.startsWith('/subscriptions')) {
    if (method === 'POST') return 'subscriptions.create'
    if (method === 'GET') return 'subscriptions.read'
  }
  if (method === 'POST' && (path.endsWith('/billing:generate') || path.endsWith('/v1/billing:generate'))) {
    return 'billing.generate'
  }
  if (/\/bills\/[^/]+:mark-paid$/.test(path)) return 'bills.mark_paid'
  if (/\/bills\/[^/]+:adjust$/.test(path)) return 'bills.adjust'
  if (path.endsWith('/bills:csv') || path.endsWith('/v1/bills:csv')) return 'bills.export'
  if (/\/bills\/[^/]+$/.test(path)) return 'bills.read'
  if (path.endsWith('/bills') || path.endsWith('/v1/bills')) return 'bills.list'
  if (/\/sims\/[^/]+:reset-connection$/.test(path)) return 'sims.reset_connection'
  if (/\/sims\/[^/]+\/connectivity-status$/.test(path)) return 'sims.connectivity.read'
  if (/\/sims\/[^/]+\/location-history$/.test(path)) return 'sims.location.history'
  if (/\/sims\/[^/]+\/location$/.test(path)) return 'sims.location.read'
  if (path.endsWith('/sims:csv') || path.endsWith('/v1/sims:csv')) return 'sims.export'
  if (/\/sims\/[^/]+$/.test(path)) return 'sims.read'
  if (path.endsWith('/sims') || path.endsWith('/v1/sims')) {
    if (method === 'POST') return 'sims.create'
    return 'sims.list'
  }
  if (path.startsWith('/v1/jobs') || path.startsWith('/jobs')) {
    return method === 'GET' ? 'jobs.read' : null
  }
  if (
    path.startsWith('/v1/packages') ||
    path.startsWith('/packages')
  ) {
    return path.endsWith(':csv') ? 'catalog.packages.export' : 'catalog.packages.list'
  }
  if (path.startsWith('/v1/package-versions') || path.startsWith('/package-versions')) {
    return 'catalog.package_versions.list'
  }
  if (path.startsWith('/v1/price-plans') || path.startsWith('/price-plans')) {
    return 'price_plans.read'
  }
  if (path.startsWith('/v1/alerts') || path.startsWith('/alerts')) {
    if (/\/alerts\/[^/]+:acknowledge$/.test(path)) return 'alerts.acknowledge'
    return 'alerts.read'
  }
  if (path.startsWith('/v1/reports') || path.startsWith('/reports')) {
    return 'reports.read'
  }
  return null
}

async function permissionGuard(req, res, next) {
  const permission = resolvePermissionForRequest(req)
  if (!permission) return next()
  if (await hasPermission(req, permission)) return next()
  return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
}

function getEnterpriseIdFromReq(req) {
  const v = req?.tenantScope?.customerId ?? req?.cmpAuth?.enterpriseId ?? req?.cmpAuth?.customerId
  return v ? String(v) : null
}

function getDepartmentIdFromReq(req) {
  const v = req?.tenantScope?.departmentId ?? req?.cmpAuth?.departmentId
  return v ? String(v) : null
}

function buildSimTenantFilter(req, enterpriseId) {
  const parts = []
  if (enterpriseId) parts.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  if (getRoleScope(req) === 'department') {
    const departmentId = getDepartmentIdFromReq(req)
    if (departmentId) parts.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
  }
  return parts.length ? `&${parts.join('&')}` : ''
}

async function ensureDepartmentSimAccess(req, res, supabase, iccid, enterpriseId) {
  if (getRoleScope(req) !== 'department') return true
  const departmentId = getDepartmentIdFromReq(req)
  if (!departmentId) return true
  const filters = [
    `iccid=eq.${encodeURIComponent(iccid)}`,
    `department_id=eq.${encodeURIComponent(departmentId)}`,
  ]
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  const rows = await supabase.select(
    'sims',
    `select=sim_id&${filters.join('&')}&limit=1`
  )
  const sim = Array.isArray(rows) ? rows[0] : null
  if (!sim) {
    sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    return false
  }
  return true
}

async function resolveReportScope(req, res, supabase, enterpriseIdParam) {
  const roleScope = getRoleScope(req)
  const resellerId = req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null
  if (roleScope === 'reseller') {
    if (!resellerId) {
      sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      return null
    }
    if (enterpriseIdParam) {
      if (!isValidUuid(enterpriseIdParam)) {
        sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const enterpriseId = await resolveEnterpriseForResellerScope(req, res, supabase, enterpriseIdParam)
      if (!enterpriseId) return null
      return { enterpriseId, enterpriseIds: null, resellerId }
    }
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
    )
    const enterpriseIds = Array.isArray(rows) ? rows.map((r) => r?.tenant_id).filter(Boolean).map((v) => String(v)) : []
    return { enterpriseId: null, enterpriseIds, resellerId }
  }
  if (roleScope === 'platform') {
    if (enterpriseIdParam) {
      if (!isValidUuid(enterpriseIdParam)) {
        sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      return { enterpriseId: enterpriseIdParam, enterpriseIds: null, resellerId: null }
    }
    return { enterpriseId: null, enterpriseIds: null, resellerId: null }
  }
  const fromReq = getEnterpriseIdFromReq(req)
  const enterpriseId = fromReq ? String(fromReq) : null
  if (!enterpriseId || !isValidUuid(enterpriseId)) {
    sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
    return null
  }
  return { enterpriseId, enterpriseIds: null, resellerId: null }
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

function getTestQuotaMb() {
  const n = getEnvNumber('TEST_QUOTA_KB', 102400)
  return Math.max(0, n)
}

function normalizeCommercialTerms(obj) {
  const t = obj && typeof obj === 'object' ? obj : {}
  const v = (k) => t[k] !== undefined && t[k] !== null ? t[k] : undefined
  const n = (x) => {
    const y = Number(x)
    return Number.isFinite(y) && y >= 0 ? y : undefined
  }
  const up = (s) => (typeof s === 'string' ? s.toUpperCase() : undefined)
  const testPeriodDays =
    n(v('testPeriodDays')) ?? n(v('test_period_days')) ?? n(v('testPeriod')) ?? n(v('test_period'))
  const testQuotaMb =
    n(v('testQuotaMb')) ?? n(v('test_quota_mb')) ?? n(v('testQuota')) ?? n(v('test_quota'))
  const testExpiryConditionRaw =
    up(v('testExpiryCondition')) ?? up(v('test_expiry_condition'))
  const testExpiryCondition =
    (testExpiryConditionRaw === 'PERIOD_ONLY' || testExpiryConditionRaw === 'QUOTA_ONLY' || testExpiryConditionRaw === 'PERIOD_OR_QUOTA')
      ? testExpiryConditionRaw
      : undefined
  const commitmentPeriodMonths =
    n(v('commitmentPeriodMonths')) ?? n(v('commitment_period_months')) ?? n(v('commitmentMonths'))
  const commitmentPeriodDays =
    n(v('commitmentPeriodDays')) ?? n(v('commitment_period_days')) ?? n(v('commitmentDays'))
  const expiryBoundaryRaw =
    up(v('expiryBoundary')) ?? up(v('expiry_boundary'))
  const expiryBoundary =
    (expiryBoundaryRaw === 'CALENDAR_DAY_END' || expiryBoundaryRaw === 'DURATION_EXCLUSIVE_END')
      ? expiryBoundaryRaw
      : undefined
  return {
    testPeriodDays,
    testQuotaMb,
    testExpiryCondition,
    commitmentPeriodMonths,
    commitmentPeriodDays,
    expiryBoundary,
  }
}
function getAdminApiKeyFromReq(req) {
  const v = req.header('x-api-key')
  return v ? String(v) : null
}

function requireAdminApiKey(req, res) {
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

function randomClientSecret() {
  return crypto.randomBytes(24).toString('base64url')
}

function getCmpWebhookKey() {
  const v = getEnvTrim('CMP_WEBHOOK_KEY')
  return v ? v : null
}

function requireCmpWebhookKey(req, res) {
  const expected = getCmpWebhookKey()
  const adminKey = getEnvTrim('ADMIN_API_KEY')
  const actual = req.header('x-api-key')
  if (expected) {
    if (actual && (actual === expected || (adminKey && actual === adminKey))) {
      return true
    }
    sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
    return false
  }
  if (adminKey) {
    if (actual && actual === adminKey) {
      return true
    }
    sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
    return false
  }
  sendError(res, 500, 'INTERNAL_ERROR', 'CMP_WEBHOOK_KEY is not configured.')
  return false
}

function getWxWebhookKey() {
  const v = getEnvTrim('WXZHONGGENG_WEBHOOK_KEY')
  return v ? v : null
}
function requireWxWebhookKey(req, res) {
  const expected = getWxWebhookKey()
  if (!expected) {
    sendError(res, 500, 'INTERNAL_ERROR', 'WXZHONGGENG_WEBHOOK_KEY is not configured.')
    return false
  }
  const actual = req.header('x-api-key')
  if (!actual || actual !== expected) {
    sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
    return false
  }
  return true
}
const WX_WEBHOOK_MAX_AGE_MINUTES = getEnvNumber('WX_WEBHOOK_MAX_AGE_MINUTES', 60)
const WEBHOOK_MAX_FUTURE_SECONDS = getEnvNumber('WEBHOOK_MAX_FUTURE_SECONDS', 300)
function validateWebhookTimestamp(res, occurredAt, maxAgeMinutes) {
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
async function isDuplicateEventByPayloadField({ supabase, eventType, field, value }) {
  if (!supabase || !eventType || !field || !value) return false
  const rows = await supabase.select(
    'events',
    `select=event_id&event_type=eq.${encodeURIComponent(eventType)}&payload->>${field}=eq.${encodeURIComponent(value)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return Boolean(row?.event_id)
}
async function pushSimStatusToUpstream({ iccid, status, traceId, supplierId }) {
  if (supplierId) {
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
  const url = getEnvTrim('CMP_SYNC_URL')
  const key = getEnvTrim('CMP_SYNC_KEY')
  if (!url || !key) return { ok: false }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
      ...(traceId ? { 'X-Request-Id': traceId } : {}),
    },
    body: JSON.stringify({ iccid, status }),
  })
  const ok = res.ok
  return { ok, status: res.status }
}
function getPlanChangeWebhookUrl() {
  const v = getEnvTrim('CMP_PLAN_CHANGE_WEBHOOK_URL')
  return v ? v : null
}
function getPlanChangeWebhookKey() {
  const v = getEnvTrim('CMP_PLAN_CHANGE_WEBHOOK_KEY')
  return v ? v : null
}
async function pushPlanChangeToWebhook({
  iccid,
  simId,
  enterpriseId,
  subscriptionId,
  packageVersionId,
  effectiveAt,
  strategy,
  vendorRequestId,
  traceId,
  jobId,
}) {
  const url = getPlanChangeWebhookUrl()
  const key = getPlanChangeWebhookKey()
  if (!url || !key) return { ok: false, skipped: true }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': key,
        ...(traceId ? { 'X-Request-Id': traceId } : {}),
      },
      body: JSON.stringify({
        iccid,
        simId,
        enterpriseId,
        subscriptionId,
        packageVersionId,
        effectiveAt,
        strategy,
        vendorRequestId,
        jobId,
      }),
    })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false }
  }
}
function authGuard(req, res, next) {
  if (req.path === '/health') return next()
  if (req.path === '/ready') return next()
  if (req.path === '/metrics') return next()
  if (req.path === '/v1/auth/token') return next()
  if (req.path === '/auth/token') return next()
  if (req.path === '/v1/auth/login') return next()
  if (req.path === '/auth/login') return next()
  if (req.path === '/v1/auth/refresh') return next()
  if (req.path === '/auth/refresh') return next()
  if (req.path === '/openapi.yaml') return next()
  if (req.path === '/v1/openapi.yaml') return next()
  if (req.path === '/docs') return next()
  if (req.path === '/v1/docs') return next()
  if (req.path === '/docs/assets/swagger-ui-bundle.js') return next()
  if (req.path === '/docs/assets/swagger-ui.css') return next()
  if (req.path === '/v1/docs/assets/swagger-ui-bundle.js') return next()
  if (req.path === '/v1/docs/assets/swagger-ui.css') return next()
  if (req.path === '/favicon.ico') return next()
  if (req.path === '/auth/token') return next()
  if (req.path === '/v1/auth/token') return next()

  if (isBillCsvDownloadWithToken(req)) {
    req.cmpAuth = { roleScope: 'platform', role: 'platform_admin' }
    req.tenantScope = {}
    return next()
  }

  const apiKey = req.header('x-api-key')
  const apiSecret = req.header('x-api-secret')
  const bearer = getBearerToken(req)

  if (!apiKey && !bearer) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Missing Authorization: Bearer <token> or X-API-Key header.')
  }

  if (apiKey && apiSecret) {
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    supabase.select(
      'customers',
      `select=customer_id,id,reseller_id,api_secret_hash,status&api_key=eq.${encodeURIComponent(apiKey)}&limit=1`
    ).then((rows) => {
      const row = Array.isArray(rows) ? rows[0] : null
      if (!row || String(row.status || '').toLowerCase() !== 'active') {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
      }
      if (!verifySecretScrypt(String(apiSecret), String(row.api_secret_hash))) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Secret.')
      }
      const customerId = row.customer_id ?? row.id ?? null
      req.cmpAuth = {
        enterpriseId: customerId ? String(customerId) : null,
        clientId: String(customerId ?? apiKey),
        customerId: customerId ? String(customerId) : null,
        resellerId: row.reseller_id ? String(row.reseller_id) : null,
        roleScope: 'customer',
        role: 'customer_m2m',
        userId: null,
      }
      req.tenantScope = { customerId: customerId ? String(customerId) : null }
      return next()
    }).catch(() => sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.'))
    return
  }

  if (apiKey) {
    const adminKey = getEnvTrim('ADMIN_API_KEY')
    if (adminKey && apiKey === adminKey) {
      req.cmpAuth = {
        enterpriseId: null,
        clientId: String(adminKey),
        customerId: null,
        resellerId: null,
        roleScope: 'platform',
        role: 'platform_admin',
        userId: null,
      }
      req.tenantScope = {}
      return next()
    }
  }

  if (apiKey) {
    const adminKey = getEnvTrim('ADMIN_API_KEY')
    if (adminKey && apiKey === adminKey) {
      req.cmpAuth = { roleScope: 'platform', role: 'platform_admin' }
      return next()
    }
    const expected = getEnvTrim('API_KEY')
    if (expected && apiKey !== expected) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid X-API-Key.')
    }
    return next()
  }

  if (!bearer) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Missing Authorization: Bearer <token>.')
  }

  const oidcConfigured = Boolean(getEnvTrim('OIDC_ISSUER') && getEnvTrim('OIDC_AUDIENCE') && getEnvTrim('OIDC_JWKS_URL'))
  if (!oidcConfigured && !isAuthConfigured() && !isDbAuthConfigured()) {
    return next()
  }

  if (oidcConfigured) {
    verifyOidcAccessToken(bearer).then((result) => {
      if (!result.ok) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid or expired access token.')
      }
      res.locals.auth = result.payload
      const customerId = result.payload?.customerId ? String(result.payload.customerId) : null
      const resellerId = result.payload?.resellerId ? String(result.payload.resellerId) : null
      const departmentId = result.payload?.departmentId ? String(result.payload.departmentId) : null
      const roleScope = result.payload?.roleScope ? String(result.payload.roleScope) : null
      req.cmpAuth = {
        enterpriseId: result.payload?.enterpriseId ? String(result.payload.enterpriseId) : customerId,
        clientId: result.payload?.sub ? String(result.payload.sub) : null,
        userId: result.payload?.userId ? String(result.payload.userId) : result.payload?.sub ? String(result.payload.sub) : null,
        resellerId,
        customerId,
        departmentId,
        roleScope,
        role: result.payload?.role ? String(result.payload.role) : null,
        permissions: normalizePermissions(result.payload),
      }
      if (roleScope === 'customer' && customerId) {
        req.tenantScope = { customerId }
      } else if (roleScope === 'department' && customerId && departmentId) {
        req.tenantScope = { customerId, departmentId }
      } else if (roleScope === 'reseller' && resellerId) {
        req.tenantScope = { resellerId }
      } else {
        req.tenantScope = {}
      }
      return next()
    }).catch(() => sendError(res, 401, 'UNAUTHORIZED', 'Invalid or expired access token.'))
    return
  }

  const result = verifyAccessToken(bearer)
  if (!result.ok) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Invalid or expired access token.')
  }

  res.locals.auth = result.payload
  if (result.payload?.enterpriseId) {
    const customerId = String(result.payload.enterpriseId)
    const userIdCandidate = result.payload?.sub ? String(result.payload.sub) : null
    const userId = userIdCandidate && isValidUuid(userIdCandidate) ? userIdCandidate : null
    req.cmpAuth = {
      enterpriseId: customerId,
      clientId: result.payload.sub ? String(result.payload.sub) : null,
      customerId,
      roleScope: 'customer',
      role: result.payload?.role ? String(result.payload.role) : null,
      userId,
    }
    req.tenantScope = { customerId }
  } else {
    const roleScope = result.payload?.roleScope ? String(result.payload.roleScope) : null
    const role = result.payload?.role ? String(result.payload.role) : null
    const customerId = result.payload?.customerId ? String(result.payload.customerId) : null
    const resellerId = result.payload?.resellerId ? String(result.payload.resellerId) : null
    const departmentId = result.payload?.departmentId ? String(result.payload.departmentId) : null
    if (roleScope || role) {
      const userIdCandidate = result.payload?.userId ? String(result.payload.userId) : result.payload?.sub ? String(result.payload.sub) : null
      const userId = userIdCandidate && isValidUuid(userIdCandidate) ? userIdCandidate : null
      req.cmpAuth = {
        enterpriseId: customerId,
        clientId: result.payload?.sub ? String(result.payload.sub) : null,
        userId,
        resellerId,
        customerId,
        departmentId,
        roleScope,
        role,
      }
      if (roleScope === 'customer' && customerId) {
        req.tenantScope = { customerId }
      } else if (roleScope === 'department' && customerId && departmentId) {
        req.tenantScope = { customerId, departmentId }
      } else if (roleScope === 'reseller' && resellerId) {
        req.tenantScope = { resellerId }
      } else {
        req.tenantScope = {}
      }
    }
  }
  return next()
}

function escapeCsv(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`
  }
  return s
}

function buildBaseUrl(req) {
  const host = req.get('host')
  const headerProto = req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : req.protocol
  const publicIp = getEnvTrim('PUBLIC_IP')
  const port = getEnvTrim('PORT') || '3000'
  const proto = getEnvTrim('PUBLIC_PROTO') || headerProto || 'http'
  const isLocalHost = host && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))
  if (publicIp && host && host.endsWith(`:${port}`) && !isLocalHost) {
    return `${proto}://${publicIp}:${port}`
  }
  return `${proto}://${host}`
}

function toIsoDateTime(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function startOfDayUtc(date) {
  const d = new Date(date)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

function addDaysUtc(date, days) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function parseReportPeriod(period) {
  const endDay = startOfDayUtc(new Date())
  if (!period) {
    const startDay = addDaysUtc(endDay, -29)
    return { startDay, endDay }
  }
  const raw = String(period).trim()
  if (!raw) {
    const startDay = addDaysUtc(endDay, -29)
    return { startDay, endDay }
  }
  if (raw.includes(',')) {
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length === 2) {
      const start = new Date(parts[0])
      const end = new Date(parts[1])
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
        return { startDay: startOfDayUtc(start), endDay: startOfDayUtc(end) }
      }
    }
  }
  if (/^\d+d$/i.test(raw)) {
    const days = Number(raw.slice(0, -1))
    if (Number.isFinite(days) && days > 0) {
      const startDay = addDaysUtc(endDay, -(days - 1))
      return { startDay, endDay }
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`)
    if (!Number.isNaN(d.getTime())) {
      const startDay = startOfDayUtc(d)
      return { startDay, endDay: startDay }
    }
  }
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const [y, m] = raw.split('-').map((v) => Number(v))
    if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
      const startDay = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0))
      const endDayMonth = new Date(Date.UTC(y, m, 0, 0, 0, 0, 0))
      return { startDay, endDay: endDayMonth }
    }
  }
  return null
}

function normalizeReportGranularity(value) {
  const raw = String(value || '').toLowerCase()
  if (raw === 'month' || raw === 'monthly') return 'month'
  return 'day'
}

function chunkArray(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

function firstDayNextMonthUtc() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0))
}

function computeOneTimeExpiry(effectiveAtIso, validityDays, expiryBoundary) {
  const days = Number(validityDays)
  if (!effectiveAtIso || !Number.isFinite(days) || days < 1) return null
  const base = new Date(effectiveAtIso)
  if (Number.isNaN(base.getTime())) return null
  if (expiryBoundary === 'DURATION_EXCLUSIVE_END') {
    return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
  }
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (days - 1), 23, 59, 59, 999)
  return end.toISOString()
}

export function createApp() {
  const app = express()

  // Patch Express 4 to catch async route handler errors and forward them to the global error handler
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = app[method].bind(app)
    app[method] = function (path, ...handlers) {
      const wrapped = handlers.map((fn) => {
        if (typeof fn !== 'function') return fn
        if (fn.length >= 4) return fn
        return (req, res, next) => {
          try {
            const result = fn(req, res, next)
            if (result && typeof result.catch === 'function') {
              result.catch(next)
            }
          } catch (err) {
            next(err)
          }
        }
      })
      return original(path, ...wrapped)
    }
  }

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, Idempotency-Key')
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200)
    }
    next()
  })

  const corsAllowOrigins = parseCsvEnv('CORS_ALLOW_ORIGINS')
  const corsAllowHeaders = parseCsvEnv('CORS_ALLOW_HEADERS')
  const allowHeaders = corsAllowHeaders.length
    ? corsAllowHeaders.join(', ')
    : 'Authorization, Content-Type, X-API-Key, X-API-Secret, X-Request-Id, Idempotency-Key'

  if (corsAllowOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.headers.origin ? String(req.headers.origin) : null
      if (origin && isOriginAllowed(origin, corsAllowOrigins)) {
        res.setHeader('Access-Control-Allow-Origin', corsAllowOrigins.includes('*') ? '*' : origin)
        res.setHeader('Vary', 'Origin')
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', allowHeaders)
        res.setHeader('Access-Control-Allow-Credentials', 'false')
      }
      if (req.method === 'OPTIONS') {
        return res.status(204).end()
      }
      return next()
    })
  }

  app.use((req, res, next) => {
    const traceId = `req_${crypto.randomUUID().replaceAll('-', '')}`
    res.locals.traceId = traceId
    res.setHeader('X-Request-Id', traceId)
    next()
  })

  app.use(express.json({ limit: '1mb' }))
  const tokenLimiter = createRateLimiter({
    windowMs: getEnvNumber('RATE_LIMIT_TOKEN_WINDOW_MS', 60000),
    max: getEnvNumber('RATE_LIMIT_TOKEN_MAX', 30),
    keyResolver: (req) => (req.body?.clientId ? String(req.body.clientId) : req.ip)
  })
  const adminLimiter = createRateLimiter({
    windowMs: getEnvNumber('RATE_LIMIT_ADMIN_WINDOW_MS', 60000),
    max: getEnvNumber('RATE_LIMIT_ADMIN_MAX', 60),
    keyResolver: (req) => getAdminApiKeyFromReq(req) ?? req.ip
  })
  const globalLimiter = createRateLimiter({
    windowMs: getEnvNumber('RATE_LIMIT_GLOBAL_WINDOW_MS', 60000),
    max: getEnvNumber('RATE_LIMIT_GLOBAL_MAX', 0) || Number.MAX_SAFE_INTEGER,
    keyResolver: (req) => {
      if (req?.cmpAuth?.customerId) return `customer:${String(req.cmpAuth.customerId)}`
      if (req?.cmpAuth?.resellerId) return `reseller:${String(req.cmpAuth.resellerId)}`
      if (req?.cmpAuth?.clientId) return String(req.cmpAuth.clientId)
      return req.ip
    }
  })
  app.use('/v1/auth/token', tokenLimiter)
  app.use('/auth/token', tokenLimiter)
  app.use('/admin', adminLimiter)
  app.use('/v1/admin', adminLimiter)
  app.use(authGuard)
  const tenantScopedRoutes = [
    '/v1/bills',
    '/bills',
    '/v1/sims',
    '/sims',
    '/v1/jobs',
    '/jobs',
    '/v1/subscriptions',
    '/subscriptions',
    '/v1/packages',
    '/packages',
    '/v1/price-plans',
    '/price-plans',
  ]
  app.use(tenantScopedRoutes, requireRoleScopes(['customer', 'department', 'reseller']))
  app.use(tenantScopedRoutes, requireEnterpriseScope())
  app.use(permissionGuard)
  app.use('/v1/bills', globalLimiter)
  app.use('/v1/sims', globalLimiter)
  app.use('/v1/jobs', globalLimiter)
  app.use('/bills', globalLimiter)
  app.use('/sims', globalLimiter)
  app.use('/jobs', globalLimiter)

  const writeLimiter = createRateLimiter({
    windowMs: getEnvNumber('RATE_LIMIT_WRITE_WINDOW_MS', 60000),
    max: getEnvNumber('RATE_LIMIT_WRITE_MAX', 0) || Number.MAX_SAFE_INTEGER,
    keyResolver: (req) => {
      if (req?.cmpAuth?.customerId) return `customer:${String(req.cmpAuth.customerId)}`
      if (req?.cmpAuth?.resellerId) return `reseller:${String(req.cmpAuth.resellerId)}`
      if (req?.cmpAuth?.clientId) return String(req.cmpAuth.clientId)
      return req.ip
    }
  })
  app.use('/v1/bills/:billId\\:mark-paid', writeLimiter)
  app.use('/v1/bills/:billId\\:adjust', writeLimiter)
  app.use('/bills/:billId\\:mark-paid', writeLimiter)
  app.use('/bills/:billId\\:adjust', writeLimiter)
 
  const metrics = {
    count: 0,
    errorCount: 0,
    rateLimitedCount: 0,
    authFailureCount: 0,
    durations: [],
    maxSamples: 1000,
    byLabel: new Map(),
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
  const alertMetricsCache = {
    expiresAt: 0,
    value: null,
  }
  const alertMetricsTtlMs = 60000
  const alertMetricsWindowMs = 24 * 60 * 60 * 1000

  async function countAlerts({ supabase, sinceIso, alertType, status, severity }) {
    const filters = [`created_at=gte.${encodeURIComponent(sinceIso)}`]
    if (alertType) filters.push(`alert_type=eq.${encodeURIComponent(alertType)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (severity) filters.push(`severity=eq.${encodeURIComponent(severity)}`)
    const query = `select=alert_id&limit=1&${filters.join('&')}`
    try {
      const { total } = await supabase.selectWithCount('alerts', query)
      return typeof total === 'number' ? total : 0
    } catch (err) {
      const body = err?.body ? String(err.body) : String(err?.message ?? '')
      if (body.includes('invalid input value for enum alert_type')) {
        return 0
      }
      throw err
    }
  }

  async function countAlertEvents({ supabase, sinceIso }) {
    const query = `select=event_id&limit=1&event_type=eq.ALERT_TRIGGERED&occurred_at=gte.${encodeURIComponent(sinceIso)}`
    const { total } = await supabase.selectWithCount('events', query)
    return typeof total === 'number' ? total : 0
  }

  async function loadAlertMetrics(traceId) {
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
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      const dur = Date.now() - start
      metrics.count += 1
      metrics.durations.push(dur)
      if (metrics.durations.length > metrics.maxSamples) metrics.durations.shift()
      const sc = res.statusCode
      if (sc === 429) metrics.rateLimitedCount += 1
      if (sc === 401) metrics.authFailureCount += 1
      if (sc >= 500) metrics.errorCount += 1
      const method = String(req.method || 'GET')
      const path = String(req.originalUrl || req.url || '/')
      const route = path.startsWith('/v1/bills') ? '/v1/bills' :
        path.startsWith('/v1/sims') ? '/v1/sims' :
        path.startsWith('/v1/jobs') ? '/v1/jobs' :
        path.startsWith('/bills') ? '/bills' :
        path.startsWith('/sims') ? '/sims' :
        path.startsWith('/jobs') ? '/jobs' :
        path.startsWith('/v1/auth/token') ? '/v1/auth/token' :
        path.startsWith('/auth/token') ? '/auth/token' :
        path.startsWith('/v1/admin') ? '/v1/admin' :
        path.startsWith('/admin') ? '/admin' : 'other'
      const statusClass = `${Math.floor(sc / 100)}xx`
      const key = `${method}|${route}|${statusClass}`
      const prev = metrics.byLabel.get(key) ?? { count: 0, durations: [] }
      prev.count += 1
      prev.durations.push(dur)
      if (prev.durations.length > metrics.maxSamples) prev.durations.shift()
      metrics.byLabel.set(key, prev)
    })
    next()
  })

  function percentile(sorted, p) {
    if (!sorted.length) return 0
    const idx = Math.floor(p * (sorted.length - 1))
    return sorted[idx]
  }
  function buildHistogram(values, buckets) {
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

  app.get('/metrics', async (req, res) => {
    const sorted = metrics.durations.slice().sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const p99 = percentile(sorted, 0.99)
    const out = []
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
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.send(`${out.join('\n')}\n`)
  })
  async function handleAuthToken(req, res) {
    const { clientId, clientSecret } = req.body ?? {}
    if (!clientId || !clientSecret) {
      return sendError(res, 400, 'BAD_REQUEST', 'clientId and clientSecret are required.')
    }

    if (!isAuthConfigured() && !isDbAuthConfigured()) {
      const token = Buffer.from(`${clientId}:${clientSecret}:${Date.now()}`).toString('base64url')
      return res.json({
        accessToken: token,
        expiresIn: 3600,
        tokenType: 'Bearer'
      })
    }

    if (isAuthConfigured()) {
      const expectedClientId = getEnvTrim('AUTH_CLIENT_ID')
      const expectedClientSecret = getEnvTrim('AUTH_CLIENT_SECRET')
      if (clientId !== expectedClientId || clientSecret !== expectedClientSecret) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid client credentials.')
      }

      const ttlConfig = getEnvNumber('AUTH_TOKEN_TTL_SECONDS', 3600)
      const ttlSeconds = Math.min(86400, Math.max(60, ttlConfig))
      const now = Math.floor(Date.now() / 1000)
      let enterpriseId = getEnvTrim('AUTH_ENTERPRISE_ID')
      if (enterpriseId && !isValidUuid(enterpriseId) && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        try {
          const supabase = createSupabaseRestClient({ useServiceRole: true })
          const rows = await supabase.select('packages', 'select=enterprise_id&limit=1')
          const row = Array.isArray(rows) ? rows[0] : null
          if (row && row.enterprise_id && isValidUuid(row.enterprise_id)) {
            enterpriseId = String(row.enterprise_id)
          }
        } catch {}
        if (!isValidUuid(enterpriseId)) {
          enterpriseId = '00000000-0000-0000-0000-000000000000'
        }
      }
      const roleScope = enterpriseId ? 'customer' : 'platform'
      const role = enterpriseId ? 'customer_m2m' : 'platform_admin'
      const payload = {
        iss: 'iot-cmp-api',
        sub: String(clientId),
        iat: now,
        exp: now + ttlSeconds,
        roleScope,
        role,
        ...(enterpriseId ? { enterpriseId } : {}),
      }

      const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
      return res.json({
        accessToken: token,
        expiresIn: ttlSeconds,
        tokenType: 'Bearer'
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
        if (!row || row.status !== 'ACTIVE') {
          return sendError(res, 401, 'UNAUTHORIZED', 'Invalid client credentials.')
        }

        const ok = verifySecretScrypt(String(clientSecret), row.secret_hash)
        if (!ok) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Invalid client credentials.')
        }

        const ttlConfig = getEnvNumber('AUTH_TOKEN_TTL_SECONDS', 3600)
        const ttlSeconds = Math.min(86400, Math.max(60, ttlConfig))
        const now = Math.floor(Date.now() / 1000)
        const enterpriseId = String(row.enterprise_id)
        const roleScope = enterpriseId ? 'customer' : 'platform'
        const role = enterpriseId ? 'customer_m2m' : 'platform_admin'
        const payload = {
          iss: 'iot-cmp-api',
          sub: String(clientId),
          iat: now,
          exp: now + ttlSeconds,
          roleScope,
          role,
          ...(enterpriseId ? { enterpriseId } : {}),
        }

        const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
        return res.json({
          accessToken: token,
          expiresIn: ttlSeconds,
          tokenType: 'Bearer'
        })
      } catch (err) {
        const expectedClientId = getEnvTrim('AUTH_CLIENT_ID')
        const expectedClientSecret = getEnvTrim('AUTH_CLIENT_SECRET')
        if (isAuthConfigured() && clientId === expectedClientId && clientSecret === expectedClientSecret) {
          const ttlConfig = getEnvNumber('AUTH_TOKEN_TTL_SECONDS', 3600)
          const ttlSeconds = Math.min(86400, Math.max(60, ttlConfig))
          const now = Math.floor(Date.now() / 1000)
          const enterpriseId = getEnvTrim('AUTH_ENTERPRISE_ID')
          const roleScope = enterpriseId ? 'customer' : 'platform'
          const role = enterpriseId ? 'customer_m2m' : 'platform_admin'
          const payload = {
            iss: 'iot-cmp-api',
            sub: String(clientId),
            iat: now,
            exp: now + ttlSeconds,
            roleScope,
            role,
            ...(enterpriseId ? { enterpriseId } : {}),
          }
          const token = signJwtHs256(payload, getEnvTrim('AUTH_TOKEN_SECRET'))
          return res.json({
            accessToken: token,
            expiresIn: ttlSeconds,
            tokenType: 'Bearer'
          })
        }
        return sendError(res, 502, 'UPSTREAM_ERROR', 'Auth upstream error.')
      }
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Auth is misconfigured.')
  }

  async function handleAuthLogin(req, res) {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!email || !password) {
      return sendError(res, 400, 'BAD_REQUEST', 'email and password are required.')
    }

    const ttlConfig = getEnvNumber('AUTH_TOKEN_TTL_SECONDS', 3600)
    const ttlSeconds = Math.min(86400, Math.max(60, ttlConfig))
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
      let enterpriseId = getEnvTrim('AUTH_ENTERPRISE_ID')
      if (enterpriseId && !isValidUuid(enterpriseId) && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        try {
          const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
          const rows = await supabase.select('packages', 'select=enterprise_id&limit=1')
          const row = Array.isArray(rows) ? rows[0] : null
          if (row && row.enterprise_id && isValidUuid(row.enterprise_id)) {
            enterpriseId = String(row.enterprise_id)
          }
        } catch {}
        if (!isValidUuid(enterpriseId)) {
          enterpriseId = '00000000-0000-0000-0000-000000000000'
        }
      }
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
      if (!row || row.status !== 'ACTIVE') {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials.')
      }
      const ok = verifySecretScrypt(String(password), row.secret_hash)
      if (!ok) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials.')
      }
      const enterpriseId = row.enterprise_id ? String(row.enterprise_id) : null
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

  async function handleAuthRefresh(req, res) {
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
    const ttlConfig = getEnvNumber('AUTH_TOKEN_TTL_SECONDS', 3600)
    const ttlSeconds = Math.min(86400, Math.max(60, ttlConfig))
    const now = Math.floor(Date.now() / 1000)
    const nextPayload = { ...payload, iat: now, exp: now + ttlSeconds }
    const accessToken = signJwtHs256(nextPayload, secret)
    const userId = payload?.userId ? String(payload.userId) : payload?.sub ? String(payload.sub) : ''
    const email = payload?.email ? String(payload.email) : payload?.sub ? String(payload.sub) : ''
    const roleScope = payload?.roleScope ? String(payload.roleScope) : (payload && payload.enterpriseId ? 'customer' : 'platform')
    const role = payload?.role ? String(payload.role) : (payload && payload.enterpriseId ? 'customer_m2m' : 'platform_admin')
    const resellerId = payload?.resellerId ? String(payload.resellerId) : null
    const customerId = payload?.customerId ? String(payload.customerId) : payload?.enterpriseId ? String(payload.enterpriseId) : null
    res.json({
      accessToken,
      expiresIn: ttlSeconds,
      tokenType: 'Bearer',
      user: {
        userId,
        email,
        role,
        roleScope,
        resellerId,
        customerId,
      },
    })
  }

  const getAuthContext = (req) => ({
    roleScope: getRoleScope(req),
    role: req?.cmpAuth?.role ? String(req.cmpAuth.role) : null,
    resellerId: req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null,
    customerId: req?.cmpAuth?.customerId ? String(req.cmpAuth.customerId) : null,
    userId: req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null,
  })

  const resellerSalesRoles = new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director'])
  const ensureResellerRole = (req, res, roles) => {
    const auth = getAuthContext(req)
    if (!auth.roleScope && !auth.role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' }
    if (auth.roleScope === 'reseller' && auth.role && roles.has(auth.role)) return { ...auth, scope: 'reseller' }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }
  const ensureResellerAdmin = (req, res) => ensureResellerRole(req, res, new Set(['reseller_admin']))
  const ensureResellerSales = (req, res) => ensureResellerRole(req, res, resellerSalesRoles)
  const ensurePlatformAdmin = (req, res) => {
    const auth = getAuthContext(req)
    if (!auth.roleScope && !auth.role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }
  const resolveEnterpriseForResellerScope = async (req, res, supabase, enterpriseId) => {
    const auth = getAuthContext(req)
    if (auth.roleScope !== 'reseller') return enterpriseId
    const resellerId = auth.resellerId
    if (!resellerId) {
      sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      return null
    }
    if (!enterpriseId) {
      sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required for reseller scope.')
      return null
    }
    const rows = await supabase.select('tenants', `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`)
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row || String(row.parent_id || '') !== String(resellerId)) {
      sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
      return null
    }
    return enterpriseId
  }

  function mountBillsRoutes(prefix) {
    function isMissingColumnError(err, column) {
      const body = String(err?.body || err?.message || '')
      return body.includes('does not exist') && body.includes(column)
    }

    async function resolveBillWriteAuth(req, res, supabase, bill) {
      const auth = req?.cmpAuth ?? {}
      const roleScope = getRoleScope(req)
      const role = auth?.role ? String(auth.role) : null
      if (roleScope === 'platform' || role === 'platform_admin') return auth
      if (roleScope === 'reseller' && role === 'reseller_admin') {
        if (bill.reseller_id && String(bill.reseller_id) === String(auth.resellerId || '')) return auth
        if (bill.enterprise_id && auth.resellerId) {
          const entRows = await supabase.select(
            'tenants',
            `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(bill.enterprise_id)}&tenant_type=eq.ENTERPRISE&limit=1`
          )
          const ent = Array.isArray(entRows) ? entRows[0] : null
          if (ent && String(ent.parent_id || '') === String(auth.resellerId)) return auth
        }
        sendError(res, 403, 'FORBIDDEN', 'billId is out of reseller scope.')
        return null
      }
      if (roleScope === 'customer') {
        const enterpriseId = getEnterpriseIdFromReq(req)
        if (!enterpriseId || String(bill.enterprise_id || '') !== String(enterpriseId)) {
          sendError(res, 403, 'FORBIDDEN', 'billId is out of enterprise scope.')
          return null
        }
        return auth
      }
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return null
    }

    async function loadBillLineItems(supabase, billId) {
      try {
        return await supabase.select(
          'bill_line_items',
          `select=line_item_id,item_type,amount,metadata,group_key,group_type&bill_id=eq.${encodeURIComponent(billId)}&order=line_item_id.asc`,
          { suppressMissingColumns: true }
        )
      } catch (err) {
        if (isMissingColumnError(err, 'group_key') || isMissingColumnError(err, 'group_type')) {
          return await supabase.select(
            'bill_line_items',
            `select=line_item_id,item_type,amount,metadata&bill_id=eq.${encodeURIComponent(billId)}&order=line_item_id.asc`
          )
        }
        throw err
      }
    }

    async function loadBillLineItemsWithCount(supabase, billId, filters, pageSize, offset) {
      const base = `bill_id=eq.${encodeURIComponent(billId)}`
      const queryFilters = [base, ...filters]
      const query = `select=line_item_id,item_type,amount,metadata,group_key,group_type&${queryFilters.join('&')}&order=line_item_id.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
      try {
        return await supabase.selectWithCount('bill_line_items', query)
      } catch (err) {
        if (isMissingColumnError(err, 'group_key') || isMissingColumnError(err, 'group_type')) {
          const fallback = `select=line_item_id,item_type,amount,metadata&${queryFilters.join('&')}&order=line_item_id.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
          return await supabase.selectWithCount('bill_line_items', fallback)
        }
        throw err
      }
    }

    async function loadBillScope(supabase, billId) {
      try {
        return await supabase.select(
          'bills',
          `select=bill_id,reseller_id,enterprise_id,status&bill_id=eq.${encodeURIComponent(billId)}&limit=1`,
          { suppressMissingColumns: true }
        )
      } catch (err) {
        if (isMissingColumnError(err, 'reseller_id')) {
          return await supabase.select(
            'bills',
            `select=bill_id,enterprise_id,status&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
          )
        }
        throw err
      }
    }
    function buildBillDetail({ bill, lineItems }) {
      const simItems = lineItems.filter((it) => String(it.item_type || '') === 'SIM_TOTAL')
      const l1Summary = {
        monthlyFeeTotal: 0,
        usageChargeTotal: 0,
        overageChargeTotal: 0,
      }
      const groupMap = new Map()
      for (const item of simItems) {
        const meta = item.metadata ?? {}
        l1Summary.monthlyFeeTotal += Number(meta.monthlyFee ?? 0)
        l1Summary.usageChargeTotal += Number(meta.usageCharge ?? 0)
        l1Summary.overageChargeTotal += Number(meta.overageCharge ?? 0)
        const groupKey = item.group_key ?? meta.departmentId ?? meta.packageVersionId ?? null
        const groupType = item.group_type ?? (meta.departmentId ? 'DEPARTMENT' : (meta.packageVersionId ? 'PACKAGE' : null))
        const groupName = meta.departmentName ?? meta.packageName ?? null
        const groupId = `${groupType || 'UNKNOWN'}:${groupKey || 'NONE'}`
        const subtotal = Number(item.amount ?? 0)
        const current = groupMap.get(groupId) || { groupKey, groupType, groupName, subtotal: 0 }
        current.subtotal += subtotal
        groupMap.set(groupId, current)
      }
      const l2Groups = Array.from(groupMap.values()).map((g) => ({
        groupKey: g.groupKey,
        groupType: g.groupType,
        groupName: g.groupName,
        subtotal: Number(g.subtotal.toFixed(2)),
      }))
      return {
        billId: bill.bill_id ?? bill.billId ?? bill.bill_id,
        period: String(bill.period_start ?? bill.period ?? '').slice(0, 7),
        status: bill.status,
        dueDate: bill.due_date ?? bill.dueDate ?? null,
        currency: bill.currency,
        totalAmount: Number(bill.total_amount ?? bill.totalAmount ?? 0),
        enterpriseId: bill.enterprise_id ?? bill.enterpriseId ?? null,
        l1Summary: {
          monthlyFeeTotal: Number(l1Summary.monthlyFeeTotal.toFixed(2)),
          usageChargeTotal: Number(l1Summary.usageChargeTotal.toFixed(2)),
          overageChargeTotal: Number(l1Summary.overageChargeTotal.toFixed(2)),
        },
        l2Groups,
        l3LineItemsUrl: `${prefix}/bills/${bill.bill_id ?? bill.billId}/line-items?page=1&pageSize=100`,
      }
    }

    app.post(`${prefix}/billing:generate`, async (req, res) => {
      const authCtx = getAuthContext(req)
      if (!authCtx.roleScope && !authCtx.role) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      }
      const isPlatform = authCtx.roleScope === 'platform' || authCtx.role === 'platform_admin'
      const isResellerAdmin = authCtx.roleScope === 'reseller' && authCtx.role === 'reseller_admin'
      if (!isPlatform && !isResellerAdmin) {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }

      const period = req.body?.period ? String(req.body.period) : null
      const enterpriseIdRaw = req.body?.enterpriseId != null && req.body?.enterpriseId !== ''
        ? String(req.body.enterpriseId)
        : null
      if (!period) {
        return sendError(res, 400, 'BAD_REQUEST', 'period is required.')
      }
      const traceId = getTraceId(res)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId })

      let payload = null
      let actorUserId = authCtx.userId ?? null
      if (isPlatform) {
        payload = {
          period,
          enterpriseId: enterpriseIdRaw,
          resellerId: null,
          traceId,
          actorUserId,
          actorRole: authCtx.role ?? 'platform_admin',
        }
      } else {
        const resellerId = authCtx.resellerId ? String(authCtx.resellerId) : null
        if (!resellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'resellerId is required for reseller billing.')
        }
        let enterpriseId = null
        if (enterpriseIdRaw) {
          if (!isValidUuid(enterpriseIdRaw)) {
            return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
          }
          enterpriseId = await resolveEnterpriseForResellerScope(req, res, supabase, enterpriseIdRaw)
          if (!enterpriseId) return
        }
        payload = {
          period,
          enterpriseId,
          resellerId,
          traceId,
          actorUserId,
          actorRole: authCtx.role ?? 'reseller_admin',
        }
      }

      const jobs = await supabase.insert('jobs', {
        job_type: 'BILLING_GENERATE',
        status: 'QUEUED',
        progress_processed: 0,
        progress_total: 0,
        payload,
        request_id: JSON.stringify(payload),
        actor_user_id: actorUserId,
      })
      const jobId = Array.isArray(jobs) ? jobs[0]?.job_id : null
      res.status(202).json({ jobId, period, status: 'QUEUED', enterpriseId: payload.enterpriseId ?? null, resellerId: payload.resellerId ?? null })
    })
    app.get(`${prefix}/bills`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (enterpriseId) {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })

        const period = req.query.period ? String(req.query.period) : null
        const status = req.query.status ? String(req.query.status) : null
        const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : null
        const sortOrderRaw = req.query.sortOrder ? String(req.query.sortOrder) : null
        const limit = req.query.limit ? Number(req.query.limit) : 20
        const page = req.query.page ? Number(req.query.page) : 1
        const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))

        const filters = [`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`]
        if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
        if (period) {
          const m = period.match(/^(\d{4})-(\d{2})$/)
          if (m) {
            const y = Number(m[1])
            const mm = Number(m[2])
            const monthStart = `${m[1]}-${m[2]}-01`
            const nextMonth = mm === 12 ? `${y + 1}-01-01` : `${m[1]}-${String(mm + 1).padStart(2, '0')}-01`
            filters.push(`period_start=gte.${encodeURIComponent(monthStart)}`)
            filters.push(`period_start=lt.${encodeURIComponent(nextMonth)}`)
          }
        }

        const sortByMap = {
          period: 'period_start',
          dueDate: 'due_date',
          totalAmount: 'total_amount',
          status: 'status'
        }
        const sortBy = sortByRaw && sortByMap[sortByRaw] ? sortByMap[sortByRaw] : 'period_start'
        const sortOrder = sortOrderRaw === 'asc' || sortOrderRaw === 'desc' ? sortOrderRaw : 'desc'
        const qs = `select=bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date&${filters.join('&')}&order=${sortBy}.${sortOrder}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
        const { data, total } = await supabase.selectWithCount('bills', qs)
        const rows = Array.isArray(data) ? data : []
        const items = rows.map((b) => ({
          billId: b.bill_id,
          period: String(b.period_start).slice(0, 7),
          status: b.status,
          dueDate: b.due_date,
          currency: b.currency,
          totalAmount: Number(b.total_amount),
          enterpriseId: b.enterprise_id,
        }))
        {
          const filterPairs = []
          if (period) filterPairs.push(`period=${period}`)
          if (status) filterPairs.push(`status=${status}`)
          if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
          if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
          filterPairs.push(`limit=${limit}`)
          filterPairs.push(`page=${page}`)
          setXFilters(res, filterPairs.join(';'))
        }
        return res.json({
          items,
          total: typeof total === 'number' ? total : items.length,
        })
      }

      const roleScope = getRoleScope(req)
      const auth = getAuthContext(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })

      const period = req.query.period ? String(req.query.period) : null
      const status = req.query.status ? String(req.query.status) : null
      const resellerIdParam = req.query.resellerId ? String(req.query.resellerId) : null
      const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrderRaw = req.query.sortOrder ? String(req.query.sortOrder) : null

      let resellerId = null
      let enterpriseIdFilter = null
      if (roleScope === 'reseller') {
        resellerId = auth.resellerId
        if (!resellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        }
        const tenantRows = await supabase.select(
          'tenants',
          `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
        )
        const customerIds = Array.isArray(tenantRows) ? tenantRows.map((r) => r?.tenant_id).filter(Boolean).map((v) => encodeURIComponent(String(v))) : []
        if (customerIds.length === 0) {
          return res.json({ items: [], total: 0 })
        }
        enterpriseIdFilter = `enterprise_id=in.(${customerIds.join(',')})`
      } else if (roleScope === 'platform') {
        resellerId = resellerIdParam
        if (resellerId) {
          const tenantRows = await supabase.select(
            'tenants',
            `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
          )
          const customerIds = Array.isArray(tenantRows) ? tenantRows.map((r) => r?.tenant_id).filter(Boolean).map((v) => encodeURIComponent(String(v))) : []
          if (customerIds.length > 0) {
            enterpriseIdFilter = `enterprise_id=in.(${customerIds.join(',')})`
          } else {
            enterpriseIdFilter = `reseller_id=eq.${encodeURIComponent(resellerId)}`
          }
        }
      } else {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }

      const limit = req.query.limit ? Number(req.query.limit) : 20
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const filters = []
      if (enterpriseIdFilter) {
        filters.push(enterpriseIdFilter)
      } else if (resellerId) {
        filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
      }
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (period) {
        const m = period.match(/^(\d{4})-(\d{2})$/)
        if (m) {
          const y = Number(m[1])
          const mm = Number(m[2])
          const monthStart = `${m[1]}-${m[2]}-01`
          const nextMonth = mm === 12 ? `${y + 1}-01-01` : `${m[1]}-${String(mm + 1).padStart(2, '0')}-01`
          filters.push(`period_start=gte.${encodeURIComponent(monthStart)}`)
          filters.push(`period_start=lt.${encodeURIComponent(nextMonth)}`)
        }
      }
      const sortByMap = {
        period: 'period_start',
        dueDate: 'due_date',
        totalAmount: 'total_amount',
        status: 'status'
      }
      const sortBy = sortByRaw && sortByMap[sortByRaw] ? sortByMap[sortByRaw] : 'period_start'
      const sortOrder = sortOrderRaw === 'asc' || sortOrderRaw === 'desc' ? sortOrderRaw : 'desc'
      const qs = `select=bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date,reseller_id&${filters.join('&')}&order=${sortBy}.${sortOrder}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
      const { data, total } = await supabase.selectWithCount('bills', qs)
      const rows = Array.isArray(data) ? data : []
      const items = rows.map((b) => ({
        billId: b.bill_id,
        period: String(b.period_start).slice(0, 7),
        status: b.status,
        dueDate: b.due_date,
        currency: b.currency,
        totalAmount: Number(b.total_amount),
        enterpriseId: b.enterprise_id,
        resellerId: b.reseller_id ?? null,
      }))
      {
        const filterPairs = []
        if (period) filterPairs.push(`period=${period}`)
        if (status) filterPairs.push(`status=${status}`)
        if (resellerIdParam) filterPairs.push(`resellerId=${resellerIdParam}`)
        if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
        if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json({
        items,
        total: typeof total === 'number' ? total : items.length,
      })
    })
    app.get(`${prefix}/bills:csv`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (enterpriseId) {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const period = req.query.period ? String(req.query.period) : null
        const status = req.query.status ? String(req.query.status) : null
        const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : null
        const sortOrderRaw = req.query.sortOrder ? String(req.query.sortOrder) : null
        const limit = req.query.limit ? Number(req.query.limit) : 1000
        const page = req.query.page ? Number(req.query.page) : 1
        const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
        const filters = [`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`]
        if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
        if (period) {
          const m = period.match(/^(\d{4})-(\d{2})$/)
          if (m) {
            const y = Number(m[1])
            const mm = Number(m[2])
            const monthStart = `${m[1]}-${m[2]}-01`
            const nextMonth = mm === 12 ? `${y + 1}-01-01` : `${m[1]}-${String(mm + 1).padStart(2, '0')}-01`
            filters.push(`period_start=gte.${encodeURIComponent(monthStart)}`)
            filters.push(`period_start=lt.${encodeURIComponent(nextMonth)}`)
          }
        }
        const sortByMap = { period: 'period_start', dueDate: 'due_date', totalAmount: 'total_amount', status: 'status' }
        const sortBy = sortByRaw && sortByMap[sortByRaw] ? sortByMap[sortByRaw] : 'period_start'
        const sortOrder = sortOrderRaw === 'asc' || sortOrderRaw === 'desc' ? sortOrderRaw : 'desc'
        const qs = `select=bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date&${filters.join('&')}&order=${sortBy}.${sortOrder}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
        const { data } = await supabase.selectWithCount('bills', qs)
        const rows = Array.isArray(data) ? data : []
        const headers = ['billId','period','status','dueDate','currency','totalAmount','enterpriseId']
        const csvRows = [headers.map(escapeCsv).join(',')]
        for (const b of rows) {
          csvRows.push([
            escapeCsv(b.bill_id),
            escapeCsv(String(b.period_start).slice(0, 7)),
            escapeCsv(b.status),
            escapeCsv(b.due_date ?? ''),
            escapeCsv(b.currency ?? ''),
            escapeCsv(b.total_amount ?? ''),
            escapeCsv(b.enterprise_id ?? ''),
          ].join(','))
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', 'attachment; filename="bills.csv"')
        {
          const filterPairs = []
          if (period) filterPairs.push(`period=${period}`)
          if (status) filterPairs.push(`status=${status}`)
          if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
          if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
          filterPairs.push(`limit=${limit}`)
          filterPairs.push(`page=${page}`)
          setXFilters(res, filterPairs.join(';'))
        }
        return res.send(`${csvRows.join('\n')}\n`)
      }
      const roleScope = getRoleScope(req)
      const auth = getAuthContext(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const period = req.query.period ? String(req.query.period) : null
      const status = req.query.status ? String(req.query.status) : null
      const resellerIdParam = req.query.resellerId ? String(req.query.resellerId) : null
      const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrderRaw = req.query.sortOrder ? String(req.query.sortOrder) : null
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))

      let resellerId = null
      let enterpriseIdFilter = null
      if (roleScope === 'reseller') {
        resellerId = auth.resellerId
        if (!resellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        }
        const tenantRows = await supabase.select(
          'tenants',
          `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
        )
        const customerIds = Array.isArray(tenantRows) ? tenantRows.map((r) => r?.tenant_id).filter(Boolean).map((v) => encodeURIComponent(String(v))) : []
        if (customerIds.length === 0) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8')
          res.setHeader('Content-Disposition', 'attachment; filename="bills.csv"')
          return res.send('billId,period,status,dueDate,currency,totalAmount,enterpriseId\n')
        }
        enterpriseIdFilter = `enterprise_id=in.(${customerIds.join(',')})`
      } else if (roleScope === 'platform') {
        resellerId = resellerIdParam
        if (resellerId) {
          const tenantRows = await supabase.select(
            'tenants',
            `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
          )
          const customerIds = Array.isArray(tenantRows) ? tenantRows.map((r) => r?.tenant_id).filter(Boolean).map((v) => encodeURIComponent(String(v))) : []
          if (customerIds.length > 0) {
            enterpriseIdFilter = `enterprise_id=in.(${customerIds.join(',')})`
          } else {
            enterpriseIdFilter = `reseller_id=eq.${encodeURIComponent(resellerId)}`
          }
        }
      } else {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }

      const filters = []
      if (enterpriseIdFilter) filters.push(enterpriseIdFilter)
      else if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (period) {
        const m = period.match(/^(\d{4})-(\d{2})$/)
        if (m) {
          const y = Number(m[1])
          const mm = Number(m[2])
          const monthStart = `${m[1]}-${m[2]}-01`
          const nextMonth = mm === 12 ? `${y + 1}-01-01` : `${m[1]}-${String(mm + 1).padStart(2, '0')}-01`
          filters.push(`period_start=gte.${encodeURIComponent(monthStart)}`)
          filters.push(`period_start=lt.${encodeURIComponent(nextMonth)}`)
        }
      }
      const sortByMap = { period: 'period_start', dueDate: 'due_date', totalAmount: 'total_amount', status: 'status' }
      const sortBy = sortByRaw && sortByMap[sortByRaw] ? sortByMap[sortByRaw] : 'period_start'
      const sortOrder = sortOrderRaw === 'asc' || sortOrderRaw === 'desc' ? sortOrderRaw : 'desc'
      const qs = `select=bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date&${filters.join('&')}&order=${sortBy}.${sortOrder}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
      const { data } = await supabase.selectWithCount('bills', qs)
      const rows = Array.isArray(data) ? data : []
      const headers = ['billId','period','status','dueDate','currency','totalAmount','enterpriseId']
      const csvRows = [headers.map(escapeCsv).join(',')]
      for (const b of rows) {
        csvRows.push([
          escapeCsv(b.bill_id),
          escapeCsv(String(b.period_start).slice(0, 7)),
          escapeCsv(b.status),
          escapeCsv(b.due_date ?? ''),
          escapeCsv(b.currency ?? ''),
          escapeCsv(b.total_amount ?? ''),
          escapeCsv(b.enterprise_id ?? ''),
        ].join(','))
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="bills.csv"')
      {
        const filterPairs = []
        if (period) filterPairs.push(`period=${period}`)
        if (status) filterPairs.push(`status=${status}`)
        if (resellerIdParam) filterPairs.push(`resellerId=${resellerIdParam}`)
        if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
        if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      return res.send(`${csvRows.join('\n')}\n`)
    })

    app.get(`${prefix}/bills/:billId`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (enterpriseId) {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const billId = String(req.params.billId)
        const rows = await supabase.select(
          'bills',
          `select=bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date&bill_id=eq.${encodeURIComponent(billId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
        )
        const b = Array.isArray(rows) ? rows[0] : null
        if (!b) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
        }
        const lineItems = await loadBillLineItems(supabase, billId)
        return res.json(buildBillDetail({ bill: b, lineItems: Array.isArray(lineItems) ? lineItems : [] }))
      }

      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const billId = String(req.params.billId)
      const rows = await supabase.select(
        'bills',
        `select=bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
      )
      const bill = Array.isArray(rows) ? rows[0] : null
      if (!bill) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
      }
      const roleScope = getRoleScope(req)
      const auth = getAuthContext(req)
      if (roleScope === 'reseller' && auth?.resellerId) {
        const entRows = await supabase.select(
          'tenants',
          `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(bill.enterprise_id)}&tenant_type=eq.ENTERPRISE&limit=1`
        )
        const ent = Array.isArray(entRows) ? entRows[0] : null
        if (!ent || String(ent.parent_id || '') !== String(auth.resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'Bill is out of reseller scope.')
        }
      }
      const lineItems = await loadBillLineItems(supabase, billId)
      res.json(buildBillDetail({ bill, lineItems: Array.isArray(lineItems) ? lineItems : [] }))
    })

    const getBillReconciliationSummary = async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const billId = String(req.params.billId)
      let bill = null
      if (enterpriseId) {
        const rows = await supabase.select(
          'bills',
          `select=bill_id,enterprise_id,reseller_id,status,currency,total_amount,period_start,period_end&bill_id=eq.${encodeURIComponent(billId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`,
          { suppressMissingColumns: true }
        )
        bill = Array.isArray(rows) ? rows[0] : null
      } else {
        const rows = await supabase.select(
          'bills',
          `select=bill_id,enterprise_id,reseller_id,status,currency,total_amount,period_start,period_end&bill_id=eq.${encodeURIComponent(billId)}&limit=1`,
          { suppressMissingColumns: true }
        )
        bill = Array.isArray(rows) ? rows[0] : null
        if (bill) {
          const auth = await resolveBillWriteAuth(req, res, supabase, bill)
          if (!auth) return
        }
      }
      if (!bill) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
        return null
      }
      const lineItemRows = await supabase.select(
        'bill_line_items',
        `select=item_type,amount&bill_id=eq.${encodeURIComponent(billId)}`
      )
      const lineItems = Array.isArray(lineItemRows) ? lineItemRows : []
      const byTypeMap = new Map()
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
      const noteIds = Array.from(new Set(noteItems.map((n) => n?.note_id).filter(Boolean).map((v) => String(v))))
      let notes = []
      if (noteIds.length) {
        const idList = noteIds.map((id) => encodeURIComponent(id)).join(',')
        const noteRows = await supabase.select(
          'adjustment_notes',
          `select=note_id,note_type,status,total_amount,currency,created_at&note_id=in.(${idList})`
        )
        notes = Array.isArray(noteRows) ? noteRows : []
      }
      const statusMap = new Map()
      const typeMap = new Map()
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

    app.get(`${prefix}/bills/:billId/reconciliation`, async (req, res) => {
      const summary = await getBillReconciliationSummary(req, res)
      if (!summary) return
      res.json(summary)
    })

    app.get(`${prefix}/bills/:billId/reconciliation\\:csv`, async (req, res) => {
      const summary = await getBillReconciliationSummary(req, res)
      if (!summary) return
      const rows = [['section', 'name', 'count', 'amount']]
      rows.push(['summary', 'billAmount', '', summary.totals.billAmount])
      rows.push(['summary', 'lineItemsAmount', '', summary.totals.lineItemsAmount])
      rows.push(['summary', 'deltaAmount', '', summary.totals.deltaAmount])
      rows.push(['summary', 'lineItemsCount', summary.totals.lineItemsCount, ''])
      rows.push(['summary', 'negativeLineItems', summary.totals.negativeLineItems, ''])
      rows.push(['summary', 'zeroLineItems', summary.totals.zeroLineItems, ''])
      rows.push(['summary', 'adjustmentNotes', summary.adjustments.totalNotes, ''])
      rows.push(['summary', 'adjustmentAmount', '', summary.adjustments.totalAmount])
      for (const item of summary.byItemType) {
        rows.push(['itemType', item.itemType, item.count, item.amount])
      }
      for (const item of summary.adjustments.byStatus) {
        rows.push(['adjustmentStatus', item.status, item.count, item.amount])
      }
      for (const item of summary.adjustments.byType) {
        rows.push(['adjustmentType', item.type, item.count, item.amount])
      }
      const csv = `${rows.map((row) => row.map(escapeCsv).join(',')).join('\n')}\n`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="bill-${summary.billId}-reconciliation.csv"`)
      setXFilters(res, `billId=${summary.billId}`)
      res.send(csv)
    })

    app.get(`${prefix}/bills/:billId/line-items`, async (req, res) => {
      const billId = String(req.params.billId)
      const enterpriseId = getEnterpriseIdFromReq(req)
      const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 100
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, pageSize))
      const groupKey = req.query.groupKey ? String(req.query.groupKey) : null
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      if (enterpriseId) {
        const bills = await supabase.select(
          'bills',
          `select=bill_id&bill_id=eq.${encodeURIComponent(billId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
        )
        if (!Array.isArray(bills) || bills.length === 0) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
        }
      }
      const filters = ['item_type=eq.SIM_TOTAL']
      if (groupKey) filters.push(`group_key=eq.${encodeURIComponent(groupKey)}`)
      let data
      let total
      try {
        const result = await loadBillLineItemsWithCount(supabase, billId, filters, pageSize, offset)
        data = result?.data
        total = result?.total
      } catch (err) {
        if (groupKey && isMissingColumnError(err, 'group_key')) {
          const result = await loadBillLineItemsWithCount(supabase, billId, ['item_type=eq.SIM_TOTAL'], pageSize, offset)
          data = result?.data
          total = result?.total
        } else {
          throw err
        }
      }
      const items = Array.isArray(data) ? data : []
      const mapped = items.map((item) => {
        const meta = item.metadata ?? {}
        return {
          lineItemId: item.line_item_id,
          iccid: meta.iccid ?? null,
          msisdn: meta.msisdn ?? null,
          departmentName: meta.departmentName ?? null,
          packageName: meta.packageName ?? null,
          monthlyFee: meta.monthlyFee ?? 0,
          usageCharge: meta.usageCharge ?? 0,
          overageCharge: meta.overageCharge ?? 0,
          subtotal: meta.subtotal ?? Number(item.amount ?? 0),
          usageKb: meta.usageKb ?? 0,
          groupKey: item.group_key ?? null,
          groupType: item.group_type ?? null,
        }
      })
      res.json({
        items: mapped,
        total: typeof total === 'number' ? total : mapped.length,
      })
    })

    app.get(`${prefix}/enterprises/:enterpriseId/dunning`, async (req, res) => {
      const auth = ensureResellerSales(req, res)
      if (!auth) return
      const enterpriseIdParam = String(req.params.enterpriseId || '').trim()
      if (!isValidUuid(enterpriseIdParam)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      let enterpriseId = enterpriseIdParam
      if (auth.scope === 'reseller') {
        enterpriseId = await resolveEnterpriseForResellerScope(req, res, supabase, enterpriseIdParam)
        if (!enterpriseId) return
      }
      const result = await getEnterpriseDunningSummary({ supabase, enterpriseId })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      res.json(result.value)
    })

    app.post(`${prefix}/enterprises/:enterpriseId/dunning\\:resolve`, async (req, res) => {
      const auth = ensureResellerAdmin(req, res)
      if (!auth) return
      const enterpriseIdParam = String(req.params.enterpriseId || '').trim()
      if (!isValidUuid(enterpriseIdParam)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      let enterpriseId = enterpriseIdParam
      if (auth.scope === 'reseller') {
        enterpriseId = await resolveEnterpriseForResellerScope(req, res, supabase, enterpriseIdParam)
        if (!enterpriseId) return
      }
      const result = await resolveDunningForEnterprise({ supabase, enterpriseId })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      res.json(result.value)
    })

    app.get(`${prefix}/sims/:simId/usage`, async (req, res) => {
      const period = req.query.period ? String(req.query.period) : null
      const startDateRaw = req.query.startDate ? String(req.query.startDate) : null
      const endDateRaw = req.query.endDate ? String(req.query.endDate) : null
      const parsed = parseSimIdentifier(req.params.simId)
      if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const simRows = await supabase.select(
        'sims',
        `select=sim_id,iccid,enterprise_id&${parsed.field}=eq.${encodeURIComponent(parsed.value)}&limit=1`
      )
      const sim = Array.isArray(simRows) ? simRows[0] : null
      if (!sim) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Sim ${parsed.value} not found.`)
      }

      if (period || (!startDateRaw && !endDateRaw)) {
        if (!period || !/^\d{4}-\d{2}$/.test(period)) {
          return sendError(res, 400, 'BAD_REQUEST', 'period must be YYYY-MM.')
        }
        const zone = req.query.zone ? String(req.query.zone) : null
        const [yearStr, monthStr] = period.split('-')
        const year = Number(yearStr)
        const month = Number(monthStr)
        const start = new Date(Date.UTC(year, month - 1, 1))
        const end = new Date(Date.UTC(year, month, 0))
        const roleScope = getRoleScope(req)
        const auth = getAuthContext(req)
        if (roleScope === 'customer' || roleScope === 'department') {
          const enterpriseId = req?.tenantScope?.customerId ?? req?.cmpAuth?.customerId ?? req?.cmpAuth?.enterpriseId
          if (!enterpriseId || String(sim.enterprise_id || '') !== String(enterpriseId)) {
            return sendError(res, 403, 'FORBIDDEN', 'Sim is out of tenant scope.')
          }
        } else if (roleScope === 'reseller') {
          const resellerId = auth.resellerId
          if (!resellerId) {
            return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
          }
          const entRows = await supabase.select('tenants', `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(sim.enterprise_id)}&limit=1`)
          const ent = Array.isArray(entRows) ? entRows[0] : null
          if (!ent || String(ent.parent_id || '') !== String(resellerId)) {
            return sendError(res, 403, 'FORBIDDEN', 'Sim is out of reseller scope.')
          }
        } else if (roleScope !== 'platform') {
          return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
        }
        const zoneFilter = zone ? `&visited_mccmnc=eq.${encodeURIComponent(zone)}` : ''
        const usageRows = await supabase.select(
          'usage_daily_summary',
          `select=visited_mccmnc,total_kb&sim_id=eq.${encodeURIComponent(sim.sim_id)}&usage_day=gte.${encodeURIComponent(start.toISOString().slice(0, 10))}&usage_day=lte.${encodeURIComponent(end.toISOString().slice(0, 10))}${zoneFilter}`
        )
        const usageList = Array.isArray(usageRows) ? usageRows : []
        const usageByZone = new Map()
        for (const row of usageList) {
          const key = String(row.visited_mccmnc || '')
          if (!key) continue
          const current = usageByZone.get(key) || { visitedMccMnc: key, usageKb: 0 }
          current.usageKb += Number(row.total_kb ?? 0)
          usageByZone.set(key, current)
        }
        const ratingRows = await supabase.select(
          'rating_results',
          `select=visited_mccmnc,matched_subscription_id,matched_package_version_id,classification,charged_mb&sim_id=eq.${encodeURIComponent(sim.sim_id)}&usage_day=gte.${encodeURIComponent(start.toISOString().slice(0, 10))}&usage_day=lte.${encodeURIComponent(end.toISOString().slice(0, 10))}`
        )
        const ratingList = Array.isArray(ratingRows) ? ratingRows : []
        const subIds = Array.from(new Set(ratingList.map((r) => r.matched_subscription_id).filter(Boolean).map(String)))
        const pkgVersionIds = Array.from(new Set(ratingList.map((r) => r.matched_package_version_id).filter(Boolean).map(String)))
        const subKinds = new Map()
        if (subIds.length) {
          const idFilter = subIds.map((id) => encodeURIComponent(id)).join(',')
          const subs = await supabase.select('subscriptions', `select=subscription_id,subscription_kind&subscription_id=in.(${idFilter})`)
          const list = Array.isArray(subs) ? subs : []
          for (const sub of list) {
            if (sub?.subscription_id) subKinds.set(String(sub.subscription_id), String(sub.subscription_kind || 'MAIN'))
          }
        }
        const pkgNames = new Map()
        if (pkgVersionIds.length) {
          const idFilter = pkgVersionIds.map((id) => encodeURIComponent(id)).join(',')
          const pkgs = await supabase.select('package_versions', `select=package_version_id,packages(name)&package_version_id=in.(${idFilter})`)
          const list = Array.isArray(pkgs) ? pkgs : []
          for (const pkg of list) {
            if (pkg?.package_version_id) pkgNames.set(String(pkg.package_version_id), pkg?.packages?.name ?? null)
          }
        }
        const zoneMatchStats = new Map()
        for (const row of ratingList) {
          const zoneKey = String(row.visited_mccmnc || '')
          if (!zoneKey) continue
          const pkgId = row.matched_package_version_id ? String(row.matched_package_version_id) : null
          const subKind = row.matched_subscription_id ? subKinds.get(String(row.matched_subscription_id)) : null
          const classification = String(row.classification || '')
          const chargedMb = Number(row.charged_mb ?? 0)
          const current = zoneMatchStats.get(zoneKey) || new Map()
          const key = pkgId || 'NO_PACKAGE'
          const entry = current.get(key) || { chargedMb: 0, subKind, classification }
          entry.chargedMb += chargedMb
          entry.subKind = subKind ?? entry.subKind
          entry.classification = classification || entry.classification
          current.set(key, entry)
          zoneMatchStats.set(zoneKey, current)
        }
        const byZone = Array.from(usageByZone.values()).map((entry) => {
          const stats = zoneMatchStats.get(entry.visitedMccMnc)
          let matchedPackage = null
          let matchType = 'OUT_OF_PROFILE'
          if (stats && stats.size) {
            let bestKey = null
            let bestCharged = -1
            let best = null
            for (const [key, value] of stats.entries()) {
              if (value.chargedMb > bestCharged) {
                bestCharged = value.chargedMb
                bestKey = key
                best = value
              }
            }
            if (bestKey && bestKey !== 'NO_PACKAGE') {
              matchedPackage = pkgNames.get(bestKey) ?? null
            }
            const classification = String(best?.classification || '')
            if (classification.startsWith('PAYG')) {
              matchType = 'OUT_OF_PROFILE'
            } else if (best?.subKind && String(best.subKind).toUpperCase() === 'ADD_ON') {
              matchType = 'ADD_ON'
            } else if (bestKey && bestKey !== 'NO_PACKAGE') {
              matchType = 'MAIN'
            }
          }
          return {
            visitedMccMnc: entry.visitedMccMnc,
            countryName: matchedPackage ? null : null,
            usageKb: Number(entry.usageKb ?? 0),
            matchedPackage,
            matchType,
          }
        })
        const totalUsageKb = Array.from(usageByZone.values()).reduce((sum, entry) => sum + Number(entry.usageKb ?? 0), 0)
        const mccmncPairs = Array.from(new Set(byZone.map((z) => String(z.visitedMccMnc || '')).filter(Boolean)))
        if (mccmncPairs.length) {
          const pairs = mccmncPairs.map((pair) => pair.split('-')).filter((p) => p.length === 2)
          const mccList = Array.from(new Set(pairs.map((p) => p[0])))
          const mncList = Array.from(new Set(pairs.map((p) => p[1])))
          if (mccList.length && mncList.length) {
            const mccFilter = mccList.map((v) => encodeURIComponent(v)).join(',')
            const mncFilter = mncList.map((v) => encodeURIComponent(v)).join(',')
            const carriers = await supabase.select('business_operators', `select=mcc,mnc,name&mcc=in.(${mccFilter})&mnc=in.(${mncFilter})`)
            const carrierList = Array.isArray(carriers) ? carriers : []
            const carrierMap = new Map()
            for (const c of carrierList) {
              const key = `${String(c.mcc).trim()}-${String(c.mnc).trim()}`
              carrierMap.set(key, c.name ?? null)
            }
            for (const zoneRow of byZone) {
              const name = carrierMap.get(String(zoneRow.visitedMccMnc || ''))
              if (name) zoneRow.countryName = name
            }
          }
        }
        res.json({
          simId: sim.sim_id,
          iccid: sim.iccid,
          period,
          totalUsageKb: Math.floor(totalUsageKb),
          byZone,
        })
        return
      }

      const startDate = startDateRaw ? new Date(startDateRaw) : null
      const endDate = endDateRaw ? new Date(endDateRaw) : null
      if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return sendError(res, 400, 'BAD_REQUEST', 'startDate and endDate are required and must be valid date-time.')
      }
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (!(await ensureDepartmentSimAccess(req, res, supabase, sim.iccid, enterpriseId))) return

      const { page, pageSize, offset } = parsePagination(req.query ?? {}, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 1000 })

      const startDay = startOfDayUtc(startDate)
      const endDay = startOfDayUtc(endDate)
      const tenantFilter = enterpriseId ? `&enterprise_id=eq.${encodeURIComponent(enterpriseId)}` : ''
      const baseFilter = `iccid=eq.${encodeURIComponent(sim.iccid)}${tenantFilter}&usage_day=gte.${encodeURIComponent(startDay.toISOString().slice(0, 10))}&usage_day=lte.${encodeURIComponent(endDay.toISOString().slice(0, 10))}`
      const { data, total } = await supabase.selectWithCount(
        'usage_daily_summary',
        `select=usage_day,uplink_kb,downlink_kb,total_kb,created_at&${baseFilter}&order=usage_day.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
      )

      const rawRows = Array.isArray(data) ? data : []
      const items = rawRows.map((r) => {
        const day = new Date(`${r.usage_day}T00:00:00.000Z`)
        const next = addDaysUtc(day, 1)
        return {
          periodStart: day.toISOString(),
          periodEnd: next.toISOString(),
          uplinkBytes: Number(r.uplink_kb ?? 0) * 1024,
          downlinkBytes: Number(r.downlink_kb ?? 0) * 1024,
          totalBytes: Number(r.total_kb ?? 0) * 1024,
          sessionCount: 0,
        }
      })

      res.json({
        items,
        page,
        pageSize,
        total: typeof total === 'number' ? total : items.length,
      })
    })

    app.get(`${prefix}/enterprises/:enterpriseId/usage`, async (req, res) => {
      const enterpriseId = String(req.params.enterpriseId)
      if (!isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      const period = req.query.period ? String(req.query.period) : null
      if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        return sendError(res, 400, 'BAD_REQUEST', 'period must be YYYY-MM.')
      }
      const auth = getAuthContext(req)
      const roleScope = getRoleScope(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      if (roleScope === 'customer' || roleScope === 'department') {
        const scoped = req?.tenantScope?.customerId ?? req?.cmpAuth?.customerId ?? req?.cmpAuth?.enterpriseId
        if (!scoped || String(scoped) !== String(enterpriseId)) {
          return sendError(res, 403, 'FORBIDDEN', 'Enterprise is out of tenant scope.')
        }
      } else if (roleScope === 'reseller') {
        const resellerId = auth.resellerId
        if (!resellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        }
        const entRows = await supabase.select('tenants', `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`)
        const ent = Array.isArray(entRows) ? entRows[0] : null
        if (!ent || String(ent.parent_id || '') !== String(resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'Enterprise is out of reseller scope.')
        }
      } else if (roleScope !== 'platform') {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      const [yearStr, monthStr] = period.split('-')
      const year = Number(yearStr)
      const month = Number(monthStr)
      const start = new Date(Date.UTC(year, month - 1, 1))
      const end = new Date(Date.UTC(year, month, 0))
      const usageRows = await supabase.select(
        'usage_daily_summary',
        `select=total_kb&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&usage_day=gte.${encodeURIComponent(start.toISOString().slice(0, 10))}&usage_day=lte.${encodeURIComponent(end.toISOString().slice(0, 10))}`
      )
      const usageList = Array.isArray(usageRows) ? usageRows : []
      const totalUsageKb = usageList.reduce((sum, row) => sum + Number(row.total_kb ?? 0), 0)
      const simsRows = await supabase.select(
        'sims',
        `select=sim_id,status&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&status=eq.ACTIVATED`
      )
      const activatedSimCount = Array.isArray(simsRows) ? simsRows.length : 0
      const ratingRows = await supabase.select(
        'rating_results',
        `select=matched_package_version_id,charged_mb&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&usage_day=gte.${encodeURIComponent(start.toISOString().slice(0, 10))}&usage_day=lte.${encodeURIComponent(end.toISOString().slice(0, 10))}`
      )
      const ratingList = Array.isArray(ratingRows) ? ratingRows : []
      const packageUsage = new Map()
      for (const row of ratingList) {
        const pkgId = row.matched_package_version_id ? String(row.matched_package_version_id) : null
        if (!pkgId) continue
        const current = packageUsage.get(pkgId) || 0
        packageUsage.set(pkgId, current + Number(row.charged_mb ?? 0))
      }
      const packageVersionIds = Array.from(packageUsage.keys())
      const packageMeta = new Map()
      const pricePlanMeta = new Map()
      if (packageVersionIds.length) {
        const idFilter = packageVersionIds.map((id) => encodeURIComponent(id)).join(',')
        const pkgRows = await supabase.select(
          'package_versions',
          `select=package_version_id,package_id,price_plan_version_id,packages(name)&package_version_id=in.(${idFilter})`
        )
        const pkgList = Array.isArray(pkgRows) ? pkgRows : []
        for (const pkg of pkgList) {
          if (pkg?.package_version_id) {
            packageMeta.set(String(pkg.package_version_id), {
              packageId: pkg.package_id ?? null,
              packageName: pkg?.packages?.name ?? null,
              pricePlanVersionId: pkg.price_plan_version_id ?? null,
            })
          }
        }
        const pricePlanVersionIds = Array.from(new Set(pkgList.map((p) => p.price_plan_version_id).filter(Boolean).map(String)))
        if (pricePlanVersionIds.length) {
          const planFilter = pricePlanVersionIds.map((id) => encodeURIComponent(id)).join(',')
          const planRows = await supabase.select(
            'price_plan_versions',
            `select=price_plan_version_id,quota_mb,total_quota_mb,per_sim_quota_mb&price_plan_version_id=in.(${planFilter})`
          )
          const planList = Array.isArray(planRows) ? planRows : []
          for (const plan of planList) {
            if (plan?.price_plan_version_id) {
              pricePlanMeta.set(String(plan.price_plan_version_id), plan)
            }
          }
        }
      }
      const byPackage = Array.from(packageUsage.entries()).map(([pkgVersionId, usedKb]) => {
        const meta = packageMeta.get(pkgVersionId) || {}
        const plan = meta.pricePlanVersionId ? pricePlanMeta.get(String(meta.pricePlanVersionId)) : null
        const quotaMb = Number(plan?.total_quota_mb ?? plan?.per_sim_quota_mb ?? plan?.quota_mb ?? 0)
        const quotaValue = Number.isFinite(quotaMb) && quotaMb > 0 ? quotaMb : null
        const usagePercent = quotaValue ? Number(((usedKb / quotaValue) * 100).toFixed(2)) : null
        const overageKb = quotaValue ? Math.max(0, Number(usedKb) - quotaValue) : 0
        return {
          packageId: meta.packageId ?? null,
          packageName: meta.packageName ?? null,
          quotaMb: quotaValue ?? null,
          usedKb: Math.floor(Number(usedKb ?? 0)),
          usagePercent,
          overageKb: Math.floor(Number(overageKb)),
        }
      })
      res.json({
        enterpriseId,
        period,
        totalUsageKb: Math.floor(totalUsageKb),
        activatedSimCount,
        byPackage,
      })
    })

    app.get(`${prefix}/bills/:billId/files`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const billId = String(req.params.billId)
      let bill = null
      if (enterpriseId) {
        const rows = await supabase.select('bills', `select=bill_id,enterprise_id&bill_id=eq.${encodeURIComponent(billId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`)
        bill = Array.isArray(rows) ? rows[0] : null
      } else {
        const rows = await supabase.select('bills', `select=bill_id,enterprise_id&bill_id=eq.${encodeURIComponent(billId)}&limit=1`)
        bill = Array.isArray(rows) ? rows[0] : null
        if (bill) {
          const roleScope = getRoleScope(req)
          const auth = getAuthContext(req)
          if (roleScope === 'reseller' && auth?.resellerId) {
            const entRows = await supabase.select(
              'tenants',
              `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(bill.enterprise_id)}&tenant_type=eq.ENTERPRISE&limit=1`
            )
            const ent = Array.isArray(entRows) ? entRows[0] : null
            if (!ent || String(ent.parent_id || '') !== String(auth.resellerId)) {
              return sendError(res, 403, 'FORBIDDEN', 'Bill is out of reseller scope.')
            }
          }
        }
      }
      if (!bill) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
      }
      const baseUrl = buildBaseUrl(req)
      const secret = getEnvTrim('AUTH_TOKEN_SECRET')
      let csvUrl = `${baseUrl}${prefix}/bills/${billId}/files/csv`
      if (secret) {
        const downloadToken = signJwtHs256(
          { billId, purpose: 'csv', exp: Math.floor(Date.now() / 1000) + 900 },
          secret
        )
        csvUrl += `?downloadToken=${encodeURIComponent(downloadToken)}`
      }
      res.json({
        pdfUrl: null,
        csvUrl,
      })
    })

    app.get(`${prefix}/bills/:billId/files/csv`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const billId = String(req.params.billId)
      const limitParam = req.query?.limit ?? req.query?.pageSize
      const { page, pageSize, offset } = parsePagination(
        { pageSize: limitParam, page: req.query?.page },
        { defaultPage: 1, defaultPageSize: 2000, maxPageSize: 10000 }
      )

      const downloadToken = req.query?.downloadToken ? String(req.query.downloadToken) : null
      if (downloadToken) {
        const secret = getEnvTrim('AUTH_TOKEN_SECRET')
        if (!secret) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Download token not supported.')
        }
        const result = verifyJwtHs256(downloadToken, secret)
        if (!result.ok || result.payload?.purpose !== 'csv' || String(result.payload?.billId || '') !== billId) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Invalid or expired download token.')
        }
        const billRows = await supabase.select('bills', `select=bill_id&bill_id=eq.${encodeURIComponent(billId)}&limit=1`)
        if (!Array.isArray(billRows) || billRows.length === 0) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
        }
      } else {
        const enterpriseId = getEnterpriseIdFromReq(req)
        if (enterpriseId) {
          const bills = await supabase.select('bills', `select=bill_id&bill_id=eq.${encodeURIComponent(billId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`)
          if (!Array.isArray(bills) || bills.length === 0) {
            return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
          }
        } else {
          const billRows = await supabase.select('bills', `select=bill_id,enterprise_id&bill_id=eq.${encodeURIComponent(billId)}&limit=1`)
          const bill = Array.isArray(billRows) ? billRows[0] : null
          if (!bill) {
            return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
          }
          const roleScope = getRoleScope(req)
          const auth = getAuthContext(req)
          if (roleScope === 'reseller' && auth?.resellerId) {
            const entRows = await supabase.select(
              'tenants',
              `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(bill.enterprise_id)}&tenant_type=eq.ENTERPRISE&limit=1`
            )
            const ent = Array.isArray(entRows) ? entRows[0] : null
            if (!ent || String(ent.parent_id || '') !== String(auth.resellerId)) {
              return sendError(res, 403, 'FORBIDDEN', 'Bill is out of reseller scope.')
            }
          }
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
        'chargedMb',
        'ratePerMb',
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
            meta.chargedMb,
            meta.ratePerMb,
            meta.inputRef,
            it.created_at,
          ]
            .map(escapeCsv)
            .join(',')
        )
      }

      const csv = `${lines.join('\n')}\n`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="bill-${billId}.csv"`)
      {
        const filterPairs = []
        filterPairs.push(`billId=${billId}`)
        filterPairs.push(`limit=${pageSize}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.send(csv)
    })

    app.post(`${prefix}/bills/:billId\\:mark-paid`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const billId = String(req.params.billId)
      const { paymentRef, paidAt } = req.body ?? {}
      const rows = await loadBillScope(supabase, billId)
      const bill = Array.isArray(rows) ? rows[0] : null
      if (!bill) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
      }
      const auth = await resolveBillWriteAuth(req, res, supabase, bill)
      if (!auth) return
      const result = await transitionBillStatus({
        supabase,
        billId,
        action: 'pay',
        paymentRef: paymentRef ?? null,
        paidAt: paidAt ?? null,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(res),
      })
      if (!result.ok) {
        return sendError(res, result.status, result.code, result.message)
      }
      const v = result.value || {}
      const response = {
        billId: v.bill_id ?? v.billId ?? billId,
        status: v.status ?? null,
        paidAmount: typeof v.total_amount === 'number' ? Number(v.total_amount) : (v.paid_amount ?? null),
        paymentRef: v.payment_ref ?? (paymentRef ?? null),
        paidAt: v.paid_at ?? (paidAt ?? null),
      }
      res.json(response)
    })

    app.post(`${prefix}/bills/:billId\\:adjust`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const billId = String(req.params.billId)
      const { type, amount, reason } = req.body ?? {}
      const items = Array.isArray(req.body?.items) ? req.body.items : []
      const billRows = await loadBillScope(supabase, billId)
      const bill = Array.isArray(billRows) ? billRows[0] : null
      if (!bill) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
      }
      const auth = await resolveBillWriteAuth(req, res, supabase, bill)
      if (!auth) return
      if (!reason) {
        return sendError(res, 400, 'BAD_REQUEST', 'reason is required.')
      }
      let totalAmount = typeof amount === 'number' ? amount : 0
      if (items.length) {
        totalAmount = items.reduce((sum, item) => {
          const v = Number(item?.amount ?? 0)
          if (!Number.isFinite(v) || v <= 0) return sum
          return sum + v
        }, 0)
      }
      const result = await createAdjustmentNote({
        supabase,
        billId,
        type,
        amount: totalAmount,
        reason,
        items,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(res),
      })
      if (!result.ok) {
        return sendError(res, result.status, result.code, result.message)
      }
      const note = result.value || {}
      res.status(201).json({
        ...note,
        noteId: note.noteId ?? note.adjustmentNoteId ?? null,
      })
    })

    app.post(`${prefix}/adjustment-notes/:noteId\\:approve`, async (req, res) => {
      const auth = ensureResellerAdmin(req, res)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const noteId = String(req.params.noteId)
      const result = await approveAdjustmentNote({ supabase, noteId })
      if (!result.ok) {
        return sendError(res, result.status, result.code, result.message)
      }
      res.json(result.value)
    })

    app.get(`${prefix}/adjustment-notes`, async (req, res) => {
      const auth = ensureResellerAdmin(req, res)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const result = await listAdjustmentNotes({
        supabase,
        billId: req.query.billId ? String(req.query.billId) : null,
        type: req.query.type ? String(req.query.type) : null,
        status: req.query.status ? String(req.query.status) : null,
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
      })
      if (!result.ok) {
        return sendError(res, result.status, result.code, result.message)
      }
      res.json(result.value)
    })
  }

  function mountJobsRoutes(prefix) {
    app.get(`${prefix}/jobs/:jobId`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const jobId = String(req.params.jobId)
      const rows = await supabase.select('jobs', `select=job_id,job_type,status,progress_processed,progress_total,error_summary,actor_user_id,created_at,started_at,finished_at&job_id=eq.${encodeURIComponent(jobId)}&limit=1`)
      const job = Array.isArray(rows) ? rows[0] : null
      if (!job) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Job ${jobId} not found.`)
      }

      res.json({
        jobId: job.job_id,
        type: job.job_type,
        status: job.status,
        progress: {
          processed: Number(job.progress_processed ?? 0),
          total: Number(job.progress_total ?? 0),
        },
        errorSummary: job.error_summary ?? null,
        createdAt: job.created_at ?? null,
        updatedAt: job.finished_at ?? job.started_at ?? job.created_at ?? null,
      })
    })
    app.post(`${prefix}/jobs/:jobId\\:cancel`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const jobId = String(req.params.jobId)
      const rows = await supabase.select('jobs', `select=job_id,status,actor_user_id&job_id=eq.${encodeURIComponent(jobId)}&limit=1`)
      const job = Array.isArray(rows) ? rows[0] : null
      if (!job) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `Job ${jobId} not found.`)
      }
      const authUserId = req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null
      const roleScope = getRoleScope(req)
      const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
      const isResellerAdmin = roleScope === 'reseller' && role === 'reseller_admin'
      const isPlatformAdmin = roleScope === 'platform' || role === 'platform_admin'
      if (!isPlatformAdmin && !isResellerAdmin && (!authUserId || String(job.actor_user_id || '') !== authUserId)) {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      if (job.status !== 'QUEUED' && job.status !== 'RUNNING') {
        return sendError(res, 409, 'INVALID_STATE', 'Only QUEUED or RUNNING jobs can be cancelled.')
      }
      await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
        status: 'CANCELLED',
        finished_at: new Date().toISOString(),
      }, { returning: 'minimal' })
      res.json({ jobId, status: 'CANCELLED' })
    })
    app.post(`${prefix}/jobs:late-cdr`, async (req, res) => {
      const roleScope = getRoleScope(req)
      if (roleScope !== 'customer' && roleScope !== 'department') {
        return sendError(res, 403, 'FORBIDDEN', 'Tenant scope required.')
      }
      const enterpriseId = req?.tenantScope?.customerId ?? req?.cmpAuth?.customerId ?? req?.cmpAuth?.enterpriseId
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
      const records = Array.isArray(req.body?.records) ? req.body.records : null
      if (!records || records.length === 0) {
        return sendError(res, 400, 'BAD_REQUEST', 'records must be a non-empty array.')
      }
      const source = req.body?.source ? String(req.body.source) : null
      const batchId = req.body?.batchId ? String(req.body.batchId) : null
      const payload = {
        records: records.map((r) => ({ ...r, enterpriseId })),
        source,
        batchId,
        traceId: getTraceId(res),
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const jobs = await supabase.insert('jobs', {
        job_type: 'LATE_CDR_PROCESS',
        status: 'QUEUED',
        progress_processed: 0,
        progress_total: Number(records.length || 0),
        request_id: JSON.stringify(payload),
        actor_user_id: req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null,
      })
      const jobId = Array.isArray(jobs) ? jobs[0]?.job_id : null
      res.status(202).json({ jobId, status: 'QUEUED' })
    })
  }

  function mountSimsRoutes(prefix) {
    const getAuth = (req) => ({
      roleScope: getRoleScope(req),
      role: req?.cmpAuth?.role ? String(req.cmpAuth.role) : null,
      resellerId: req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null,
      customerId: req?.cmpAuth?.customerId ? String(req.cmpAuth.customerId) : null,
      userId: req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null,
    })
    const resellerSalesRoles = new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director'])
    const ensureResellerRole = (req, res, roles) => {
      const auth = getAuth(req)
      if (!auth.roleScope && !auth.role) {
        sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
        return null
      }
      if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' }
      if (auth.roleScope === 'reseller' && auth.role && roles.has(auth.role)) return { ...auth, scope: 'reseller' }
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return null
    }
    const ensureResellerAdmin = (req, res) => ensureResellerRole(req, res, new Set(['reseller_admin']))
    const ensureResellerSales = (req, res) => ensureResellerRole(req, res, resellerSalesRoles)
    const ensureSubscriptionAccess = (req, res) => {
      const auth = getAuth(req)
      if (!auth.roleScope && !auth.role) {
        sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
        return null
      }
      if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' }
      if (auth.roleScope === 'reseller' && auth.role && resellerSalesRoles.has(auth.role)) return { ...auth, scope: 'reseller' }
      if (auth.roleScope === 'customer') return { ...auth, scope: 'customer' }
      if (auth.roleScope === 'department') return { ...auth, scope: 'department' }
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return null
    }
    const resolveResellerIdentity = async (supabase, rawResellerId) => {
      if (!rawResellerId || !/^[0-9a-f-]{36}$/i.test(String(rawResellerId))) return null
      const id = String(rawResellerId).trim()
      const rows = await supabase.select(
        'resellers',
        `select=id,tenant_id&or=(id.eq.${encodeURIComponent(id)},tenant_id.eq.${encodeURIComponent(id)})&limit=1`
      )
      const row = Array.isArray(rows) && rows[0] ? rows[0] : null
      if (!row) return null
      return { resellerId: row.id ? String(row.id) : null, tenantId: row.tenant_id ? String(row.tenant_id) : null }
    }
    const resolveEnterpriseForReseller = async (req, res, supabase, enterpriseId) => {
      const auth = getAuth(req)
      if (auth.roleScope !== 'reseller') return enterpriseId
      const rawResellerId = auth.resellerId
      if (!rawResellerId) {
        sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        return null
      }
      if (!enterpriseId) {
        sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required for reseller scope.')
        return null
      }
      const resolved = await resolveResellerIdentity(supabase, rawResellerId)
      const resellerTenantId = resolved?.tenantId || rawResellerId
      const rows = await supabase.select('tenants', `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`)
      const row = Array.isArray(rows) ? rows[0] : null
      if (!row || String(row.parent_id || '') !== String(resellerTenantId)) {
        sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
        return null
      }
      return enterpriseId
    }
    const resolveDepartmentForEnterprise = async (req, res, supabase, enterpriseId, departmentId) => {
      if (!departmentId) return null
      if (!isValidUuid(departmentId)) {
        sendError(res, 400, 'BAD_REQUEST', 'departmentId must be a valid uuid.')
        return null
      }
      if (!enterpriseId) {
        sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required when filtering by departmentId.')
        return null
      }
      const rows = await supabase.select('tenants', `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(departmentId)}&tenant_type=eq.DEPARTMENT&limit=1`)
      const row = Array.isArray(rows) ? rows[0] : null
      if (!row || String(row.parent_id || '') !== String(enterpriseId)) {
        sendError(res, 403, 'FORBIDDEN', 'departmentId is out of enterprise scope.')
        return null
      }
      return departmentId
    }
    registerSimPhase4Routes({
      app,
      prefix,
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
      prefix,
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
      prefix,
      deps: {
        createSupabaseRestClient,
        getTraceId,
        sendError,
        ensureResellerAdmin,
        ensureResellerSales,
        resolveEnterpriseForReseller,
        getEnterpriseIdFromReq,
        isValidUuid,
      },
    })
    registerPackageModuleRoutes({
      app,
      prefix,
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
      prefix,
      deps: {
        createSupabaseRestClient,
        getTraceId,
        sendError,
        ensureResellerAdmin,
        ensureResellerSales,
        isValidUuid,
      },
    })
    registerWebhookRoutes({
      app,
      prefix,
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
      prefix,
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
      prefix,
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
      prefix,
      deps: {
        createSupabaseRestClient,
        getTraceId,
        sendError,
        ensurePlatformAdmin,
        isValidUuid,
      },
    })
    const simCsvHandler = async (req, res) => {
      console.log('[DEBUG] simCsvHandler entered for path:', req.path)
      const auth = ensureSubscriptionAccess(req, res)
      if (!auth) return

      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })

      const resellerIdQuery = req.query.resellerId ? String(req.query.resellerId) : null
      const pathEnterpriseId = req.params.enterpriseId ? String(req.params.enterpriseId) : null
      const enterpriseIdQuery = pathEnterpriseId || (req.query.enterpriseId ? String(req.query.enterpriseId) : null)
      const departmentIdQuery = req.query.departmentId ? String(req.query.departmentId) : null

      let enterpriseId = null
      let departmentId = null
      let resellerId = null

      if (auth.scope === 'platform') {
        if (resellerIdQuery && !isValidUuid(resellerIdQuery)) {
          return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        }
        if (enterpriseIdQuery && !isValidUuid(enterpriseIdQuery)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        resellerId = resellerIdQuery
        enterpriseId = enterpriseIdQuery
      } else if (auth.scope === 'reseller') {
        resellerId = auth.resellerId ? String(auth.resellerId) : null
        if (enterpriseIdQuery) {
          if (!isValidUuid(enterpriseIdQuery)) {
            return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
          }
          enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdQuery)
          if (!enterpriseId) return
        }
      } else if (auth.scope === 'customer') {
        enterpriseId = auth.customerId ? String(auth.customerId) : null
        if (pathEnterpriseId && pathEnterpriseId !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'Access denied to this enterprise.')
        }
        // If query param mismatch, we ignore it and enforce auth context
      } else if (auth.scope === 'department') {
        enterpriseId = auth.customerId ? String(auth.customerId) : null
        departmentId = auth.departmentId ? String(auth.departmentId) : null
        if (pathEnterpriseId && pathEnterpriseId !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'Access denied to this enterprise.')
        }
      }

      if (departmentIdQuery && !departmentId) {
        if (enterpriseId) {
          departmentId = await resolveDepartmentForEnterprise(req, res, supabase, enterpriseId, departmentIdQuery)
          if (!departmentId) return
        } else if (auth.scope === 'platform' || auth.scope === 'reseller') {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required when filtering by departmentId.')
        }
      }

      const includeSensitive = (auth.scope === 'platform' || auth.scope === 'reseller') && !pathEnterpriseId

      const iccid = req.query.iccid ? normalizeIccid(req.query.iccid) : null
      const msisdn = req.query.msisdn ? String(req.query.msisdn) : null
      const status = req.query.status ? String(req.query.status) : null
      const supplierId = includeSensitive && req.query.supplierId ? String(req.query.supplierId).trim() : null
      const operatorId = includeSensitive && req.query.operatorId ? String(req.query.operatorId).trim() : null
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))

      if (iccid && !isValidIccid(iccid)) {
        return sendError(res, 400, 'BAD_REQUEST', 'iccid must be 18-20 digits.')
      }

      let resellerEnterpriseIds = null
      if (!enterpriseId && resellerId && (auth.scope === 'platform' || auth.scope === 'reseller')) {
        const resellerRows = await supabase.select('tenants', `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE`)
        resellerEnterpriseIds = (Array.isArray(resellerRows) ? resellerRows : []).map((t) => String(t.tenant_id))
        if (resellerEnterpriseIds.length === 0) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8')
          res.setHeader('Content-Disposition', 'attachment; filename="sims.csv"')
          res.send('simId,iccid,imsi,msisdn,status,lifecycleSubStatus,upstreamStatus,upstreamStatusUpdatedAt,formFactor,activationCode,apn,activationDate,totalUsageBytes,imei\n')
          return
        }
      }

      const filters = []
      if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      if (!enterpriseId && resellerEnterpriseIds) {
        filters.push(`enterprise_id=in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
      }
      if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
      if (iccid) filters.push(`iccid=eq.${encodeURIComponent(iccid)}`)
      if (msisdn) filters.push(`msisdn=eq.${encodeURIComponent(msisdn)}`)
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
      if (operatorId) filters.push(`operator_id=eq.${encodeURIComponent(operatorId)}`)

      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data } = await supabase.selectWithCount(
        'sims',
        `select=sim_id,iccid,primary_imsi,msisdn,status,apn,activation_date,bound_imei,activation_code,supplier_id,operator_id,enterprise_id,department_id,form_factor,upstream_status,upstream_status_updated_at,created_at,suppliers(name),operators(name,business_operators(name,mcc,mnc))&order=iccid.asc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []

      const enterpriseIds = Array.from(new Set(rows.map((r) => r.enterprise_id).filter(Boolean).map((v) => String(v))))
      const departmentIds = Array.from(new Set(rows.map((r) => r.department_id).filter(Boolean).map((v) => String(v))))
      const tenantIds = Array.from(new Set([...enterpriseIds, ...departmentIds]))
      let tenantNameMap = new Map()
      let tenantParentMap = new Map()
      let resellerNameMap = new Map()

      if (tenantIds.length) {
        const tRows = await supabase.select('tenants', `select=tenant_id,name,parent_id&tenant_id=in.(${tenantIds.map((id) => encodeURIComponent(id)).join(',')})`)
        const tRowsArr = Array.isArray(tRows) ? tRows : []
        tenantNameMap = new Map(tRowsArr.map((t) => [String(t.tenant_id), t.name ?? null]))
        tenantParentMap = new Map(tRowsArr.map((t) => [String(t.tenant_id), t.parent_id ? String(t.parent_id) : null]))
        
        const resellerIds = Array.from(new Set(tRowsArr.map((t) => t.parent_id).filter(Boolean).map((v) => String(v))))
        if (resellerIds.length) {
          const rRows = await supabase.select('tenants', `select=tenant_id,name&tenant_id=in.(${resellerIds.map((id) => encodeURIComponent(id)).join(',')})`)
          resellerNameMap = new Map((Array.isArray(rRows) ? rRows : []).map((t) => [String(t.tenant_id), t.name ?? null]))
        }
      }

      const headers = [
        'simId',
        'iccid',
        'imsi',
        'msisdn',
        'status',
        'lifecycleSubStatus',
        'upstreamStatus',
        'upstreamStatusUpdatedAt',
        'formFactor',
        'activationCode',
        ...(includeSensitive ? ['supplierId', 'supplierName', 'operatorId', 'operatorName', 'mcc', 'mnc'] : []),
        'apn',
        ...(includeSensitive ? ['resellerId', 'resellerName'] : []),
        'enterpriseId',
        'enterpriseName',
        'departmentId',
        'departmentName',
        'activationDate',
        'totalUsageBytes',
        'imei',
      ]

      const csvRows = [headers.map(escapeCsv).join(',')]
      for (const r of rows) {
        csvRows.push([
          escapeCsv(r.sim_id ?? ''),
          escapeCsv(r.iccid ?? ''),
          escapeCsv(r.primary_imsi ?? ''),
          escapeCsv(r.msisdn ?? ''),
          escapeCsv(r.status ?? ''),
          escapeCsv(''),
          escapeCsv(r.upstream_status ?? ''),
          escapeCsv(toIsoDateTime(r.upstream_status_updated_at) ?? ''),
          escapeCsv(r.form_factor ?? ''),
          escapeCsv(r.activation_code ?? ''),
          ...(includeSensitive ? [
            escapeCsv(r.supplier_id ?? ''),
            escapeCsv(r.suppliers?.name ?? ''),
            escapeCsv(r.operator_id ?? ''),
            escapeCsv(r.operators?.business_operators?.name ?? r.operators?.name ?? ''),
            escapeCsv(r.operators?.business_operators?.mcc ?? ''),
            escapeCsv(r.operators?.business_operators?.mnc ?? ''),
          ] : []),
          escapeCsv(r.apn ?? ''),
          ...(includeSensitive ? [
            escapeCsv(r.enterprise_id ? tenantParentMap.get(String(r.enterprise_id)) ?? '' : ''),
            escapeCsv((r.enterprise_id && tenantParentMap.get(String(r.enterprise_id))) ? resellerNameMap.get(tenantParentMap.get(String(r.enterprise_id))) ?? '' : ''),
          ] : []),
          escapeCsv(r.enterprise_id ?? ''),
          escapeCsv(r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? '' : ''),
          escapeCsv(r.department_id ?? ''),
          escapeCsv(r.department_id ? tenantNameMap.get(String(r.department_id)) ?? '' : ''),
          escapeCsv(toIsoDateTime(r.activation_date) ?? ''),
          escapeCsv(''),
          escapeCsv(r.bound_imei ?? ''),
        ].join(','))
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="sims.csv"')
      {
        const filterPairs = []
        if (iccid) filterPairs.push(`iccid=${iccid}`)
        if (msisdn) filterPairs.push(`msisdn=${msisdn}`)
        if (status) filterPairs.push(`status=${status}`)
        if (supplierId) filterPairs.push(`supplierId=${supplierId}`)
        if (operatorId) filterPairs.push(`operatorId=${operatorId}`)
        if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
        if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
        if (resellerId) filterPairs.push(`resellerId=${resellerId}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.send(`${csvRows.join('\n')}\n`)
    }

    app.get(`${prefix}/sims:csv`, simCsvHandler)
    app.get(`${prefix}/enterprises/:enterpriseId/sims:csv`, simCsvHandler)

    app.get(`${prefix}/sims/:iccid`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return

      const tenantQs = buildSimTenantFilter(req, enterpriseId)
      const rows = await supabase.select(
        'sims',
        `select=iccid,primary_imsi,msisdn,status,apn,activation_date,bound_imei&iccid=eq.${encodeURIComponent(iccid)}${tenantQs}&limit=1`
      )
      const r = Array.isArray(rows) ? rows[0] : null
      if (!r) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `The requested SIM card with ICCID ${iccid} was not found.`)
      }

      res.json({
        iccid: r.iccid,
        imsi: r.primary_imsi,
        msisdn: r.msisdn,
        status: r.status,
        apn: r.apn,
        planName: null,
        activationDate: toIsoDateTime(r.activation_date),
        imeiLocked: Boolean(r.bound_imei),
      })
    })

    const simAllowedTransitions = {
      INVENTORY:   new Set(['TEST_READY', 'ACTIVATED']),
      TEST_READY:  new Set(['ACTIVATED', 'DEACTIVATED']),
      ACTIVATED:   new Set(['DEACTIVATED']),
      DEACTIVATED: new Set(['ACTIVATED', 'RETIRED']),
      RETIRED:     new Set(),
    }
    const simValidStatuses = new Set(['INVENTORY', 'TEST_READY', 'ACTIVATED', 'DEACTIVATED', 'RETIRED'])

    app.patch(`${prefix}/sims/:iccid`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const { status, reason } = req.body ?? {}
      if (!status || !simValidStatuses.has(status)) {
        return sendError(res, 400, 'BAD_REQUEST', `status is required and must be one of: ${[...simValidStatuses].join(', ')}.`)
      }

      const enterpriseId = getEnterpriseIdFromReq(req)
      const tenantQs = buildSimTenantFilter(req, enterpriseId)

      const existingRows = await supabase.select(
        'sims',
        `select=sim_id,status,enterprise_id,supplier_id&iccid=eq.${encodeURIComponent(iccid)}${tenantQs}&limit=1`
      )
      const existing = Array.isArray(existingRows) ? existingRows[0] : null
      if (!existing) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
      }

      if (existing.status === status) {
        return sendError(res, 409, 'ALREADY_IN_STATUS', `SIM is already ${status}.`)
      }
      const allowed = simAllowedTransitions[existing.status]
      if (!allowed || !allowed.has(status)) {
        return sendError(res, 409, 'INVALID_TRANSITION', `Cannot transition from ${existing.status} to ${status}.`)
      }
      if ((status === 'DEACTIVATED' || status === 'RETIRED') && !reason) {
        return sendError(res, 400, 'BAD_REQUEST', 'reason is required for DEACTIVATED or RETIRED transitions.')
      }

      const jobs = await supabase.insert('jobs', {
        job_type: 'SIM_STATUS_CHANGE',
        status: 'QUEUED',
        progress_processed: 0,
        progress_total: 1,
      })
      const jobId = Array.isArray(jobs) ? jobs[0]?.job_id : null

      const nowIso = new Date().toISOString()
      const updatePayload = { status, last_status_change_at: nowIso }
      if (status === 'ACTIVATED' && !existing.activation_date) {
        updatePayload.activation_date = nowIso
      }
      await supabase.update('sims', `sim_id=eq.${encodeURIComponent(existing.sim_id)}`, updatePayload, { returning: 'minimal' })
      await supabase.insert('sim_state_history', {
        sim_id: existing.sim_id,
        before_status: existing.status,
        after_status: status,
        start_time: nowIso,
        source: 'API_STATUS_CHANGE',
        request_id: getTraceId(res),
      }, { returning: 'minimal' })
      await supabase.insert('events', {
        event_type: 'SIM_STATUS_CHANGED',
        occurred_at: nowIso,
        tenant_id: existing.enterprise_id ?? null,
        request_id: getTraceId(res),
        payload: {
          iccid,
          beforeStatus: existing.status,
          afterStatus: status,
          reason: reason || 'API_STATUS_CHANGE',
        },
      }, { returning: 'minimal' })
      await pushSimStatusToUpstream({ iccid, status, traceId: getTraceId(res), supplierId: existing?.supplier_id ?? null })

      if (jobId) {
        await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
          status: 'SUCCEEDED',
          progress_processed: 1,
          progress_total: 1,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        })
      }

      res.json({
        jobId: jobId ?? 'unknown',
        status: 'PENDING',
      })
    })

    app.put(`${prefix}/sims/:iccid/plan`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (!(await ensureDepartmentSimAccess(req, res, supabase, iccid, enterpriseId))) return
      const { newPlanCode, effectiveDate } = req.body ?? {}
      if (!newPlanCode) {
        return sendError(res, 400, 'BAD_REQUEST', 'newPlanCode is required.')
      }
      const packageVersionId = String(newPlanCode || '').trim()
      if (!isValidUuid(packageVersionId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'newPlanCode must be a valid uuid.')
      }
      const tenantFilter = buildSimTenantFilter(req, enterpriseId)
      const simRows = await supabase.select(
        'sims',
        `select=sim_id,iccid,enterprise_id,supplier_id,status&iccid=eq.${encodeURIComponent(iccid)}${tenantFilter}&limit=1`
      )
      const sim = Array.isArray(simRows) ? simRows[0] : null
      if (!sim) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
      }
      const resolvedEnterpriseId = enterpriseId || (sim.enterprise_id ? String(sim.enterprise_id) : null)
      if (!resolvedEnterpriseId || !isValidUuid(resolvedEnterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
      }
      if (!sim.supplier_id) {
        return sendError(res, 409, 'MISSING_SUPPLIER', 'SIM supplier is not assigned.')
      }
      const mappingRows = await supabase.select(
        'vendor_product_mappings',
        `select=external_product_id,provisioning_parameters&supplier_id=eq.${encodeURIComponent(sim.supplier_id)}&package_version_id=eq.${encodeURIComponent(packageVersionId)}&limit=1`
      )
      const mapping = Array.isArray(mappingRows) ? mappingRows[0] : null
      if (!mapping?.external_product_id) {
        return sendError(res, 404, 'VENDOR_PRODUCT_MAPPING_NOT_FOUND', 'Vendor product mapping not found.')
      }

      const jobs = await supabase.insert('jobs', {
        job_type: 'SIM_PLAN_CHANGE',
        status: 'QUEUED',
        progress_processed: 0,
        progress_total: 1,
      })
      const jobId = Array.isArray(jobs) ? jobs[0]?.job_id : null
      const jobStartedAt = new Date().toISOString()
      if (jobId) {
        await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
          status: 'RUNNING',
          started_at: jobStartedAt,
        })
      }

      const eff = effectiveDate === 'IMMEDIATE' ? new Date() : firstDayNextMonthUtc()
      let provisioningResult = null
      let adapter
      try {
        adapter = createSupplierAdapter({ supplierId: sim.supplier_id })
      } catch {
        if (jobId) {
          await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
            status: 'FAILED',
            progress_processed: 1,
            progress_total: 1,
            finished_at: new Date().toISOString(),
            error_summary: 'Supplier adapter not found.',
            started_at: jobStartedAt,
          })
        }
        return sendError(res, 404, 'SUPPLIER_ADAPTER_NOT_FOUND', 'Supplier adapter not found.')
      }
      const strategy = negotiateChangePlanStrategy({ adapter, effectiveAt: eff })
      if (strategy.mode === 'UPSTREAM') {
        const result = await adapter.changePlan({
          iccid,
          externalProductId: String(mapping.external_product_id),
          effectiveAt: eff,
          idempotencyKey: traceId
            ? `${traceId}:${iccid}:PLAN:${packageVersionId}`
            : `sim:${iccid}:plan:${Date.now()}`,
        })
        provisioningResult = result
        if (!result?.ok) {
          if (jobId) {
            await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
              status: 'FAILED',
              progress_processed: 1,
              progress_total: 1,
              finished_at: new Date().toISOString(),
              error_summary: result?.message || 'Upstream plan change failed.',
              started_at: jobStartedAt,
            })
          }
          return sendError(res, 502, 'UPSTREAM_ERROR', result?.message || 'Upstream plan change failed.')
        }
      }

      const switchResult = await switchSubscription({
        supabase,
        enterpriseId: resolvedEnterpriseId,
        iccid,
        newPackageVersionId: packageVersionId,
        effectiveStrategy: effectiveDate,
        tenantFilter,
      })
      if (!switchResult.ok) {
        if (jobId) {
          await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
            status: 'FAILED',
            progress_processed: 1,
            progress_total: 1,
            finished_at: new Date().toISOString(),
            error_summary: switchResult.message || 'Subscription switch failed.',
            started_at: jobStartedAt,
          })
        }
        return sendError(res, switchResult.status, switchResult.code, switchResult.message)
      }
      const afterState = effectiveDate === 'IMMEDIATE' ? 'ACTIVE' : 'PENDING'
      const effectiveAt = switchResult.value?.effectiveAt ?? eff.toISOString()
      await emitEvent({
        eventType: 'SUBSCRIPTION_CHANGED',
        tenantId: resolvedEnterpriseId,
        requestId: traceId,
        jobId,
        payload: {
          subscriptionId: switchResult.value?.newSubscriptionId ?? null,
          simId: sim.sim_id,
          packageVersionId,
          beforeState: 'ACTIVE',
          afterState,
          effectiveAt,
          fromSubscriptionId: switchResult.value?.cancelledSubscriptionId ?? null,
        },
      })
      await supabase.insert('audit_logs', {
        actor_role: 'ENTERPRISE',
        tenant_id: resolvedEnterpriseId,
        action: 'SUBSCRIPTION_SWITCH',
        target_type: 'SUBSCRIPTION',
        target_id: switchResult.value?.newSubscriptionId ?? 'unknown',
        request_id: traceId,
        source_ip: req.ip,
        after_data: {
          iccid,
          fromSubscriptionId: switchResult.value?.cancelledSubscriptionId ?? null,
          toPackageVersionId: packageVersionId,
          effectiveAt,
        },
      }, { returning: 'minimal' })
      await pushPlanChangeToWebhook({
        iccid,
        simId: sim.sim_id,
        enterpriseId: resolvedEnterpriseId,
        subscriptionId: switchResult.value?.newSubscriptionId ?? null,
        packageVersionId,
        effectiveAt,
        strategy: strategy.mode,
        vendorRequestId: provisioningResult?.vendorRequestId ?? null,
        traceId,
        jobId,
      })

      if (jobId) {
        await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
          status: 'SUCCEEDED',
          progress_processed: 1,
          progress_total: 1,
          started_at: jobStartedAt,
          finished_at: new Date().toISOString(),
        })
      }

      res.json({
        success: true,
        effectiveDate: eff.toISOString(),
      })
    })

    app.get(`${prefix}/sims/:iccid/usage`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = enterpriseId ? createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) }) : createSupabaseRestClient({ traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      if (!(await ensureDepartmentSimAccess(req, res, supabase, iccid, enterpriseId))) return
      const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : null
      const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : null

      if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return sendError(res, 400, 'BAD_REQUEST', 'startDate and endDate are required and must be valid date-time.')
      }

      const { page, pageSize, offset } = parsePagination(req.query ?? {}, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 1000 })

      const startDay = startOfDayUtc(startDate)
      const endDay = startOfDayUtc(endDate)
      const tenantFilter = enterpriseId ? `&enterprise_id=eq.${encodeURIComponent(enterpriseId)}` : ''
      const baseFilter = `iccid=eq.${encodeURIComponent(iccid)}${tenantFilter}&usage_day=gte.${encodeURIComponent(startDay.toISOString().slice(0, 10))}&usage_day=lte.${encodeURIComponent(endDay.toISOString().slice(0, 10))}`
      const { data, total } = await supabase.selectWithCount(
        'usage_daily_summary',
        `select=usage_day,uplink_kb,downlink_kb,total_kb,created_at&${baseFilter}&order=usage_day.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
      )

      const rawRows = Array.isArray(data) ? data : []
      const items = rawRows.map((r) => {
        const day = new Date(`${r.usage_day}T00:00:00.000Z`)
        const next = addDaysUtc(day, 1)
        return {
          periodStart: day.toISOString(),
          periodEnd: next.toISOString(),
          uplinkBytes: Number(r.uplink_kb ?? 0) * 1024,
          downlinkBytes: Number(r.downlink_kb ?? 0) * 1024,
          totalBytes: Number(r.total_kb ?? 0) * 1024,
          sessionCount: 0,
        }
      })

      res.json({
        items,
        page,
        pageSize,
        total: typeof total === 'number' ? total : items.length,
      })
    })

    app.get(`${prefix}/sims/:iccid/balance`, async (req, res) => {
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const simRows = await supabase.select(
        'sims',
        `select=sim_id,iccid,enterprise_id,department_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
      const sim = Array.isArray(simRows) ? simRows[0] : null
      if (!sim) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
      }
      const roleScope = getRoleScope(req)
      const auth = getAuthContext(req)
      if (roleScope === 'customer' || roleScope === 'department') {
        if (!enterpriseId || String(sim.enterprise_id || '') !== String(enterpriseId)) {
          return sendError(res, 403, 'FORBIDDEN', 'Sim is out of tenant scope.')
        }
        if (roleScope === 'department') {
          const departmentId = getDepartmentIdFromReq(req)
          if (sim.department_id && String(sim.department_id) !== String(departmentId)) {
            return sendError(res, 403, 'FORBIDDEN', 'Sim is out of tenant scope.')
          }
        }
      } else if (roleScope === 'reseller') {
        const resellerId = auth.resellerId
        if (!resellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        }
        const entRows = await supabase.select(
          'tenants',
          `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(sim.enterprise_id)}&limit=1`
        )
        const ent = Array.isArray(entRows) ? entRows[0] : null
        if (!ent || String(ent.parent_id || '') !== String(resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'Sim is out of reseller scope.')
        }
      } else if (roleScope !== 'platform') {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      const balanceRows = await supabase.select(
        'sim_balance_snapshots',
        `select=currency,account_balance,data_balance_bytes,sms_balance_count,updated_at&iccid=eq.${encodeURIComponent(iccid)}&order=updated_at.desc&limit=1`
      )
      const balance = Array.isArray(balanceRows) ? balanceRows[0] : null
      res.json({
        currency: balance?.currency ?? 'USD',
        accountBalance: Number(balance?.account_balance ?? 0),
        dataBalanceBytes: Number(balance?.data_balance_bytes ?? 0),
        smsBalanceCount: Number(balance?.sms_balance_count ?? 0),
        updatedAt: balance?.updated_at ?? null,
      })
    })

    app.get(`${prefix}/sims/:iccid/subscriptions`, async (req, res) => {
      const auth = ensureSubscriptionAccess(req, res)
      if (!auth) return
      const parsed = parseSimIdentifier(req.params.iccid)
      if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
      const roleScope = getRoleScope(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const query = req.query ?? {}
      let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
      if (roleScope === 'reseller') {
        if (enterpriseId && isValidUuid(enterpriseId)) {
          enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
          if (!enterpriseId) return
        } else if (!enterpriseId) {
          const idField = parsed.field === 'sim_id' ? 'sim_id' : 'iccid'
          const simRows = await supabase.select(
            'sims',
            `select=enterprise_id&${idField}=eq.${encodeURIComponent(parsed.value)}&limit=1`
          )
          const sim = Array.isArray(simRows) ? simRows[0] : null
          if (!sim || !sim.enterprise_id) {
            return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${parsed.value} not found.`)
          }
          enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, String(sim.enterprise_id))
          if (!enterpriseId) return
        } else {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
      } else if (roleScope === 'platform') {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
        if (enterpriseId && !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        if (!enterpriseId) {
          const idField = parsed.field === 'sim_id' ? 'sim_id' : 'iccid'
          const simRows = await supabase.select(
            'sims',
            `select=enterprise_id&${idField}=eq.${encodeURIComponent(parsed.value)}&limit=1`
          )
          const sim = Array.isArray(simRows) ? simRows[0] : null
          if (!sim || !sim.enterprise_id) {
            return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${parsed.value} not found.`)
          }
          enterpriseId = String(sim.enterprise_id)
        }
      } else {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = fromReq ? String(fromReq) : null
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
        }
      }
      const result = await listSimSubscriptions({
        supabase,
        enterpriseId,
        simIdentifier: { field: parsed.field, value: parsed.value },
        tenantFilter: buildSimTenantFilter(req, enterpriseId),
        state: query.state,
        kind: query.kind,
        page: query.page,
        pageSize: query.pageSize,
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      {
        const filterPairs = []
        if (query.state) filterPairs.push(`state=${query.state}`)
        if (query.kind) filterPairs.push(`kind=${query.kind}`)
        if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
        filterPairs.push(`page=${result.value.page}`)
        filterPairs.push(`pageSize=${result.value.pageSize}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json(result.value)
    })

    app.get(`${prefix}/subscriptions`, async (req, res) => {
      const auth = ensureSubscriptionAccess(req, res)
      if (!auth) return
      const query = req.query ?? {}
      const roleScope = getRoleScope(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
      if (roleScope === 'reseller') {
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
        if (!enterpriseId) return
      } else if (roleScope === 'platform') {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
        if (enterpriseId && !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        if (!enterpriseId) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required for list subscriptions.')
        }
      } else {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = fromReq ? String(fromReq) : null
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
        }
        const queryEnterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
        if (queryEnterpriseId && queryEnterpriseId !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'enterpriseId in query must match your token scope.')
        }
      }
      const result = await listSubscriptions({
        supabase,
        enterpriseId,
        iccid: query.iccid,
        state: query.state,
        kind: query.kind,
        page: query.page,
        pageSize: query.pageSize,
        tenantFilter: buildSimTenantFilter(req, enterpriseId),
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      {
        const filterPairs = []
        if (query.enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
        if (query.iccid) filterPairs.push(`iccid=${query.iccid}`)
        if (query.state) filterPairs.push(`state=${query.state}`)
        if (query.kind) filterPairs.push(`kind=${query.kind}`)
        filterPairs.push(`page=${result.value.page}`)
        filterPairs.push(`pageSize=${result.value.pageSize}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json(result.value)
    })

    app.get(`${prefix}/subscriptions/:subscriptionId`, async (req, res) => {
      const auth = ensureSubscriptionAccess(req, res)
      if (!auth) return
      const subscriptionId = req.params.subscriptionId
      const roleScope = getRoleScope(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      let enterpriseId = null
      if (roleScope === 'reseller') {
        const queryEnterpriseId = req.query.enterpriseId ? String(req.query.enterpriseId).trim() : null
        if (!queryEnterpriseId || !isValidUuid(queryEnterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, queryEnterpriseId)
        if (!enterpriseId) return
      } else if (roleScope === 'platform') {
        enterpriseId = getEnterpriseIdFromReq(req) || (req.query.enterpriseId ? String(req.query.enterpriseId).trim() : null)
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
        }
      } else {
        enterpriseId = getEnterpriseIdFromReq(req)
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
        }
        const queryEnterpriseId = req.query.enterpriseId ? String(req.query.enterpriseId).trim() : null
        if (queryEnterpriseId && queryEnterpriseId !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'enterpriseId in query must match your token scope.')
        }
      }
      const result = await getSubscription({ supabase, enterpriseId, subscriptionId })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      res.json(result.value)
    })

    app.post(`${prefix}/subscriptions`, async (req, res) => {
      const auth = ensureSubscriptionAccess(req, res)
      if (!auth) return
      const body = req.body ?? {}
      const roleScope = getRoleScope(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      let enterpriseId = body.enterpriseId ? String(body.enterpriseId).trim() : null
      if (roleScope === 'reseller') {
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
        if (!enterpriseId) return
      } else if (roleScope === 'platform') {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
      } else {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = fromReq ? String(fromReq) : null
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
        }
        const bodyEnterpriseId = body.enterpriseId ? String(body.enterpriseId).trim() : null
        if (bodyEnterpriseId && bodyEnterpriseId !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'enterpriseId in body must match your token scope.')
        }
      }
      const result = await createSubscription({
        supabase,
        enterpriseId,
        iccid: body.iccid,
        packageVersionId: body.packageVersionId,
        kind: body.kind,
        effectiveAt: body.effectiveAt,
        tenantFilter: buildSimTenantFilter(req, enterpriseId),
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      {
        const nowIso = new Date().toISOString()
        const actorUserId = req?.cmpAuth?.userId
        const actorUserIdValue = actorUserId && isValidUuid(actorUserId) ? String(actorUserId) : null
        const payload = {
          subscriptionId: result.value.subscriptionId,
          iccid: body.iccid ? String(body.iccid) : null,
          packageVersionId: body.packageVersionId ? String(body.packageVersionId) : null,
          kind: body.kind ? String(body.kind) : 'MAIN',
          beforeState: null,
          afterState: result.value.state,
          effectiveAt: result.value.effectiveAt,
          expiresAt: result.value.expiresAt,
          commitmentEndAt: result.value.commitmentEndAt,
        }
        try {
          await supabase.insert('events', {
            event_type: 'SUBSCRIPTION_CHANGED',
            occurred_at: nowIso,
            tenant_id: enterpriseId ?? null,
            request_id: getTraceId(res),
            payload,
          }, { returning: 'minimal' })
          await supabase.insert('audit_logs', {
            actor_user_id: actorUserIdValue,
            actor_role: req?.cmpAuth?.role ?? req?.cmpAuth?.roleScope ?? null,
            tenant_id: enterpriseId ?? null,
            action: 'SUBSCRIPTION_CREATE',
            target_type: 'SUBSCRIPTION',
            target_id: result.value.subscriptionId,
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: payload,
          }, { returning: 'minimal' })
        } catch {}
      }
      res.status(201).json(result.value)
    })

    app.post(`${prefix}/subscriptions\\:switch`, async (req, res) => {
      const auth = ensureSubscriptionAccess(req, res)
      if (!auth) return
      const body = req.body ?? {}
      const roleScope = getRoleScope(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      let enterpriseId = body.enterpriseId ? String(body.enterpriseId).trim() : null
      if (roleScope === 'reseller') {
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
        if (!enterpriseId) return
      } else if (roleScope === 'platform') {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
      } else {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = fromReq ? String(fromReq) : null
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
        }
        const bodyEnterpriseId = body.enterpriseId ? String(body.enterpriseId).trim() : null
        if (bodyEnterpriseId && bodyEnterpriseId !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'enterpriseId in body must match your token scope.')
        }
      }
      const newPackageVersionId = body.toPackageVersionId ?? body.newPackageVersionId
      const result = await switchSubscription({
        supabase,
        enterpriseId,
        iccid: body.iccid,
        fromSubscriptionId: body.fromSubscriptionId,
        newPackageVersionId,
        effectiveStrategy: body.effectiveStrategy,
        tenantFilter: buildSimTenantFilter(req, enterpriseId),
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      {
        const nowIso = new Date().toISOString()
        const strategy = String(body.effectiveStrategy || '').toUpperCase() === 'IMMEDIATE' ? 'IMMEDIATE' : 'NEXT_CYCLE'
        const actorUserId = req?.cmpAuth?.userId
        const actorUserIdValue = actorUserId && isValidUuid(actorUserId) ? String(actorUserId) : null
        const payload = {
          subscriptionId: result.value.newSubscriptionId,
          iccid: body.iccid ? String(body.iccid) : null,
          fromPackageVersionId: null,
          toPackageVersionId: newPackageVersionId ? String(newPackageVersionId) : null,
          beforeState: null,
          afterState: strategy === 'IMMEDIATE' ? 'ACTIVE' : 'PENDING',
          effectiveAt: result.value.effectiveAt,
        }
        try {
          await supabase.insert('events', {
            event_type: 'SUBSCRIPTION_CHANGED',
            occurred_at: nowIso,
            tenant_id: enterpriseId ?? null,
            request_id: getTraceId(res),
            payload,
          }, { returning: 'minimal' })
          await supabase.insert('audit_logs', {
            actor_user_id: actorUserIdValue,
            actor_role: req?.cmpAuth?.role ?? req?.cmpAuth?.roleScope ?? null,
            tenant_id: enterpriseId ?? null,
            action: 'SUBSCRIPTION_SWITCH',
            target_type: 'SUBSCRIPTION',
            target_id: result.value.newSubscriptionId,
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: payload,
          }, { returning: 'minimal' })
        } catch {}
      }
      res.json(result.value)
    })

    app.post(`${prefix}/subscriptions/:subscriptionId\\:cancel`, async (req, res) => {
      const auth = ensureSubscriptionAccess(req, res)
      if (!auth) return
      const roleScope = getRoleScope(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const body = req.body ?? {}
      const query = req.query ?? {}
      let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
      if (!enterpriseId && body.enterpriseId) enterpriseId = String(body.enterpriseId).trim()
      if (roleScope === 'reseller') {
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
        if (!enterpriseId) return
      } else if (roleScope === 'platform') {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
      } else {
        const fromReq = getEnterpriseIdFromReq(req)
        enterpriseId = fromReq ? String(fromReq) : null
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
        }
        const providedEnterpriseId = (query.enterpriseId ? String(query.enterpriseId).trim() : null) || (body.enterpriseId ? String(body.enterpriseId).trim() : null)
        if (providedEnterpriseId && providedEnterpriseId !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'enterpriseId must match your token scope.')
        }
      }
      const immediate = body.immediate !== undefined && body.immediate !== null ? body.immediate : query.immediate
      const result = await cancelSubscription({
        supabase,
        enterpriseId,
        subscriptionId: req.params.subscriptionId,
        immediate,
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      {
        const nowIso = new Date().toISOString()
        const actorUserId = req?.cmpAuth?.userId
        const actorUserIdValue = actorUserId && isValidUuid(actorUserId) ? String(actorUserId) : null
        const payload = {
          subscriptionId: result.value.subscriptionId,
          beforeState: null,
          afterState: result.value.state,
          scheduled: result.value.scheduled ?? false,
          expiresAt: result.value.expiresAt ?? null,
          scheduledExecuteAt: result.value.scheduledExecuteAt ?? null,
        }
        try {
          await supabase.insert('events', {
            event_type: 'SUBSCRIPTION_CHANGED',
            occurred_at: nowIso,
            tenant_id: enterpriseId ?? null,
            request_id: getTraceId(res),
            payload,
          }, { returning: 'minimal' })
          await supabase.insert('audit_logs', {
            actor_user_id: actorUserIdValue,
            actor_role: req?.cmpAuth?.role ?? req?.cmpAuth?.roleScope ?? null,
            tenant_id: enterpriseId ?? null,
            action: result.value.scheduled ? 'SUBSCRIPTION_CANCEL_SCHEDULED' : 'SUBSCRIPTION_CANCEL',
            target_type: 'SUBSCRIPTION',
            target_id: result.value.subscriptionId,
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: payload,
          }, { returning: 'minimal' })
        } catch {}
      }
      res.json(result.value)
    })
    app.get(`${prefix}/sims/:iccid/connectivity-status`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = enterpriseId ? createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) }) : createSupabaseRestClient({ traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      if (!(await ensureDepartmentSimAccess(req, res, supabase, iccid, enterpriseId))) return
      const wxClient = createWxzhonggengClient()
      let result
      try {
        result = await getConnectivityStatus({ supabase, wxClient, iccid, enterpriseId })
      } catch {
        result = await getConnectivityStatus({ supabase, wxClient: null, iccid, enterpriseId })
      }
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      res.json(result.value)
    })

    app.post(`${prefix}/sims/:iccid\\:reset-connection`, async (req, res) => {
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      if (!(await ensureDepartmentSimAccess(req, res, supabase, iccid, enterpriseId))) return
      const body = req.body ?? {}
      const actorUserId = req?.cmpAuth?.userId
      const actorUserIdValue = actorUserId && isValidUuid(actorUserId) ? String(actorUserId) : null
      const result = await requestResetConnection({
        supabase,
        iccid,
        enterpriseId,
        resellerId: req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null,
        actorUserId: actorUserIdValue,
        traceId: getTraceId(res),
        reason: body.reason ? String(body.reason) : null,
        idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      res.status(202).json({
        jobId: result.value.jobId,
        simId: result.value.simId ?? null,
        message: 'Connection reset request submitted',
      })
    })

    app.get(`${prefix}/sims/:iccid/location`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = enterpriseId ? createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) }) : createSupabaseRestClient({ traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      if (!(await ensureDepartmentSimAccess(req, res, supabase, iccid, enterpriseId))) return
      const wxClient = createWxzhonggengClient()
      let result
      try {
        result = await getLocation({ supabase, wxClient, iccid, enterpriseId })
      } catch {
        result = await getLocation({ supabase, wxClient: null, iccid, enterpriseId })
      }
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      res.json(result.value)
    })

    app.get(`${prefix}/sims/:iccid/location-history`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      const supabase = enterpriseId ? createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) }) : createSupabaseRestClient({ traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      if (!(await ensureDepartmentSimAccess(req, res, supabase, iccid, enterpriseId))) return
      const fromRaw = req.query.from ?? req.query.startDate
      const toRaw = req.query.to ?? req.query.endDate
      const fromDate = fromRaw ? new Date(String(fromRaw)) : null
      const toDate = toRaw ? new Date(String(toRaw)) : null
      if (!fromDate || !toDate || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return sendError(res, 400, 'BAD_REQUEST', 'from and to are required and must be valid date-time.')
      }
      const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 50, maxPageSize: 1000 })
      const result = await getLocationHistory({
        supabase,
        wxClient: null,
        iccid,
        enterpriseId,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        limit: pageSize,
        offset,
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      {
        const filterPairs = []
        filterPairs.push(`from=${fromDate.toISOString()}`)
        filterPairs.push(`to=${toDate.toISOString()}`)
        filterPairs.push(`pageSize=${pageSize}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json({
        items: result.value.items,
        total: result.value.total,
        page,
        pageSize,
      })
    })

    app.get(`${prefix}/alerts`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const query = req.query ?? {}
      const enterpriseIdParam = query.enterpriseId ? String(query.enterpriseId) : null
      const scope = await resolveReportScope(req, res, supabase, enterpriseIdParam)
      if (!scope) return
      let acknowledged = null
      if (query.acknowledged !== undefined) {
        const v = String(query.acknowledged).toLowerCase()
        if (v === 'true' || v === '1' || v === 'yes') acknowledged = true
        else if (v === 'false' || v === '0' || v === 'no') acknowledged = false
        else return sendError(res, 400, 'BAD_REQUEST', 'acknowledged must be true or false.')
      }
      const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 50, maxPageSize: 1000 })
      const result = await listAlerts({
        supabase,
        resellerId: scope.resellerId ?? null,
        enterpriseId: scope.enterpriseId ?? null,
        alertType: query.alertType ? String(query.alertType) : null,
        from: query.from ? String(query.from) : null,
        to: query.to ? String(query.to) : null,
        acknowledged,
        limit: pageSize,
        offset,
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      {
        const filterPairs = []
        if (enterpriseIdParam) filterPairs.push(`enterpriseId=${enterpriseIdParam}`)
        if (query.alertType) filterPairs.push(`alertType=${String(query.alertType)}`)
        if (query.from) filterPairs.push(`from=${String(query.from)}`)
        if (query.to) filterPairs.push(`to=${String(query.to)}`)
        if (query.acknowledged !== undefined) filterPairs.push(`acknowledged=${String(query.acknowledged)}`)
        filterPairs.push(`pageSize=${pageSize}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json({
        items: result.value.items,
        total: result.value.total,
        page,
        pageSize,
      })
    })

    app.post(`${prefix}/alerts/:alertId\\:acknowledge`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const alertId = String(req.params.alertId || '').trim()
      if (!alertId) return sendError(res, 400, 'BAD_REQUEST', 'alertId is required.')
      const roleScope = getRoleScope(req)
      const resellerId = req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null
      const actorUserId = req?.cmpAuth?.userId
      const actorUserIdValue = actorUserId && isValidUuid(actorUserId) ? String(actorUserId) : null
      if (roleScope === 'reseller' && !resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      if (roleScope !== 'platform' && roleScope !== 'reseller') {
        const enterpriseId = getEnterpriseIdFromReq(req)
        if (!enterpriseId || !isValidUuid(enterpriseId)) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
        }
        const rows = await supabase.select(
          'alerts',
          `select=alert_id&alert_id=eq.${encodeURIComponent(alertId)}&customer_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
        )
        const existing = Array.isArray(rows) ? rows[0] : null
        if (!existing) return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'alert not found.')
      }
      const result = await acknowledgeAlert({
        supabase,
        alertId,
        resellerId: roleScope === 'reseller' ? resellerId : null,
        actorUserId: actorUserIdValue,
      })
      if (!result.ok) return sendError(res, result.status, result.code, result.message)
      res.json(result.value)
    })

    app.get(`${prefix}/reports/usage-trend`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const query = req.query ?? {}
      const enterpriseIdParam = query.enterpriseId ? String(query.enterpriseId) : null
      const scope = await resolveReportScope(req, res, supabase, enterpriseIdParam)
      if (!scope) return
      const period = parseReportPeriod(query.period)
      if (!period) return sendError(res, 400, 'BAD_REQUEST', 'period is invalid.')
      const granularity = normalizeReportGranularity(query.granularity)
      const startDay = period.startDay.toISOString().slice(0, 10)
      const endDay = period.endDay.toISOString().slice(0, 10)
      const filters = [
        `usage_day=gte.${encodeURIComponent(startDay)}`,
        `usage_day=lte.${encodeURIComponent(endDay)}`,
      ]
      if (scope.enterpriseId) {
        filters.push(`enterprise_id=eq.${encodeURIComponent(scope.enterpriseId)}`)
      } else if (scope.enterpriseIds) {
        if (!scope.enterpriseIds.length) {
          return res.json({ granularity, startDate: startDay, endDate: endDay, items: [] })
        }
        const list = scope.enterpriseIds.map((v) => encodeURIComponent(String(v))).join(',')
        filters.push(`enterprise_id=in.(${list})`)
      }
      const rows = await supabase.select(
        'usage_daily_summary',
        `select=usage_day,total_kb&${filters.join('&')}&order=usage_day.asc&limit=10000`
      )
      const data = Array.isArray(rows) ? rows : []
      const bucket = new Map()
      for (const r of data) {
        const day = r?.usage_day ? String(r.usage_day).slice(0, 10) : null
        if (!day) continue
        const key = granularity === 'month' ? day.slice(0, 7) : day
        const current = bucket.get(key) || 0
        bucket.set(key, current + Number(r?.total_kb ?? 0))
      }
      const items = Array.from(bucket.entries())
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([periodKey, totalKb]) => ({ period: periodKey, totalKb: Number(totalKb.toFixed(2)) }))
      res.json({
        granularity,
        startDate: startDay,
        endDate: endDay,
        items,
      })
    })

    app.get(`${prefix}/reports/top-sims`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const query = req.query ?? {}
      const enterpriseIdParam = query.enterpriseId ? String(query.enterpriseId) : null
      const scope = await resolveReportScope(req, res, supabase, enterpriseIdParam)
      if (!scope) return
      const period = parseReportPeriod(query.period)
      if (!period) return sendError(res, 400, 'BAD_REQUEST', 'period is invalid.')
      const limitRaw = query.limit ?? query.pageSize ?? query.page
      const limitValue = Number.isFinite(Number(limitRaw)) ? Math.min(100, Math.max(1, Number(limitRaw))) : 10
      const startDay = period.startDay.toISOString().slice(0, 10)
      const endDay = period.endDay.toISOString().slice(0, 10)
      const filters = [
        `usage_day=gte.${encodeURIComponent(startDay)}`,
        `usage_day=lte.${encodeURIComponent(endDay)}`,
      ]
      if (scope.enterpriseId) {
        filters.push(`enterprise_id=eq.${encodeURIComponent(scope.enterpriseId)}`)
      } else if (scope.enterpriseIds) {
        if (!scope.enterpriseIds.length) {
          return res.json({ startDate: startDay, endDate: endDay, items: [] })
        }
        const list = scope.enterpriseIds.map((v) => encodeURIComponent(String(v))).join(',')
        filters.push(`enterprise_id=in.(${list})`)
      }
      const rows = await supabase.select(
        'usage_daily_summary',
        `select=iccid,total_kb&${filters.join('&')}&limit=50000`
      )
      const data = Array.isArray(rows) ? rows : []
      const totals = new Map()
      for (const r of data) {
        const iccid = r?.iccid ? String(r.iccid) : null
        if (!iccid) continue
        const current = totals.get(iccid) || 0
        totals.set(iccid, current + Number(r?.total_kb ?? 0))
      }
      const items = Array.from(totals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limitValue)
        .map(([iccid, totalKb]) => ({ iccid, totalKb: Number(totalKb.toFixed(2)) }))
      res.json({
        startDate: startDay,
        endDate: endDay,
        items,
      })
    })

    app.get(`${prefix}/reports/anomaly-sims`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const query = req.query ?? {}
      const enterpriseIdParam = query.enterpriseId ? String(query.enterpriseId) : null
      const scope = await resolveReportScope(req, res, supabase, enterpriseIdParam)
      if (!scope) return
      const period = parseReportPeriod(query.period)
      if (!period) return sendError(res, 400, 'BAD_REQUEST', 'period is invalid.')
      const startIso = period.startDay.toISOString()
      const endIso = new Date(period.endDay.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString()
      const filters = [
        `window_start=gte.${encodeURIComponent(startIso)}`,
        `window_start=lte.${encodeURIComponent(endIso)}`,
      ]
      if (scope.enterpriseId) {
        filters.push(`customer_id=eq.${encodeURIComponent(scope.enterpriseId)}`)
      } else if (scope.resellerId) {
        filters.push(`reseller_id=eq.${encodeURIComponent(scope.resellerId)}`)
      }
      const rows = await supabase.select(
        'alerts',
        `select=alert_id,alert_type,severity,status,sim_id,window_start,last_seen_at,created_at,sims(iccid)&order=window_start.desc&limit=1000&${filters.join('&')}`
      )
      const data = Array.isArray(rows) ? rows : []
      const map = new Map()
      for (const r of data) {
        const simId = r?.sim_id ? String(r.sim_id) : null
        if (!simId) continue
        const current = map.get(simId) || {
          simId,
          iccid: r?.sims?.iccid ?? null,
          alertCount: 0,
          latestAlertType: null,
          latestSeverity: null,
          latestStatus: null,
          lastSeenAt: null,
        }
        current.alertCount += 1
        const lastSeen = r?.last_seen_at ?? r?.window_start ?? r?.created_at ?? null
        if (!current.lastSeenAt || (lastSeen && new Date(lastSeen).getTime() > new Date(current.lastSeenAt).getTime())) {
          current.lastSeenAt = lastSeen ? new Date(lastSeen).toISOString() : current.lastSeenAt
          current.latestAlertType = r?.alert_type ?? current.latestAlertType
          current.latestSeverity = r?.severity ?? current.latestSeverity
          current.latestStatus = r?.status ?? current.latestStatus
        }
        map.set(simId, current)
      }
      const items = Array.from(map.values()).sort((a, b) => b.alertCount - a.alertCount)
      res.json({
        startDate: period.startDay.toISOString().slice(0, 10),
        endDate: period.endDay.toISOString().slice(0, 10),
        items,
        total: items.length,
      })
    })

    app.get(`${prefix}/reports/deactivation-reasons`, async (req, res) => {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const query = req.query ?? {}
      const enterpriseIdParam = query.enterpriseId ? String(query.enterpriseId) : null
      const scope = await resolveReportScope(req, res, supabase, enterpriseIdParam)
      if (!scope) return
      const period = parseReportPeriod(query.period)
      if (!period) return sendError(res, 400, 'BAD_REQUEST', 'period is invalid.')
      const startIso = period.startDay.toISOString()
      const endIso = new Date(period.endDay.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString()
      const enterpriseIds = scope.enterpriseId ? [scope.enterpriseId] : scope.enterpriseIds
      if (enterpriseIds && !enterpriseIds.length) {
        return res.json({ startDate: period.startDay.toISOString().slice(0, 10), endDate: period.endDay.toISOString().slice(0, 10), items: [] })
      }
      let sims = []
      if (enterpriseIds) {
        const list = enterpriseIds.map((v) => encodeURIComponent(String(v))).join(',')
        const rows = await supabase.select(
          'sims',
          `select=sim_id,enterprise_id&enterprise_id=in.(${list})&limit=10000`
        )
        sims = Array.isArray(rows) ? rows : []
      } else if (scope.enterpriseId) {
        const rows = await supabase.select(
          'sims',
          `select=sim_id,enterprise_id&enterprise_id=eq.${encodeURIComponent(scope.enterpriseId)}&limit=10000`
        )
        sims = Array.isArray(rows) ? rows : []
      } else {
        const rows = await supabase.select(
          'sims',
          `select=sim_id,enterprise_id&limit=10000`
        )
        sims = Array.isArray(rows) ? rows : []
      }
      const simIds = sims.map((s) => s?.sim_id).filter(Boolean).map((v) => String(v))
      if (!simIds.length) {
        return res.json({ startDate: period.startDay.toISOString().slice(0, 10), endDate: period.endDay.toISOString().slice(0, 10), items: [] })
      }
      const reasonCounts = new Map()
      const chunks = chunkArray(simIds, 200)
      for (const chunk of chunks) {
        const list = chunk.map((v) => encodeURIComponent(String(v))).join(',')
        const rows = await supabase.select(
          'sim_state_history',
          `select=source,sim_id,start_time&after_status=eq.DEACTIVATED&sim_id=in.(${list})&start_time=gte.${encodeURIComponent(startIso)}&start_time=lte.${encodeURIComponent(endIso)}&limit=1000`
        )
        const data = Array.isArray(rows) ? rows : []
        for (const r of data) {
          const source = r?.source ? String(r.source) : 'UNKNOWN'
          reasonCounts.set(source, (reasonCounts.get(source) || 0) + 1)
        }
      }
      const items = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count }))
      res.json({
        startDate: period.startDay.toISOString().slice(0, 10),
        endDate: period.endDay.toISOString().slice(0, 10),
        items,
      })
    })
  }

  function mountAdminRoutes(prefix) {
    app.get(`${prefix}/admin/api-clients`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseId = req.query.enterpriseId ? String(req.query.enterpriseId) : null
      const status = req.query.status ? String(req.query.status) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 50, maxPageSize: 1000 })

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
        `select=client_id,enterprise_id,status,created_at,rotated_at${orderQs}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )

      const rows = Array.isArray(data) ? data : []
      {
        const filterPairs = []
        if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
        if (status) filterPairs.push(`status=${status}`)
        if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
        if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
        filterPairs.push(`pageSize=${pageSize}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json({
        items: rows.map((r) => ({
          clientId: r.client_id,
          enterpriseId: r.enterprise_id,
          status: r.status,
          createdAt: r.created_at,
          rotatedAt: r.rotated_at,
        })),
        total: typeof total === 'number' ? total : rows.length,
      })
    })

    app.get(`${prefix}/admin/api-clients:csv`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseId = req.query.enterpriseId ? String(req.query.enterpriseId) : null
      const status = req.query.status ? String(req.query.status) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))

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
        `select=client_id,enterprise_id,status,created_at,rotated_at${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []
      const headers = ['clientId', 'enterpriseId', 'status', 'createdAt', 'rotatedAt']
      const csvRows = [headers.map(escapeCsv).join(',')]
      for (const r of rows) {
        csvRows.push([
          escapeCsv(r.client_id),
          escapeCsv(r.enterprise_id ?? ''),
          escapeCsv(r.status),
          escapeCsv(r.created_at ?? ''),
          escapeCsv(r.rotated_at ?? ''),
        ].join(','))
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="api_clients.csv"')
      {
        const filterPairs = []
        if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
        if (status) filterPairs.push(`status=${status}`)
        if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
        if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.send(`${csvRows.join('\n')}\n`)
    })
    app.post(`${prefix}/admin/api-clients/:clientId\\:rotate`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const clientId = String(req.params.clientId)
      const newClientSecret = (req.body?.clientSecret ? String(req.body.clientSecret) : null) ?? randomClientSecret()

      const rows = await supabase.select(
        'api_clients',
        `select=client_id,status&client_id=eq.${encodeURIComponent(clientId)}&limit=1`
      )
      const row = Array.isArray(rows) ? rows[0] : null
      if (!row) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `api_client ${clientId} not found.`)
      }

      const secretHash = hashSecretScrypt(newClientSecret)
      await supabase.update('api_clients', `client_id=eq.${encodeURIComponent(clientId)}`, {
        secret_hash: secretHash,
        rotated_at: new Date().toISOString(),
        status: 'ACTIVE',
      }, { returning: 'minimal' })
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        action: 'ADMIN_API_CLIENT_ROTATE',
        target_type: 'API_CLIENT',
        target_id: clientId,
        request_id: getTraceId(res),
        source_ip: req.ip,
      }, { returning: 'minimal' })

      res.json({
        clientId,
        clientSecret: newClientSecret,
      })
    })

    app.post(`${prefix}/admin/api-clients/:clientId\\:deactivate`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const clientId = String(req.params.clientId)

      const rows = await supabase.select(
        'api_clients',
        `select=client_id,status&client_id=eq.${encodeURIComponent(clientId)}&limit=1`
      )
      const row = Array.isArray(rows) ? rows[0] : null
      if (!row) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `api_client ${clientId} not found.`)
      }

      await supabase.update('api_clients', `client_id=eq.${encodeURIComponent(clientId)}`, {
        status: 'INACTIVE',
      }, { returning: 'minimal' })
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        action: 'ADMIN_API_CLIENT_DEACTIVATE',
        target_type: 'API_CLIENT',
        target_id: clientId,
        request_id: getTraceId(res),
        source_ip: req.ip,
      }, { returning: 'minimal' })

      res.json({
        clientId,
        status: 'INACTIVE',
      })
    })

    app.post(`${prefix}/admin/sims/:iccid\\:assign-test`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const rows = await supabase.select(
        'sims',
        `select=sim_id,iccid,status,enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
      const sim = Array.isArray(rows) ? rows[0] : null
      if (!sim) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
      }
      const nowIso = new Date().toISOString()
      await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
        status: 'TEST_READY',
        last_status_change_at: nowIso,
      }, { returning: 'minimal' })
      await supabase.insert('sim_state_history', {
        sim_id: sim.sim_id,
        before_status: sim.status,
        after_status: 'TEST_READY',
        start_time: nowIso,
        source: 'ADMIN_ASSIGN_TEST',
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
          afterStatus: 'TEST_READY',
          reason: 'ADMIN_ASSIGN_TEST',
        },
      }, { returning: 'minimal' })
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: sim.enterprise_id ?? null,
        action: 'ADMIN_ASSIGN_TEST',
        target_type: 'SIM',
        target_id: iccid,
        request_id: getTraceId(res),
        source_ip: req.ip,
      }, { returning: 'minimal' })
      res.json({ success: true })
    })
    app.post(`${prefix}/admin/sims/:iccid\\:reset-inventory`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const rows = await supabase.select(
        'sims',
        `select=sim_id,iccid,status,enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
      const sim = Array.isArray(rows) ? rows[0] : null
      if (!sim) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
      }
      const nowIso = new Date().toISOString()
      await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
        status: 'INVENTORY',
        last_status_change_at: nowIso,
      }, { returning: 'minimal' })
      await supabase.insert('sim_state_history', {
        sim_id: sim.sim_id,
        before_status: sim.status,
        after_status: 'INVENTORY',
        start_time: nowIso,
        source: 'ADMIN_RESET_INVENTORY',
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
          afterStatus: 'INVENTORY',
          reason: 'ADMIN_RESET_INVENTORY',
        },
      }, { returning: 'minimal' })
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: sim.enterprise_id ?? null,
        action: 'ADMIN_RESET_INVENTORY',
        target_type: 'SIM',
        target_id: iccid,
        request_id: getTraceId(res),
        source_ip: req.ip,
      }, { returning: 'minimal' })
      res.json({ success: true })
    })
    app.post(`${prefix}/admin/sims/:iccid\\:reset-activated`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const rows = await supabase.select(
        'sims',
        `select=sim_id,iccid,status,enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
      const sim = Array.isArray(rows) ? rows[0] : null
      if (!sim) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
      }
      const nowIso = new Date().toISOString()
      await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
        status: 'ACTIVATED',
        last_status_change_at: nowIso,
      }, { returning: 'minimal' })
      await supabase.insert('sim_state_history', {
        sim_id: sim.sim_id,
        before_status: sim.status,
        after_status: 'ACTIVATED',
        start_time: nowIso,
        source: 'ADMIN_RESET_ACTIVATED',
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
          afterStatus: 'ACTIVATED',
          reason: 'ADMIN_RESET_ACTIVATED',
        },
      }, { returning: 'minimal' })
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: sim.enterprise_id ?? null,
        action: 'ADMIN_RESET_ACTIVATED',
        target_type: 'SIM',
        target_id: iccid,
        request_id: getTraceId(res),
        source_ip: req.ip,
      }, { returning: 'minimal' })
      res.json({ success: true })
    })
    app.post(`${prefix}/admin/sims/:iccid\\:retire`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const rows = await supabase.select(
        'sims',
        `select=sim_id,iccid,status,enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
      const sim = Array.isArray(rows) ? rows[0] : null
      if (!sim) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
      }
      if (sim.status !== 'DEACTIVATED') {
        return sendError(res, 400, 'INVALID_STATE', 'SIM must be DEACTIVATED before retire.')
      }
      const subs = await supabase.select(
        'subscriptions',
        `select=commitment_end_at,effective_at&sim_id=eq.${encodeURIComponent(sim.sim_id)}`
      )
      let thresholdIso = null
      if (Array.isArray(subs)) {
        for (const s of subs) {
          const c = s?.commitment_end_at ? new Date(s.commitment_end_at).toISOString() : null
          if (c && (!thresholdIso || new Date(c).getTime() > new Date(thresholdIso).getTime())) {
            thresholdIso = c
          }
        }
      }
      if (thresholdIso && Date.now() <= new Date(thresholdIso).getTime()) {
        return sendError(res, 400, 'COMMITMENT_NOT_MET', `Retire blocked until ${thresholdIso}.`)
      }
      const nowIso = new Date().toISOString()
      await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
        status: 'RETIRED',
        last_status_change_at: nowIso,
      }, { returning: 'minimal' })
      await supabase.insert('sim_state_history', {
        sim_id: sim.sim_id,
        before_status: sim.status,
        after_status: 'RETIRED',
        start_time: nowIso,
        source: 'ADMIN_RETIRE',
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
          afterStatus: 'RETIRED',
          reason: 'ADMIN_RETIRE',
          commitmentCheckUntil: thresholdIso ?? null,
        },
      }, { returning: 'minimal' })
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: sim.enterprise_id ?? null,
        action: 'ADMIN_RETIRE',
        target_type: 'SIM',
        target_id: iccid,
        request_id: getTraceId(res),
        source_ip: req.ip,
      }, { returning: 'minimal' })
      res.json({ success: true })
    })
    app.post(`${prefix}/admin/sims/:iccid\\:seed-usage`, async (req, res) => {
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

    app.post(`${prefix}/admin/sims\\:evaluate-test-expiry`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseId = req.query.enterpriseId ? String(req.query.enterpriseId) : null
      const filters = [`status=eq.TEST_READY`]
      if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      const { data } = await supabase.selectWithCount(
        'sims',
        `select=sim_id,iccid,enterprise_id,status,last_status_change_at&${filters.join('&')}&order=last_status_change_at.asc`
      )
      const sims = Array.isArray(data) ? data : []
      const cond = getTestExpiryCondition()
      const periodDays = getTestPeriodDays()
      const quotaMbLimit = getTestQuotaMb()
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
          for (const r of usageRows) {
            totalKb += Number(r.total_kb ?? 0)
          }
        }
        const expireByQuota = quotaMbLimit > 0 ? totalKb >= quotaMbLimit : false
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
            quotaMbLimit,
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

    app.post(`${prefix}/admin/sims/:iccid\\:backdate-test-start`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      const daysBack = req.body?.daysBack ? Number(req.body.daysBack) : 1
      const d = Number.isFinite(daysBack) && daysBack > 0 ? daysBack : 1
      const rows = await supabase.select(
        'sims',
        `select=sim_id,iccid,status,enterprise_id,last_status_change_at&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
      const sim = Array.isArray(rows) ? rows[0] : null
      if (!sim) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
      }
      const backIso = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
      await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
        status: 'TEST_READY',
        last_status_change_at: backIso,
      }, { returning: 'minimal' })
      const histRows = await supabase.select(
        'sim_state_history',
        `select=history_id,start_time&sim_id=eq.${encodeURIComponent(sim.sim_id)}&after_status=eq.TEST_READY&order=start_time.desc&limit=1`
      )
      const hist = Array.isArray(histRows) ? histRows[0] : null
      if (hist?.history_id) {
        await supabase.update('sim_state_history', `history_id=eq.${encodeURIComponent(hist.history_id)}`, {
          start_time: backIso,
        }, { returning: 'minimal' })
      } else {
        await supabase.insert('sim_state_history', {
          sim_id: sim.sim_id,
          after_status: 'TEST_READY',
          start_time: backIso,
          source: 'ADMIN_BACKDATE',
          request_id: getTraceId(res),
        }, { returning: 'minimal' })
      }
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: sim.enterprise_id ?? null,
        action: 'ADMIN_BACKDATE_TEST_START',
        target_type: 'SIM',
        target_id: iccid,
        request_id: getTraceId(res),
        source_ip: req.ip,
        after_data: { daysBack: d, newStart: backIso },
      }, { returning: 'minimal' })
      res.json({ success: true, newStart: backIso })
    })

    app.post(`${prefix}/admin/wx/sims:query-info`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const iccid = requireIccid(res, req.body?.iccid)
      if (!iccid) return
      try {
        const data = await client.getSimStatus(iccid)
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_INFO',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_INFO',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.post(`${prefix}/admin/wx/sims:query-info-batch`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const iccids = requireIccidList(res, req.body?.iccids)
      if (!iccids) return
      try {
        const data = await client.getSimInfoBatch(iccids)
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_INFO_BATCH',
          target_type: 'SIM_BATCH',
          target_id: String(iccids.length),
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { count: iccids.length },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_INFO_BATCH',
          target_type: 'SIM_BATCH',
          target_id: String(iccids.length),
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { count: iccids.length, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.post(`${prefix}/admin/wx/sims:sync`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const pageSize = req.body?.pageSize ? Number(req.body.pageSize) : 50
      const pageIndex = req.body?.pageIndex ? Number(req.body.pageIndex) : 1
      const status = req.body?.status ? String(req.body.status) : null
      if (!Number.isFinite(pageSize) || pageSize <= 0 || !Number.isFinite(pageIndex) || pageIndex <= 0) {
        return sendError(res, 400, 'BAD_REQUEST', 'pageSize and pageIndex must be positive numbers.')
      }
      try {
        const data = await client.getSimInfoSync(pageSize, pageIndex, status)
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_SYNC_INFO',
          target_type: 'SIM_BATCH',
          target_id: `${pageIndex}/${pageSize}`,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { pageSize, pageIndex, status },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_SYNC_INFO',
          target_type: 'SIM_BATCH',
          target_id: `${pageIndex}/${pageSize}`,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { pageSize, pageIndex, status, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.post(`${prefix}/admin/wx/sims:query-status`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const iccid = requireIccid(res, req.body?.iccid)
      if (!iccid) return
      try {
        const upstream = await client.getSimCardStatus(iccid)
        const base = upstream && typeof upstream === 'object' ? upstream : {}
        const success = base.success ?? true
        const payload = Array.isArray(base.data) ? { items: base.data } : (base.data && typeof base.data === 'object' ? base.data : {})
        if (!payload.iccid && !payload.imsi) {
          payload.iccid = iccid
        }
        const data = { ...base, success, data: payload }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_STATUS',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_STATUS',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.get(`${prefix}/admin/wx/sims/:iccid/status`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const iccid = requireIccid(res, req.params.iccid)
      if (!iccid) return
      try {
        const upstream = await client.getSimCardStatus(iccid)
        const base = upstream && typeof upstream === 'object' ? upstream : {}
        const success = base.success ?? true
        const payload = Array.isArray(base.data) ? { items: base.data } : (base.data && typeof base.data === 'object' ? base.data : {})
        if (!payload.iccid && !payload.imsi) {
          payload.iccid = iccid
        }
        const data = { ...base, success, data: payload }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_STATUS',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_STATUS',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.post(`${prefix}/admin/wx/sims:query-status-batch`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const iccids = requireIccidList(res, req.body?.iccids)
      if (!iccids) return
      try {
        const upstream = await client.getSimStatusBatch(iccids)
        const base = upstream && typeof upstream === 'object' ? upstream : {}
        const payload = Array.isArray(base.data) ? base.data : (Array.isArray(base.list) ? base.list : [])
        const data = { ...base, data: payload }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_STATUS_BATCH',
          target_type: 'SIM_BATCH',
          target_id: String(iccids.length),
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { count: iccids.length },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_STATUS_BATCH',
          target_type: 'SIM_BATCH',
          target_id: String(iccids.length),
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { count: iccids.length, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.post(`${prefix}/admin/wx/sims:query-flow`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const iccid = requireIccid(res, req.body?.iccid)
      if (!iccid) return
      try {
        const upstream = await client.getSimFlow(iccid)
        const base = upstream && typeof upstream === 'object' ? upstream : {}
        const success = base.success ?? true
        let payload = Array.isArray(base.data) ? base.data.find((item) => String(item?.iccid || '') === iccid) : base.data
        if (!payload && Array.isArray(base.list)) {
          payload = base.list.find((item) => String(item?.iccid || '') === iccid)
        }
        payload = payload && typeof payload === 'object' ? payload : {}
        if (!payload.iccid) payload.iccid = iccid
        if (payload.totalFlow === undefined) {
          const used = Number(payload.usedFlow ?? 0)
          const residual = Number(payload.residualFlow ?? 0)
          payload.totalFlow = Number.isNaN(used + residual) ? 0 : used + residual
        }
        if (payload.usedFlow === undefined) payload.usedFlow = 0
        if (payload.residualFlow === undefined) payload.residualFlow = 0
        const data = { ...base, success, data: payload }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_FLOW',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        const msg = String(err?.message || '')
        const isConfigError = msg.includes('missing_') || msg.includes('not configured')
        if (isConfigError) {
          const data = {
            success: false,
            data: {
              iccid,
              totalFlow: 0,
              usedFlow: 0,
              residualFlow: 0,
            },
            message: msg || 'wxzhonggeng not configured',
          }
          await supabase.insert('audit_logs', {
            actor_role: 'ADMIN',
            tenant_id: null,
            action: 'ADMIN_WX_QUERY_FLOW',
            target_type: 'SIM',
            target_id: iccid,
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: { iccid, fallback: true, error: msg || 'not_configured' },
          }, { returning: 'minimal' })
          return res.json(data)
        }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_FLOW',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.post(`${prefix}/admin/wx/sims:query-flow-batch`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const iccids = requireIccidList(res, req.body?.iccids)
      if (!iccids) return
      try {
        const upstream = await client.getSimFlowsBatch(iccids)
        const base = upstream && typeof upstream === 'object' ? upstream : {}
        const payload = Array.isArray(base.data) ? base.data : (Array.isArray(base.list) ? base.list : [])
        const data = { ...base, data: payload }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_FLOW_BATCH',
          target_type: 'SIM_BATCH',
          target_id: String(iccids.length),
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { count: iccids.length },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        const msg = String(err?.message || '')
        const isConfigError = msg.includes('missing_') || msg.includes('not configured')
        if (isConfigError) {
          const data = { success: false, data: [], message: msg || 'wxzhonggeng not configured' }
          await supabase.insert('audit_logs', {
            actor_role: 'ADMIN',
            tenant_id: null,
            action: 'ADMIN_WX_QUERY_FLOW_BATCH',
            target_type: 'SIM_BATCH',
            target_id: String(iccids.length),
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: { count: iccids.length, fallback: true, error: msg || 'not_configured' },
          }, { returning: 'minimal' })
          return res.json(data)
        }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_FLOW_BATCH',
          target_type: 'SIM_BATCH',
          target_id: String(iccids.length),
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { count: iccids.length, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.post(`${prefix}/admin/wx/sims:query-usage-month`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const month = req.body?.month ? String(req.body.month) : ''
      if (!month) {
        return sendError(res, 400, 'BAD_REQUEST', 'month and iccids are required.')
      }
      const iccids = requireIccidList(res, req.body?.iccids)
      if (!iccids) return
      try {
        const data = await client.getUsageByMonth(month, iccids)
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_USAGE_MONTH',
          target_type: 'SIM_BATCH',
          target_id: String(iccids.length),
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { month, count: iccids.length },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_QUERY_USAGE_MONTH',
          target_type: 'SIM_BATCH',
          target_id: String(iccids.length),
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { month, count: iccids.length, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.post(`${prefix}/admin/wx/sims:update-status`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const iccid = requireIccid(res, req.body?.iccid)
      const operation = req.body?.operation ? String(req.body.operation) : ''
      if (!iccid) return
      if (!operation) return sendError(res, 400, 'BAD_REQUEST', 'operation is required.')
      try {
        const data = await client.updateCardStatus(iccid, operation)
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_UPDATE_STATUS',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid, operation },
        }, { returning: 'minimal' })
        res.json(data ?? null)
      } catch (err) {
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: null,
          action: 'ADMIN_WX_UPDATE_STATUS',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { iccid, operation, error: err?.message ?? 'upstream_error' },
        }, { returning: 'minimal' })
        return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'WXZHONGGENG request failed.')
      }
    })

    app.get(`${prefix}/admin/audits`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const tenantId = req.query.tenantId ? String(req.query.tenantId) : null
      const action = req.query.action ? String(req.query.action) : null
      const targetType = req.query.targetType ? String(req.query.targetType) : null
      const targetId = req.query.targetId ? String(req.query.targetId) : null
      const requestId = req.query.requestId ? String(req.query.requestId) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const start = req.query.start ? new Date(String(req.query.start)) : null
      const end = req.query.end ? new Date(String(req.query.end)) : null
      const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 50, maxPageSize: 1000 })
      const filters = []
      if (tenantId) filters.push(`tenant_id=eq.${encodeURIComponent(tenantId)}`)
      if (action) filters.push(`action=eq.${encodeURIComponent(action)}`)
      if (targetType) filters.push(`target_type=eq.${encodeURIComponent(targetType)}`)
      if (targetId) filters.push(`target_id=eq.${encodeURIComponent(targetId)}`)
      if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
      if (start && !Number.isNaN(start.getTime())) filters.push(`created_at=gte.${encodeURIComponent(start.toISOString())}`)
      if (end && !Number.isNaN(end.getTime())) filters.push(`created_at=lte.${encodeURIComponent(end.toISOString())}`)
      const orderField = sortBy && ['createdat', 'created_at'].includes(sortBy.toLowerCase()) ? 'created_at' : 'created_at'
      const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
      const orderQs = `&order=${orderField}.${orderDir}`
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data, total } = await supabase.selectWithCount(
        'audit_logs',
        `select=audit_id,actor_user_id,actor_role,tenant_id,action,target_type,target_id,request_id,created_at,before_data,after_data${orderQs}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []
      {
        const filterPairs = []
        if (tenantId) filterPairs.push(`tenantId=${tenantId}`)
        if (action) filterPairs.push(`action=${action}`)
        if (targetType) filterPairs.push(`targetType=${targetType}`)
        if (targetId) filterPairs.push(`targetId=${targetId}`)
        if (requestId) filterPairs.push(`requestId=${requestId}`)
        if (start && !Number.isNaN(start.getTime())) filterPairs.push(`start=${start.toISOString()}`)
        if (end && !Number.isNaN(end.getTime())) filterPairs.push(`end=${end.toISOString()}`)
        if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
        if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
        filterPairs.push(`pageSize=${pageSize}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json({
        items: rows.map((r) => ({
          auditId: r.audit_id,
          actorUserId: r.actor_user_id ?? null,
          actorRole: r.actor_role,
          tenantId: r.tenant_id ?? null,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id,
          requestId: r.request_id,
          createdAt: r.created_at,
          beforeData: r.before_data ?? null,
          afterData: r.after_data ?? null,
        })),
        total: typeof total === 'number' ? total : rows.length,
      })
    })

    app.get(`${prefix}/admin/audits:csv`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const tenantId = req.query.tenantId ? String(req.query.tenantId) : null
      const action = req.query.action ? String(req.query.action) : null
      const targetType = req.query.targetType ? String(req.query.targetType) : null
      const targetId = req.query.targetId ? String(req.query.targetId) : null
      const requestId = req.query.requestId ? String(req.query.requestId) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const start = req.query.start ? new Date(String(req.query.start)) : null
      const end = req.query.end ? new Date(String(req.query.end)) : null
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const filters = []
      if (tenantId) filters.push(`tenant_id=eq.${encodeURIComponent(tenantId)}`)
      if (action) filters.push(`action=eq.${encodeURIComponent(action)}`)
      if (targetType) filters.push(`target_type=eq.${encodeURIComponent(targetType)}`)
      if (targetId) filters.push(`target_id=eq.${encodeURIComponent(targetId)}`)
      if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
      if (start && !Number.isNaN(start.getTime())) filters.push(`created_at=gte.${encodeURIComponent(start.toISOString())}`)
      if (end && !Number.isNaN(end.getTime())) filters.push(`created_at=lte.${encodeURIComponent(end.toISOString())}`)
      const orderField = sortBy && ['createdat', 'created_at'].includes(sortBy.toLowerCase()) ? 'created_at' : 'created_at'
      const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
      const orderQs = `&order=${orderField}.${orderDir}`
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data } = await supabase.selectWithCount(
        'audit_logs',
        `select=audit_id,actor_user_id,actor_role,tenant_id,action,target_type,target_id,request_id,created_at,before_data,after_data${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []
      const headers = ['auditId', 'action', 'targetType', 'targetId', 'occurredAt', 'actor', 'tenantId', 'requestId', 'changes']
      const csvRows = [headers.map(escapeCsv).join(',')]
      for (const r of rows) {
        const actor = r.actor_user_id ?? r.actor_role ?? ''
        const changes = JSON.stringify({ before: r.before_data ?? null, after: r.after_data ?? null })
        csvRows.push([
          escapeCsv(r.audit_id),
          escapeCsv(r.action),
          escapeCsv(r.target_type),
          escapeCsv(r.target_id),
          escapeCsv(r.created_at),
          escapeCsv(actor),
          escapeCsv(r.tenant_id ?? ''),
          escapeCsv(r.request_id ?? ''),
          escapeCsv(changes),
        ].join(','))
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="audits.csv"')
      {
        const filterPairs = []
        if (tenantId) filterPairs.push(`tenantId=${tenantId}`)
        if (action) filterPairs.push(`action=${action}`)
        if (targetType) filterPairs.push(`targetType=${targetType}`)
        if (targetId) filterPairs.push(`targetId=${targetId}`)
        if (requestId) filterPairs.push(`requestId=${requestId}`)
        if (start && !Number.isNaN(start.getTime())) filterPairs.push(`start=${start.toISOString()}`)
        if (end && !Number.isNaN(end.getTime())) filterPairs.push(`end=${end.toISOString()}`)
        if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
        if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.send(`${csvRows.join('\n')}\n`)
    })

    app.get(`${prefix}/admin/audits/:auditId`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const auditId = String(req.params.auditId || '')
      if (!auditId) {
        return sendError(res, 400, 'BAD_REQUEST', 'auditId is required.')
      }
      const rows = await supabase.select(
        'audit_logs',
        `select=audit_id,actor_user_id,actor_role,tenant_id,action,target_type,target_id,request_id,created_at,source_ip,after_data&audit_id=eq.${encodeURIComponent(auditId)}&limit=1`
      )
      const r = Array.isArray(rows) ? rows[0] : null
      if (!r) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `audit ${auditId} not found.`)
      }
      res.json({
        auditId: r.audit_id,
        actorUserId: r.actor_user_id ?? null,
        actorRole: r.actor_role,
        tenantId: r.tenant_id ?? null,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        requestId: r.request_id,
        createdAt: r.created_at,
        sourceIp: r.source_ip ?? null,
        afterData: r.after_data ?? null,
      })
    })

    function sortJobsRows(rows, orderField, orderDir) {
      const direction = orderDir === 'asc' ? 1 : -1
      const resolveValue = (row) => {
        const primary = row?.[orderField]
        const candidates = [primary, row?.started_at, row?.created_at, row?.finished_at]
        for (const candidate of candidates) {
          if (!candidate) continue
          const time = new Date(candidate).getTime()
          if (!Number.isNaN(time)) return time
        }
        return 0
      }
      return rows.sort((a, b) => {
        const av = resolveValue(a)
        const bv = resolveValue(b)
        if (av === bv) return 0
        return av > bv ? direction : -direction
      })
    }
    app.get(`${prefix}/admin/jobs`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const jobType = req.query.jobType ? String(req.query.jobType) : null
      const status = req.query.status ? String(req.query.status) : null
      const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : null
      const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : null
      const requestId = req.query.requestId ? String(req.query.requestId) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const limit = req.query.limit ? Number(req.query.limit) : 50
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const filters = []
      if (jobType) filters.push(`job_type=eq.${encodeURIComponent(jobType)}`)
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
      if (startDate && !Number.isNaN(startDate.getTime())) filters.push(`started_at=gte.${encodeURIComponent(startDate.toISOString())}`)
      if (endDate && !Number.isNaN(endDate.getTime())) filters.push(`started_at=lte.${encodeURIComponent(endDate.toISOString())}`)
      const orderField = (() => {
        const s = sortBy ? sortBy.toLowerCase() : ''
        if (s === 'startedat' || s === 'started_at') return 'started_at'
        if (s === 'finishedat' || s === 'finished_at') return 'finished_at'
        return 'started_at'
      })()
      const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
      const orderQs = `&order=${orderField}.${orderDir}`
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data, total } = await supabase.selectWithCount(
        'jobs',
        `select=job_id,job_type,status,progress_processed,progress_total,started_at,finished_at,request_id${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = sortJobsRows(Array.isArray(data) ? data : [], orderField, orderDir)
      {
        const filterPairs = []
        if (jobType) filterPairs.push(`jobType=${jobType}`)
        if (status) filterPairs.push(`status=${status}`)
        if (requestId) filterPairs.push(`requestId=${requestId}`)
        if (startDate && !Number.isNaN(startDate.getTime())) filterPairs.push(`startDate=${startDate.toISOString()}`)
        if (endDate && !Number.isNaN(endDate.getTime())) filterPairs.push(`endDate=${endDate.toISOString()}`)
        if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
        if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json({
        items: rows.map((r) => ({
          jobId: r.job_id,
          jobType: r.job_type,
          status: r.status,
          progress: {
            processed: Number(r.progress_processed ?? 0),
            total: Number(r.progress_total ?? 0),
          },
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          requestId: r.request_id,
        })),
        total: typeof total === 'number' ? total : rows.length,
      })
    })

    app.get(`${prefix}/admin/jobs:csv`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const jobType = req.query.jobType ? String(req.query.jobType) : null
      const status = req.query.status ? String(req.query.status) : null
      const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : null
      const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : null
      const requestId = req.query.requestId ? String(req.query.requestId) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const filters = []
      if (jobType) filters.push(`job_type=eq.${encodeURIComponent(jobType)}`)
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
      if (startDate && !Number.isNaN(startDate.getTime())) filters.push(`started_at=gte.${encodeURIComponent(startDate.toISOString())}`)
      if (endDate && !Number.isNaN(endDate.getTime())) filters.push(`started_at=lte.${encodeURIComponent(endDate.toISOString())}`)
      const orderField = (() => {
        const s = sortBy ? sortBy.toLowerCase() : ''
        if (s === 'startedat' || s === 'started_at') return 'started_at'
        if (s === 'finishedat' || s === 'finished_at') return 'finished_at'
        return 'started_at'
      })()
      const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
      const orderQs = `&order=${orderField}.${orderDir}`
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data } = await supabase.selectWithCount(
        'jobs',
        `select=job_id,job_type,status,progress_processed,progress_total,started_at,finished_at,request_id,error_summary${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = sortJobsRows(Array.isArray(data) ? data : [], orderField, orderDir)
      const headers = ['jobId', 'jobType', 'status', 'progress', 'startedAt', 'finishedAt', 'requestId', 'error']
      const csvRows = [headers.map(escapeCsv).join(',')]
      for (const r of rows) {
        const processed = Number(r.progress_processed ?? 0)
        const total = Number(r.progress_total ?? 0)
        csvRows.push([
          escapeCsv(r.job_id),
          escapeCsv(r.job_type),
          escapeCsv(r.status),
          escapeCsv(`${processed}/${total}`),
          escapeCsv(r.started_at),
          escapeCsv(r.finished_at ?? ''),
          escapeCsv(r.request_id ?? ''),
          escapeCsv(r.error_summary ?? ''),
        ].join(','))
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="jobs.csv"')
      {
        const filterPairs = []
        if (jobType) filterPairs.push(`jobType=${jobType}`)
        if (status) filterPairs.push(`status=${status}`)
        if (requestId) filterPairs.push(`requestId=${requestId}`)
        if (startDate && !Number.isNaN(startDate.getTime())) filterPairs.push(`startDate=${startDate.toISOString()}`)
        if (endDate && !Number.isNaN(endDate.getTime())) filterPairs.push(`endDate=${endDate.toISOString()}`)
        if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
        if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.send(`${csvRows.join('\n')}\n`)
    })

    app.get(`${prefix}/admin/events`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const eventType = req.query.eventType ? String(req.query.eventType) : null
      const tenantId = req.query.tenantId ? String(req.query.tenantId) : null
      const requestId = req.query.requestId ? String(req.query.requestId) : null
      const iccid = req.query.iccid ? normalizeIccid(req.query.iccid) : null
      if (iccid && !isValidIccid(iccid)) {
        return sendError(res, 400, 'BAD_REQUEST', 'iccid must be 18-20 digits.')
      }
      const beforeStatus = req.query.beforeStatus ? String(req.query.beforeStatus) : null
      const afterStatus = req.query.afterStatus ? String(req.query.afterStatus) : null
      const reason = req.query.reason ? String(req.query.reason) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const start = req.query.start ? new Date(String(req.query.start)) : null
      const end = req.query.end ? new Date(String(req.query.end)) : null
      const limit = req.query.limit ? Number(req.query.limit) : 50
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const filters = []
      if (eventType) filters.push(`event_type=eq.${encodeURIComponent(eventType)}`)
      if (tenantId) filters.push(`tenant_id=eq.${encodeURIComponent(tenantId)}`)
      if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
      if (iccid) filters.push(`payload->>iccid=eq.${encodeURIComponent(iccid)}`)
      if (beforeStatus) filters.push(`payload->>beforeStatus=eq.${encodeURIComponent(beforeStatus)}`)
      if (afterStatus) filters.push(`payload->>afterStatus=eq.${encodeURIComponent(afterStatus)}`)
      if (reason) filters.push(`payload->>reason=eq.${encodeURIComponent(reason)}`)
      if (start && !Number.isNaN(start.getTime())) filters.push(`occurred_at=gte.${encodeURIComponent(start.toISOString())}`)
      if (end && !Number.isNaN(end.getTime())) filters.push(`occurred_at=lte.${encodeURIComponent(end.toISOString())}`)
      const orderField = sortBy && ['occurredat', 'occurred_at'].includes(sortBy.toLowerCase()) ? 'occurred_at' : 'occurred_at'
      const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
      const orderQs = `&order=${orderField}.${orderDir}`
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data, total } = await supabase.selectWithCount(
        'events',
        `select=event_id,event_type,occurred_at,tenant_id,request_id,job_id,payload${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []
      {
        const filterPairs = []
        if (eventType) filterPairs.push(`eventType=${eventType}`)
        if (tenantId) filterPairs.push(`tenantId=${tenantId}`)
        if (requestId) filterPairs.push(`requestId=${requestId}`)
        if (iccid) filterPairs.push(`iccid=${iccid}`)
        if (beforeStatus) filterPairs.push(`beforeStatus=${beforeStatus}`)
        if (afterStatus) filterPairs.push(`afterStatus=${afterStatus}`)
        if (reason) filterPairs.push(`reason=${reason}`)
        if (start && !Number.isNaN(start.getTime())) filterPairs.push(`start=${start.toISOString()}`)
        if (end && !Number.isNaN(end.getTime())) filterPairs.push(`end=${end.toISOString()}`)
        if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
        if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.json({
        items: rows.map((r) => ({
          eventId: r.event_id,
          eventType: r.event_type,
          occurredAt: r.occurred_at,
          tenantId: r.tenant_id ?? null,
          requestId: r.request_id ?? null,
          jobId: r.job_id ?? null,
          payload: r.payload ?? null,
        })),
        total: typeof total === 'number' ? total : rows.length,
      })
    })

    app.get(`${prefix}/admin/events:csv`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const eventType = req.query.eventType ? String(req.query.eventType) : null
      const tenantId = req.query.tenantId ? String(req.query.tenantId) : null
      const requestId = req.query.requestId ? String(req.query.requestId) : null
      const iccid = req.query.iccid ? normalizeIccid(req.query.iccid) : null
      if (iccid && !isValidIccid(iccid)) {
        return sendError(res, 400, 'BAD_REQUEST', 'iccid must be 18-20 digits.')
      }
      const beforeStatus = req.query.beforeStatus ? String(req.query.beforeStatus) : null
      const afterStatus = req.query.afterStatus ? String(req.query.afterStatus) : null
      const reason = req.query.reason ? String(req.query.reason) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const start = req.query.start ? new Date(String(req.query.start)) : null
      const end = req.query.end ? new Date(String(req.query.end)) : null
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const filters = []
      if (eventType) filters.push(`event_type=eq.${encodeURIComponent(eventType)}`)
      if (tenantId) filters.push(`tenant_id=eq.${encodeURIComponent(tenantId)}`)
      if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
      if (iccid) filters.push(`payload->>iccid=eq.${encodeURIComponent(iccid)}`)
      if (beforeStatus) filters.push(`payload->>beforeStatus=eq.${encodeURIComponent(beforeStatus)}`)
      if (afterStatus) filters.push(`payload->>afterStatus=eq.${encodeURIComponent(afterStatus)}`)
      if (reason) filters.push(`payload->>reason=eq.${encodeURIComponent(reason)}`)
      if (start && !Number.isNaN(start.getTime())) filters.push(`occurred_at=gte.${encodeURIComponent(start.toISOString())}`)
      if (end && !Number.isNaN(end.getTime())) filters.push(`occurred_at=lte.${encodeURIComponent(end.toISOString())}`)
      const orderField = sortBy && ['occurredat', 'occurred_at'].includes(sortBy.toLowerCase()) ? 'occurred_at' : 'occurred_at'
      const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
      const orderQs = `&order=${orderField}.${orderDir}`
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data } = await supabase.selectWithCount(
        'events',
        `select=event_id,event_type,occurred_at,tenant_id,request_id,job_id,payload${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []
      const headers = ['eventId', 'eventType', 'occurredAt', 'tenantId', 'requestId', 'jobId', 'payload']
      const csvRows = [headers.map(escapeCsv).join(',')]
      for (const r of rows) {
        csvRows.push([
          escapeCsv(r.event_id),
          escapeCsv(r.event_type),
          escapeCsv(r.occurred_at),
          escapeCsv(r.tenant_id ?? ''),
          escapeCsv(r.request_id ?? ''),
          escapeCsv(r.job_id ?? ''),
          escapeCsv(JSON.stringify(r.payload ?? {})),
        ].join(','))
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="events.csv"')
      {
        const filterPairs = []
        if (eventType) filterPairs.push(`eventType=${eventType}`)
        if (tenantId) filterPairs.push(`tenantId=${tenantId}`)
        if (requestId) filterPairs.push(`requestId=${requestId}`)
        if (iccid) filterPairs.push(`iccid=${iccid}`)
        if (beforeStatus) filterPairs.push(`beforeStatus=${beforeStatus}`)
        if (afterStatus) filterPairs.push(`afterStatus=${afterStatus}`)
        if (reason) filterPairs.push(`reason=${reason}`)
        if (start && !Number.isNaN(start.getTime())) filterPairs.push(`start=${start.toISOString()}`)
        if (end && !Number.isNaN(end.getTime())) filterPairs.push(`end=${end.toISOString()}`)
        if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
        if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        setXFilters(res, filterPairs.join(';'))
      }
      res.send(`${csvRows.join('\n')}\n`)
    })

    app.get(`${prefix}/admin/events/:eventId`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const eventId = String(req.params.eventId || '')
      if (!eventId) {
        return sendError(res, 400, 'BAD_REQUEST', 'eventId is required.')
      }
      const rows = await supabase.select(
        'events',
        `select=event_id,event_type,occurred_at,tenant_id,request_id,job_id,payload&event_id=eq.${encodeURIComponent(eventId)}&limit=1`
      )
      const r = Array.isArray(rows) ? rows[0] : null
      if (!r) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `event ${eventId} not found.`)
      }
      res.json({
        eventId: r.event_id,
        eventType: r.event_type,
        occurredAt: r.occurred_at,
        tenantId: r.tenant_id ?? null,
        requestId: r.request_id ?? null,
        jobId: r.job_id ?? null,
        payload: r.payload ?? null,
      })
    })
    app.get(`${prefix}/admin/share-links`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseId = req.query.enterpriseId ? String(req.query.enterpriseId) : null
      const kind = req.query.kind ? String(req.query.kind) : null
      const code = req.query.code ? String(req.query.code) : null
      const requestId = req.query.requestId ? String(req.query.requestId) : null
      const status = req.query.status ? String(req.query.status).toLowerCase() : null
      const expiresFromIso = req.query.expiresFrom ? toIsoDateTime(String(req.query.expiresFrom)) : null
      const expiresToIso = req.query.expiresTo ? toIsoDateTime(String(req.query.expiresTo)) : null
      const codePrefix = req.query.codePrefix ? String(req.query.codePrefix) : null
      const codeLike = req.query.codeLike ? String(req.query.codeLike) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const limit = req.query.limit ? Number(req.query.limit) : 50
      const page = req.query.page ? Number(req.query.page) : 1
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
      let data = []
      let total = 0
      try {
        const r = await supabase.selectWithCount(
          'share_links',
          `select=code,enterprise_id,kind,expires_at,created_at,request_id${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
        )
        data = Array.isArray(r.data) ? r.data : []
        total = typeof r.total === 'number' ? r.total : data.length
      } catch (err) {
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
      const filterPairs = []
      function addFilter(k, v) { if (v && String(v).trim().length > 0) filterPairs.push(k + '=' + String(v).trim()) }
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
      if (filtersSummary) setXFilters(res, filtersSummary)
      res.json({
        items: rows.map((r) => ({
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
    app.get(`${prefix}/admin/share-links:csv`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseId = req.query.enterpriseId ? String(req.query.enterpriseId) : null
      const kind = req.query.kind ? String(req.query.kind) : null
      const code = req.query.code ? String(req.query.code) : null
      const requestId = req.query.requestId ? String(req.query.requestId) : null
      const status = req.query.status ? String(req.query.status).toLowerCase() : null
      const expiresFromIso = req.query.expiresFrom ? toIsoDateTime(String(req.query.expiresFrom)) : null
      const expiresToIso = req.query.expiresTo ? toIsoDateTime(String(req.query.expiresTo)) : null
      const codePrefix = req.query.codePrefix ? String(req.query.codePrefix) : null
      const codeLike = req.query.codeLike ? String(req.query.codeLike) : null
      const sortBy = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : null
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
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
      let data = []
      try {
        const r = await supabase.selectWithCount(
          'share_links',
          `select=code,enterprise_id,kind,expires_at,created_at,request_id${orderQs}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
        )
        data = Array.isArray(r.data) ? r.data : []
      } catch (err) {
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
      const filterPairs = []
      function addFilter(k, v) { if (v && String(v).trim().length > 0) filterPairs.push(k + '=' + String(v).trim()) }
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
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="share_links.csv"')
      if (filtersSummary) setXFilters(res, filtersSummary)
      res.send(`${csvRows.join('\n')}\n`)
    })
    app.post(`${prefix}/admin/share-links/:code\\:invalidate`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const code = String(req.params.code)
      let rows = null
      try {
        rows = await supabase.select(
          'share_links',
          `select=code,enterprise_id,kind,expires_at&code=eq.${encodeURIComponent(code)}&limit=1`
        )
      } catch (err) {
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
      } catch (err) {
        const msg = typeof err?.body === 'string' ? err.body : ''
        if (String(msg).includes("Could not find the table 'public.share_links'")) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `share_link ${code} not found.`)
        }
        throw err
      }
      res.json({ code, expiresAt: nowIso, status: 'INVALIDATED' })
    })
    app.delete(`${prefix}/admin/share-links/:code`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const code = String(req.params.code)
      let rows = null
      try {
        rows = await supabase.select(
          'share_links',
          `select=code,enterprise_id,kind,expires_at&code=eq.${encodeURIComponent(code)}&limit=1`
        )
      } catch (err) {
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
      } catch (err) {
        const msg = typeof err?.body === 'string' ? err.body : ''
        if (String(msg).includes("Could not find the table 'public.share_links'")) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `share_link ${code} not found.`)
        }
        throw err
      }
      res.json({ code, deleted: true })
    })
    app.get(`${prefix}/admin/jobs/:jobId`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const jobId = String(req.params.jobId || '')
      if (!jobId) {
        return sendError(res, 400, 'BAD_REQUEST', 'jobId is required.')
      }
      const rows = await supabase.select(
        'jobs',
        `select=job_id,job_type,status,progress_processed,progress_total,started_at,finished_at,request_id&job_id=eq.${encodeURIComponent(jobId)}&limit=1`
      )
      const r = Array.isArray(rows) ? rows[0] : null
      if (!r) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `job ${jobId} not found.`)
      }
      res.json({
        jobId: r.job_id,
        jobType: r.job_type,
        status: r.status,
        progress: {
          processed: Number(r.progress_processed ?? 0),
          total: Number(r.progress_total ?? 0),
        },
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        requestId: r.request_id,
      })
    })

    app.post(`${prefix}/admin/jobs:test-ready-expiry-run`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseId = req.body?.enterpriseId ? String(req.body.enterpriseId) : null
      const pageSize = req.body?.pageSize ? Math.max(1, Number(req.body.pageSize)) : 100
      const cond = getTestExpiryCondition()
      const periodDays = getTestPeriodDays()
      const quotaMbLimit = getTestQuotaMb()
      const filters = [`status=eq.TEST_READY`]
      if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      const { total } = await supabase.selectWithCount(
        'sims',
        `select=sim_id&${filters.join('&')}`
      )
      const jobs = await supabase.insert('jobs', {
        job_type: 'TEST_READY_EXPIRY',
        status: 'RUNNING',
        progress_processed: 0,
        progress_total: Number(total ?? 0),
        started_at: new Date().toISOString(),
        request_id: getTraceId(res),
      })
      const jobId = Array.isArray(jobs) ? jobs[0]?.job_id : null
      let processed = 0
      let activated = 0
      for (let offset = 0; ; offset += pageSize) {
        const rows = await supabase.select(
          'sims',
          `select=sim_id,iccid,enterprise_id,status,last_status_change_at&${filters.join('&')}&order=last_status_change_at.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
        )
        const sims = Array.isArray(rows) ? rows : []
        if (!sims.length) break
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
          const expireByQuota = quotaMbLimit > 0 ? totalKb >= quotaMbLimit : false
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
            source: 'TEST_EXPIRY_JOB',
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
              reason: 'TEST_EXPIRY_JOB',
              expiryBy: expireByPeriod && expireByQuota ? 'PERIOD_OR_QUOTA' : expireByPeriod ? 'PERIOD' : 'QUOTA',
              totalKb,
              periodDays,
              quotaMbLimit,
              startTime: startTimeIso,
              endTime: nowIso,
            },
          }, { returning: 'minimal' })
          activated += 1
        }
        if (jobId) {
          await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
            progress_processed: processed,
            progress_total: Number(total ?? processed),
          }, { returning: 'minimal' })
        }
      }
      if (jobId) {
        await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
          status: 'SUCCEEDED',
          finished_at: new Date().toISOString(),
        }, { returning: 'minimal' })
      }
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: enterpriseId ?? null,
        action: 'ADMIN_TEST_READY_EXPIRY_RUN',
        target_type: 'SIM_BATCH',
        target_id: enterpriseId ?? 'ALL',
        request_id: getTraceId(res),
        source_ip: req.ip,
        after_data: { processed, activated, total },
      }, { returning: 'minimal' })
      res.json({ jobId, processed, activated, total })
    })
    app.post(`${prefix}/admin/jobs:wx-sync-daily-usage`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const client = createWxzhonggengClient()
      const enterpriseId = req.body?.enterpriseId ? String(req.body.enterpriseId) : null
      const startDate = req.body?.startDate ? new Date(String(req.body.startDate)) : new Date(Date.now() - 24 * 3600 * 1000)
      const endDate = req.body?.endDate ? new Date(String(req.body.endDate)) : new Date()
      const pageSize = req.body?.pageSize ? Math.max(1, Number(req.body.pageSize)) : 100
      const path = getEnvTrim('WXZHONGGENG_USAGE_DAILY_PATH') ?? '/sim-card/card/card-info/api/queryCdrFlowByDate'
      const supplierRows = await supabase.select('suppliers', `select=supplier_id&name=eq.${encodeURIComponent('WXZHONGGENG')}&limit=1`)
      const wxSupplierId = Array.isArray(supplierRows) ? supplierRows[0]?.supplier_id : null
      const filters = []
      if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      if (wxSupplierId) filters.push(`supplier_id=eq.${encodeURIComponent(wxSupplierId)}`)
      filters.push('status=eq.ACTIVATED')
      let sims = []
      let total = 0
      if (wxSupplierId) {
        const r = await supabase.selectWithCount(
          'sims',
          `select=sim_id,iccid,enterprise_id,supplier_id,apn,status&${filters.join('&')}&order=sim_id.asc`
        )
        sims = Array.isArray(r.data) ? r.data : []
        total = typeof r.total === 'number' ? r.total : sims.length
      }
      const jobs = await supabase.insert('jobs', {
        job_type: 'WX_SYNC_DAILY_USAGE',
        status: 'RUNNING',
        progress_processed: 0,
        progress_total: Number(total ?? sims.length),
        started_at: new Date().toISOString(),
        request_id: getTraceId(res),
      })
      const jobId = Array.isArray(jobs) ? jobs[0]?.job_id : null
      let processed = 0
      if (!sims.length) {
        if (jobId) {
          await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
            status: 'SUCCEEDED',
            finished_at: new Date().toISOString(),
          }, { returning: 'minimal' })
        }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: enterpriseId ?? null,
          action: 'ADMIN_WX_SYNC_DAILY_USAGE_RUN',
          target_type: 'SIM_BATCH',
          target_id: enterpriseId ?? 'ALL',
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { processed, total: sims.length, startDate: startDate.toISOString(), endDate: endDate.toISOString() },
        }, { returning: 'minimal' })
        return res.json({ jobId, processed, total: sims.length })
      }
      try {
        const ok = await client.ping()
        if (!ok) {
          if (jobId) {
            await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
              status: 'SUCCEEDED',
              finished_at: new Date().toISOString(),
            }, { returning: 'minimal' })
          }
          await supabase.insert('audit_logs', {
            actor_role: 'ADMIN',
            tenant_id: enterpriseId ?? null,
            action: 'ADMIN_WX_SYNC_DAILY_USAGE_RUN',
            target_type: 'SIM_BATCH',
            target_id: enterpriseId ?? 'ALL',
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: { processed, total: sims.length, startDate: startDate.toISOString(), endDate: endDate.toISOString() },
          }, { returning: 'minimal' })
          return res.json({ jobId, processed, total: sims.length })
        }
      } catch {
        if (jobId) {
          await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
            status: 'SUCCEEDED',
            finished_at: new Date().toISOString(),
          }, { returning: 'minimal' })
        }
        await supabase.insert('audit_logs', {
          actor_role: 'ADMIN',
          tenant_id: enterpriseId ?? null,
          action: 'ADMIN_WX_SYNC_DAILY_USAGE_RUN',
          target_type: 'SIM_BATCH',
          target_id: enterpriseId ?? 'ALL',
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { processed, total: sims.length, startDate: startDate.toISOString(), endDate: endDate.toISOString() },
        }, { returning: 'minimal' })
        return res.json({ jobId, processed, total: sims.length })
      }
      let startDay = startOfDayUtc(startDate)
      let endDay = startOfDayUtc(endDate)
      if (endDay < startDay) endDay = startDay
      const simMap = new Map(sims.map((s) => [String(s.iccid), s]))
      for (let day = startDay; day <= endDay; day = addDaysUtc(day, 1)) {
        const dateStr = day.toISOString().slice(0, 10)
        for (let offset = 0; offset < sims.length; offset += pageSize) {
          const batch = sims.slice(offset, offset + pageSize).map((s) => String(s.iccid))
          if (!batch.length) break
          let resp = null
          try {
            resp = await client.request('POST', path, {
              body: {
                iccids: batch,
                date: dateStr,
              },
            })
          } catch {
            resp = null
          }
          const rows = Array.isArray(resp?.data) ? resp.data : []
          for (const r of rows) {
            const iccid = String(r.iccid || r.msisdn || '')
            if (!iccid) continue
            const usedFlow = Number(r.usedFlow ?? r.totalFlow ?? 0)
            const totalKb = Math.max(0, Math.floor(usedFlow))
            const uplinkKb = 0
            const downlinkKb = totalKb
            const apn = r.apn ? String(r.apn) : null
            const rat = r.rat ? String(r.rat) : null
            const sim = simMap.get(iccid)
            if (!sim) continue
            const usageDay = dateStr
            const visited = String(r.visitedMccMnc || r.mccmnc || r.mccMnc || '204-08')
            const match = `iccid=eq.${encodeURIComponent(iccid)}&usage_day=eq.${encodeURIComponent(usageDay)}&visited_mccmnc=eq.${encodeURIComponent(visited)}`
            const existing = await supabase.select('usage_daily_summary', `select=usage_id&${match}&limit=1`)
            if (Array.isArray(existing) && existing.length > 0) {
              const usageId = existing[0]?.usage_id
              await supabase.update('usage_daily_summary', `usage_id=eq.${encodeURIComponent(String(usageId))}`, {
                uplink_kb: uplinkKb,
                downlink_kb: downlinkKb,
                total_kb: totalKb,
                apn: apn ?? null,
                rat: rat ?? null,
                input_ref: jobId ?? null,
                updated_at: new Date().toISOString(),
              }, { returning: 'minimal' })
            } else {
              await supabase.insert('usage_daily_summary', {
                supplier_id: sim.supplier_id,
                enterprise_id: sim.enterprise_id ?? null,
                sim_id: sim.sim_id ?? null,
                iccid,
                usage_day: usageDay,
                visited_mccmnc: visited,
                uplink_kb: uplinkKb,
                downlink_kb: downlinkKb,
                total_kb: totalKb,
                apn: apn ?? null,
                rat: rat ?? null,
                input_ref: jobId ?? null,
                updated_at: new Date().toISOString(),
              }, { returning: 'minimal' })
            }
            processed += 1
          }
          if (jobId) {
            await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
              progress_processed: processed,
              progress_total: Math.max(processed, Number(total ?? sims.length)),
            }, { returning: 'minimal' })
          }
        }
      }
      if (jobId) {
        await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
          status: 'SUCCEEDED',
          finished_at: new Date().toISOString(),
        }, { returning: 'minimal' })
      }
      await supabase.insert('audit_logs', {
        actor_role: 'ADMIN',
        tenant_id: enterpriseId ?? null,
        action: 'ADMIN_WX_SYNC_DAILY_USAGE_RUN',
        target_type: 'SIM_BATCH',
        target_id: enterpriseId ?? 'ALL',
        request_id: getTraceId(res),
        source_ip: req.ip,
        after_data: { processed, total: sims.length, startDate: startDate.toISOString(), endDate: endDate.toISOString() },
      }, { returning: 'minimal' })
      res.json({ jobId, processed, total: sims.length })
    })
    app.post(`${prefix}/admin/jobs:wx-sync-sim-info-batch`, async (req, res) => {
      let jobId = null
      let processed = 0
      let total = 0
      let enterpriseId = null
      let pageSize = 50

      try {
        if (!requireAdminApiKey(req, res)) return
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const client = createWxzhonggengClient()
        
        console.log('wx-sync-sim-info-batch: started')

        enterpriseId = req.body?.enterpriseId ? String(req.body.enterpriseId) : null
        if (enterpriseId && !isValidUuid(enterpriseId)) {
          return sendError(res, 400, 'BAD_REQUEST', 'Invalid enterpriseId.')
        }
        pageSize = req.body?.pageSize ? Math.max(1, Number(req.body.pageSize)) : 50
        
        console.log('wx-sync-sim-info-batch: selecting supplier')
        const supplierRows = await supabase.select('suppliers', `select=supplier_id&name=eq.${encodeURIComponent('WXZHONGGENG')}&limit=1`)
        const wxSupplierId = Array.isArray(supplierRows) ? supplierRows[0]?.supplier_id : null
        console.log('wx-sync-sim-info-batch: supplier found?', wxSupplierId)
        
        const filters = []
        if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
        if (wxSupplierId) filters.push(`supplier_id=eq.${encodeURIComponent(wxSupplierId)}`)
        
        if (wxSupplierId) {
          console.log('wx-sync-sim-info-batch: counting sims')
          const countResp = await supabase.selectWithCount('sims', `select=sim_id&${filters.join('&')}`)
          total = typeof countResp.total === 'number' ? countResp.total : Array.isArray(countResp.data) ? countResp.data.length : 0
          console.log('wx-sync-sim-info-batch: total sims', total)
        }

        console.log('wx-sync-sim-info-batch: inserting job')
        const jobs = await supabase.insert('jobs', {
          job_type: 'WX_SYNC_SIM_INFO_BATCH',
          status: 'RUNNING',
          progress_processed: 0,
          progress_total: Number(total ?? 0),
          started_at: new Date().toISOString(),
          request_id: getTraceId(res),
        })
        jobId = Array.isArray(jobs) ? jobs[0]?.job_id : null
        console.log('wx-sync-sim-info-batch: job created', jobId)

        if (!wxSupplierId || total === 0) {
          if (jobId) {
            await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
              status: 'SUCCEEDED',
              finished_at: new Date().toISOString(),
            }, { returning: 'minimal' })
          }
          await supabase.insert('audit_logs', {
            actor_role: 'ADMIN',
            tenant_id: enterpriseId ?? null,
            action: 'ADMIN_WX_SYNC_SIM_INFO_BATCH_RUN',
            target_type: 'SIM_BATCH',
            target_id: enterpriseId ?? 'ALL',
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: { processed, total, pageSize },
          }, { returning: 'minimal' })
          return res.json({ jobId, processed, total })
        }

        // Proceed with actual sync logic
        const ok = await client.ping()
        if (!ok) {
          if (jobId) {
            await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
              status: 'FAILED',
              finished_at: new Date().toISOString(),
              error_summary: 'upstream_ping_failed'
            }, { returning: 'minimal' })
          }
          return sendError(res, 502, 'UPSTREAM_UNAVAILABLE', 'WXZHONGGENG ping failed.')
        }

        let hasUpstreamColumns = true
        try {
          await supabase.select('sims', 'select=upstream_status,upstream_info&limit=1')
        } catch {
          hasUpstreamColumns = false
        }

        for (let offset = 0; ; offset += pageSize) {
          const rows = await supabase.select(
            'sims',
            `select=sim_id,iccid,primary_imsi,msisdn,activation_date,enterprise_id,supplier_id&${filters.join('&')}&order=sim_id.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
          )
          const sims = Array.isArray(rows) ? rows : []
          if (!sims.length) break
          const simMap = new Map(sims.map((s) => [String(s.iccid), s]))
          const iccids = sims.map((s) => String(s.iccid)).filter((v) => /^\d{18,20}$/.test(v))
          if (!iccids.length) {
            continue
          }
          let resp = null
          try {
            resp = await client.getSimInfoBatch(iccids)
          } catch {
            resp = null
          }
          const list = Array.isArray(resp?.data) ? resp.data : Array.isArray(resp) ? resp : []
          for (const info of list) {
            const iccid = info?.iccid ? String(info.iccid) : ''
            if (!iccid) continue
            const sim = simMap.get(iccid)
            if (!sim) continue
            const update = {}
            const imsi = info?.imsi ? String(info.imsi) : null
            if (imsi && imsi !== sim.primary_imsi) update.primary_imsi = imsi
            const msisdn = info?.msisdn ? String(info.msisdn) : null
            if (msisdn && msisdn !== sim.msisdn) update.msisdn = msisdn
            const activationDate = toIsoDateTime(info?.activateTime || info?.activationTime || info?.activeTime)
            if (activationDate && activationDate !== sim.activation_date) update.activation_date = activationDate
            const upstreamStatus = info?.status ? String(info.status) : (info?.state ? String(info.state) : (info?.ispType ? String(info.ispType) : null))
            const upstreamInfo = {
              iccid,
              imsi: info?.imsi ?? null,
              msisdn: info?.msisdn ?? null,
              status: info?.status ?? null,
              state: info?.state ?? null,
              ispType: info?.ispType ?? null,
              chargeTime: info?.chargeTime ?? null,
              activateTime: info?.activateTime ?? info?.activationTime ?? info?.activeTime ?? null,
              expireTime: info?.expireTime ?? null,
              totalFlow: info?.totalFlow ?? null,
              usedFlow: info?.usedFlow ?? null,
              residualFlow: info?.residualFlow ?? null,
            }
            if (hasUpstreamColumns) {
              update.upstream_status = upstreamStatus
              update.upstream_info = upstreamInfo
            }
            if (!Object.keys(update).length) continue
            await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, update, { returning: 'minimal' })
            try {
              await supabase.insert('audit_logs', {
                actor_role: 'ADMIN',
                tenant_id: sim.enterprise_id ?? null,
                action: 'ADMIN_WX_SYNC_SIM_INFO_UPDATE',
                target_type: 'SIM',
                target_id: iccid,
                request_id: getTraceId(res),
                source_ip: req.ip,
                after_data: { upstreamStatus, upstreamInfo }
              }, { returning: 'minimal' })
            } catch {}
            processed += 1
          }
          if (jobId) {
            await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
              progress_processed: processed,
              progress_total: Math.max(processed, Number(total ?? processed)),
            }, { returning: 'minimal' })
          }
        }

        if (jobId) {
          await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
            status: 'SUCCEEDED',
            finished_at: new Date().toISOString(),
          }, { returning: 'minimal' })
        }
        try {
          await supabase.insert('audit_logs', {
            actor_role: 'ADMIN',
            tenant_id: enterpriseId ?? null,
            action: 'ADMIN_WX_SYNC_SIM_INFO_BATCH_RUN',
            target_type: 'SIM_BATCH',
            target_id: enterpriseId ?? 'ALL',
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: { processed, total, pageSize },
          }, { returning: 'minimal' })
        } catch (auditErr) {
          console.error('wx-sync-sim-info-batch: audit log insert failed', auditErr)
        }
        res.json({ jobId, processed, total })

      } catch (err) {
        if (err?.name === 'UpstreamError') {
          const status = Number(err.status) || 502
          const type = String(err.upstreamType || 'UPSTREAM_ERROR')
          const msg = type === 'UPSTREAM_TIMEOUT' ? 'Upstream timeout.' :
            type === 'UPSTREAM_RATE_LIMITED' ? 'Upstream rate limited.' :
            type === 'UPSTREAM_CIRCUIT_OPEN' ? 'Upstream circuit open.' :
            type === 'UPSTREAM_SERVER_ERROR' ? 'Upstream server error.' :
            type === 'UPSTREAM_NETWORK_ERROR' ? 'Upstream network error.' :
            'Upstream bad response.'
          console.error('Error in wx-sync-sim-info-batch upstream:', {
            type,
            status,
            body: err?.body ?? null
          })
          res.setHeader('X-Upstream-Type', type)
          if (err.retryAfter !== undefined && err.retryAfter !== null) {
            res.setHeader('Retry-After', String(err.retryAfter))
          }
          return sendError(res, status, 'UPSTREAM_ERROR', msg)
        }
        console.error('Error in wx-sync-sim-info-batch:', err)
        if (jobId) {
          try {
            await createSupabaseRestClient({ useServiceRole: true }).update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
              status: 'FAILED',
              error_summary: err?.message ? String(err.message) : 'wx_sync_sim_info_failed',
              finished_at: new Date().toISOString(),
            }, { returning: 'minimal' })
          } catch (e) { /* ignore secondary error */ }
        }
        // Also log audit failure if possible
        try {
          await createSupabaseRestClient({ useServiceRole: true }).insert('audit_logs', {
            actor_role: 'ADMIN',
            tenant_id: enterpriseId ?? null,
            action: 'ADMIN_WX_SYNC_SIM_INFO_BATCH_RUN',
            target_type: 'SIM_BATCH',
            target_id: enterpriseId ?? 'ALL',
            request_id: getTraceId(res),
            source_ip: req.ip,
            after_data: { processed, total, pageSize, error: err?.message ?? 'upstream_error' },
          }, { returning: 'minimal' })
        } catch (e) { /* ignore */ }
        
        return sendError(res, 500, 'INTERNAL_ERROR', err.message)
      }
    })
    app.post(`${prefix}/admin/jobs:late-cdr`, async (req, res) => {
      if (!requireAdminApiKey(req, res)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const records = Array.isArray(req.body?.records) ? req.body.records : null
      if (!records || records.length === 0) {
        return sendError(res, 400, 'BAD_REQUEST', 'records must be a non-empty array.')
      }
      const source = req.body?.source ? String(req.body.source) : null
      const batchId = req.body?.batchId ? String(req.body.batchId) : null
      const payload = {
        records,
        source,
        batchId,
        traceId: getTraceId(res),
      }
      const jobs = await supabase.insert('jobs', {
        job_type: 'LATE_CDR_PROCESS',
        status: 'QUEUED',
        progress_processed: 0,
        progress_total: Number(records.length || 0),
        request_id: JSON.stringify(payload),
      })
      const jobId = Array.isArray(jobs) ? jobs[0]?.job_id : null
      res.status(202).json({ jobId, status: 'QUEUED' })
    })
  }

  app.get('/health', (req, res) => {
    res.json({ ok: true })
  })

  app.get('/ready', async (req, res) => {
    const details = {
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
      } catch (err) {
        upstreamReady = false
      }
      details.upstream.supabase = upstreamReady
    }
    const wxConfigured = details.config.wxzhonggengUrl && details.config.wxzhonggengTokenUrl
    if (wxConfigured) {
      try {
        const client = createWxzhonggengClient()
        const ok = await client.ping()
        details.upstream.wxzhonggeng = ok === true
      } catch (err) {
        details.upstream.wxzhonggeng = false
      }
    }
    const ok = supabaseConfigured ? upstreamReady === true : true
    res.status(ok ? 200 : 503).json({ ok, details })
  })
  async function serveOpenApiYaml(req, res) {
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
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8')
    res.send(yaml)
  }

  app.get('/openapi.yaml', serveOpenApiYaml)
  app.get('/v1/openapi.yaml', serveOpenApiYaml)

  function serveDocs(req, res) {
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
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>Subscription Demos</strong>
        <input id="subIccid" placeholder="ICCID" />
        <input id="pkgVerId" placeholder="PackageVersionId" />
        <select id="pkgVerSelect">
          <option value="">Select PackageVersion</option>
        </select>
        <select id="pkgFilterSelect">
          <option value="">Filter by Package</option>
        </select>
        <input id="pkgStatus" placeholder="status filter (optional)" />
        <input id="pkgSvcType" placeholder="serviceType filter (optional)" />
        <input id="pkgQuery" placeholder="name contains (optional)" />
        <input id="effStart" placeholder="effectiveFrom >= ISO (optional)" />
        <input id="effEnd" placeholder="effectiveFrom <= ISO (optional)" />
        <input id="mcc" placeholder="MCC (optional)" />
        <input id="mnc" placeholder="MNC (optional)" />
        <input id="mccmnc" placeholder="MCCMNC (optional, e.g. 46000 or 460001)" />
        <input id="carrierNameLike" placeholder="Carrier name contains (optional)" />
        <input id="mccmncList" placeholder="MCCMNC list (comma sep)" />
        <div id="mccmncChips" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
        <input id="mccBuilder" placeholder="MCC add (3 digits)" />
        <input id="mncBuilder" placeholder="MNC add (2/3 digits)" />
        <button id="btnAddMccmnc" class="secondary">Add MCCMNC</button>
        <button id="btnClearMccmnc" class="secondary">Clear MCCMNC</button>
        <input id="carrierNameExact" placeholder="Carrier exact name (optional)" />
        <input id="apnLike" placeholder="APN contains (optional)" />
        <select id="sortBy">
          <option value="">Sort By</option>
          <option value="createdAt">createdAt</option>
          <option value="effectiveFrom">effectiveFrom</option>
          <option value="status">status</option>
        </select>
        <select id="sortOrder">
          <option value="">Order</option>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <input id="pkgLimit" placeholder="limit (default 100)" />
        <input id="pkgPage" placeholder="page (default 1)" />
        <button id="pkgPrev" class="secondary">Previous</button>
        <button id="pkgNext" class="secondary">Next</button>
        <button id="pkgClear" class="secondary">Clear Filters</button>
        <button id="pkgReload" class="secondary">Reload</button>
        <button id="pkgCsv" class="secondary">Download CSV</button>
        <button id="pkgCsvCopyCurl" class="secondary">Copy CSV cURL</button>
        <button id="pkgShare" class="secondary">Copy Share Link</button>
        <button id="pkgCopyDocsUrl" class="secondary">Copy Long Link</button>
        <button id="pkgCopyQuery" class="secondary">Copy Query URL</button>
        <button id="pkgCopyCurl" class="secondary">Copy cURL</button>
        <input id="subId" placeholder="SubscriptionId" />
        <select id="kindSelect">
          <option value="MAIN">MAIN</option>
          <option value="ADD_ON">ADD_ON</option>
        </select>
        <select id="effMode">
          <option value="immediate">Immediate</option>
          <option value="nextCycle">Next Cycle</option>
        </select>
        <input id="effCustom" placeholder="effectiveAt ISO (optional)" />
        <button id="btnCreateSub">Create</button>
        <button id="btnSwitchSub">Switch</button>
        <button id="btnCancelImmediate">Cancel Now</button>
        <button id="btnCancelEom" class="secondary">Cancel Month End</button>
        <button id="btnListSubs">List SIM Subs</button>
        <button id="btnCopyCurl" class="secondary">Copy cURL</button>
      </div>
      <div class="cmp-hint">Requires Bearer token above. For demo, enter ICCID and IDs, then click.</div>
      <div style="padding: 8px 16px;"><pre id="demoOutput" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:240px"></pre></div>
      <div class="cmp-hint">Package Versions 列表视图</div>
      <div style="padding: 8px 16px;"><div id="pkgVerTableContainer" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:300px"></div></div>
    </div>
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>Packages 列表</strong>
        <input id="pkListQuery" placeholder="name contains (optional)" />
        <select id="pkListSortBy">
          <option value="">Sort By</option>
          <option value="name">name</option>
        </select>
        <select id="pkListSortOrder">
          <option value="">Order</option>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <input id="pkListLimit" placeholder="limit (default 100)" />
        <input id="pkListPage" placeholder="page (default 1)" />
        <button id="pkListPrev" class="secondary">Previous</button>
        <button id="pkListNext" class="secondary">Next</button>
        <button id="pkListReload" class="secondary">Reload</button>
        <button id="pkListCsv" class="secondary">Download CSV</button>
        <button id="pkListCsvCopyCurl" class="secondary">Copy CSV cURL</button>
        <button id="pkListShare" class="secondary">Copy Share Link</button>
        <button id="pkListCopyDocsUrl" class="secondary">Copy Long Link</button>
        <button id="pkListCopyQuery" class="secondary">Copy Query URL</button>
        <button id="pkListCopyCurl" class="secondary">Copy cURL</button>
      </div>
      <div class="cmp-hint">使用 /v1/packages 展示当前企业可见的套餐列表。</div>
      <div style="padding: 8px 16px;"><div id="pkListContainer" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:240px"></div></div>
    </div>
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>账单列表与导出</strong>
        <input id="billPeriod" placeholder="period (YYYY-MM)" />
        <select id="billStatus">
          <option value="">status</option>
          <option value="GENERATED">GENERATED</option>
          <option value="PAID">PAID</option>
        </select>
        <select id="billSortBy">
          <option value="">Sort By</option>
          <option value="period">period</option>
          <option value="dueDate">dueDate</option>
          <option value="totalAmount">totalAmount</option>
          <option value="status">status</option>
        </select>
        <select id="billSortOrder">
          <option value="">Order</option>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <input id="billLimit" placeholder="limit (default 20)" />
        <input id="billPage" placeholder="page (default 1)" />
        <button id="billQuickThisMonth" class="secondary">本月</button>
        <button id="billQuickLastMonth" class="secondary">上月</button>
        <button id="billQuickOverdue" class="secondary">逾期</button>
        <button id="billReload" class="secondary">Reload</button>
        <button id="billCsv" class="secondary">Download CSV</button>
        <button id="billCsvCopyCurl" class="secondary">Copy CSV cURL</button>
        <button id="billListCopyCurl" class="secondary">Copy List cURL</button>
        <button id="billShare" class="secondary">Copy Share Link</button>
        <button id="billCopyDocsUrl" class="secondary">Copy Long Link</button>
      </div>
      <div class="cmp-hint">使用 /v1/bills 展示账单列表；每行可下载 CSV。</div>
      <div style="padding: 8px 16px;"><div id="billsTableContainer" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:300px"></div></div>
    </div>
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>SIM 列表</strong>
        <input id="simIccid" placeholder="iccid (optional)" />
        <input id="simMsisdn" placeholder="msisdn (optional)" />
        <select id="simStatus">
          <option value="">status</option>
          <option value="INVENTORY">INVENTORY</option>
          <option value="TEST_READY">TEST_READY</option>
          <option value="ACTIVATED">ACTIVATED</option>
          <option value="DEACTIVATED">DEACTIVATED</option>
          <option value="RETIRED">RETIRED</option>
        </select>
        <input id="simLimit" placeholder="limit (default 20)" />
        <input id="simPage" placeholder="page (default 1)" />
        <button id="simReload" class="secondary">Reload</button>
        <button id="simListCopyCurl" class="secondary">Copy List cURL</button>
        <button id="simCsv" class="secondary">Download CSV</button>
        <button id="simCsvCopyCurl" class="secondary">Copy CSV cURL</button>
      </div>
      <div class="cmp-hint">使用 /v1/sims 展示当前企业可见的卡列表。</div>
      <div style="padding: 8px 16px;"><div id="simsTableContainer" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:300px"></div></div>
    </div>
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>Admin 短链接管理</strong>
        <input id="adminApiKey" placeholder="ADMIN_API_KEY" type="password" />
        <input id="slEnterprise" placeholder="enterpriseId (optional)" />
        <input id="slKind" placeholder="kind (optional)" />
        <input id="slCode" placeholder="code (optional)" />
        <input id="slCodePrefix" placeholder="codePrefix (optional)" />
        <input id="slCodeLike" placeholder="codeLike (optional)" />
        <input id="slRequestId" placeholder="requestId (optional)" />
        <select id="slStatus">
          <option value="">status</option>
          <option value="active">active</option>
          <option value="expired">expired</option>
        </select>
        <input id="slExpiresFrom" type="datetime-local" placeholder="expiresFrom (optional)" />
        <input id="slExpiresTo" type="datetime-local" placeholder="expiresTo (optional)" />
        <select id="slSortOrder">
          <option value="">order</option>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <select id="slSortBy">
          <option value="">sortBy</option>
          <option value="expiresAt">expiresAt</option>
          <option value="createdAt">createdAt</option>
          <option value="code">code</option>
        </select>
        <input id="slLimit" placeholder="limit (default 50)" />
        <input id="slPage" placeholder="page (default 1)" />
        <button id="slQuickLast7" class="secondary">Last 7d</button>
        <button id="slQuickNext7" class="secondary">Next 7d</button>
        <button id="slQuickClear" class="secondary">Clear Range</button>
        <button id="slQuickLast30" class="secondary">Last 30d</button>
        <button id="slQuickNext30" class="secondary">Next 30d</button>
        <button id="slQuickLast90" class="secondary">Last 90d</button>
        <button id="slQuickNext90" class="secondary">Next 90d</button>
        <button id="slQuickNext24h" class="secondary">Next 24h</button>
        <button id="slQuickActive24h" class="secondary">Active in 24h</button>
        <button id="slQuickActive7d" class="secondary">Active in 7d</button>
        <button id="slQuickActive30d" class="secondary">Active in 30d</button>
        <button id="slQuickActive90d" class="secondary">Active in 90d</button>
        <button id="slQuickExpired24h" class="secondary">Expired in 24h</button>
        <button id="slQuickExpired7d" class="secondary">Expired in 7d</button>
        <button id="slQuickExpired30d" class="secondary">Expired in 30d</button>
        <button id="slQuickExpired90d" class="secondary">Expired in 90d</button>
        <button id="slClearStatus" class="secondary">Clear Status</button>
        <button id="slFirst" class="secondary">First</button>
        <button id="slPrev" class="secondary">Previous</button>
        <button id="slNext" class="secondary">Next</button>
        <button id="slLast" class="secondary">Last</button>
        <button id="slReload" class="secondary">Reload</button>
        <button id="slCsv" class="secondary">Download CSV</button>
        <button id="slCsvCopyCurl" class="secondary">Copy CSV cURL</button>
        <button id="slListCopyCurl" class="secondary">Copy List cURL</button>
        <button id="slCopyDocsUrl" class="secondary">Copy Admin Long Link</button>
        <button id="slCopySummary" class="secondary">Copy Filters</button>
        <button id="slClearAll" class="secondary">Clear All</button>
        <button id="slInvalidate" class="secondary">Invalidate by Code</button>
        <button id="slDelete" class="secondary">Delete by Code</button>
      </div>
      <div class="cmp-hint">使用 /v1/admin/share-links 与 /v1/admin/share-links:csv；需要 Admin X-API-Key。<span id="slPageStatus"></span></div>
      <div style="padding: 8px 16px;"><div id="shareLinksTableContainer" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:300px"></div></div>
    </div>
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>Admin 事件查看与导出</strong>
        <input id="evEventType" placeholder="eventType (optional)" />
        <input id="evTenantId" placeholder="tenantId (optional)" />
        <input id="evRequestId" placeholder="requestId (optional)" />
        <input id="evIccid" placeholder="iccid (optional)" />
        <input id="evBeforeStatus" placeholder="beforeStatus (optional)" />
        <input id="evAfterStatus" placeholder="afterStatus (optional)" />
        <input id="evReason" placeholder="reason (optional)" />
        <input id="evStart" type="datetime-local" placeholder="start (optional)" />
        <input id="evEnd" type="datetime-local" placeholder="end (optional)" />
        <select id="evSortOrder">
          <option value="">order</option>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <input id="evLimit" placeholder="limit (default 50)" />
        <input id="evPage" placeholder="page (default 1)" />
        <button id="evQuickLast24h" class="secondary">Last 24h</button>
        <button id="evQuickLast7d" class="secondary">Last 7d</button>
        <button id="evQuickClear" class="secondary">Clear Range</button>
        <button id="evFirst" class="secondary">First</button>
        <button id="evPrev" class="secondary">Previous</button>
        <button id="evNext" class="secondary">Next</button>
        <button id="evLast" class="secondary">Last</button>
        <button id="evReload" class="secondary">Reload</button>
        <button id="evCsv" class="secondary">Download CSV</button>
        <button id="evCsvCopyCurl" class="secondary">Copy CSV cURL</button>
        <button id="evListCopyCurl" class="secondary">Copy List cURL</button>
      </div>
      <div class="cmp-hint">使用 /v1/admin/events 与 /v1/admin/events:csv；需要 Admin X-API-Key。<span id="evPageStatus"></span></div>
      <div style="padding: 8px 16px;"><div id="eventsTableContainer" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:300px"></div></div>
    </div>
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>Admin 任务查看与导出</strong>
        <input id="jobType" placeholder="jobType (optional)" />
        <select id="jobStatus">
          <option value="">status</option>
          <option value="QUEUED">QUEUED</option>
          <option value="RUNNING">RUNNING</option>
          <option value="SUCCEEDED">SUCCEEDED</option>
          <option value="FAILED">FAILED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
        <input id="jobRequestId" placeholder="requestId (optional)" />
        <input id="jobStart" type="datetime-local" placeholder="startDate (optional)" />
        <input id="jobEnd" type="datetime-local" placeholder="endDate (optional)" />
        <select id="jobSortBy">
          <option value="">sortBy</option>
          <option value="startedAt">startedAt</option>
          <option value="finishedAt">finishedAt</option>
        </select>
        <select id="jobSortOrder">
          <option value="">order</option>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <input id="jobLimit" placeholder="limit (default 50)" />
        <input id="jobPage" placeholder="page (default 1)" />
        <button id="jobReload" class="secondary">Reload</button>
        <button id="jobCsv" class="secondary">Download CSV</button>
        <button id="jobCsvCopyCurl" class="secondary">Copy CSV cURL</button>
        <button id="jobListCopyCurl" class="secondary">Copy List cURL</button>
      </div>
      <div class="cmp-hint">使用 /v1/admin/jobs 与 /v1/admin/jobs:csv；需要 Admin X-API-Key。<span id="jobPageStatus"></span></div>
      <div style="padding: 8px 16px;"><div id="jobsTableContainer" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:300px"></div></div>
    </div>
    <div class="cmp-toolbar">
      <div class="cmp-row">
        <strong>Admin 审计查看与导出</strong>
        <input id="auditTenantId" placeholder="tenantId (optional)" />
        <input id="auditAction" placeholder="action (optional)" />
        <input id="auditTargetType" placeholder="targetType (optional)" />
        <input id="auditTargetId" placeholder="targetId (optional)" />
        <input id="auditRequestId" placeholder="requestId (optional)" />
        <input id="auditStart" type="datetime-local" placeholder="start (optional)" />
        <input id="auditEnd" type="datetime-local" placeholder="end (optional)" />
        <select id="auditSortOrder">
          <option value="">order</option>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <input id="auditLimit" placeholder="limit (default 50)" />
        <input id="auditPage" placeholder="page (default 1)" />
        <button id="auditReload" class="secondary">Reload</button>
        <button id="auditCsv" class="secondary">Download CSV</button>
        <button id="auditCsvCopyCurl" class="secondary">Copy CSV cURL</button>
        <button id="auditListCopyCurl" class="secondary">Copy List cURL</button>
      </div>
      <div class="cmp-hint">使用 /v1/admin/audits 与 /v1/admin/audits:csv；需要 Admin X-API-Key。<span id="auditPageStatus"></span></div>
      <div style="padding: 8px 16px;"><div id="auditsTableContainer" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;max-height:300px"></div></div>
    </div>
    <div id="swagger-ui"></div>
    <script src="${baseUrl}/v1/docs/assets/swagger-ui-bundle.js"></script>
    <script>
      const STORAGE_KEY = 'cmp_bearer_token'
      const ADMIN_KEY_STORAGE = 'cmp_admin_api_key'
      const statusEl = document.getElementById('status')

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
      function getStoredAdminKey() {
        try { return localStorage.getItem(ADMIN_KEY_STORAGE) } catch { return null }
      }
      function setStoredAdminKey(v) {
        try { localStorage.setItem(ADMIN_KEY_STORAGE, v || '') } catch {}
      }

      function preauthorizeIfPossible(ui) {
        const token = getStoredToken()
        if (!token) return
        if (ui && typeof ui.preauthorizeApiKey === 'function') {
          try {
            ui.preauthorizeApiKey('BearerAuth', token)
            setStatus('Authorized')
          } catch {
            setStatus('Token stored (manual authorize may be needed)')
          }
        } else {
          setStatus('Token stored (Swagger UI unavailable)')
        }
      }

      ;(function initSwaggerUiSafely() {
        try {
          if (typeof SwaggerUIBundle === 'function') {
            const ui = SwaggerUIBundle({
              url: ${JSON.stringify(openapiUrl)},
              dom_id: '#swagger-ui',
              deepLinking: true,
              docExpansion: 'none',
              tagsSorter: 'alpha',
              operationsSorter: 'alpha',
              presets: [SwaggerUIBundle.presets.apis],
              layout: 'BaseLayout',
              onComplete: function() {
                const token = getStoredToken()
                if (token) {
                  preauthorizeIfPossible(ui)
                }
                const k = getStoredAdminKey()
                const adminKeyInput = document.getElementById('adminApiKey')
                if (adminKeyInput) adminKeyInput.value = k || ''
              }
            })
            window.ui = ui
          } else {
            setStatus('Swagger UI unavailable (CDN blocked)')
          }
        } catch (err) {
          setStatus('Swagger UI init failed')
        }
      })()

      const clientIdInput = document.getElementById('clientId')
      const clientSecretInput = document.getElementById('clientSecret')
      const validateBtn = document.getElementById('validateToken')

      clientIdInput.value = ''
      clientSecretInput.value = ''

      document.getElementById('getToken').addEventListener('click', async () => {
        setStatus('Fetching token...')
        const clientId = clientIdInput.value.trim()
        const clientSecret = clientSecretInput.value
        if (!clientId || !clientSecret) {
          setStatus('Missing clientId/clientSecret')
          return
        }

        try {
          const res = await fetch(${JSON.stringify(tokenUrl)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, clientSecret })
          })
          const text = await res.text()
          if (!res.ok) {
            setStatus('Token request failed')
            return
          }
          const data = text ? JSON.parse(text) : null
          if (!data || !data.accessToken) {
            setStatus('Invalid token response')
            return
          }
          setStoredToken(data.accessToken)
          preauthorizeIfPossible(window.ui)
          try { await loadPackageVersions() } catch {}
          try { await loadPackagesCard() } catch {}
          try { await refreshCsvButtonsState() } catch {}
        } catch {
          setStatus('Token request error')
        }
      })

      document.getElementById('clearToken').addEventListener('click', () => {
        clearStoredToken()
        setStatus('Cleared')
      })
      validateBtn.addEventListener('click', async () => {
        setStatus('Validating...')
        try {
          const res = await fetch(${JSON.stringify(baseUrl)} + '/v1/sims?limit=1&page=1', { headers: getAuthHeaders() })
          const ok = res.ok
          setStatus(ok ? 'Token valid' : 'Token invalid')
          if (ok) { try { await loadPackageVersions() } catch {} try { await loadPackagesCard() } catch {} try { await refreshCsvButtonsState() } catch {} }
        } catch {
          setStatus('Token invalid')
        }
      })
      const apiBase = ${JSON.stringify(baseUrl)}
      const outputEl = document.getElementById('demoOutput')
      function setOutput(obj) {
        try { outputEl.textContent = JSON.stringify(obj, null, 2) } catch { outputEl.textContent = String(obj) }
      }
      function getAuthHeaders(extra) {
        const t = getStoredToken()
        const h = { ...(extra || {}) }
        if (t) h.Authorization = 'Bearer ' + t
        return h
      }
      function getAdminHeaders(extra) {
        const k = getStoredAdminKey()
        const h = { ...(extra || {}) }
        if (k) h['X-API-Key'] = k
        return h
      }
      function firstDayNextMonthUtc() {
        const now = new Date()
        const y = now.getUTCFullYear()
        const m = now.getUTCMonth()
        return new Date(Date.UTC(m + 1 >= 12 ? y + Math.floor((m + 1) / 12) : y, (m + 1) % 12, 1, 0, 0, 0, 0)).toISOString()
      }
      function setLocal(key, val) { try { localStorage.setItem(key, val) } catch {} }
      function getLocal(key) { try { return localStorage.getItem(key) } catch { return null } }
      function initFromQuery() {
        const qs = new URLSearchParams(location.search)
        const iccid = qs.get('iccid'); const pkgv = qs.get('pkg'); const sid = qs.get('sub')
        const shareCode = qs.get('shareCode')
        if (iccid) subIccid.value = iccid
        if (pkgv) pkgVerId.value = pkgv
        if (sid) subId.value = sid
        if (shareCode) {
          applyShareCode(shareCode)
        }
        const pv = {
          status: qs.get('pv_status'),
          serviceType: qs.get('pv_serviceType'),
          q: qs.get('pv_q'),
          effectiveFromStart: qs.get('pv_effectiveFromStart'),
          effectiveFromEnd: qs.get('pv_effectiveFromEnd'),
          mcc: qs.get('pv_mcc'),
          mnc: qs.get('pv_mnc'),
          mccmnc: qs.get('pv_mccmnc'),
          carrierNameLike: qs.get('pv_carrierNameLike'),
          mccmncList: qs.get('pv_mccmncList'),
          carrierName: qs.get('pv_carrierName'),
          apnLike: qs.get('pv_apnLike'),
          sortBy: qs.get('pv_sortBy'),
          sortOrder: qs.get('pv_sortOrder'),
          packageId: qs.get('pv_packageId'),
          limit: qs.get('pv_limit'),
          page: qs.get('pv_page'),
        }
        let pvApplied = false
        for (const k in pv) {
          if (pv[k] !== null && pv[k] !== undefined) { pvApplied = true; break }
        }
        if (pvApplied) {
          if (pv.status !== null) document.getElementById('pkgStatus').value = pv.status || ''
          if (pv.serviceType !== null) document.getElementById('pkgSvcType').value = pv.serviceType || ''
          if (pv.q !== null) document.getElementById('pkgQuery').value = pv.q || ''
          if (pv.effectiveFromStart !== null) document.getElementById('effStart').value = pv.effectiveFromStart || ''
          if (pv.effectiveFromEnd !== null) document.getElementById('effEnd').value = pv.effectiveFromEnd || ''
          if (pv.mcc !== null) document.getElementById('mcc').value = pv.mcc || ''
          if (pv.mnc !== null) document.getElementById('mnc').value = pv.mnc || ''
          if (pv.mccmnc !== null) document.getElementById('mccmnc').value = pv.mccmnc || ''
          if (pv.carrierNameLike !== null) document.getElementById('carrierNameLike').value = pv.carrierNameLike || ''
          if (pv.mccmncList !== null) document.getElementById('mccmncList').value = pv.mccmncList || ''
          if (pv.carrierName !== null) document.getElementById('carrierNameExact').value = pv.carrierName || ''
          if (pv.apnLike !== null) document.getElementById('apnLike').value = pv.apnLike || ''
          if (pv.sortBy !== null) document.getElementById('sortBy').value = pv.sortBy || ''
          if (pv.sortOrder !== null) document.getElementById('sortOrder').value = pv.sortOrder || ''
          if (pv.packageId !== null) document.getElementById('pkgFilterSelect').value = pv.packageId || ''
          if (pv.limit !== null) document.getElementById('pkgLimit').value = pv.limit || ''
          if (pv.page !== null) document.getElementById('pkgPage').value = pv.page || ''
          renderMccmncChips()
          try { loadPackageVersions() } catch {}
        }
        const pk = {
          q: qs.get('pk_q'),
          sortBy: qs.get('pk_sortBy'),
          sortOrder: qs.get('pk_sortOrder'),
          limit: qs.get('pk_limit'),
          page: qs.get('pk_page'),
        }
        let pkApplied = false
        for (const k in pk) {
          if (pk[k] !== null && pk[k] !== undefined) { pkApplied = true; break }
        }
        if (pkApplied) {
          if (pk.q !== null) document.getElementById('pkListQuery').value = pk.q || ''
          if (pk.sortBy !== null) document.getElementById('pkListSortBy').value = pk.sortBy || ''
          if (pk.sortOrder !== null) document.getElementById('pkListSortOrder').value = pk.sortOrder || ''
          if (pk.limit !== null) document.getElementById('pkListLimit').value = pk.limit || ''
          if (pk.page !== null) document.getElementById('pkListPage').value = pk.page || ''
          try { loadPackagesCard() } catch {}
        }
        const bl = {
          period: qs.get('bl_period'),
          status: qs.get('bl_status'),
          sortBy: qs.get('bl_sortBy'),
          sortOrder: qs.get('bl_sortOrder'),
          limit: qs.get('bl_limit'),
          page: qs.get('bl_page'),
        }
        let blApplied = false
        for (const k in bl) {
          if (bl[k] !== null && bl[k] !== undefined) { blApplied = true; break }
        }
        if (blApplied) {
          if (bl.period !== null) document.getElementById('billPeriod').value = bl.period || ''
          if (bl.status !== null) document.getElementById('billStatus').value = bl.status || ''
          if (bl.sortBy !== null) document.getElementById('billSortBy').value = bl.sortBy || ''
          if (bl.sortOrder !== null) document.getElementById('billSortOrder').value = bl.sortOrder || ''
          if (bl.limit !== null) document.getElementById('billLimit').value = bl.limit || ''
          if (bl.page !== null) document.getElementById('billPage').value = bl.page || ''
          try { loadBills() } catch {}
        }
        const sl = {
          enterpriseId: qs.get('sl_enterpriseId'),
          kind: qs.get('sl_kind'),
          code: qs.get('sl_code'),
          codePrefix: qs.get('sl_codePrefix'),
          codeLike: qs.get('sl_codeLike'),
          requestId: qs.get('sl_requestId'),
          status: qs.get('sl_status'),
          expiresFrom: qs.get('sl_expiresFrom'),
          expiresTo: qs.get('sl_expiresTo'),
          sortBy: qs.get('sl_sortBy'),
          sortOrder: qs.get('sl_sortOrder'),
          limit: qs.get('sl_limit'),
          page: qs.get('sl_page'),
        }
        let slApplied = false
        for (const k in sl) {
          if (sl[k] !== null && sl[k] !== undefined) { slApplied = true; break }
        }
        if (slApplied) {
          const m = {
            enterpriseId: 'slEnterprise',
            kind: 'slKind',
            code: 'slCode',
            codePrefix: 'slCodePrefix',
            codeLike: 'slCodeLike',
            requestId: 'slRequestId',
            status: 'slStatus',
            expiresFrom: 'slExpiresFrom',
            expiresTo: 'slExpiresTo',
            sortBy: 'slSortBy',
            sortOrder: 'slSortOrder',
            limit: 'slLimit',
            page: 'slPage',
          }
          function normalizeForDatetimeLocal(s) {
            const str = String(s || '').trim()
            if (!str) return ''
            if (str.includes('Z') || str.includes('+')) {
              const d = new Date(str)
              if (Number.isNaN(d.getTime())) return ''
              const y = d.getFullYear()
              const m = String(d.getMonth() + 1).padStart(2, '0')
              const day = String(d.getDate()).padStart(2, '0')
              const hh = String(d.getHours()).padStart(2, '0')
              const mm = String(d.getMinutes()).padStart(2, '0')
              return y + '-' + m + '-' + day + 'T' + hh + ':' + mm
            }
            return str
          }
          for (const k in m) {
            const el = document.getElementById(m[k])
            if (!el) continue
            if (k === 'expiresFrom' || k === 'expiresTo') {
              if (sl[k] !== null) el.value = normalizeForDatetimeLocal(sl[k] || '')
            } else {
              if (sl[k] !== null) el.value = sl[k] || ''
            }
          }
          try { loadAdminShareLinks() } catch {}
        }
      }
      async function applyShareCode(code) {
        try {
          const res = await fetch(apiBase + '/v1/s/' + encodeURIComponent(code) + '.json', { headers: getAuthHeaders() })
          const text = await res.text()
          const data = text ? JSON.parse(text) : null
          if (!data || !data.kind || !data.params) return
          if (data.kind === 'packages') {
            if (data.params.q !== undefined) document.getElementById('pkListQuery').value = String(data.params.q || '')
            if (data.params.sortBy !== undefined) document.getElementById('pkListSortBy').value = String(data.params.sortBy || '')
            if (data.params.sortOrder !== undefined) document.getElementById('pkListSortOrder').value = String(data.params.sortOrder || '')
            if (data.params.limit !== undefined) document.getElementById('pkListLimit').value = String(data.params.limit || '')
            if (data.params.page !== undefined) document.getElementById('pkListPage').value = String(data.params.page || '')
            await loadPackagesCard()
          } else if (data.kind === 'packageVersions') {
            const map = {
              status: 'pkgStatus',
              serviceType: 'pkgSvcType',
              q: 'pkgQuery',
              effectiveFromStart: 'effStart',
              effectiveFromEnd: 'effEnd',
              mcc: 'mcc',
              mnc: 'mnc',
              mccmnc: 'mccmnc',
              carrierNameLike: 'carrierNameLike',
              mccmncList: 'mccmncList',
              carrierName: 'carrierNameExact',
              apnLike: 'apnLike',
              sortBy: 'sortBy',
              sortOrder: 'sortOrder',
              packageId: 'pkgFilterSelect',
              limit: 'pkgLimit',
              page: 'pkgPage',
            }
            for (const k in map) {
              if (Object.prototype.hasOwnProperty.call(data.params, k)) {
                const el = document.getElementById(map[k])
                if (el) el.value = String(data.params[k] || '')
              }
            }
            renderMccmncChips()
            await loadPackageVersions()
          } else if (data.kind === 'bills') {
            if (data.params.period !== undefined) document.getElementById('billPeriod').value = String(data.params.period || '')
            if (data.params.status !== undefined) document.getElementById('billStatus').value = String(data.params.status || '')
            if (data.params.sortBy !== undefined) document.getElementById('billSortBy').value = String(data.params.sortBy || '')
            if (data.params.sortOrder !== undefined) document.getElementById('billSortOrder').value = String(data.params.sortOrder || '')
            if (data.params.limit !== undefined) document.getElementById('billLimit').value = String(data.params.limit || '')
            if (data.params.page !== undefined) document.getElementById('billPage').value = String(data.params.page || '')
            await loadBills()
          }
        } catch {}
      }
      function sanitizeMccmncToken(s) {
        const t = String(s || '').replace(/[^0-9]/g, '')
        if (t.length === 5 || t.length === 6) return t
        return ''
      }
      function parseMccmncList(str) {
        return String(str || '').split(',').map((s) => s.trim()).map(sanitizeMccmncToken).filter(Boolean)
      }
      function setMccmncListVal(tokens) {
        const uniq = Array.from(new Set(tokens))
        const el = document.getElementById('mccmncList')
        el.value = uniq.join(',')
      }
      function renderMccmncChips() {
        const cont = document.getElementById('mccmncChips')
        while (cont.firstChild) cont.removeChild(cont.firstChild)
        const tokens = parseMccmncList(document.getElementById('mccmncList').value.trim())
        tokens.forEach((tok) => {
          const b = document.createElement('button')
          b.className = 'secondary'
          b.textContent = tok + ' ✕'
          b.addEventListener('click', async () => {
            const cur = parseMccmncList(document.getElementById('mccmncList').value.trim())
            const next = cur.filter((t) => t !== tok)
            setMccmncListVal(next)
            renderMccmncChips()
            await loadPackageVersions()
          })
          cont.appendChild(b)
        })
      }
      async function addMccmncFromBuilder() {
        const mcc = document.getElementById('mccBuilder').value.trim()
        const mnc = document.getElementById('mncBuilder').value.trim()
        const tok = sanitizeMccmncToken(mcc + mnc)
        if (!tok) return
        const cur = parseMccmncList(document.getElementById('mccmncList').value.trim())
        cur.push(tok)
        setMccmncListVal(cur)
        renderMccmncChips()
        await loadPackageVersions()
      }
      async function clearMccmncBuilder() {
        setMccmncListVal([])
        renderMccmncChips()
        await loadPackageVersions()
      }
      function buildPackageVersionsQueryUrl() {
        const status = document.getElementById('pkgStatus').value.trim()
        const svcType = document.getElementById('pkgSvcType').value.trim()
        const q = document.getElementById('pkgQuery').value.trim()
        const lim = document.getElementById('pkgLimit').value.trim()
        const pg = document.getElementById('pkgPage').value.trim()
        const pkgFilterId = document.getElementById('pkgFilterSelect').value.trim()
        const qs = new URLSearchParams({ limit: lim || '100', page: pg || '1' })
        if (status) qs.set('status', status)
        if (svcType) qs.set('serviceType', svcType)
        if (q) qs.set('q', q)
        const effStart = document.getElementById('effStart').value.trim()
        const effEnd = document.getElementById('effEnd').value.trim()
        if (effStart) qs.set('effectiveFromStart', effStart)
        if (effEnd) qs.set('effectiveFromEnd', effEnd)
        const mcc = document.getElementById('mcc').value.trim()
        const mnc = document.getElementById('mnc').value.trim()
        const mccmnc = document.getElementById('mccmnc').value.trim()
        const carrierNameLike = document.getElementById('carrierNameLike').value.trim()
        const mccmncList = document.getElementById('mccmncList').value.trim()
        const carrierNameExact = document.getElementById('carrierNameExact').value.trim()
        const apnLike = document.getElementById('apnLike').value.trim()
        const sortBy = document.getElementById('sortBy').value.trim()
        const sortOrder = document.getElementById('sortOrder').value.trim()
        if (mcc) qs.set('mcc', mcc)
        if (mnc) qs.set('mnc', mnc)
        if (mccmnc) qs.set('mccmnc', mccmnc)
        if (carrierNameLike) qs.set('carrierNameLike', carrierNameLike)
        if (mccmncList) qs.set('mccmncList', mccmncList)
        if (carrierNameExact) qs.set('carrierName', carrierNameExact)
        if (apnLike) qs.set('apnLike', apnLike)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        if (pkgFilterId) qs.set('packageId', pkgFilterId)
        return apiBase + '/v1/package-versions?' + qs.toString()
      }
      function persistInputs() {
        setLocal('demo_iccid', subIccid.value.trim())
        setLocal('demo_pkgv', pkgVerId.value.trim())
        setLocal('demo_sub', subId.value.trim())
        setLocal('demo_kind', kindSelect.value)
        setLocal('demo_eff', effMode.value)
      }
      function restoreInputs() {
        const iccid = getLocal('demo_iccid'); const pkgv = getLocal('demo_pkgv'); const sid = getLocal('demo_sub')
        const kind = getLocal('demo_kind'); const eff = getLocal('demo_eff')
        if (iccid) subIccid.value = iccid
        if (pkgv) pkgVerId.value = pkgv
        if (sid) subId.value = sid
        if (kind) kindSelect.value = kind
        if (eff) effMode.value = eff
      }
      async function postJson(url, body) {
        const res = await fetch(url, { method: 'POST', headers: getAuthHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}) })
        const text = await res.text()
        const data = text ? JSON.parse(text) : null
        return { ok: res.ok, status: res.status, data }
      }
      async function getJson(url) {
        const res = await fetch(url, { method: 'GET', headers: getAuthHeaders() })
        const text = await res.text()
        const data = text ? JSON.parse(text) : null
        return { ok: res.ok, status: res.status, data }
      }
      async function loadPackageVersions() {
        try {
          const status = document.getElementById('pkgStatus').value.trim()
          const svcType = document.getElementById('pkgSvcType').value.trim()
          const q = document.getElementById('pkgQuery').value.trim()
          const lim = document.getElementById('pkgLimit').value.trim()
          const pg = document.getElementById('pkgPage').value.trim()
          const pkgFilterId = document.getElementById('pkgFilterSelect').value.trim()
          const qs = new URLSearchParams({ limit: lim || '100', page: pg || '1' })
          if (status) qs.set('status', status)
          if (svcType) qs.set('serviceType', svcType)
          if (q) qs.set('q', q)
          const effStart = document.getElementById('effStart').value.trim()
          const effEnd = document.getElementById('effEnd').value.trim()
          if (effStart) qs.set('effectiveFromStart', effStart)
          if (effEnd) qs.set('effectiveFromEnd', effEnd)
          const mcc = document.getElementById('mcc').value.trim()
          const mnc = document.getElementById('mnc').value.trim()
          const mccmnc = document.getElementById('mccmnc').value.trim()
          const carrierNameLike = document.getElementById('carrierNameLike').value.trim()
          const mccmncList = document.getElementById('mccmncList').value.trim()
          const carrierNameExact = document.getElementById('carrierNameExact').value.trim()
          const apnLike = document.getElementById('apnLike').value.trim()
          const sortBy = document.getElementById('sortBy').value.trim()
          const sortOrder = document.getElementById('sortOrder').value.trim()
          if (mcc) qs.set('mcc', mcc)
          if (mnc) qs.set('mnc', mnc)
          if (mccmnc) qs.set('mccmnc', mccmnc)
          if (carrierNameLike) qs.set('carrierNameLike', carrierNameLike)
          if (mccmncList) qs.set('mccmncList', mccmncList)
          if (carrierNameExact) qs.set('carrierName', carrierNameExact)
          if (apnLike) qs.set('apnLike', apnLike)
          if (sortBy) qs.set('sortBy', sortBy)
          if (sortOrder) qs.set('sortOrder', sortOrder)
          if (pkgFilterId) qs.set('packageId', pkgFilterId)
          const r = await getJson(apiBase + '/v1/package-versions?' + qs.toString())
          const sel = document.getElementById('pkgVerSelect')
          while (sel.firstChild) sel.removeChild(sel.firstChild)
          const opt0 = document.createElement('option')
          opt0.value = ''
          const count = Array.isArray(r?.data?.items) ? r.data.items.length : 0
          const total = typeof r?.data?.total === 'number' ? r.data.total : count
          const pageTxt = (pg || '1')
          const limitTxt = (lim || '100')
          opt0.textContent = 'Select PackageVersion (' + count + '/' + total + ', page ' + pageTxt + ', limit ' + limitTxt + ')'
          sel.appendChild(opt0)
          const items = Array.isArray(r?.data?.items) ? r.data.items : []
          const stored = getLocal('demo_pkgv')
          items.forEach((it) => {
            const opt = document.createElement('option')
            opt.value = String(it.packageVersionId)
            const name = it.packageName ? String(it.packageName) : String(it.packageId || '')
            const st = it.status ? String(it.status) : ''
            const svc = it.serviceType ? String(it.serviceType) : ''
            const eff = it.effectiveFrom ? String(it.effectiveFrom) : ''
            const apn = it.apn ? String(it.apn) : ''
            const mccmnc = (it.mcc && it.mnc) ? (String(it.mcc) + String(it.mnc)) : ''
            const idShort = String(it.packageVersionId).slice(0, 8)
            const labelParts = []
            if (name) labelParts.push(name)
            if (st) labelParts.push(st)
            if (svc) labelParts.push(svc)
            if (apn) labelParts.push(apn)
            if (mccmnc) labelParts.push(mccmnc)
            if (eff) labelParts.push(eff)
            labelParts.push(idShort)
            opt.textContent = labelParts.join(' · ')
            sel.appendChild(opt)
          })
          if (stored) {
            sel.value = stored
            pkgVerId.value = stored
          }
          renderMccmncChips()
          const cont = document.getElementById('pkgVerTableContainer')
          while (cont.firstChild) cont.removeChild(cont.firstChild)
          const table = document.createElement('div')
          const header = document.createElement('div')
          const hName = document.createElement('button'); hName.className = 'secondary'; hName.textContent = 'Package'
          const hStatus = document.createElement('button'); hStatus.className = 'secondary'; hStatus.textContent = 'Status'
          const hEff = document.createElement('button'); hEff.className = 'secondary'; hEff.textContent = 'EffectiveFrom'
          header.style.display = 'flex'; header.style.gap = '8px'; header.style.flexWrap = 'wrap'
          header.appendChild(hName); header.appendChild(hStatus); header.appendChild(hEff)
          table.appendChild(header)
          hStatus.addEventListener('click', async () => {
            const curBy = document.getElementById('sortBy'); const curOrder = document.getElementById('sortOrder')
            const nextOrder = (curBy.value === 'status' && curOrder.value === 'asc') ? 'desc' : 'asc'
            curBy.value = 'status'; curOrder.value = nextOrder; await loadPackageVersions()
          })
          hEff.addEventListener('click', async () => {
            const curBy = document.getElementById('sortBy'); const curOrder = document.getElementById('sortOrder')
            const nextOrder = (curBy.value === 'effectiveFrom' && curOrder.value === 'asc') ? 'desc' : 'asc'
            curBy.value = 'effectiveFrom'; curOrder.value = nextOrder; await loadPackageVersions()
          })
          items.forEach((it) => {
            const row = document.createElement('div')
            row.style.display = 'flex'; row.style.gap = '8px'; row.style.flexWrap = 'wrap'; row.style.padding = '6px 0'
            const name = document.createElement('span'); name.textContent = (it.packageName ? String(it.packageName) : String(it.packageId || ''))
            const st = document.createElement('span'); st.textContent = (it.status ? String(it.status) : '')
            const svc = document.createElement('span'); svc.textContent = (it.serviceType ? String(it.serviceType) : '')
            const apn = document.createElement('span'); apn.textContent = (it.apn ? String(it.apn) : '')
            const mccmnc = document.createElement('span'); mccmnc.textContent = ((it.mcc && it.mnc) ? (String(it.mcc) + String(it.mnc)) : '')
            const eff = document.createElement('span'); eff.textContent = (it.effectiveFrom ? String(it.effectiveFrom) : '')
            const idShort = String(it.packageVersionId).slice(0, 8)
            const idBtn = document.createElement('button'); idBtn.className = 'secondary'; idBtn.textContent = idShort
            idBtn.addEventListener('click', () => { try { navigator.clipboard.writeText(String(it.packageVersionId)) } catch {} })
            const pickBtn = document.createElement('button'); pickBtn.textContent = 'Pick'; pickBtn.className = 'secondary'
            pickBtn.addEventListener('click', () => { pkgVerId.value = String(it.packageVersionId); persistInputs() })
            row.appendChild(name); row.appendChild(st); row.appendChild(svc); row.appendChild(apn); row.appendChild(mccmnc); row.appendChild(eff); row.appendChild(idBtn); row.appendChild(pickBtn)
            table.appendChild(row)
          })
          cont.appendChild(table)
        } catch {}
      }
      async function loadPackagesForFilter() {
        try {
          const r = await getJson(apiBase + '/v1/packages?limit=200&page=1')
          const sel = document.getElementById('pkgFilterSelect')
          while (sel.firstChild) sel.removeChild(sel.firstChild)
          const opt0 = document.createElement('option')
          opt0.value = ''
          opt0.textContent = 'Filter by Package'
          sel.appendChild(opt0)
          const items = Array.isArray(r?.data?.items) ? r.data.items : []
          items.forEach((it) => {
            const opt = document.createElement('option')
            opt.value = String(it.packageId)
            opt.textContent = String(it.name || it.packageId)
            sel.appendChild(opt)
          })
        } catch {}
      }
      async function loadPackagesCard() {
        try {
          const lim = document.getElementById('pkListLimit').value.trim()
          const pg = document.getElementById('pkListPage').value.trim()
          const q = document.getElementById('pkListQuery').value.trim()
          const sortBy = document.getElementById('pkListSortBy').value.trim()
          const sortOrder = document.getElementById('pkListSortOrder').value.trim()
          const qs = new URLSearchParams({ limit: lim || '100', page: pg || '1' })
          if (q) qs.set('q', q)
          if (sortBy) qs.set('sortBy', sortBy)
          if (sortOrder) qs.set('sortOrder', sortOrder)
          const r = await getJson(apiBase + '/v1/packages?' + qs.toString())
          const cont = document.getElementById('pkListContainer')
          while (cont.firstChild) cont.removeChild(cont.firstChild)
          const items = Array.isArray(r?.data?.items) ? r.data.items : []
          const count = items.length
          const total = typeof r?.data?.total === 'number' ? r.data.total : count
          const pageTxt = (pg || '1')
          const limitTxt = (lim || '100')
          const header = document.createElement('div')
          header.textContent = 'Packages (' + count + '/' + total + ', page ' + pageTxt + ', limit ' + limitTxt + ')'
          cont.appendChild(header)
          const bar = document.createElement('div')
          bar.style.display = 'flex'; bar.style.gap = '8px'; bar.style.flexWrap = 'wrap'; bar.style.padding = '6px 0'
          const hName = document.createElement('button'); hName.className = 'secondary'; hName.textContent = 'Name'
          hName.addEventListener('click', async () => {
            const curBy = document.getElementById('pkListSortBy'); const curOrder = document.getElementById('pkListSortOrder')
            const nextOrder = (curBy.value === 'name' && curOrder.value === 'asc') ? 'desc' : 'asc'
            curBy.value = 'name'; curOrder.value = nextOrder; await loadPackagesCard()
          })
          bar.appendChild(hName)
          cont.appendChild(bar)
          items.forEach((it) => {
            const row = document.createElement('div')
            const btn = document.createElement('button')
            btn.className = 'secondary'
            const name = it?.name ? String(it.name) : ''
            const id = String(it.packageId || '')
            btn.textContent = (name || '(unnamed)') + ' · ' + id
            btn.addEventListener('click', async () => {
              const sel = document.getElementById('pkgFilterSelect')
              sel.value = id
              document.getElementById('pkgPage').value = '1'
              await loadPackageVersions()
            })
            row.appendChild(btn)
            cont.appendChild(row)
          })
        } catch {}
      }
      async function refreshCsvButtonsState() {
        // no-op placeholder to future-disable buttons when no token
      }
      function buildPackagesQueryUrl() {
        const lim = document.getElementById('pkListLimit').value.trim()
        const pg = document.getElementById('pkListPage').value.trim()
        const q = document.getElementById('pkListQuery').value.trim()
        const sortBy = document.getElementById('pkListSortBy').value.trim()
        const sortOrder = document.getElementById('pkListSortOrder').value.trim()
        const qs = new URLSearchParams({ limit: lim || '100', page: pg || '1' })
        if (q) qs.set('q', q)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        return apiBase + '/v1/packages?' + qs.toString()
      }
      function buildPackagesCsvUrl() {
        const lim = document.getElementById('pkListLimit').value.trim()
        const pg = document.getElementById('pkListPage').value.trim()
        const q = document.getElementById('pkListQuery').value.trim()
        const sortBy = document.getElementById('pkListSortBy').value.trim()
        const sortOrder = document.getElementById('pkListSortOrder').value.trim()
        const qs = new URLSearchParams({ limit: lim || '1000', page: pg || '1' })
        if (q) qs.set('q', q)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        return apiBase + '/v1/packages:csv?' + qs.toString()
      }
      async function copyPackagesCurl() {
        const url = buildPackagesQueryUrl()
        const token = getStoredToken()
        const curl = 'curl -X GET \"' + url + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      }
      async function copyPackagesCsvCurl() {
        const url = buildPackagesCsvUrl()
        const token = getStoredToken()
        const curl = 'curl -X GET \"' + url + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      }
      async function copyPkgVersionsCurl() {
        const url = buildPackageVersionsQueryUrl()
        const token = getStoredToken()
        const curl = 'curl -X GET \"' + url + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      }
      function buildPackageVersionsCsvUrl() {
        const qs = new URLSearchParams()
        const status = document.getElementById('pkgStatus').value.trim()
        const svcType = document.getElementById('pkgSvcType').value.trim()
        const q = document.getElementById('pkgQuery').value.trim()
        const effStart = document.getElementById('effStart').value.trim()
        const effEnd = document.getElementById('effEnd').value.trim()
        const mcc = document.getElementById('mcc').value.trim()
        const mnc = document.getElementById('mnc').value.trim()
        const mccmnc = document.getElementById('mccmnc').value.trim()
        const carrierNameLike = document.getElementById('carrierNameLike').value.trim()
        const mccmncList = document.getElementById('mccmncList').value.trim()
        const carrierNameExact = document.getElementById('carrierNameExact').value.trim()
        const apnLike = document.getElementById('apnLike').value.trim()
        const sortBy = document.getElementById('sortBy').value.trim()
        const sortOrder = document.getElementById('sortOrder').value.trim()
        const pkgFilterId = document.getElementById('pkgFilterSelect').value.trim()
        const lim = document.getElementById('pkgLimit').value.trim()
        const pg = document.getElementById('pkgPage').value.trim()
        if (status) qs.set('status', status)
        if (svcType) qs.set('serviceType', svcType)
        if (q) qs.set('q', q)
        if (effStart) qs.set('effectiveFromStart', effStart)
        if (effEnd) qs.set('effectiveFromEnd', effEnd)
        if (mcc) qs.set('mcc', mcc)
        if (mnc) qs.set('mnc', mnc)
        if (mccmnc) qs.set('mccmnc', mccmnc)
        if (carrierNameLike) qs.set('carrierNameLike', carrierNameLike)
        if (mccmncList) qs.set('mccmncList', mccmncList)
        if (carrierNameExact) qs.set('carrierName', carrierNameExact)
        if (apnLike) qs.set('apnLike', apnLike)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        if (pkgFilterId) qs.set('packageId', pkgFilterId)
        qs.set('limit', lim || '1000')
        qs.set('page', pg || '1')
        return apiBase + '/v1/package-versions:csv?' + qs.toString()
      }
      async function copyPkgVersionsCsvCurl() {
        const url = buildPackageVersionsCsvUrl()
        const token = getStoredToken()
        const curl = 'curl -X GET \"' + url + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      }
      function buildDocsUrlForPackages() {
        const base = apiBase + '/v1/docs'
        const lim = document.getElementById('pkListLimit').value.trim()
        const pg = document.getElementById('pkListPage').value.trim()
        const q = document.getElementById('pkListQuery').value.trim()
        const sortBy = document.getElementById('pkListSortBy').value.trim()
        const sortOrder = document.getElementById('pkListSortOrder').value.trim()
        const qs = new URLSearchParams()
        if (q) qs.set('pk_q', q)
        if (sortBy) qs.set('pk_sortBy', sortBy)
        if (sortOrder) qs.set('pk_sortOrder', sortOrder)
        if (lim) qs.set('pk_limit', lim)
        if (pg) qs.set('pk_page', pg)
        const s = qs.toString()
        return s ? (base + '?' + s) : base
      }
      function buildDocsUrlForBills() {
        const base = apiBase + '/v1/docs'
        const period = document.getElementById('billPeriod').value.trim()
        const status = document.getElementById('billStatus').value.trim()
        const sortBy = document.getElementById('billSortBy').value.trim()
        const sortOrder = document.getElementById('billSortOrder').value.trim()
        const lim = document.getElementById('billLimit').value.trim()
        const pg = document.getElementById('billPage').value.trim()
        const qs = new URLSearchParams()
        if (period) qs.set('bl_period', period)
        if (status) qs.set('bl_status', status)
        if (sortBy) qs.set('bl_sortBy', sortBy)
        if (sortOrder) qs.set('bl_sortOrder', sortOrder)
        if (lim) qs.set('bl_limit', lim)
        if (pg) qs.set('bl_page', pg)
        const s = qs.toString()
        return s ? (base + '?' + s) : base
      }
      function buildBillsShareParams() {
        const obj = {}
        const period = document.getElementById('billPeriod').value.trim()
        const status = document.getElementById('billStatus').value.trim()
        const sortBy = document.getElementById('billSortBy').value.trim()
        const sortOrder = document.getElementById('billSortOrder').value.trim()
        const lim = document.getElementById('billLimit').value.trim()
        const pg = document.getElementById('billPage').value.trim()
        if (period) obj.period = period
        if (status) obj.status = status
        if (sortBy) obj.sortBy = sortBy
        if (sortOrder) obj.sortOrder = sortOrder
        obj.limit = lim || '20'
        obj.page = pg || '1'
        return obj
      }
      function buildDocsUrlForPackageVersions() {
        const base = apiBase + '/v1/docs'
        const status = document.getElementById('pkgStatus').value.trim()
        const svcType = document.getElementById('pkgSvcType').value.trim()
        const q = document.getElementById('pkgQuery').value.trim()
        const effStart = document.getElementById('effStart').value.trim()
        const effEnd = document.getElementById('effEnd').value.trim()
        const mcc = document.getElementById('mcc').value.trim()
        const mnc = document.getElementById('mnc').value.trim()
        const mccmnc = document.getElementById('mccmnc').value.trim()
        const carrierNameLike = document.getElementById('carrierNameLike').value.trim()
        const mccmncList = document.getElementById('mccmncList').value.trim()
        const carrierNameExact = document.getElementById('carrierNameExact').value.trim()
        const apnLike = document.getElementById('apnLike').value.trim()
        const sortBy = document.getElementById('sortBy').value.trim()
        const sortOrder = document.getElementById('sortOrder').value.trim()
        const pkgFilterId = document.getElementById('pkgFilterSelect').value.trim()
        const lim = document.getElementById('pkgLimit').value.trim()
        const pg = document.getElementById('pkgPage').value.trim()
        const qs = new URLSearchParams()
        if (status) qs.set('pv_status', status)
        if (svcType) qs.set('pv_serviceType', svcType)
        if (q) qs.set('pv_q', q)
        if (effStart) qs.set('pv_effectiveFromStart', effStart)
        if (effEnd) qs.set('pv_effectiveFromEnd', effEnd)
        if (mcc) qs.set('pv_mcc', mcc)
        if (mnc) qs.set('pv_mnc', mnc)
        if (mccmnc) qs.set('pv_mccmnc', mccmnc)
        if (carrierNameLike) qs.set('pv_carrierNameLike', carrierNameLike)
        if (mccmncList) qs.set('pv_mccmncList', mccmncList)
        if (carrierNameExact) qs.set('pv_carrierName', carrierNameExact)
        if (apnLike) qs.set('pv_apnLike', apnLike)
        if (sortBy) qs.set('pv_sortBy', sortBy)
        if (sortOrder) qs.set('pv_sortOrder', sortOrder)
        if (pkgFilterId) qs.set('pv_packageId', pkgFilterId)
        if (lim) qs.set('pv_limit', lim)
        if (pg) qs.set('pv_page', pg)
        const s = qs.toString()
        return s ? (base + '?' + s) : base
      }
      function buildPackagesShareParams() {
        const lim = document.getElementById('pkListLimit').value.trim()
        const pg = document.getElementById('pkListPage').value.trim()
        const q = document.getElementById('pkListQuery').value.trim()
        const sortBy = document.getElementById('pkListSortBy').value.trim()
        const sortOrder = document.getElementById('pkListSortOrder').value.trim()
        const obj = {}
        if (q) obj.q = q
        if (sortBy) obj.sortBy = sortBy
        if (sortOrder) obj.sortOrder = sortOrder
        obj.limit = lim || '100'
        obj.page = pg || '1'
        return obj
      }
      function buildPackageVersionsShareParams() {
        const obj = {}
        const status = document.getElementById('pkgStatus').value.trim()
        const svcType = document.getElementById('pkgSvcType').value.trim()
        const q = document.getElementById('pkgQuery').value.trim()
        const effStart = document.getElementById('effStart').value.trim()
        const effEnd = document.getElementById('effEnd').value.trim()
        const mcc = document.getElementById('mcc').value.trim()
        const mnc = document.getElementById('mnc').value.trim()
        const mccmnc = document.getElementById('mccmnc').value.trim()
        const carrierNameLike = document.getElementById('carrierNameLike').value.trim()
        const mccmncList = document.getElementById('mccmncList').value.trim()
        const carrierNameExact = document.getElementById('carrierNameExact').value.trim()
        const apnLike = document.getElementById('apnLike').value.trim()
        const sortBy = document.getElementById('sortBy').value.trim()
        const sortOrder = document.getElementById('sortOrder').value.trim()
        const pkgFilterId = document.getElementById('pkgFilterSelect').value.trim()
        const lim = document.getElementById('pkgLimit').value.trim()
        const pg = document.getElementById('pkgPage').value.trim()
        if (status) obj.status = status
        if (svcType) obj.serviceType = svcType
        if (q) obj.q = q
        if (effStart) obj.effectiveFromStart = effStart
        if (effEnd) obj.effectiveFromEnd = effEnd
        if (mcc) obj.mcc = mcc
        if (mnc) obj.mnc = mnc
        if (mccmnc) obj.mccmnc = mccmnc
        if (carrierNameLike) obj.carrierNameLike = carrierNameLike
        if (mccmncList) obj.mccmncList = mccmncList
        if (carrierNameExact) obj.carrierName = carrierNameExact
        if (apnLike) obj.apnLike = apnLike
        if (sortBy) obj.sortBy = sortBy
        if (sortOrder) obj.sortOrder = sortOrder
        if (pkgFilterId) obj.packageId = pkgFilterId
        obj.limit = lim || '100'
        obj.page = pg || '1'
        return obj
      }
      async function createShareLink(kind, params) {
        try {
          const res = await fetch(apiBase + '/v1/share-links', { method: 'POST', headers: getAuthHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ kind, params }) })
          const text = await res.text()
          const data = text ? JSON.parse(text) : null
          if (data?.url) {
            try { await navigator.clipboard.writeText(data.url) } catch {}
            setOutput(data.url)
          }
        } catch {}
      }
      async function downloadCsv(url, filename) {
        try {
          const res = await fetch(url, { headers: getAuthHeaders() })
          const blob = await res.blob()
          const a = document.createElement('a')
          const urlObj = URL.createObjectURL(blob)
          a.href = urlObj
          a.download = filename
          document.body.appendChild(a)
          a.click()
          URL.revokeObjectURL(urlObj)
          a.remove()
        } catch {}
      }
      const subIccid = document.getElementById('subIccid')
      const pkgVerId = document.getElementById('pkgVerId')
      const pkgVerSelect = document.getElementById('pkgVerSelect')
      const pkgFilterSelect = document.getElementById('pkgFilterSelect')
      const pkgReload = document.getElementById('pkgReload')
      const pkgCsv = document.getElementById('pkgCsv')
      const pkgCopyQuery = document.getElementById('pkgCopyQuery')
      const pkgCopyCurl = document.getElementById('pkgCopyCurl')
      const pkgShare = document.getElementById('pkgShare')
      const pkgCopyDocsUrl = document.getElementById('pkgCopyDocsUrl')
      const pkListReload = document.getElementById('pkListReload')
      const pkListPrev = document.getElementById('pkListPrev')
      const pkListNext = document.getElementById('pkListNext')
      const pkListCsv = document.getElementById('pkListCsv')
      const pkListCopyQuery = document.getElementById('pkListCopyQuery')
      const pkListCopyCurl = document.getElementById('pkListCopyCurl')
      const pkListShare = document.getElementById('pkListShare')
      const pkListCopyDocsUrl = document.getElementById('pkListCopyDocsUrl')
      const billPeriod = document.getElementById('billPeriod')
      const billStatus = document.getElementById('billStatus')
      const billSortBy = document.getElementById('billSortBy')
      const billSortOrder = document.getElementById('billSortOrder')
      const billLimit = document.getElementById('billLimit')
      const billPage = document.getElementById('billPage')
      const billQuickThisMonth = document.getElementById('billQuickThisMonth')
      const billQuickLastMonth = document.getElementById('billQuickLastMonth')
      const billQuickOverdue = document.getElementById('billQuickOverdue')
      const billReload = document.getElementById('billReload')
      const billCsv = document.getElementById('billCsv')
      const billCsvCopyCurl = document.getElementById('billCsvCopyCurl')
      const billListCopyCurl = document.getElementById('billListCopyCurl')
      const billCopyDocsUrl = document.getElementById('billCopyDocsUrl')
      const billShare = document.getElementById('billShare')
      const billsTableContainer = document.getElementById('billsTableContainer')
      const simIccid = document.getElementById('simIccid')
      const simMsisdn = document.getElementById('simMsisdn')
      const simStatus = document.getElementById('simStatus')
      const simLimit = document.getElementById('simLimit')
      const simPage = document.getElementById('simPage')
      const simReload = document.getElementById('simReload')
      const simListCopyCurl = document.getElementById('simListCopyCurl')
      const simCsv = document.getElementById('simCsv')
      const simCsvCopyCurl = document.getElementById('simCsvCopyCurl')
      const simsTableContainer = document.getElementById('simsTableContainer')
      const pkgPrev = document.getElementById('pkgPrev')
      const pkgNext = document.getElementById('pkgNext')
      const btnAddMccmnc = document.getElementById('btnAddMccmnc')
      const btnClearMccmnc = document.getElementById('btnClearMccmnc')
      const subId = document.getElementById('subId')
      const kindSelect = document.getElementById('kindSelect')
      const effMode = document.getElementById('effMode')
      const effCustom = document.getElementById('effCustom')
      const btnCopyCurl = document.getElementById('btnCopyCurl')
      const adminApiKeyInput = document.getElementById('adminApiKey')
      const slEnterprise = document.getElementById('slEnterprise')
      const slKind = document.getElementById('slKind')
      const slCode = document.getElementById('slCode')
      const slCodePrefix = document.getElementById('slCodePrefix')
      const slCodeLike = document.getElementById('slCodeLike')
      const slRequestId = document.getElementById('slRequestId')
      const slStatus = document.getElementById('slStatus')
      const slExpiresFrom = document.getElementById('slExpiresFrom')
      const slExpiresTo = document.getElementById('slExpiresTo')
      const slSortOrder = document.getElementById('slSortOrder')
      const slSortBy = document.getElementById('slSortBy')
      const slLimit = document.getElementById('slLimit')
      const slPage = document.getElementById('slPage')
      const slFirst = document.getElementById('slFirst')
      const slPrev = document.getElementById('slPrev')
      const slNext = document.getElementById('slNext')
      const slLast = document.getElementById('slLast')
      const slQuickLast7 = document.getElementById('slQuickLast7')
      const slQuickNext7 = document.getElementById('slQuickNext7')
      const slQuickClear = document.getElementById('slQuickClear')
      const slQuickLast30 = document.getElementById('slQuickLast30')
      const slQuickNext30 = document.getElementById('slQuickNext30')
      const slQuickLast90 = document.getElementById('slQuickLast90')
      const slQuickNext90 = document.getElementById('slQuickNext90')
      const slQuickNext24h = document.getElementById('slQuickNext24h')
      const slQuickActive24h = document.getElementById('slQuickActive24h')
      const slQuickActive7d = document.getElementById('slQuickActive7d')
      const slQuickActive30d = document.getElementById('slQuickActive30d')
      const slQuickActive90d = document.getElementById('slQuickActive90d')
      const slQuickExpired24h = document.getElementById('slQuickExpired24h')
      const slQuickExpired7d = document.getElementById('slQuickExpired7d')
      const slQuickExpired30d = document.getElementById('slQuickExpired30d')
      const slQuickExpired90d = document.getElementById('slQuickExpired90d')
      const slClearStatus = document.getElementById('slClearStatus')
      const slReload = document.getElementById('slReload')
      const slCsv = document.getElementById('slCsv')
      const slCsvCopyCurl = document.getElementById('slCsvCopyCurl')
      const slListCopyCurl = document.getElementById('slListCopyCurl')
      const slCopyDocsUrl = document.getElementById('slCopyDocsUrl')
      const slCopySummary = document.getElementById('slCopySummary')
      const slClearAll = document.getElementById('slClearAll')
      const slInvalidate = document.getElementById('slInvalidate')
      const slDelete = document.getElementById('slDelete')
      const slTableContainer = document.getElementById('shareLinksTableContainer')
      const slPageStatus = document.getElementById('slPageStatus')
      let slTotal = 0
      const storedSortBy = getLocal('cmp_sl_sort_by')
      const storedSortOrder = getLocal('cmp_sl_sort_order')
      if (storedSortBy) slSortBy.value = storedSortBy
      if (storedSortOrder) slSortOrder.value = storedSortOrder
      restoreInputs()
      initFromQuery()
      subIccid.addEventListener('change', persistInputs)
      pkgVerId.addEventListener('change', persistInputs)
      pkgVerSelect.addEventListener('change', () => {
        pkgVerId.value = pkgVerSelect.value
        persistInputs()
      })
      pkgFilterSelect.addEventListener('change', async () => {
        await loadPackageVersions()
      })
      pkgReload.addEventListener('click', async () => {
        await loadPackageVersions()
      })
      pkgCopyQuery.addEventListener('click', async () => {
        const url = buildPackageVersionsQueryUrl()
        try { await navigator.clipboard.writeText(url) } catch {}
        setOutput(url)
      })
      pkgCopyCurl.addEventListener('click', async () => {
        await copyPkgVersionsCurl()
      })
      adminApiKeyInput.addEventListener('change', () => {
        setStoredAdminKey(adminApiKeyInput.value.trim())
      })
      slSortBy.addEventListener('change', () => {
        setLocal('cmp_sl_sort_by', slSortBy.value.trim())
      })
      slSortOrder.addEventListener('change', () => {
        setLocal('cmp_sl_sort_order', slSortOrder.value.trim())
      })
      function buildAdminShareLinksUrl() {
        const qs = new URLSearchParams()
        const ent = slEnterprise.value.trim()
        const kind = slKind.value.trim()
        const code = slCode.value.trim()
        const codePrefix = slCodePrefix.value.trim()
        const codeLike = slCodeLike.value.trim()
        const reqId = slRequestId.value.trim()
        const status = slStatus.value.trim()
        const exFrom = slExpiresFrom.value.trim()
        const exTo = slExpiresTo.value.trim()
        const sortBy = slSortBy.value.trim()
        const sortOrder = slSortOrder.value.trim()
        const lim = slLimit.value.trim()
        const pg = slPage.value.trim()
        if (ent) qs.set('enterpriseId', ent)
        if (kind) qs.set('kind', kind)
        if (code) qs.set('code', code)
        if (codePrefix) qs.set('codePrefix', codePrefix)
        if (codeLike) qs.set('codeLike', codeLike)
        if (reqId) qs.set('requestId', reqId)
        if (status) qs.set('status', status)
        function toIsoFromLocalInput(s) {
          if (!s) return ''
          const d = new Date(s)
          if (Number.isNaN(d.getTime())) return ''
          return d.toISOString()
        }
        const exFromIso = toIsoFromLocalInput(exFrom)
        const exToIso = toIsoFromLocalInput(exTo)
        if (exFromIso) qs.set('expiresFrom', exFromIso)
        if (exToIso) qs.set('expiresTo', exToIso)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        qs.set('limit', lim || '50')
        qs.set('page', pg || '1')
        return apiBase + '/v1/admin/share-links?' + qs.toString()
      }
      function buildAdminShareLinksCsvUrl() {
        const u = buildAdminShareLinksUrl()
        return u.replace('/share-links?', '/share-links:csv?')
      }
      const evEventType = document.getElementById('evEventType')
      const evTenantId = document.getElementById('evTenantId')
      const evRequestId = document.getElementById('evRequestId')
      const evIccid = document.getElementById('evIccid')
      const evBeforeStatus = document.getElementById('evBeforeStatus')
      const evAfterStatus = document.getElementById('evAfterStatus')
      const evReason = document.getElementById('evReason')
      const evStart = document.getElementById('evStart')
      const evEnd = document.getElementById('evEnd')
      const evSortOrder = document.getElementById('evSortOrder')
      const evLimit = document.getElementById('evLimit')
      const evPage = document.getElementById('evPage')
      const evQuickLast24h = document.getElementById('evQuickLast24h')
      const evQuickLast7d = document.getElementById('evQuickLast7d')
      const evQuickClear = document.getElementById('evQuickClear')
      const evFirst = document.getElementById('evFirst')
      const evPrev = document.getElementById('evPrev')
      const evNext = document.getElementById('evNext')
      const evLast = document.getElementById('evLast')
      const evReload = document.getElementById('evReload')
      const evCsv = document.getElementById('evCsv')
      const evCsvCopyCurl = document.getElementById('evCsvCopyCurl')
      const evListCopyCurl = document.getElementById('evListCopyCurl')
      const evTableContainer = document.getElementById('eventsTableContainer')
      const evPageStatus = document.getElementById('evPageStatus')
      let evTotal = 0
      function buildAdminEventsUrl() {
        const qs = new URLSearchParams()
        const eventType = evEventType.value.trim()
        const tenantId = evTenantId.value.trim()
        const requestId = evRequestId.value.trim()
        const iccid = evIccid.value.trim()
        const beforeStatus = evBeforeStatus.value.trim()
        const afterStatus = evAfterStatus.value.trim()
        const reason = evReason.value.trim()
        const sortOrder = evSortOrder.value.trim()
        const lim = evLimit.value.trim()
        const pg = evPage.value.trim()
        const st = evStart.value.trim()
        const en = evEnd.value.trim()
        function toIsoFromLocalInput(s) {
          if (!s) return ''
          const d = new Date(s)
          if (Number.isNaN(d.getTime())) return ''
          return d.toISOString()
        }
        const stIso = toIsoFromLocalInput(st)
        const enIso = toIsoFromLocalInput(en)
        if (eventType) qs.set('eventType', eventType)
        if (tenantId) qs.set('tenantId', tenantId)
        if (requestId) qs.set('requestId', requestId)
        if (iccid) qs.set('iccid', iccid)
        if (beforeStatus) qs.set('beforeStatus', beforeStatus)
        if (afterStatus) qs.set('afterStatus', afterStatus)
        if (reason) qs.set('reason', reason)
        if (stIso) qs.set('start', stIso)
        if (enIso) qs.set('end', enIso)
        if (sortOrder) {
          qs.set('sortBy', 'occurredAt')
          qs.set('sortOrder', sortOrder)
        }
        qs.set('limit', lim || '50')
        qs.set('page', pg || '1')
        return apiBase + '/v1/admin/events?' + qs.toString()
      }
      function buildAdminEventsCsvUrl() {
        const u = buildAdminEventsUrl()
        return u.replace('/events?', '/events:csv?')
      }
      async function loadAdminEvents() {
        const url = buildAdminEventsUrl()
        try {
          const res = await fetch(url, { headers: getAdminHeaders() })
          const text = await res.text()
          const data = text ? JSON.parse(text) : null
          const items = Array.isArray(data?.items) ? data.items : []
          evTotal = Number(data?.total || 0)
          const lim = Number(evLimit.value.trim() || '50')
          const pg = Number(evPage.value.trim() || '1')
          const pages = Math.max(1, Math.ceil((evTotal || 0) / Math.max(1, lim)))
          if (evPageStatus) evPageStatus.textContent = ' Page ' + pg + ' / ' + pages + ' | Total ' + evTotal
          const table = document.createElement('table')
          table.style.width = '100%'
          table.style.borderCollapse = 'collapse'
          function td(s, isHeader) {
            const el = document.createElement(isHeader ? 'th' : 'td')
            el.textContent = s
            el.style.border = '1px solid #e5e7eb'
            el.style.padding = '4px 6px'
            el.style.fontSize = '12px'
            return el
          }
          const header = document.createElement('tr')
          ;['eventId','eventType','occurredAt','tenantId','requestId','jobId','payload'].forEach((h) => header.appendChild(td(h, true)))
          table.appendChild(header)
          items.forEach((it) => {
            const tr = document.createElement('tr')
            tr.appendChild(td(String(it.eventId || '')))
            tr.appendChild(td(String(it.eventType || '')))
            tr.appendChild(td(String(it.occurredAt || '')))
            tr.appendChild(td(String(it.tenantId || '')))
            tr.appendChild(td(String(it.requestId || '')))
            tr.appendChild(td(String(it.jobId || '')))
            tr.appendChild(td(JSON.stringify(it.payload ?? {})))
            table.appendChild(tr)
          })
          evTableContainer.innerHTML = ''
          evTableContainer.appendChild(table)
        } catch {}
      }
      evCsv.addEventListener('click', async () => {
        const url = buildAdminEventsCsvUrl()
        try {
          const res = await fetch(url, { headers: getAdminHeaders() })
          const blob = await res.blob()
          const a = document.createElement('a')
          const urlObj = URL.createObjectURL(blob)
          a.href = urlObj
          a.download = 'events.csv'
          document.body.appendChild(a)
          a.click()
          URL.revokeObjectURL(urlObj)
          a.remove()
        } catch {}
      })
      evReload.addEventListener('click', async () => {
        await loadAdminEvents()
      })
      evFirst.addEventListener('click', async () => {
        evPage.value = '1'
        await loadAdminEvents()
      })
      evPrev.addEventListener('click', async () => {
        const cur = Number(evPage.value.trim() || '1')
        const next = Math.max(1, cur - 1)
        evPage.value = String(next)
        await loadAdminEvents()
      })
      evNext.addEventListener('click', async () => {
        const lim = Number(evLimit.value.trim() || '50')
        const pages = Math.max(1, Math.ceil((evTotal || 0) / Math.max(1, lim)))
        const cur = Number(evPage.value.trim() || '1')
        const next = Math.min(pages, cur + 1)
        evPage.value = String(next)
        await loadAdminEvents()
      })
      evLast.addEventListener('click', async () => {
        const lim = Number(evLimit.value.trim() || '50')
        const pages = Math.max(1, Math.ceil((evTotal || 0) / Math.max(1, lim)))
        evPage.value = String(pages)
        await loadAdminEvents()
      })
      evCsvCopyCurl.addEventListener('click', async () => {
        const url = buildAdminEventsCsvUrl()
        const k = getStoredAdminKey()
        const curl = 'curl -X GET \"' + url + '\"' + (k ? ' -H \"X-API-Key: ' + k + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })
      evListCopyCurl.addEventListener('click', async () => {
        const url = buildAdminEventsUrl()
        const k = getStoredAdminKey()
        const curl = 'curl -X GET "' + url + '"' + (k ? ' -H "X-API-Key: ' + k + '"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })

      const jobType = document.getElementById('jobType')
      const jobStatus = document.getElementById('jobStatus')
      const jobRequestId = document.getElementById('jobRequestId')
      const jobStart = document.getElementById('jobStart')
      const jobEnd = document.getElementById('jobEnd')
      const jobSortBy = document.getElementById('jobSortBy')
      const jobSortOrder = document.getElementById('jobSortOrder')
      const jobLimit = document.getElementById('jobLimit')
      const jobPage = document.getElementById('jobPage')
      const jobReload = document.getElementById('jobReload')
      const jobCsv = document.getElementById('jobCsv')
      const jobCsvCopyCurl = document.getElementById('jobCsvCopyCurl')
      const jobListCopyCurl = document.getElementById('jobListCopyCurl')
      const jobsTableContainer = document.getElementById('jobsTableContainer')
      const jobPageStatus = document.getElementById('jobPageStatus')
      let jobTotal = 0

      function buildAdminJobsUrl() {
        const qs = new URLSearchParams()
        const type = jobType.value.trim()
        const status = jobStatus.value.trim()
        const reqId = jobRequestId.value.trim()
        const sortBy = jobSortBy.value.trim()
        const sortOrder = jobSortOrder.value.trim()
        const lim = jobLimit.value.trim()
        const pg = jobPage.value.trim()
        const st = jobStart.value.trim()
        const en = jobEnd.value.trim()

        function toIsoFromLocalInput(s) {
          if (!s) return ''
          const d = new Date(s)
          if (Number.isNaN(d.getTime())) return ''
          return d.toISOString()
        }

        const stIso = toIsoFromLocalInput(st)
        const enIso = toIsoFromLocalInput(en)

        if (type) qs.set('jobType', type)
        if (status) qs.set('status', status)
        if (reqId) qs.set('requestId', reqId)
        if (stIso) qs.set('startDate', stIso)
        if (enIso) qs.set('endDate', enIso)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        qs.set('limit', lim || '50')
        qs.set('page', pg || '1')

        return apiBase + '/v1/admin/jobs?' + qs.toString()
      }

      function buildAdminJobsCsvUrl() {
        const u = buildAdminJobsUrl()
        return u.replace('/jobs?', '/jobs:csv?')
      }

      async function loadAdminJobs() {
        const url = buildAdminJobsUrl()
        try {
          const res = await fetch(url, { headers: getAdminHeaders() })
          const text = await res.text()
          const data = text ? JSON.parse(text) : null
          const items = Array.isArray(data?.items) ? data.items : []
          jobTotal = Number(data?.total || 0)
          const lim = Number(jobLimit.value.trim() || '50')
          const pg = Number(jobPage.value.trim() || '1')
          const pages = Math.max(1, Math.ceil((jobTotal || 0) / Math.max(1, lim)))
          if (jobPageStatus) jobPageStatus.textContent = ' Page ' + pg + ' / ' + pages + ' | Total ' + jobTotal

          const table = document.createElement('table')
          table.style.width = '100%'
          table.style.borderCollapse = 'collapse'
          function td(s, isHeader) {
            const el = document.createElement(isHeader ? 'th' : 'td')
            el.textContent = s
            el.style.border = '1px solid #e5e7eb'
            el.style.padding = '4px 6px'
            el.style.fontSize = '12px'
            return el
          }

          const header = document.createElement('tr')
          ;['jobId','jobType','status','progress','startedAt','finishedAt','requestId','error'].forEach((h) => header.appendChild(td(h, true)))
          table.appendChild(header)

          items.forEach((it) => {
            const tr = document.createElement('tr')
            tr.appendChild(td(String(it.jobId || '')))
            tr.appendChild(td(String(it.jobType || '')))
            tr.appendChild(td(String(it.status || '')))
            const prog = (it.progress?.processed ?? 0) + '/' + (it.progress?.total ?? 0)
            tr.appendChild(td(prog))
            tr.appendChild(td(String(it.startedAt || '')))
            tr.appendChild(td(String(it.finishedAt || '')))
            tr.appendChild(td(String(it.requestId || '')))
            tr.appendChild(td(String(it.errorSummary || '')))
            table.appendChild(tr)
          })

          jobsTableContainer.innerHTML = ''
          jobsTableContainer.appendChild(table)
        } catch {}
      }

      jobReload.addEventListener('click', async () => { await loadAdminJobs() })

      jobCsv.addEventListener('click', async () => {
        const url = buildAdminJobsCsvUrl()
        try {
          const res = await fetch(url, { headers: getAdminHeaders() })
          const blob = await res.blob()
          const a = document.createElement('a')
          const urlObj = URL.createObjectURL(blob)
          a.href = urlObj
          a.download = 'jobs.csv'
          document.body.appendChild(a)
          a.click()
          URL.revokeObjectURL(urlObj)
          a.remove()
        } catch {}
      })

      jobCsvCopyCurl.addEventListener('click', async () => {
        const url = buildAdminJobsCsvUrl()
        const k = getStoredAdminKey()
        const curl = 'curl -X GET "' + url + '"' + (k ? ' -H "X-API-Key: ' + k + '"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })

      jobListCopyCurl.addEventListener('click', async () => {
        const url = buildAdminJobsUrl()
        const k = getStoredAdminKey()
        const curl = 'curl -X GET "' + url + '"' + (k ? ' -H "X-API-Key: ' + k + '"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })

      const auditTenantId = document.getElementById('auditTenantId')
      const auditAction = document.getElementById('auditAction')
      const auditTargetType = document.getElementById('auditTargetType')
      const auditTargetId = document.getElementById('auditTargetId')
      const auditRequestId = document.getElementById('auditRequestId')
      const auditStart = document.getElementById('auditStart')
      const auditEnd = document.getElementById('auditEnd')
      const auditSortOrder = document.getElementById('auditSortOrder')
      const auditLimit = document.getElementById('auditLimit')
      const auditPage = document.getElementById('auditPage')
      const auditReload = document.getElementById('auditReload')
      const auditCsv = document.getElementById('auditCsv')
      const auditCsvCopyCurl = document.getElementById('auditCsvCopyCurl')
      const auditListCopyCurl = document.getElementById('auditListCopyCurl')
      const auditsTableContainer = document.getElementById('auditsTableContainer')
      const auditPageStatus = document.getElementById('auditPageStatus')
      let auditTotal = 0

      function buildAdminAuditsUrl() {
        const qs = new URLSearchParams()
        const tenant = auditTenantId.value.trim()
        const action = auditAction.value.trim()
        const targetType = auditTargetType.value.trim()
        const targetId = auditTargetId.value.trim()
        const reqId = auditRequestId.value.trim()
        const sortOrder = auditSortOrder.value.trim()
        const lim = auditLimit.value.trim()
        const pg = auditPage.value.trim()
        const st = auditStart.value.trim()
        const en = auditEnd.value.trim()

        function toIsoFromLocalInput(s) {
          if (!s) return ''
          const d = new Date(s)
          if (Number.isNaN(d.getTime())) return ''
          return d.toISOString()
        }

        const stIso = toIsoFromLocalInput(st)
        const enIso = toIsoFromLocalInput(en)

        if (tenant) qs.set('tenantId', tenant)
        if (action) qs.set('action', action)
        if (targetType) qs.set('targetType', targetType)
        if (targetId) qs.set('targetId', targetId)
        if (reqId) qs.set('requestId', reqId)
        if (stIso) qs.set('start', stIso)
        if (enIso) qs.set('end', enIso)
        if (sortOrder) {
          qs.set('sortBy', 'occurredAt')
          qs.set('sortOrder', sortOrder)
        }
        qs.set('limit', lim || '50')
        qs.set('page', pg || '1')

        return apiBase + '/v1/admin/audits?' + qs.toString()
      }

      function buildAdminAuditsCsvUrl() {
        const u = buildAdminAuditsUrl()
        return u.replace('/audits?', '/audits:csv?')
      }

      async function loadAdminAudits() {
        const url = buildAdminAuditsUrl()
        try {
          const res = await fetch(url, { headers: getAdminHeaders() })
          const text = await res.text()
          const data = text ? JSON.parse(text) : null
          const items = Array.isArray(data?.items) ? data.items : []
          auditTotal = Number(data?.total || 0)
          const lim = Number(auditLimit.value.trim() || '50')
          const pg = Number(auditPage.value.trim() || '1')
          const pages = Math.max(1, Math.ceil((auditTotal || 0) / Math.max(1, lim)))
          if (auditPageStatus) auditPageStatus.textContent = ' Page ' + pg + ' / ' + pages + ' | Total ' + auditTotal

          const table = document.createElement('table')
          table.style.width = '100%'
          table.style.borderCollapse = 'collapse'
          function td(s, isHeader) {
            const el = document.createElement(isHeader ? 'th' : 'td')
            el.textContent = s
            el.style.border = '1px solid #e5e7eb'
            el.style.padding = '4px 6px'
            el.style.fontSize = '12px'
            return el
          }

          const header = document.createElement('tr')
          ;['auditId','action','targetType','targetId','occurredAt','actor','tenantId','requestId','changes'].forEach((h) => header.appendChild(td(h, true)))
          table.appendChild(header)

          items.forEach((it) => {
            const tr = document.createElement('tr')
            tr.appendChild(td(String(it.auditId || '')))
            tr.appendChild(td(String(it.action || '')))
            tr.appendChild(td(String(it.targetType || '')))
            tr.appendChild(td(String(it.targetId || '')))
            tr.appendChild(td(String(it.occurredAt || '')))
            tr.appendChild(td(String(it.actor || '')))
            tr.appendChild(td(String(it.tenantId || '')))
            tr.appendChild(td(String(it.requestId || '')))
            tr.appendChild(td(JSON.stringify(it.changes ?? {})))
            table.appendChild(tr)
          })

          auditsTableContainer.innerHTML = ''
          auditsTableContainer.appendChild(table)
        } catch {}
      }

      auditReload.addEventListener('click', async () => { await loadAdminAudits() })

      auditCsv.addEventListener('click', async () => {
        const url = buildAdminAuditsCsvUrl()
        try {
          const res = await fetch(url, { headers: getAdminHeaders() })
          const blob = await res.blob()
          const a = document.createElement('a')
          const urlObj = URL.createObjectURL(blob)
          a.href = urlObj
          a.download = 'audits.csv'
          document.body.appendChild(a)
          a.click()
          URL.revokeObjectURL(urlObj)
          a.remove()
        } catch {}
      })

      auditCsvCopyCurl.addEventListener('click', async () => {
        const url = buildAdminAuditsCsvUrl()
        const k = getStoredAdminKey()
        const curl = 'curl -X GET "' + url + '"' + (k ? ' -H "X-API-Key: ' + k + '"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })

      auditListCopyCurl.addEventListener('click', async () => {
        const url = buildAdminAuditsUrl()
        const k = getStoredAdminKey()
        const curl = 'curl -X GET "' + url + '"' + (k ? ' -H "X-API-Key: ' + k + '"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })
      function buildDocsUrlForAdminShareLinks() {
        const base = apiBase + '/v1/docs'
        const qs = new URLSearchParams()
        const ent = slEnterprise.value.trim()
        const kind = slKind.value.trim()
        const code = slCode.value.trim()
        const codeLike = slCodeLike.value.trim()
        const reqId = slRequestId.value.trim()
        const status = slStatus.value.trim()
        const exFrom = slExpiresFrom.value.trim()
        const exTo = slExpiresTo.value.trim()
        const sortBy = slSortBy.value.trim()
        const sortOrder = slSortOrder.value.trim()
        const lim = slLimit.value.trim()
        const pg = slPage.value.trim()
        if (ent) qs.set('sl_enterpriseId', ent)
        if (kind) qs.set('sl_kind', kind)
        if (code) qs.set('sl_code', code)
        if (codeLike) qs.set('sl_codeLike', codeLike)
        if (reqId) qs.set('sl_requestId', reqId)
        if (status) qs.set('sl_status', status)
        if (exFrom) qs.set('sl_expiresFrom', exFrom)
        if (exTo) qs.set('sl_expiresTo', exTo)
        if (sortBy) qs.set('sl_sortBy', sortBy)
        if (sortOrder) qs.set('sl_sortOrder', sortOrder)
        if (lim) qs.set('sl_limit', lim)
        if (pg) qs.set('sl_page', pg)
        const s = qs.toString()
        return s ? (base + '?' + s) : base
      }
      async function loadAdminShareLinks() {
        const url = buildAdminShareLinksUrl()
        try {
          const res = await fetch(url, { headers: getAdminHeaders() })
          const text = await res.text()
          const data = text ? JSON.parse(text) : null
          const items = Array.isArray(data?.items) ? data.items : []
          slTotal = Number(data?.total || 0)
          const lim = Number(slLimit.value.trim() || '50')
          const pg = Number(slPage.value.trim() || '1')
          const pages = Math.max(1, Math.ceil((slTotal || 0) / Math.max(1, lim)))
          if (slPageStatus) slPageStatus.textContent = ' Page ' + pg + ' / ' + pages + ' | Total ' + slTotal
          const table = document.createElement('table')
          table.style.width = '100%'
          table.style.borderCollapse = 'collapse'
          function td(s, isHeader) {
            const el = document.createElement(isHeader ? 'th' : 'td')
            el.textContent = s
            el.style.border = '1px solid #e5e7eb'
            el.style.padding = '4px 6px'
            el.style.fontSize = '12px'
            return el
          }
          const header = document.createElement('tr')
          ;['code','enterpriseId','kind','expiresAt','createdAt','requestId','url','actions'].forEach((h) => header.appendChild(td(h, true)))
          table.appendChild(header)
          items.forEach((it) => {
            const tr = document.createElement('tr')
            tr.appendChild(td(String(it.code || '')))
            tr.appendChild(td(String(it.enterpriseId || '')))
            tr.appendChild(td(String(it.kind || '')))
            tr.appendChild(td(String(it.expiresAt || '')))
            tr.appendChild(td(String(it.createdAt || '')))
            tr.appendChild(td(String(it.requestId || '')))
            tr.appendChild(td(String(it.url || '')))
            const actTd = document.createElement('td')
            actTd.style.border = '1px solid #e5e7eb'
            actTd.style.padding = '4px 6px'
            actTd.style.fontSize = '12px'
            const btnInv = document.createElement('button')
            btnInv.className = 'secondary'
            btnInv.textContent = 'Invalidate'
            btnInv.addEventListener('click', async () => {
              try {
                const res = await fetch(apiBase + '/v1/admin/share-links/' + encodeURIComponent(String(it.code || '')) + ':invalidate', { method: 'POST', headers: getAdminHeaders({ 'Content-Type': 'application/json' }) })
                await res.text()
                await loadAdminShareLinks()
              } catch {}
            })
            const btnCopy = document.createElement('button')
            btnCopy.className = 'secondary'
            btnCopy.textContent = 'Copy URL'
            btnCopy.style.marginLeft = '6px'
            btnCopy.addEventListener('click', async () => {
              try { await navigator.clipboard.writeText(String(it.url || '')) } catch {}
              setOutput(String(it.url || ''))
            })
            const btnDel = document.createElement('button')
            btnDel.className = 'secondary'
            btnDel.textContent = 'Delete'
            btnDel.style.marginLeft = '6px'
            btnDel.addEventListener('click', async () => {
              try {
                const res = await fetch(apiBase + '/v1/admin/share-links/' + encodeURIComponent(String(it.code || '')), { method: 'DELETE', headers: getAdminHeaders() })
                await res.text()
                await loadAdminShareLinks()
              } catch {}
            })
            actTd.appendChild(btnInv)
            actTd.appendChild(btnCopy)
            actTd.appendChild(btnDel)
            tr.appendChild(actTd)
            table.appendChild(tr)
          })
          while (slTableContainer.firstChild) slTableContainer.removeChild(slTableContainer.firstChild)
          slTableContainer.appendChild(table)
        } catch {}
      }
      slReload.addEventListener('click', async () => { await loadAdminShareLinks() })
      function toLocalInputValue(dateObj) {
        const d = new Date(dateObj)
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        return y + '-' + m + '-' + day + 'T' + hh + ':' + mm
      }
      slQuickLast7.addEventListener('click', async () => {
        const now = new Date()
        const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        slExpiresFrom.value = toLocalInputValue(from)
        slExpiresTo.value = toLocalInputValue(now)
        await loadAdminShareLinks()
      })
      slQuickNext7.addEventListener('click', async () => {
        const now = new Date()
        const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        slExpiresFrom.value = toLocalInputValue(now)
        slExpiresTo.value = toLocalInputValue(to)
        await loadAdminShareLinks()
      })
      function rangeDaysFromNow(backDays, forwardDays) {
        const now = new Date()
        const from = new Date(now.getTime() - backDays * 24 * 60 * 60 * 1000)
        const to = new Date(now.getTime() + forwardDays * 24 * 60 * 60 * 1000)
        return { from, to }
      }
      slQuickLast30.addEventListener('click', async () => {
        const r = rangeDaysFromNow(30, 0)
        slExpiresFrom.value = toLocalInputValue(r.from)
        slExpiresTo.value = toLocalInputValue(new Date())
        await loadAdminShareLinks()
      })
      slQuickNext30.addEventListener('click', async () => {
        const r = rangeDaysFromNow(0, 30)
        slExpiresFrom.value = toLocalInputValue(new Date())
        slExpiresTo.value = toLocalInputValue(r.to)
        await loadAdminShareLinks()
      })
      slQuickLast90.addEventListener('click', async () => {
        const r = rangeDaysFromNow(90, 0)
        slExpiresFrom.value = toLocalInputValue(r.from)
        slExpiresTo.value = toLocalInputValue(new Date())
        await loadAdminShareLinks()
      })
      slQuickNext90.addEventListener('click', async () => {
        const r = rangeDaysFromNow(0, 90)
        slExpiresFrom.value = toLocalInputValue(new Date())
        slExpiresTo.value = toLocalInputValue(r.to)
        await loadAdminShareLinks()
      })
      slQuickNext24h.addEventListener('click', async () => {
        const now = new Date()
        const to = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        slExpiresFrom.value = toLocalInputValue(now)
        slExpiresTo.value = toLocalInputValue(to)
        await loadAdminShareLinks()
      })
      slQuickActive24h.addEventListener('click', async () => {
        const now = new Date()
        const to = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        slStatus.value = 'active'
        slExpiresFrom.value = toLocalInputValue(now)
        slExpiresTo.value = toLocalInputValue(to)
        await loadAdminShareLinks()
      })
      function setActiveForDays(days) {
        const now = new Date()
        const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
        slStatus.value = 'active'
        slExpiresFrom.value = toLocalInputValue(now)
        slExpiresTo.value = toLocalInputValue(to)
      }
      slQuickActive7d.addEventListener('click', async () => {
        setActiveForDays(7)
        await loadAdminShareLinks()
      })
      slQuickActive30d.addEventListener('click', async () => {
        setActiveForDays(30)
        await loadAdminShareLinks()
      })
      slQuickActive90d.addEventListener('click', async () => {
        setActiveForDays(90)
        await loadAdminShareLinks()
      })
      function setExpiredForDays(days) {
        const now = new Date()
        const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
        slStatus.value = 'expired'
        slExpiresFrom.value = toLocalInputValue(from)
        slExpiresTo.value = toLocalInputValue(now)
      }
      slQuickExpired24h.addEventListener('click', async () => {
        const now = new Date()
        const from = new Date(now.getTime() - 24 * 60 * 60 * 1000)
        slStatus.value = 'expired'
        slExpiresFrom.value = toLocalInputValue(from)
        slExpiresTo.value = toLocalInputValue(now)
        await loadAdminShareLinks()
      })
      slQuickExpired7d.addEventListener('click', async () => {
        setExpiredForDays(7)
        await loadAdminShareLinks()
      })
      slQuickExpired30d.addEventListener('click', async () => {
        setExpiredForDays(30)
        await loadAdminShareLinks()
      })
      slQuickExpired90d.addEventListener('click', async () => {
        setExpiredForDays(90)
        await loadAdminShareLinks()
      })
      slQuickClear.addEventListener('click', async () => {
        slExpiresFrom.value = ''
        slExpiresTo.value = ''
        await loadAdminShareLinks()
      })
      slClearStatus.addEventListener('click', async () => {
        slStatus.value = ''
        await loadAdminShareLinks()
      })
      slCsv.addEventListener('click', async () => {
        const url = buildAdminShareLinksCsvUrl()
        try {
          const res = await fetch(url, { headers: getAdminHeaders() })
          const blob = await res.blob()
          const a = document.createElement('a')
          const urlObj = URL.createObjectURL(blob)
          a.href = urlObj
          a.download = 'share_links.csv'
          document.body.appendChild(a)
          a.click()
          URL.revokeObjectURL(urlObj)
          a.remove()
        } catch {}
      })
      slFirst.addEventListener('click', async () => {
        slPage.value = '1'
        await loadAdminShareLinks()
      })
      slPrev.addEventListener('click', async () => {
        const cur = Number(slPage.value.trim() || '1')
        const next = Math.max(1, cur - 1)
        slPage.value = String(next)
        await loadAdminShareLinks()
      })
      slNext.addEventListener('click', async () => {
        const lim = Number(slLimit.value.trim() || '50')
        const cur = Number(slPage.value.trim() || '1')
        const pages = Math.max(1, Math.ceil((slTotal || 0) / Math.max(1, lim)))
        const next = Math.min(pages, cur + 1)
        slPage.value = String(next)
        await loadAdminShareLinks()
      })
      slLast.addEventListener('click', async () => {
        const lim = Number(slLimit.value.trim() || '50')
        const pages = Math.max(1, Math.ceil((slTotal || 0) / Math.max(1, lim)))
        slPage.value = String(pages)
        await loadAdminShareLinks()
      })
      slCsvCopyCurl.addEventListener('click', async () => {
        const url = buildAdminShareLinksCsvUrl()
        const k = getStoredAdminKey()
        const curl = 'curl -X GET \"' + url + '\"' + (k ? ' -H \"X-API-Key: ' + k + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })
      slListCopyCurl.addEventListener('click', async () => {
        const url = buildAdminShareLinksUrl()
        const k = getStoredAdminKey()
        const curl = 'curl -X GET \"' + url + '\"' + (k ? ' -H \"X-API-Key: ' + k + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })
      slCopyDocsUrl.addEventListener('click', async () => {
        const url = buildDocsUrlForAdminShareLinks()
        try { await navigator.clipboard.writeText(url) } catch {}
        setOutput(url)
      })
      slCopySummary.addEventListener('click', async () => {
        const kv = []
        const add = (k, v) => { if (v && String(v).trim().length > 0) kv.push(k + '=' + String(v).trim()) }
        add('enterpriseId', slEnterprise.value)
        add('kind', slKind.value)
        add('code', slCode.value)
        add('codePrefix', slCodePrefix.value)
        add('codeLike', slCodeLike.value)
        add('requestId', slRequestId.value)
        add('status', slStatus.value)
        add('expiresFrom', slExpiresFrom.value)
        add('expiresTo', slExpiresTo.value)
        add('sortBy', slSortBy.value)
        add('sortOrder', slSortOrder.value)
        add('limit', slLimit.value)
        add('page', slPage.value)
        const summary = kv.join(', ')
        try { await navigator.clipboard.writeText(summary) } catch {}
        setOutput(summary)
      })
      slClearAll.addEventListener('click', async () => {
        slEnterprise.value = ''
        slKind.value = ''
        slCode.value = ''
        slCodePrefix.value = ''
        slCodeLike.value = ''
        slRequestId.value = ''
        slStatus.value = ''
        slExpiresFrom.value = ''
        slExpiresTo.value = ''
        slPage.value = '1'
        await loadAdminShareLinks()
      })
      slInvalidate.addEventListener('click', async () => {
        const code = slCode.value.trim()
        if (!code) return
        try {
          const res = await fetch(apiBase + '/v1/admin/share-links/' + encodeURIComponent(code) + ':invalidate', { method: 'POST', headers: getAdminHeaders({ 'Content-Type': 'application/json' }) })
          await res.text()
          await loadAdminShareLinks()
        } catch {}
      })
      slDelete.addEventListener('click', async () => {
        const code = slCode.value.trim()
        if (!code) return
        try {
          const res = await fetch(apiBase + '/v1/admin/share-links/' + encodeURIComponent(code), { method: 'DELETE', headers: getAdminHeaders() })
          await res.text()
          await loadAdminShareLinks()
        } catch {}
      })
      pkgCsv.addEventListener('click', async () => {
        const qs = new URLSearchParams()
        const status = document.getElementById('pkgStatus').value.trim()
        const svcType = document.getElementById('pkgSvcType').value.trim()
        const q = document.getElementById('pkgQuery').value.trim()
        const effStart = document.getElementById('effStart').value.trim()
        const effEnd = document.getElementById('effEnd').value.trim()
        const mcc = document.getElementById('mcc').value.trim()
        const mnc = document.getElementById('mnc').value.trim()
        const mccmnc = document.getElementById('mccmnc').value.trim()
        const carrierNameLike = document.getElementById('carrierNameLike').value.trim()
        const mccmncList = document.getElementById('mccmncList').value.trim()
        const carrierNameExact = document.getElementById('carrierNameExact').value.trim()
        const apnLike = document.getElementById('apnLike').value.trim()
        const sortBy = document.getElementById('sortBy').value.trim()
        const sortOrder = document.getElementById('sortOrder').value.trim()
        const pkgFilterId = document.getElementById('pkgFilterSelect').value.trim()
        const lim = document.getElementById('pkgLimit').value.trim()
        const pg = document.getElementById('pkgPage').value.trim()
        if (status) qs.set('status', status)
        if (svcType) qs.set('serviceType', svcType)
        if (q) qs.set('q', q)
        if (effStart) qs.set('effectiveFromStart', effStart)
        if (effEnd) qs.set('effectiveFromEnd', effEnd)
        if (mcc) qs.set('mcc', mcc)
        if (mnc) qs.set('mnc', mnc)
        if (mccmnc) qs.set('mccmnc', mccmnc)
        if (carrierNameLike) qs.set('carrierNameLike', carrierNameLike)
        if (mccmncList) qs.set('mccmncList', mccmncList)
        if (carrierNameExact) qs.set('carrierName', carrierNameExact)
        if (apnLike) qs.set('apnLike', apnLike)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        if (pkgFilterId) qs.set('packageId', pkgFilterId)
        qs.set('limit', lim || '1000')
        qs.set('page', pg || '1')
        await downloadCsv(apiBase + '/v1/package-versions:csv?' + qs.toString(), 'package_versions.csv')
      })
      document.getElementById('pkgCsvCopyCurl').addEventListener('click', async () => {
        await copyPkgVersionsCsvCurl()
      })
      pkgShare.addEventListener('click', async () => {
        const params = buildPackageVersionsShareParams()
        await createShareLink('packageVersions', params)
      })
      pkgCopyDocsUrl.addEventListener('click', async () => {
        const url = buildDocsUrlForPackageVersions()
        try { await navigator.clipboard.writeText(url) } catch {}
        setOutput(url)
      })
      pkListReload.addEventListener('click', async () => {
        await loadPackagesCard()
      })
      function buildBillsQueryUrl() {
        const period = billPeriod.value.trim()
        const status = billStatus.value.trim()
        const sortBy = billSortBy.value.trim()
        const sortOrder = billSortOrder.value.trim()
        const lim = billLimit.value.trim()
        const pg = billPage.value.trim()
        const qs = new URLSearchParams({ limit: lim || '20', page: pg || '1' })
        if (period) qs.set('period', period)
        if (status) qs.set('status', status)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        return apiBase + '/v1/bills?' + qs.toString()
      }
      function buildBillsCsvUrl() {
        const period = billPeriod.value.trim()
        const status = billStatus.value.trim()
        const sortBy = billSortBy.value.trim()
        const sortOrder = billSortOrder.value.trim()
        const lim = billLimit.value.trim()
        const pg = billPage.value.trim()
        const qs = new URLSearchParams({ limit: lim || '1000', page: pg || '1' })
        if (period) qs.set('period', period)
        if (status) qs.set('status', status)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        return apiBase + '/v1/bills:csv?' + qs.toString()
      }
      function buildSimsQueryUrl() {
        const iccid = simIccid.value.trim()
        const msisdn = simMsisdn.value.trim()
        const status = simStatus.value.trim()
        const lim = simLimit.value.trim()
        const pg = simPage.value.trim()
        const qs = new URLSearchParams({ limit: lim || '20', page: pg || '1' })
        if (iccid) qs.set('iccid', iccid)
        if (msisdn) qs.set('msisdn', msisdn)
        if (status) qs.set('status', status)
        return apiBase + '/v1/sims?' + qs.toString()
      }
      function buildSimsCsvUrl() {
        const iccid = simIccid.value.trim()
        const msisdn = simMsisdn.value.trim()
        const status = simStatus.value.trim()
        const lim = simLimit.value.trim()
        const pg = simPage.value.trim()
        const qs = new URLSearchParams({ limit: lim || '1000', page: pg || '1' })
        if (iccid) qs.set('iccid', iccid)
        if (msisdn) qs.set('msisdn', msisdn)
        if (status) qs.set('status', status)
        return apiBase + '/v1/sims:csv?' + qs.toString()
      }
      async function copyBillsCurl() {
        const url = buildBillsQueryUrl()
        const token = getStoredToken()
        const curl = 'curl -X GET \"' + url + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      }
      async function copySimsCurl() {
        const url = buildSimsQueryUrl()
        const token = getStoredToken()
        const curl = 'curl -X GET \"' + url + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      }
      simCsv.addEventListener('click', async () => {
        const url = buildSimsCsvUrl()
        await downloadCsv(url, 'sims.csv')
      })
      simCsvCopyCurl.addEventListener('click', async () => {
        const url = buildSimsCsvUrl()
        const token = getStoredToken()
        const curl = 'curl -X GET \"' + url + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      })
      async function copyBillsCsvCurl() {
        const url = buildBillsCsvUrl()
        const token = getStoredToken()
        const curl = 'curl -X GET \"' + url + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
        try { await navigator.clipboard.writeText(curl) } catch {}
        setOutput(curl)
      }
      async function loadBills() {
        try {
          const url = buildBillsQueryUrl()
          const res = await fetch(url, { headers: getAuthHeaders() })
          const text = await res.text()
          const data = text ? JSON.parse(text) : null
          const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : [])
          const table = document.createElement('table')
          table.style.width = '100%'
          table.style.borderCollapse = 'collapse'
          function td(s, isHeader) {
            const el = document.createElement(isHeader ? 'th' : 'td')
            el.textContent = s
            el.style.border = '1px solid #e5e7eb'
            el.style.padding = '4px 6px'
            el.style.fontSize = '12px'
            return el
          }
          const header = document.createElement('tr')
          ;['billId','period','status','dueDate','currency','totalAmount','actions'].forEach((h) => header.appendChild(td(h, true)))
          table.appendChild(header)
          items.forEach((it) => {
            const tr = document.createElement('tr')
            const billId = String(it.billId || it.bill_id || '')
            tr.appendChild(td(String(billId)))
            tr.appendChild(td(String((it.period || '').slice(0, 7))))
            tr.appendChild(td(String(it.status || '')))
            tr.appendChild(td(String(it.dueDate || it.due_date || '')))
            tr.appendChild(td(String(it.currency || '')))
            tr.appendChild(td(String(typeof it.totalAmount === 'number' ? it.totalAmount : (it.total_amount ?? ''))))
            const actTd = document.createElement('td')
            actTd.style.border = '1px solid #e5e7eb'
            actTd.style.padding = '4px 6px'
            actTd.style.fontSize = '12px'
            const btnCsv = document.createElement('button')
            btnCsv.className = 'secondary'
            btnCsv.textContent = 'CSV'
            btnCsv.addEventListener('click', async () => {
              const u = apiBase + '/v1/bills/' + encodeURIComponent(billId) + '/files/csv'
              await downloadCsv(u, 'bill-' + billId + '.csv')
            })
            const btnCurl = document.createElement('button')
            btnCurl.className = 'secondary'
            btnCurl.textContent = 'Copy CSV cURL'
            btnCurl.style.marginLeft = '6px'
            btnCurl.addEventListener('click', async () => {
              const u = apiBase + '/v1/bills/' + encodeURIComponent(billId) + '/files/csv'
              const token = getStoredToken()
              const curl = 'curl -X GET \"' + u + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
              try { await navigator.clipboard.writeText(curl) } catch {}
              setOutput(curl)
            })
            actTd.appendChild(btnCsv)
            actTd.appendChild(btnCurl)
            tr.appendChild(actTd)
            table.appendChild(tr)
          })
          while (billsTableContainer.firstChild) billsTableContainer.removeChild(billsTableContainer.firstChild)
          billsTableContainer.appendChild(table)
        } catch {}
      }
      async function loadSims() {
        try {
          const url = buildSimsQueryUrl()
          const res = await fetch(url, { headers: getAuthHeaders() })
          const text = await res.text()
          const data = text ? JSON.parse(text) : null
          const items = Array.isArray(data?.items) ? data.items : []
          const table = document.createElement('table')
          table.style.width = '100%'
          table.style.borderCollapse = 'collapse'
          function td(s, isHeader) {
            const el = document.createElement(isHeader ? 'th' : 'td')
            el.textContent = s
            el.style.border = '1px solid #e5e7eb'
            el.style.padding = '4px 6px'
            el.style.fontSize = '12px'
            return el
          }
          const header = document.createElement('tr')
          ;['iccid','imsi','msisdn','status','apn','activationDate','imeiLocked','actions'].forEach((h) => header.appendChild(td(h, true)))
          table.appendChild(header)
          items.forEach((it) => {
            const tr = document.createElement('tr')
            const iccid = String(it.iccid || '')
            tr.appendChild(td(String(iccid)))
            tr.appendChild(td(String(it.imsi || '')))
            tr.appendChild(td(String(it.msisdn || '')))
            tr.appendChild(td(String(it.status || '')))
            tr.appendChild(td(String(it.apn || '')))
            tr.appendChild(td(String(it.activationDate || '')))
            tr.appendChild(td(String(it.imeiLocked ? 'true' : 'false')))
            const actTd = document.createElement('td')
            actTd.style.border = '1px solid #e5e7eb'
            actTd.style.padding = '4px 6px'
            actTd.style.fontSize = '12px'
            const btnSubs = document.createElement('button')
            btnSubs.className = 'secondary'
            btnSubs.textContent = 'Subscriptions'
            btnSubs.addEventListener('click', async () => {
              try {
                const r = await fetch(apiBase + '/v1/sims/' + encodeURIComponent(iccid) + '/subscriptions', { headers: getAuthHeaders() })
                const txt = await r.text()
                const json = txt ? JSON.parse(txt) : null
                setOutput(json)
              } catch {}
            })
            const btnCurl = document.createElement('button')
            btnCurl.className = 'secondary'
            btnCurl.textContent = 'Copy Subs cURL'
            btnCurl.style.marginLeft = '6px'
            btnCurl.addEventListener('click', async () => {
              const u = apiBase + '/v1/sims/' + encodeURIComponent(iccid) + '/subscriptions'
              const token = getStoredToken()
              const curl = 'curl -X GET \"' + u + '\"' + (token ? ' -H \"Authorization: Bearer ' + token + '\"' : '')
              try { await navigator.clipboard.writeText(curl) } catch {}
              setOutput(curl)
            })
            actTd.appendChild(btnSubs)
            actTd.appendChild(btnCurl)
            tr.appendChild(actTd)
            table.appendChild(tr)
          })
          while (simsTableContainer.firstChild) simsTableContainer.removeChild(simsTableContainer.firstChild)
          simsTableContainer.appendChild(table)
        } catch {}
      }
      billReload.addEventListener('click', async () => { await loadBills() })
      billListCopyCurl.addEventListener('click', async () => { await copyBillsCurl() })
      billCopyDocsUrl.addEventListener('click', async () => {
        const url = buildDocsUrlForBills()
        try { await navigator.clipboard.writeText(url) } catch {}
        setOutput(url)
      })
      simReload.addEventListener('click', async () => { await loadSims() })
      simListCopyCurl.addEventListener('click', async () => { await copySimsCurl() })
      billShare?.addEventListener('click', async () => {
        const params = buildBillsShareParams()
        await createShareLink('bills', params)
      })
      billQuickThisMonth.addEventListener('click', async () => {
        const d = new Date()
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        billPeriod.value = y + '-' + m
        await loadBills()
      })
      billQuickLastMonth.addEventListener('click', async () => {
        const d = new Date()
        let y = d.getFullYear()
        let m = d.getMonth()
        m = m - 1
        if (m < 0) { m = 11; y = y - 1 }
        billPeriod.value = y + '-' + String(m + 1).padStart(2, '0')
        await loadBills()
      })
      billQuickOverdue.addEventListener('click', async () => {
        billStatus.value = 'GENERATED'
        billSortBy.value = 'dueDate'
        billSortOrder.value = ''
        await loadBills()
      })
      billCsv.addEventListener('click', async () => {
        const url = buildBillsCsvUrl()
        await downloadCsv(url, 'bills.csv')
      })
      billCsvCopyCurl.addEventListener('click', async () => {
        await copyBillsCsvCurl()
      })
      pkListCsv.addEventListener('click', async () => {
        const lim = document.getElementById('pkListLimit').value.trim()
        const pg = document.getElementById('pkListPage').value.trim()
        const q = document.getElementById('pkListQuery').value.trim()
        const sortBy = document.getElementById('pkListSortBy').value.trim()
        const sortOrder = document.getElementById('pkListSortOrder').value.trim()
        const qs = new URLSearchParams({ limit: lim || '1000', page: pg || '1' })
        if (q) qs.set('q', q)
        if (sortBy) qs.set('sortBy', sortBy)
        if (sortOrder) qs.set('sortOrder', sortOrder)
        await downloadCsv(apiBase + '/v1/packages:csv?' + qs.toString(), 'packages.csv')
      })
      pkListCopyQuery.addEventListener('click', async () => {
        const url = buildPackagesQueryUrl()
        try { await navigator.clipboard.writeText(url) } catch {}
        setOutput(url)
      })
      pkListCopyCurl.addEventListener('click', async () => {
        await copyPackagesCurl()
      })
      pkListShare.addEventListener('click', async () => {
        const params = buildPackagesShareParams()
        await createShareLink('packages', params)
      })
      pkListCopyDocsUrl.addEventListener('click', async () => {
        const url = buildDocsUrlForPackages()
        try { await navigator.clipboard.writeText(url) } catch {}
        setOutput(url)
      })
      document.getElementById('pkListCsvCopyCurl').addEventListener('click', async () => {
        await copyPackagesCsvCurl()
      })
      btnAddMccmnc.addEventListener('click', async () => {
        await addMccmncFromBuilder()
      })
      btnClearMccmnc.addEventListener('click', async () => {
        await clearMccmncBuilder()
      })
      pkListPrev.addEventListener('click', async () => {
        const pgEl = document.getElementById('pkListPage')
        const cur = Math.max(1, Number(pgEl.value.trim() || '1'))
        const next = Math.max(1, cur - 1)
        pgEl.value = String(next)
        await loadPackagesCard()
      })
      pkListNext.addEventListener('click', async () => {
        const pgEl = document.getElementById('pkListPage')
        const cur = Math.max(1, Number(pgEl.value.trim() || '1'))
        const next = cur + 1
        pgEl.value = String(next)
        await loadPackagesCard()
      })
      pkgPrev.addEventListener('click', async () => {
        const pgEl = document.getElementById('pkgPage')
        const cur = Math.max(1, Number(pgEl.value.trim() || '1'))
        const next = Math.max(1, cur - 1)
        pgEl.value = String(next)
        await loadPackageVersions()
      })
      pkgNext.addEventListener('click', async () => {
        const pgEl = document.getElementById('pkgPage')
        const cur = Math.max(1, Number(pgEl.value.trim() || '1'))
        const next = cur + 1
        pgEl.value = String(next)
        await loadPackageVersions()
      })
      document.getElementById('pkgClear').addEventListener('click', async () => {
        const ids = ['pkgStatus','pkgSvcType','pkgQuery','effStart','effEnd','mcc','mnc','mccmnc','carrierNameLike','mccmncList','carrierNameExact','apnLike','sortBy','sortOrder','pkgLimit','pkgPage']
        ids.forEach((id) => {
          const el = document.getElementById(id)
          if (el && el.tagName === 'SELECT') { el.value = '' } else if (el) { el.value = '' }
        })
        await loadPackageVersions()
      })
      if (getStoredToken()) {
        loadPackagesForFilter()
        try { loadPackagesCard() } catch {}
        try { loadPackageVersions() } catch {}
        try { loadSims() } catch {}
        try { refreshCsvButtonsState() } catch {}
      } else {
        setStatus('Authorize to load data')
      }
      subId.addEventListener('change', persistInputs)
      kindSelect.addEventListener('change', persistInputs)
      effMode.addEventListener('change', persistInputs)
      effCustom.addEventListener('change', persistInputs)
      if (getStoredToken()) { try { loadPackageVersions() } catch {} }
      document.getElementById('btnCreateSub').addEventListener('click', async () => {
        const iccid = subIccid.value.trim()
        const pkgv = pkgVerId.value.trim()
        if (!iccid || !pkgv) return setOutput({ error: 'missing_iccid_or_packageVersionId' })
        const kind = (kindSelect.value || 'MAIN')
        const effectiveAt = effCustom.value.trim() ? effCustom.value.trim() : (effMode.value === 'nextCycle' ? firstDayNextMonthUtc() : new Date().toISOString())
        const body = { iccid, packageVersionId: pkgv, kind, effectiveAt }
        const r = await postJson(apiBase + '/v1/subscriptions', body)
        setOutput(r)
      })
      document.getElementById('btnSwitchSub').addEventListener('click', async () => {
        const iccid = subIccid.value.trim()
        const toPkgv = pkgVerId.value.trim()
        if (!iccid || !toPkgv) return setOutput({ error: 'missing_iccid_or_newPackageVersionId' })
        const effectiveStrategy = effMode.value === 'nextCycle' ? 'NEXT_CYCLE' : 'IMMEDIATE'
        const body = { iccid, newPackageVersionId: toPkgv, effectiveStrategy }
        const r = await postJson(apiBase + '/v1/subscriptions:switch', body)
        setOutput(r)
      })
      document.getElementById('btnCancelImmediate').addEventListener('click', async () => {
        const id = subId.value.trim()
        if (!id) return setOutput({ error: 'missing_subscriptionId' })
        const r = await postJson(apiBase + '/v1/subscriptions/' + encodeURIComponent(id) + ':cancel?immediate=true', {})
        setOutput(r)
      })
      document.getElementById('btnCancelEom').addEventListener('click', async () => {
        const id = subId.value.trim()
        if (!id) return setOutput({ error: 'missing_subscriptionId' })
        const r = await postJson(apiBase + '/v1/subscriptions/' + encodeURIComponent(id) + ':cancel?immediate=false', {})
        setOutput(r)
      })
      document.getElementById('btnListSubs').addEventListener('click', async () => {
        const iccid = subIccid.value.trim()
        if (!iccid) return setOutput({ error: 'missing_iccid' })
        const r = await getJson(apiBase + '/v1/sims/' + encodeURIComponent(iccid) + '/subscriptions')
        setOutput(r)
      })
      btnCopyCurl.addEventListener('click', async () => {
        const token = getStoredToken()
        const iccid = subIccid.value.trim()
        const pkgv = pkgVerId.value.trim()
        const sid = subId.value.trim()
        const kind = (kindSelect.value || 'MAIN')
        const effAt = effMode.value === 'nextCycle' ? firstDayNextMonthUtc() : new Date().toISOString()
        const lines = []
        lines.push('# Copy one of the following cURL examples:')
        if (iccid && pkgv) {
          lines.push('curl -X POST "' + apiBase + '/v1/subscriptions" -H "Authorization: Bearer ' + (token || '<token>') + '" -H "Content-Type: application/json" -d ' + JSON.stringify({ iccid, packageVersionId: pkgv, kind, effectiveAt: effAt }))
        }
        if (iccid && pkgv) {
          lines.push('curl -X POST "' + apiBase + '/v1/subscriptions:switch" -H "Authorization: Bearer ' + (token || '<token>') + '" -H "Content-Type: application/json" -d ' + JSON.stringify({ iccid, newPackageVersionId: pkgv, effectiveStrategy: 'NEXT_CYCLE' }))
        }
        if (sid) {
          lines.push('curl -X POST "' + apiBase + '/v1/subscriptions/' + encodeURIComponent(sid) + ':cancel?immediate=true" -H "Authorization: Bearer ' + (token || '<token>') + '" -H "Content-Type: application/json" -d {}')
          lines.push('curl -X POST "' + apiBase + '/v1/subscriptions/' + encodeURIComponent(sid) + ':cancel?immediate=false" -H "Authorization: Bearer ' + (token || '<token>') + '" -H "Content-Type: application/json" -d {}')
        }
        if (iccid) {
          lines.push('curl -X GET "' + apiBase + '/v1/sims/' + encodeURIComponent(iccid) + '/subscriptions" -H "Authorization: Bearer ' + (token || '<token>') + '"')
        }
        setOutput(lines.join('\\n'))
        try { await navigator.clipboard.writeText(lines.join('\\n')) } catch {}
      })
    </script>
  </body>
</html>`
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  }

  app.get('/docs', serveDocs)
  app.get('/v1/docs', serveDocs)
  app.get('/favicon.ico', (req, res) => res.status(204).end())

  const here = path.dirname(fileURLToPath(import.meta.url))
  const swaggerDist = path.resolve(here, '..', 'node_modules', 'swagger-ui-dist')
  app.get('/v1/docs/assets/swagger-ui-bundle.js', async (req, res) => {
    try {
      const jsPath = path.resolve(swaggerDist, 'swagger-ui-bundle.js')
      const content = await readFile(jsPath, 'utf8')
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
      res.send(content)
    } catch {
      res.status(404).end()
    }
  })
  app.get('/docs/assets/swagger-ui-bundle.js', async (req, res) => {
    try {
      const jsPath = path.resolve(swaggerDist, 'swagger-ui-bundle.js')
      const content = await readFile(jsPath, 'utf8')
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
      res.send(content)
    } catch {
      res.status(404).end()
    }
  })
  app.get('/v1/docs/assets/swagger-ui.css', async (req, res) => {
    try {
      const cssPath = path.resolve(swaggerDist, 'swagger-ui.css')
      const content = await readFile(cssPath, 'utf8')
      res.setHeader('Content-Type', 'text/css; charset=utf-8')
      res.send(content)
    } catch {
      res.status(404).end()
    }
  })
  app.get('/docs/assets/swagger-ui.css', async (req, res) => {
    try {
      const cssPath = path.resolve(swaggerDist, 'swagger-ui.css')
      const content = await readFile(cssPath, 'utf8')
      res.setHeader('Content-Type', 'text/css; charset=utf-8')
      res.send(content)
    } catch {
      res.status(404).end()
    }
  })

  const shareStore = new Map()
  function genShareCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let s = ''
    for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
    return s
  }
  function isSupabaseConfiguredForWrite() {
    return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY)
  }
  app.post('/v1/share-links', async (req, res) => {
    const enterpriseId = getEnterpriseIdFromReq(req)
    const isPlatform = getRoleScope(req) === 'platform'
    if (!enterpriseId && !isPlatform) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
    }
    const baseUrl = buildBaseUrl(req)
    const kind = String(req.body?.kind || '')
    const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : null
    const visibility = req.body?.visibility ? String(req.body.visibility) : 'tenant'
    const ttlHoursRaw = req.body?.ttlHours !== undefined && req.body?.ttlHours !== null ? Number(req.body.ttlHours) : null
    const ttlHours = Number.isFinite(ttlHoursRaw) && ttlHoursRaw > 0 ? Math.min(ttlHoursRaw, 24 * 30) : 24 * 7
    if (!['packages', 'packageVersions', 'bills'].includes(kind) || !params) {
      return sendError(res, 400, 'BAD_REQUEST', 'kind and params are required.')
    }
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString()
    const code = genShareCode()
    const entry = { kind, params, tenantId: enterpriseId, visibility, expiresAt, createdAt: now.toISOString(), requestId: getTraceId(res) }
    const allowBillsInDb = process.env.SHARE_LINKS_ALLOW_BILLS_DB === '1'
    if (isSupabaseConfiguredForWrite() && (kind !== 'bills' || allowBillsInDb)) {
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
          request_id: getTraceId(res),
        }, { returning: 'minimal' })
        return res.json({ code, url: `${baseUrl}/v1/s/${code}` })
      } catch (err) {
        // fallback to in-memory store if DB unavailable
      }
    }
    shareStore.set(code, entry)
    res.json({ code, url: `${baseUrl}/v1/s/${code}` })
  })
  app.get('/v1/s/:code.json', async (req, res) => {
    const enterpriseId = getEnterpriseIdFromReq(req)
    const code = String(req.params?.code || '')
    let row = null
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
      if (!enterpriseId && getRoleScope(req) !== 'platform') {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required to open this link.')
      }
      if (enterpriseId && String(entry.tenantId || '') !== String(enterpriseId)) {
        return sendError(res, 403, 'FORBIDDEN', 'This link belongs to a different tenant.')
      }
    }
    res.json({ kind: entry.kind, params: entry.params })
  })
  app.get('/v1/s/:code', async (req, res) => {
    const enterpriseId = getEnterpriseIdFromReq(req)
    const baseUrl = buildBaseUrl(req)
    const code = String(req.params?.code || '')
    let row = null
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

  app.post('/v1/cmp/webhook/sim-status-changed', async (req, res) => {
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
  app.post('/v1/auth/token', handleAuthToken)
  app.post('/auth/token', handleAuthToken)
  app.post('/v1/auth/login', handleAuthLogin)
  app.post('/auth/login', handleAuthLogin)
  app.post('/v1/auth/refresh', handleAuthRefresh)
  app.post('/auth/refresh', handleAuthRefresh)

  function mountResellerRoutes(prefix) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const mapStatusToStorage = (status) => {
      const v = status ? String(status).toUpperCase() : ''
      if (v === 'ACTIVE') return 'active'
      if (v === 'SUSPENDED') return 'suspended'
      if (v === 'DEACTIVATED') return 'deactivated'
      return null
    }
    const mapStatusFromStorage = (status) => {
      const v = status ? String(status).toLowerCase() : ''
      if (v === 'deactivated') return 'DEACTIVATED'
      if (v === 'suspended') return 'SUSPENDED'
      return 'ACTIVE'
    }
    const requirePlatform = (req, res) => {
      const roleScope = getRoleScope(req)
      const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
      if (!roleScope && !role) {
        sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
        return false
      }
      if (roleScope === 'platform' || role === 'platform_admin') return true
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return false
    }

    app.post(`${prefix}/resellers`, async (req, res) => {
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
      const existing = await supabase.select(
        'resellers',
        `select=id&name=eq.${encodeURIComponent(name)}&limit=1`
      )
      if (Array.isArray(existing) && existing.length > 0) {
        return sendError(res, 409, 'DUPLICATE_NAME', 'Reseller name already exists.')
      }

      const createdBy = req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null
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
      const tenantRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(reseller.id)}&tenant_type=eq.RESELLER&limit=1`
      )
      if (!Array.isArray(tenantRows) || tenantRows.length === 0) {
        await supabase.insert('tenants', {
          tenant_id: reseller.id,
          tenant_type: 'RESELLER',
          name,
        })
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

    app.get(`${prefix}/resellers`, async (req, res) => {
      if (!requirePlatform(req, res)) return
      const statusInput = req.query.status ? String(req.query.status) : null
      const storageStatus = statusInput ? mapStatusToStorage(statusInput) : null
      const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
      if (statusInput && !storageStatus) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, DEACTIVATED, or SUSPENDED.')
      }
      if (operatorId && !isValidUuid(operatorId)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
      }
      const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const filters = []
      if (storageStatus) filters.push(`status=eq.${encodeURIComponent(storageStatus)}`)
      if (operatorId) {
        const simRows = await supabase.select(
          'sims',
          `select=enterprise_id&operator_id=eq.${encodeURIComponent(operatorId)}`
        )
        const enterpriseIds = Array.from(
          new Set((Array.isArray(simRows) ? simRows : []).map((row) => row.enterprise_id).filter(Boolean).map((id) => String(id)))
        )
        if (enterpriseIds.length === 0) {
          return res.json({ items: [], total: 0, page, pageSize })
        }
        const enterpriseRows = await supabase.select(
          'tenants',
          `select=tenant_id,parent_id&tenant_type=eq.ENTERPRISE&tenant_id=in.(${enterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`
        )
        const resellerIds = Array.from(
          new Set(
            (Array.isArray(enterpriseRows) ? enterpriseRows : [])
              .map((row) => row.parent_id)
              .filter(Boolean)
              .map((id) => String(id))
          )
        )
        if (resellerIds.length === 0) {
          return res.json({ items: [], total: 0, page, pageSize })
        }
        filters.push(`id=in.(${resellerIds.map((id) => encodeURIComponent(id)).join(',')})`)
      }
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data, total } = await supabase.selectWithCount(
        'resellers',
        `select=id,name,status,created_at,updated_at&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []
      let brandingMap = new Map()
      if (rows.length) {
        const idList = rows.map((r) => encodeURIComponent(String(r.id))).join(',')
        const brandRows = await supabase.select(
          'reseller_branding',
          `select=reseller_id,brand_name,logo_url,custom_domain,primary_color,secondary_color,currency&reseller_id=in.(${idList})`
        )
        const list = Array.isArray(brandRows) ? brandRows : []
        brandingMap = new Map(list.map((b) => [String(b.reseller_id), b]))
      }
      res.json({
        items: rows.map((r) => {
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

    app.get(`${prefix}/resellers/:resellerId`, async (req, res) => {
      const roleScope = getRoleScope(req)
      const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
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
      if (!isPlatform) {
        if (roleScope !== 'reseller') {
          return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
        }
        const ownResellerId = req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null
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
      if (operatorId) {
        const enterpriseRows = await supabase.select(
          'tenants',
          `select=tenant_id&tenant_type=eq.ENTERPRISE&parent_id=eq.${encodeURIComponent(resellerId)}`
        )
        const enterpriseIds = Array.from(
          new Set((Array.isArray(enterpriseRows) ? enterpriseRows : []).map((r) => String(r.tenant_id)))
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

    app.patch(`${prefix}/resellers/:resellerId`, async (req, res) => {
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
      const resellerPatch = { updated_at: nowIso }
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
        const brandingPatch = {}
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

    app.post(`${prefix}/resellers/:resellerId\\:change-status`, async (req, res) => {
      if (!requirePlatform(req, res)) return
      const resellerId = String(req.params.resellerId || '')
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
        `select=id,status&id=eq.${encodeURIComponent(resellerId)}&limit=1`
      )
      const reseller = Array.isArray(rows) ? rows[0] : null
      if (!reseller) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      if (operatorId) {
        const enterpriseRows = await supabase.select(
          'tenants',
          `select=tenant_id&tenant_type=eq.ENTERPRISE&parent_id=eq.${encodeURIComponent(resellerId)}`
        )
        const enterpriseIds = Array.from(
          new Set((Array.isArray(enterpriseRows) ? enterpriseRows : []).map((r) => String(r.tenant_id)))
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

  function mountSupplierRoutes(prefix) {
    const normalizeStatus = (status) => {
      const v = status ? String(status).toUpperCase() : ''
      if (v === 'ACTIVE') return 'ACTIVE'
      if (v === 'SUSPENDED') return 'SUSPENDED'
      return null
    }
    const requirePlatform = (req, res) => {
      const roleScope = getRoleScope(req)
      const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
      if (!roleScope && !role) {
        sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
        return false
      }
      if (roleScope === 'platform' || role === 'platform_admin') return true
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return false
    }

    const requireAuthenticated = (req, res) => {
      const roleScope = getRoleScope(req)
      const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
      if (!roleScope && !role) {
        sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
        return false
      }
      return true
    }

    app.get(`${prefix}/operators`, async (req, res) => {
      if (!requireAuthenticated(req, res)) return
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
      const { page, pageSize, offset } = parsePagination(req.query ?? {}, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 1000 })
      const filters = []
      if (operatorId) filters.push(`operator_id=eq.${encodeURIComponent(operatorId)}`)
      if (mcc) filters.push(`mcc=eq.${encodeURIComponent(mcc)}`)
      if (mnc) filters.push(`mnc=eq.${encodeURIComponent(mnc)}`)
      if (name) filters.push(`name=ilike.*${encodeURIComponent(name)}*`)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data, total } = await supabase.selectWithCount(
        'business_operators',
        `select=operator_id,mcc,mnc,name&order=name.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []
      res.json({
        items: rows.map((row) => ({
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

    app.post(`${prefix}/operators`, async (req, res) => {
      if (!requirePlatform(req, res)) return
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
        await supabase.insert('audit_logs', {
          actor_role: 'PLATFORM',
          action: 'OPERATOR_GSMA_OVERRIDE',
          target_type: 'OPERATOR',
          target_id: row.operator_id,
          request_id: getTraceId(res),
          source_ip: req.ip,
          after_data: { mcc, mnc, name, gsmaOverride: true },
        }, { returning: 'minimal' })
      }
      res.status(201).json({
        operatorId: row.operator_id,
        mcc: row.mcc,
        mnc: row.mnc,
        name: row.name,
      })
    })

    app.patch(`${prefix}/operators/:operatorId`, async (req, res) => {
      if (!requirePlatform(req, res)) return
      const operatorId = String(req.params.operatorId || '').trim()
      if (!isValidUuid(operatorId)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
      }
      const patch = {}
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
      res.json({
        operatorId: row.operator_id,
        mcc: row.mcc,
        mnc: row.mnc,
        name: row.name,
      })
    })

    app.post(`${prefix}/resellers/:resellerId/suppliers`, async (req, res) => {
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
      if (auth.scope === 'reseller' && auth.resellerId !== resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId is out of scope.')
      }
      try {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const resellerRows = await supabase.select('resellers', `select=id&id=eq.${encodeURIComponent(resellerId)}&limit=1`)
        if (!Array.isArray(resellerRows) || resellerRows.length === 0) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
        }
        const supplierRows = await supabase.select(
          'suppliers',
          `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
        )
        if (!Array.isArray(supplierRows) || supplierRows.length === 0) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `supplier ${supplierId} not found.`)
        }
        const existingRows = await supabase.select(
          'reseller_suppliers',
          `select=reseller_id,supplier_id,created_at&reseller_id=eq.${encodeURIComponent(resellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
        )
        const existing = Array.isArray(existingRows) ? existingRows[0] : null
        if (existing?.reseller_id) {
          return sendError(res, 409, 'ALREADY_BOUND', 'supplierId is already bound to resellerId.')
        }
        const insertedRows = await supabase.insert(
          'reseller_suppliers',
          { reseller_id: resellerId, supplier_id: supplierId },
          { returning: 'representation' }
        )
        const row = Array.isArray(insertedRows) ? insertedRows[0] : null
        if (!row) {
          return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to bind supplier.')
        }
        res.status(201).json({
          resellerId: row.reseller_id,
          supplierId: row.supplier_id,
          boundAt: row.created_at ?? null,
        })
      } catch (error) {
        const message = String(error?.message ?? '')
        if (message.includes("Could not find the table 'public.reseller_suppliers'")) {
          return sendError(res, 503, 'SCHEMA_NOT_READY', 'reseller_suppliers table is not available yet.')
        }
        const status = Number(error?.status) || 500
        const code = error?.code ? String(error.code) : 'INTERNAL_ERROR'
        const errorMessage = message || 'Failed to bind supplier.'
        return sendError(res, status, code, errorMessage)
      }
    })

    app.get(`${prefix}/resellers/:resellerId/suppliers`, async (req, res) => {
      const auth = ensureResellerAdmin(req, res)
      if (!auth) return
      const resellerId = String(req.params.resellerId || '').trim()
      if (!isValidUuid(resellerId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      }
      if (auth.scope === 'reseller' && auth.resellerId !== resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId is out of scope.')
      }
      try {
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
        const resellerRows = await supabase.select('resellers', `select=id&id=eq.${encodeURIComponent(resellerId)}&limit=1`)
        if (!Array.isArray(resellerRows) || resellerRows.length === 0) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
        }
        const linksRows = await supabase.select(
          'reseller_suppliers',
          `select=supplier_id,created_at&reseller_id=eq.${encodeURIComponent(resellerId)}&order=created_at.desc`
        )
        const links = Array.isArray(linksRows) ? linksRows : []
        const supplierIds = Array.from(new Set(links.map((r) => (r?.supplier_id ? String(r.supplier_id) : '')).filter(Boolean)))
        const supplierMap = new Map()
        if (supplierIds.length) {
          const supplierFilter = supplierIds.map((id) => encodeURIComponent(id)).join(',')
          const supplierRows = await supabase.select(
            'suppliers',
            `select=supplier_id,name,status,created_at&supplier_id=in.(${supplierFilter})`
          )
          for (const row of Array.isArray(supplierRows) ? supplierRows : []) {
            const id = row?.supplier_id ? String(row.supplier_id) : ''
            if (id) supplierMap.set(id, row)
          }
        }
        const items = links.map((link) => {
          const id = link?.supplier_id ? String(link.supplier_id) : null
          const supplier = id ? supplierMap.get(id) : null
          return {
            supplierId: id,
            name: supplier?.name ?? null,
            status: supplier?.status ?? null,
            createdAt: supplier?.created_at ?? null,
            boundAt: link?.created_at ?? null,
          }
        }).filter((item) => item.supplierId)
        res.header('Cache-Control', 'no-store')
        res.json({
          resellerId,
          items,
          total: items.length,
        })
      } catch (error) {
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

    app.post(`${prefix}/suppliers`, async (req, res) => {
      if (!requirePlatform(req, res)) return
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
      const statusInput = req.body?.status ? String(req.body.status) : null
      const status = statusInput ? normalizeStatus(statusInput) : 'ACTIVE'
      const operatorIds = Array.isArray(req.body?.operatorIds) ? req.body.operatorIds.map((id) => String(id)) : []
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
      const existing = await supabase.select(
        'suppliers',
        `select=supplier_id&name=eq.${encodeURIComponent(name)}&limit=1`
      )
      if (Array.isArray(existing) && existing.length > 0) {
        return sendError(res, 409, 'DUPLICATE_NAME', 'Supplier name already exists.')
      }
      const operatorFilter = operatorIds.map((id) => encodeURIComponent(id)).join(',')
      const operatorRows = await supabase.select('business_operators', `select=operator_id,name&operator_id=in.(${operatorFilter})`)
      const operators = Array.isArray(operatorRows) ? operatorRows : []
      if (operators.length !== operatorIds.length) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'operatorIds contains invalid operator id.')
      }
      const inserted = await supabase.insert('suppliers', {
        name,
        status,
      })
      const row = Array.isArray(inserted) ? inserted[0] : null
      if (!row) {
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create supplier.')
      }
      const operatorMap = new Map(operators.map((operator) => [String(operator.operator_id), operator]))
      const operatorPayloads = operatorIds.map((operatorId) => ({
        business_operator_id: operatorId,
        supplier_id: row.supplier_id,
        name: operatorMap.get(operatorId)?.name ?? null,
      }))
      const insertedOperators = await supabase.insert('operators', operatorPayloads, { returning: 'representation' })
      const createdOperators = Array.isArray(insertedOperators) ? insertedOperators : []
      res.status(201).json({
        supplierId: row.supplier_id,
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        operatorIds: createdOperators.map((operator) => String(operator.operator_id)).filter(Boolean),
      })
    })

    app.post(`${prefix}/suppliers/:supplierId/operators`, async (req, res) => {
      if (!requirePlatform(req, res)) return
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
            name: businessOperator?.name ?? null,
          },
          { returning: 'representation' }
        )
        const row = Array.isArray(inserted) ? inserted[0] : null
        if (!row?.operator_id) {
          return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to bind operator.')
        }
        res.status(201).json({
          supplierId,
          operatorId,
          supplierOperatorId: row.operator_id,
        })
      } catch {
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to bind operator.')
      }
    })

    app.get(`${prefix}/suppliers`, async (req, res) => {
      if (!requirePlatform(req, res)) return
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
      const filters = []
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (operatorId) {
        const operatorRows = await supabase.select(
          'operators',
          `select=operator_id,supplier_id,business_operator_id&or=(business_operator_id.eq.${encodeURIComponent(operatorId)},operator_id.eq.${encodeURIComponent(operatorId)})&limit=1`
        )
        const operator = Array.isArray(operatorRows) ? operatorRows[0] : null
        if (!operator?.supplier_id) {
          return res.json({ items: [], total: 0, page, pageSize })
        }
        filters.push(`supplier_id=eq.${encodeURIComponent(String(operator.supplier_id))}`)
      }
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data, total } = await supabase.selectWithCount(
        'suppliers',
        `select=supplier_id,name,status,created_at&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const rows = Array.isArray(data) ? data : []
      const supplierIds = rows.map((r) => r?.supplier_id).filter(Boolean).map((v) => String(v))
      const operatorMap = new Map()
      if (supplierIds.length) {
        const idFilter = supplierIds.map((id) => encodeURIComponent(id)).join(',')
        const linkRows = await supabase.select(
          'operators',
          `select=operator_id,supplier_id,business_operator_id,name&supplier_id=in.(${idFilter})`
        )
        const links = Array.isArray(linkRows) ? linkRows : []
        const linkedOperatorIds = [...new Set(links.map((link) => String(link?.business_operator_id ?? link?.operator_id ?? '')).filter(Boolean))]
        const operatorInfoMap = new Map()
        if (linkedOperatorIds.length) {
          const operatorFilter = linkedOperatorIds.map((id) => encodeURIComponent(id)).join(',')
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
          const supplierId = link?.supplier_id ? String(link.supplier_id) : null
          if (!supplierId) continue
          if (!operatorMap.has(supplierId)) operatorMap.set(supplierId, [])
          const linkedOperatorId = link?.business_operator_id
            ? String(link.business_operator_id)
            : (link?.operator_id ? String(link.operator_id) : null)
          if (!linkedOperatorId) continue
          const operatorInfo = linkedOperatorId ? operatorInfoMap.get(linkedOperatorId) : null
          operatorMap.get(supplierId).push({
            operatorId: linkedOperatorId,
            name: operatorInfo?.name ?? link?.name ?? null,
            mcc: operatorInfo?.mcc ?? null,
            mnc: operatorInfo?.mnc ?? null,
          })
        }
      }
      res.json({
        items: rows.map((r) => ({
          operators: operatorMap.get(String(r.supplier_id)) ?? [],
          operatorIds: (operatorMap.get(String(r.supplier_id)) ?? []).map((o) => o.operatorId).filter(Boolean),
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

    app.get(`${prefix}/suppliers/:supplierId`, async (req, res) => {
      if (!requirePlatform(req, res)) return
      const supplierId = String(req.params.supplierId || '')
      if (!supplierId) {
        return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required.')
      }
      const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
      if (operatorId && !isValidUuid(operatorId)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
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
    const linkedOperatorIds = [...new Set(links.map((link) => String(link?.business_operator_id ?? link?.operator_id ?? '')).filter(Boolean))]
    const operatorInfoMap = new Map()
    if (linkedOperatorIds.length) {
      const operatorFilter = linkedOperatorIds.map((id) => encodeURIComponent(id)).join(',')
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
      const operators = links.map((link) => {
      const linkedOperatorId = link?.business_operator_id
        ? String(link.business_operator_id)
        : (link?.operator_id ? String(link.operator_id) : null)
      if (!linkedOperatorId) return null
      const operatorInfo = linkedOperatorId ? operatorInfoMap.get(linkedOperatorId) : null
        return {
        operatorId: linkedOperatorId,
        name: operatorInfo?.name ?? link?.name ?? null,
        mcc: operatorInfo?.mcc ?? null,
        mnc: operatorInfo?.mnc ?? null,
        }
      }).filter(Boolean)
      res.json({
        supplierId: row.supplier_id,
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        operators,
        operatorIds: operators.map((operator) => operator.operatorId).filter(Boolean),
      })
    })

    app.get(`${prefix}/suppliers/:supplierId/capabilities`, async (req, res) => {
      if (!requirePlatform(req, res)) return
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

    app.patch(`${prefix}/suppliers/:supplierId`, async (req, res) => {
      if (!requirePlatform(req, res)) return
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
      const patch = {}
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

    app.post(`${prefix}/suppliers/:supplierId\\:change-status`, async (req, res) => {
      if (!requirePlatform(req, res)) return
      const supplierId = String(req.params.supplierId || '')
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
      await supabase.insert('audit_logs', {
        actor_role: 'PLATFORM',
        action: 'SUPPLIER_STATUS_CHANGED',
        target_type: 'SUPPLIER',
        target_id: supplierId,
        request_id: getTraceId(res),
        source_ip: req.ip,
        before_data: { status: previousStatus },
        after_data: { status, reason },
      }, { returning: 'minimal' })
      res.json({
        supplierId,
        status,
        previousStatus,
        changedAt: nowIso,
      })
    })
  }

  function mountEnterpriseRoutes(prefix) {
    const normalizeStatus = (status) => {
      const v = status ? String(status).toUpperCase() : ''
      if (v === 'ACTIVE') return 'ACTIVE'
      if (v === 'SUSPENDED') return 'SUSPENDED'
      if (v === 'INACTIVE') return 'INACTIVE'
      return null
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const getAuth = (req) => ({
      roleScope: getRoleScope(req),
      role: req?.cmpAuth?.role ? String(req.cmpAuth.role) : null,
      resellerId: req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null,
      customerId: req?.cmpAuth?.customerId ? String(req.cmpAuth.customerId) : null,
      userId: req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null,
    })
    const resellerAllRoles = new Set(['reseller_admin', 'reseller_finance'])
    const resellerAssignedRoles = new Set(['reseller_sales_director', 'reseller_sales'])
    const ensurePlatformOrResellerAdmin = (req, res) => {
      const auth = getAuth(req)
      if (!auth.roleScope && !auth.role) {
        sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
        return null
      }
      if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ...auth, scope: 'platform' }
      if (auth.roleScope === 'reseller' && auth.role === 'reseller_admin') return { ...auth, scope: 'reseller' }
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return null
    }

    app.post(`${prefix}/enterprises`, async (req, res) => {
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
      if (auth.scope === 'reseller' && resellerIdRaw && resellerIdRaw !== auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match your reseller scope.')
      }
      const resellerId = auth.scope === 'reseller' ? auth.resellerId : resellerIdRaw
      if (!resellerId) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'resellerId is required.')
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

    app.get(`${prefix}/enterprises`, async (req, res) => {
      const auth = getAuth(req)
      if (!auth.roleScope && !auth.role) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      }
      const isPlatform = auth.roleScope === 'platform' || auth.role === 'platform_admin'
      const isReseller = auth.roleScope === 'reseller'
      if (!isPlatform && !isReseller) {
        return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      const statusInput = req.query.status ? String(req.query.status) : null
      const status = statusInput ? normalizeStatus(statusInput) : null
      const operatorId = req.query?.operatorId ? String(req.query.operatorId).trim() : ''
      if (statusInput && !status) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'status must be ACTIVE, INACTIVE, or SUSPENDED.')
      }
      if (operatorId && !isValidUuid(operatorId)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'operatorId must be a valid uuid.')
      }
      const queryResellerId = req.query.resellerId ? String(req.query.resellerId) : null
      const resellerId = isReseller ? auth.resellerId : queryResellerId
      if (isReseller && !resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
      const filters = ['tenant_type=eq.ENTERPRISE']
      if (status) filters.push(`enterprise_status=eq.${encodeURIComponent(status)}`)
      if (resellerId) filters.push(`parent_id=eq.${encodeURIComponent(resellerId)}`)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      if (operatorId) {
        const simRows = await supabase.select(
          'sims',
          `select=enterprise_id&operator_id=eq.${encodeURIComponent(operatorId)}`
        )
        const enterpriseIds = Array.from(
          new Set((Array.isArray(simRows) ? simRows : []).map((row) => row.enterprise_id).filter(Boolean).map((id) => String(id)))
        )
        if (enterpriseIds.length === 0) {
          return res.json({ items: [], total: 0, page, pageSize })
        }
        if (resellerId) {
          const scopedRows = await supabase.select(
            'tenants',
            `select=tenant_id&tenant_type=eq.ENTERPRISE&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_id=in.(${enterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`
          )
          const scopedIds = Array.from(
            new Set((Array.isArray(scopedRows) ? scopedRows : []).map((row) => String(row.tenant_id)))
          )
          if (scopedIds.length === 0) {
            return res.json({ items: [], total: 0, page, pageSize })
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
          const assignmentRows = await supabase.select(
            'reseller_enterprise_assignments',
            `select=enterprise_id&user_id=eq.${encodeURIComponent(auth.userId)}&reseller_id=eq.${encodeURIComponent(resellerId)}`
          )
          const assignments = Array.isArray(assignmentRows) ? assignmentRows.map((r) => String(r.enterprise_id)) : []
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
        items: rows.map((r) => ({
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

    app.get(`${prefix}/enterprises/:enterpriseId`, async (req, res) => {
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
      const response = {
        enterpriseId: row.tenant_id,
        name: row.name,
        status: row.enterprise_status,
        autoSuspendEnabled: row.auto_suspend_enabled,
        createdAt: row.created_at,
      }
      res.json(response)
    })

    app.post(`${prefix}/enterprises/:enterpriseId\\:change-status`, async (req, res) => {
      const auth = ensurePlatformOrResellerAdmin(req, res)
      if (!auth) return
      const enterpriseId = String(req.params.enterpriseId || '')
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

  function mountDepartmentRoutes(prefix) {
    const getAuth = (req) => ({
      roleScope: getRoleScope(req),
      role: req?.cmpAuth?.role ? String(req.cmpAuth.role) : null,
      resellerId: req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null,
      customerId: req?.cmpAuth?.customerId ? String(req.cmpAuth.customerId) : null,
      departmentId: req?.cmpAuth?.departmentId ? String(req.cmpAuth.departmentId) : null,
      userId: req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null,
    })
    const ensureEnterpriseAccess = async (supabase, auth, enterpriseId) => {
      if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return { ok: true }
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise) return { ok: false, error: 'not_found' }
      if (auth.roleScope === 'reseller') {
        if (!auth.resellerId || String(enterprise.parent_id || '') !== auth.resellerId) return { ok: false, error: 'forbidden' }
        if (auth.role !== 'reseller_admin') return { ok: false, error: 'forbidden' }
        return { ok: true }
      }
      if (auth.roleScope === 'customer') {
        if (!auth.customerId || auth.customerId !== enterpriseId) return { ok: false, error: 'forbidden' }
        if (auth.role !== 'customer_admin') return { ok: false, error: 'forbidden' }
        return { ok: true }
      }
      return { ok: false, error: 'forbidden' }
    }

    app.post(`${prefix}/enterprises/:enterpriseId/departments`, async (req, res) => {
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
      let inserted
      try {
        inserted = await supabase.insert('tenants', {
          parent_id: enterpriseId,
          tenant_type: 'DEPARTMENT',
          name,
        })
      } catch (err) {
        if (err?.name === 'ClientError') {
          return sendError(res, err.status || 400, err.code || 'BAD_REQUEST', err.message)
        }
        throw err
      }
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

    app.get(`${prefix}/enterprises/:enterpriseId/departments`, async (req, res) => {
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
      if (auth.roleScope === 'reseller') {
        if (!auth.resellerId || String(enterprise.parent_id || '') !== auth.resellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        }
      }
      const { data, total } = await supabase.selectWithCount(
        'tenants',
        `select=tenant_id,name,created_at&tenant_type=eq.DEPARTMENT&parent_id=eq.${encodeURIComponent(enterpriseId)}&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
      )
      const rows = Array.isArray(data) ? data : []
      res.json({
        items: rows.map((r) => ({
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

    app.get(`${prefix}/departments/:departmentId`, async (req, res) => {
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
      const enterpriseId = String(dept.parent_id || '')
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
        if (!enterprise || !auth.resellerId || String(enterprise.parent_id || '') !== auth.resellerId) {
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

  function mountUserRoutes(prefix) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const getAuth = (req) => ({
      roleScope: getRoleScope(req),
      role: req?.cmpAuth?.role ? String(req.cmpAuth.role) : null,
      resellerId: req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null,
      customerId: req?.cmpAuth?.customerId ? String(req.cmpAuth.customerId) : null,
      userId: req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null,
    })
    const resellerRoles = new Set(['reseller_admin', 'reseller_sales_director', 'reseller_sales', 'reseller_finance'])
    const enterpriseRoles = new Set(['customer_admin', 'customer_ops'])

    app.post(`${prefix}/resellers/:resellerId/users`, async (req, res) => {
      const auth = getAuth(req)
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
        ? req.body.assignedEnterpriseIds.map((id) => String(id)).filter((id) => id.trim() !== '')
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
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const tenantRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
      )
      if (!Array.isArray(tenantRows) || tenantRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      if (assignedEnterpriseIds.length > 0) {
        const enterpriseFilter = assignedEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')
        const enterpriseRows = await supabase.select(
          'tenants',
          `select=tenant_id,parent_id&tenant_id=in.(${enterpriseFilter})&tenant_type=eq.ENTERPRISE`
        )
        const enterprises = Array.isArray(enterpriseRows) ? enterpriseRows : []
        if (enterprises.length !== assignedEnterpriseIds.length) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'assignedEnterpriseIds contains invalid enterprise id.')
        }
        if (enterprises.some((e) => String(e.parent_id || '') !== resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'assignedEnterpriseIds must belong to reseller.')
        }
      }
      let inserted
      try {
        inserted = await supabase.insert('users', {
          tenant_id: resellerId,
          email,
          display_name: displayName,
          status: 'ACTIVE',
        })
      } catch (err) {
        if (err?.name === 'ClientError' && err?.code === 'DUPLICATE') {
          return sendError(res, 409, 'DUPLICATE', `email ${email} already exists for this reseller.`)
        }
        throw err
      }
      const row = Array.isArray(inserted) ? inserted[0] : null
      if (!row) {
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create user.')
      }
      await supabase.insert('user_roles', {
        user_id: row.user_id,
        role_name: role,
      }, { returning: 'minimal' })
      if (assignedEnterpriseIds.length > 0) {
        await supabase.insert('reseller_enterprise_assignments', assignedEnterpriseIds.map((enterpriseId) => ({
          user_id: row.user_id,
          reseller_id: resellerId,
          enterprise_id: enterpriseId,
        })), { returning: 'minimal' })
      }
      await supabase.insert('audit_logs', {
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
      }, { returning: 'minimal' })
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

    app.post(`${prefix}/resellers/:resellerId/users/:userId/assign-enterprises`, async (req, res) => {
      const auth = getAuth(req)
      const resellerId = String(req.params.resellerId || '')
      const userId = String(req.params.userId || '')
      if (!resellerId) {
        return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
      }
      if (!userId) {
        return sendError(res, 400, 'BAD_REQUEST', 'userId is required.')
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
      const assignedEnterpriseIds = Array.isArray(req.body?.assignedEnterpriseIds)
        ? req.body.assignedEnterpriseIds.map((id) => String(id))
        : null
      if (!assignedEnterpriseIds) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'assignedEnterpriseIds is required.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const tenantRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
      )
      if (!Array.isArray(tenantRows) || tenantRows.length === 0) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      const userRows = await supabase.select(
        'users',
        `select=user_id,tenant_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
      )
      const userRow = Array.isArray(userRows) ? userRows[0] : null
      if (!userRow || String(userRow.tenant_id || '') !== resellerId) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `user ${userId} not found.`)
      }
      const existingAssignments = await supabase.select(
        'reseller_enterprise_assignments',
        `select=enterprise_id&user_id=eq.${encodeURIComponent(userId)}&reseller_id=eq.${encodeURIComponent(resellerId)}`
      )
      const previousAssignedEnterpriseIds = Array.isArray(existingAssignments)
        ? existingAssignments.map((row) => String(row.enterprise_id))
        : []
      if (assignedEnterpriseIds.length > 0) {
        const enterpriseFilter = assignedEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')
        const enterpriseRows = await supabase.select(
          'tenants',
          `select=tenant_id,parent_id&tenant_id=in.(${enterpriseFilter})&tenant_type=eq.ENTERPRISE`
        )
        const enterprises = Array.isArray(enterpriseRows) ? enterpriseRows : []
        if (enterprises.length !== assignedEnterpriseIds.length) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'assignedEnterpriseIds contains invalid enterprise id.')
        }
        if (enterprises.some((e) => String(e.parent_id || '') !== resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'assignedEnterpriseIds must belong to reseller.')
        }
      }
      await supabase.delete(
        'reseller_enterprise_assignments',
        `user_id=eq.${encodeURIComponent(userId)}&reseller_id=eq.${encodeURIComponent(resellerId)}`
      )
      if (assignedEnterpriseIds.length > 0) {
        await supabase.insert('reseller_enterprise_assignments', assignedEnterpriseIds.map((enterpriseId) => ({
          user_id: userId,
          reseller_id: resellerId,
          enterprise_id: enterpriseId,
        })), { returning: 'minimal' })
      }
      await supabase.insert('audit_logs', {
        actor_user_id: auth.userId,
        actor_role: auth.role,
        tenant_id: resellerId,
        action: 'RESELLER_USER_ENTERPRISES_ASSIGNED',
        target_type: 'USER',
        target_id: userId,
        request_id: getTraceId(res),
        source_ip: req.ip,
        before_data: {
          assignedEnterpriseIds: previousAssignedEnterpriseIds,
        },
        after_data: {
          assignedEnterpriseIds,
        },
      }, { returning: 'minimal' })
      res.json({
        userId,
        resellerId,
        assignedEnterpriseIds,
      })
    })

    app.get(`${prefix}/resellers/:resellerId/users`, async (req, res) => {
      const auth = getAuth(req)
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
      const userIds = rows.map((r) => String(r.user_id))
      const roles = userIds.length > 0
        ? await supabase.select('user_roles', `select=user_id,role_name&user_id=in.(${userIds.map((id) => encodeURIComponent(id)).join(',')})`)
        : []
      const roleMap = new Map()
      for (const r of Array.isArray(roles) ? roles : []) {
        if (!roleMap.has(r.user_id)) roleMap.set(r.user_id, r.role_name)
      }
      res.json({
        items: rows.map((r) => ({
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

    app.get(`${prefix}/enterprises/:enterpriseId/users`, async (req, res) => {
      const auth = getAuth(req)
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
      if (auth.roleScope === 'reseller' && (!auth.resellerId || String(enterprise.parent_id || '') !== auth.resellerId)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      const { data, total } = await supabase.selectWithCount(
        'users',
        `select=user_id,email,display_name,status,created_at&tenant_id=eq.${encodeURIComponent(enterpriseId)}&order=created_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
      )
      const rows = Array.isArray(data) ? data : []
      const userIds = rows.map((r) => String(r.user_id))
      const roles = userIds.length > 0
        ? await supabase.select('user_roles', `select=user_id,role_name&user_id=in.(${userIds.map((id) => encodeURIComponent(id)).join(',')})`)
        : []
      const roleMap = new Map()
      for (const r of Array.isArray(roles) ? roles : []) {
        if (!roleMap.has(r.user_id)) roleMap.set(r.user_id, r.role_name)
      }
      res.json({
        items: rows.map((r) => ({
          userId: r.user_id,
          enterpriseId,
          email: r.email,
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

    app.post(`${prefix}/enterprises/:enterpriseId/users`, async (req, res) => {
      const auth = getAuth(req)
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
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      }
      if (auth.roleScope === 'reseller' && (!auth.resellerId || String(enterprise.parent_id || '') !== auth.resellerId)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      }
      if (departmentId) {
        const deptRows = await supabase.select(
          'tenants',
          `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(departmentId)}&tenant_type=eq.DEPARTMENT&limit=1`
        )
        const dept = Array.isArray(deptRows) ? deptRows[0] : null
        if (!dept || String(dept.parent_id || '') !== enterpriseId) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'departmentId is invalid.')
        }
      }
      let inserted
      try {
        inserted = await supabase.insert('users', {
          tenant_id: enterpriseId,
          email,
          display_name: displayName,
          status: 'ACTIVE',
        })
      } catch (err) {
        if (err?.name === 'ClientError' && err?.code === 'DUPLICATE') {
          return sendError(res, 409, 'DUPLICATE', `email ${email} already exists for this enterprise.`)
        }
        throw err
      }
      const row = Array.isArray(inserted) ? inserted[0] : null
      if (!row) {
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create user.')
      }
      await supabase.insert('user_roles', {
        user_id: row.user_id,
        role_name: role,
      }, { returning: 'minimal' })
      await supabase.insert('audit_logs', {
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
      }, { returning: 'minimal' })
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

    app.post(`${prefix}/enterprises/:enterpriseId/users/:userId/assign-departments`, async (req, res) => {
      const auth = getAuth(req)
      const enterpriseId = String(req.params.enterpriseId || '')
      const userId = String(req.params.userId || '')
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
      const assignedDepartmentIds = Array.isArray(req.body?.assignedDepartmentIds)
        ? req.body.assignedDepartmentIds.map((id) => String(id))
        : null
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
        if (auth.roleScope === 'reseller' && (!auth.resellerId || String(enterprise.parent_id || '') !== auth.resellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        }
        const userRows = await supabase.select(
          'users',
          `select=user_id,tenant_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
        )
        const userRow = Array.isArray(userRows) ? userRows[0] : null
        if (!userRow || String(userRow.tenant_id || '') !== enterpriseId) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', `user ${userId} not found.`)
        }
        const existingAssignments = await supabase.select(
          'enterprise_user_departments',
          `select=department_id&user_id=eq.${encodeURIComponent(userId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`
        )
        const previousAssignedDepartmentIds = Array.isArray(existingAssignments)
          ? existingAssignments.map((row) => String(row.department_id))
          : []
        if (assignedDepartmentIds.length > 0) {
          const departmentFilter = assignedDepartmentIds.map((id) => encodeURIComponent(id)).join(',')
          const departmentRows = await supabase.select(
            'tenants',
            `select=tenant_id,parent_id&tenant_id=in.(${departmentFilter})&tenant_type=eq.DEPARTMENT`
          )
          const departments = Array.isArray(departmentRows) ? departmentRows : []
          if (departments.length !== assignedDepartmentIds.length) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'assignedDepartmentIds contains invalid department id.')
          }
          if (departments.some((d) => String(d.parent_id || '') !== enterpriseId)) {
            return sendError(res, 403, 'FORBIDDEN', 'assignedDepartmentIds must belong to enterprise.')
          }
        }
        await supabase.delete(
          'enterprise_user_departments',
          `user_id=eq.${encodeURIComponent(userId)}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`
        )
        if (assignedDepartmentIds.length > 0) {
          await supabase.insert('enterprise_user_departments', assignedDepartmentIds.map((departmentId) => ({
            user_id: userId,
            enterprise_id: enterpriseId,
            department_id: departmentId,
          })), { returning: 'minimal' })
        }
        await supabase.insert('audit_logs', {
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
            assignedDepartmentIds,
          },
        }, { returning: 'minimal' })
        res.json({
          userId,
          enterpriseId,
          assignedDepartmentIds,
        })
      } catch (err) {
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

  function mountBrandingRoutes(prefix) {
    const getAuth = (req) => ({
      roleScope: getRoleScope(req),
      role: req?.cmpAuth?.role ? String(req.cmpAuth.role) : null,
      resellerId: req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null,
      userId: req?.cmpAuth?.userId ? String(req.cmpAuth.userId) : null,
    })
    const isHexColor = (value) => /^#[0-9a-fA-F]{6}$/.test(value)
    const isValidUrl = (value) => /^https?:\/\/[^\s]+$/.test(value)

    app.get(`${prefix}/resellers/:resellerId/branding`, async (req, res) => {
      const auth = getAuth(req)
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
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const brandingRows = await supabase.select(
        'reseller_branding',
        `select=reseller_id,logo_url,primary_color,custom_domain,brand_name,currency,updated_at&reseller_id=eq.${encodeURIComponent(resellerId)}&limit=1`
      )
      const branding = Array.isArray(brandingRows) ? brandingRows[0] : null
      const resellerRows = await supabase.select(
        'resellers',
        `select=currency&reseller_id=eq.${encodeURIComponent(resellerId)}&limit=1`
      )
      const reseller = Array.isArray(resellerRows) ? resellerRows[0] : null
      if (!branding && !reseller) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      res.json({
        resellerId,
        logoUrl: branding?.logo_url ?? null,
        primaryColor: branding?.primary_color ?? null,
        customDomain: branding?.custom_domain ?? null,
        brandName: branding?.brand_name ?? null,
        currency: branding?.currency ?? reseller?.currency ?? null,
        updatedAt: branding?.updated_at ?? null,
      })
    })

    app.put(`${prefix}/resellers/:resellerId/branding`, async (req, res) => {
      const auth = getAuth(req)
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
      const logoUrl = typeof req.body?.logoUrl === 'string' ? req.body.logoUrl.trim() : null
      const primaryColor = typeof req.body?.primaryColor === 'string' ? req.body.primaryColor.trim() : null
      const customDomain = typeof req.body?.customDomain === 'string' ? req.body.customDomain.trim() : null
      const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName.trim() : null
      const currency = typeof req.body?.currency === 'string' ? req.body.currency.trim() : null
      if (logoUrl && !isValidUrl(logoUrl)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'logoUrl must be a valid URL.')
      }
      if (primaryColor && !isHexColor(primaryColor)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'primaryColor must be hex color.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const resellerRows = await supabase.select(
        'resellers',
        `select=reseller_id,currency&reseller_id=eq.${encodeURIComponent(resellerId)}&limit=1`
      )
      const reseller = Array.isArray(resellerRows) ? resellerRows[0] : null
      if (!reseller) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
      }
      const brandingRows = await supabase.select(
        'reseller_branding',
        `select=reseller_id&reseller_id=eq.${encodeURIComponent(resellerId)}&limit=1`
      )
      const nowIso = new Date().toISOString()
      const payload = {
        reseller_id: resellerId,
        logo_url: logoUrl ?? null,
        primary_color: primaryColor ?? null,
        custom_domain: customDomain ?? null,
        brand_name: brandName ?? null,
        currency: currency ?? reseller.currency ?? null,
        updated_at: nowIso,
      }
      if (Array.isArray(brandingRows) && brandingRows.length > 0) {
        await supabase.update('reseller_branding', `reseller_id=eq.${encodeURIComponent(resellerId)}`, payload, { returning: 'minimal' })
      } else {
        await supabase.insert('reseller_branding', payload)
      }
      await supabase.insert('audit_logs', {
        actor_user_id: auth.userId,
        actor_role: auth.role,
        tenant_id: resellerId,
        action: 'RESELLER_BRANDING_UPDATED',
        target_type: 'RESELLER',
        target_id: resellerId,
        request_id: getTraceId(res),
        source_ip: req.ip,
        after_data: {
          logoUrl,
          primaryColor,
          customDomain,
          brandName,
          currency: payload.currency,
        },
      }, { returning: 'minimal' })
      res.json({
        resellerId,
        logoUrl: payload.logo_url,
        primaryColor: payload.primary_color,
        customDomain: payload.custom_domain,
        brandName: payload.brand_name,
        currency: payload.currency,
        updatedAt: payload.updated_at,
      })
    })
  }

  function mountAuditLogRoutes(prefix) {
    const getAuth = (req) => ({
      roleScope: getRoleScope(req),
      role: req?.cmpAuth?.role ? String(req.cmpAuth.role) : null,
      resellerId: req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null,
    })

    app.get(`${prefix}/audit-logs`, async (req, res) => {
      const auth = getAuth(req)
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
      const tenantIds = []
      if (resellerId) {
        const enterpriseRows = await supabase.select(
          'tenants',
          `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE`
        )
        const enterprises = Array.isArray(enterpriseRows) ? enterpriseRows : []
        tenantIds.push(resellerId, ...enterprises.map((r) => String(r.tenant_id)))
      }
      const { page, pageSize, offset } = parsePagination(req.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 100 })
      const filters = []
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
        items: rows.map((r) => ({
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
      })
    })
  }

  function mountCatalogRoutes(prefix) {
    app.get(`${prefix}/packages`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (!enterpriseId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const limit = req.query.limit ? Number(req.query.limit) : 100
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const q = req.query.q ? String(req.query.q) : null
      const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrderRaw = req.query.sortOrder ? String(req.query.sortOrder) : null
      const sortMap = { name: 'name' }
      const sortCol = sortByRaw && sortMap[sortByRaw] ? sortMap[sortByRaw] : 'name'
      const sortDir = (sortOrderRaw && (sortOrderRaw === 'asc' || sortOrderRaw === 'desc')) ? sortOrderRaw : 'asc'
      const nameFilter = q ? `&name=ilike.${encodeURIComponent('%' + q + '%')}` : ''
      const { data, total } = await supabase.selectWithCount(
        'packages',
        `select=package_id,name&enterprise_id=eq.${encodeURIComponent(enterpriseId)}${nameFilter}&order=${encodeURIComponent(sortCol)}.${encodeURIComponent(sortDir)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
      )
      const items = Array.isArray(data) ? data.map((r) => ({
        packageId: r.package_id,
        name: r.name,
      })) : []
      const filterPairs = []
      if (q) filterPairs.push(`q=${q}`)
      if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
      if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
      filterPairs.push(`limit=${limit}`)
      filterPairs.push(`page=${page}`)
      const filterStr = filterPairs.join(';')
      setXFilters(res, filterStr)
      res.json({ items, total: typeof total === 'number' ? total : items.length })
    })
    app.get(`${prefix}/packages:csv`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (!enterpriseId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const q = req.query.q ? String(req.query.q) : null
      const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrderRaw = req.query.sortOrder ? String(req.query.sortOrder) : null
      const sortMap = { name: 'name' }
      const sortCol = sortByRaw && sortMap[sortByRaw] ? sortMap[sortByRaw] : 'name'
      const sortDir = (sortOrderRaw && (sortOrderRaw === 'asc' || sortOrderRaw === 'desc')) ? sortOrderRaw : 'asc'
      const nameFilter = q ? `&name=ilike.${encodeURIComponent('%' + q + '%')}` : ''
      const { data } = await supabase.selectWithCount(
        'packages',
        `select=package_id,name&enterprise_id=eq.${encodeURIComponent(enterpriseId)}${nameFilter}&order=${encodeURIComponent(sortCol)}.${encodeURIComponent(sortDir)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
      )
      const rows = Array.isArray(data) ? data : []
      const headers = ['packageId', 'name']
      const csvRows = [headers.map(escapeCsv).join(',')]
      for (const r of rows) {
        csvRows.push([
          escapeCsv(r.package_id),
          escapeCsv(r.name ?? ''),
        ].join(','))
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="packages.csv"')
      {
        const filterPairs = []
        if (q) filterPairs.push(`q=${q}`)
        if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
        if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        const filterStr = filterPairs.join(';')
        setXFilters(res, filterStr)
      }
      res.send(`${csvRows.join('\n')}\n`)
    })
    app.get(`${prefix}/package-versions`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (!enterpriseId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const limit = req.query.limit ? Number(req.query.limit) : 50
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const pkgs = await supabase.select('packages', `select=package_id,name&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      let packageList = Array.isArray(pkgs) ? pkgs : []
      const q = req.query.q ? String(req.query.q).toLowerCase() : null
      if (q) {
        packageList = packageList.filter((p) => {
          const n = p?.name ? String(p.name).toLowerCase() : ''
          return n.includes(q)
        })
      }
      let pkgIds = packageList.map((p) => p.package_id)
      const filterPackageId = req.query.packageId ? String(req.query.packageId) : null
      if (filterPackageId) {
        pkgIds = pkgIds.filter((id) => String(id) === filterPackageId)
      }
      if (!pkgIds.length) {
        return res.json({ items: [], total: 0 })
      }
      const idList = pkgIds.map((id) => encodeURIComponent(String(id))).join(',')
      const filters = [`package_id=in.(${idList})`]
      const status = req.query.status ? String(req.query.status) : null
      const serviceType = req.query.serviceType ? String(req.query.serviceType) : null
      const effStart = req.query.effectiveFromStart ? toIsoDateTime(String(req.query.effectiveFromStart)) : null
      const effEnd = req.query.effectiveFromEnd ? toIsoDateTime(String(req.query.effectiveFromEnd)) : null
      const carrierId = req.query.carrierId ? String(req.query.carrierId) : null
      const operatorId = req.query.operatorId ? String(req.query.operatorId) : carrierId
      const mcc = req.query.mcc ? String(req.query.mcc) : null
      const mnc = req.query.mnc ? String(req.query.mnc) : null
      const apnLike = req.query.apnLike ? String(req.query.apnLike) : null
      const carrierNameLike = req.query.carrierNameLike ? String(req.query.carrierNameLike) : null
      const mccmncRaw = req.query.mccmnc ? String(req.query.mccmnc) : null
      const mccmncListRaw = req.query.mccmncList ? String(req.query.mccmncList) : null
      const carrierName = req.query.carrierName ? String(req.query.carrierName) : null
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (serviceType) filters.push(`service_type=eq.${encodeURIComponent(serviceType)}`)
      if (effStart) filters.push(`effective_from=gte.${encodeURIComponent(effStart)}`)
      if (effEnd) filters.push(`effective_from=lte.${encodeURIComponent(effEnd)}`)
      if (operatorId) filters.push(`operator_id=eq.${encodeURIComponent(operatorId)}`)
      const resolveOperatorIdsByBusinessFilters = async () => {
        const businessFilters = []
        if (mcc) businessFilters.push(`mcc=eq.${encodeURIComponent(mcc)}`)
        if (mnc) businessFilters.push(`mnc=eq.${encodeURIComponent(mnc)}`)
        if (carrierNameLike) businessFilters.push(`name=ilike.${encodeURIComponent('%' + carrierNameLike + '%')}`)
        if (carrierName) businessFilters.push(`name=eq.${encodeURIComponent(carrierName)}`)
        if (!businessFilters.length && !mccmncRaw && !mccmncListRaw) return null
        let businessIds = null
        if (businessFilters.length) {
          const rows = await supabase.select(
            'business_operators',
            `select=operator_id&order=operator_id.asc&${businessFilters.join('&')}`
          )
          businessIds = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.operator_id)))
        }
        const collectByMccMncToken = async (token) => {
          const digits = String(token || '').replace(/[^0-9]/g, '')
          if (!(digits.length === 5 || digits.length === 6)) return []
          const mcc3 = digits.slice(0, 3)
          const mnc2 = digits.slice(3, 5)
          const rowsA = await supabase.select(
            'business_operators',
            `select=operator_id&order=operator_id.asc&mcc=eq.${encodeURIComponent(mcc3)}&mnc=eq.${encodeURIComponent(mnc2)}`
          )
          const ids = new Set((Array.isArray(rowsA) ? rowsA : []).map((r) => String(r.operator_id)))
          if (digits.length === 6) {
            const mnc3 = digits.slice(3, 6)
            const rowsB = await supabase.select(
              'business_operators',
              `select=operator_id&order=operator_id.asc&mcc=eq.${encodeURIComponent(mcc3)}&mnc=eq.${encodeURIComponent(mnc3)}`
            )
            for (const row of (Array.isArray(rowsB) ? rowsB : [])) ids.add(String(row.operator_id))
          }
          return Array.from(ids)
        }
        if (mccmncRaw) {
          const ids = await collectByMccMncToken(mccmncRaw)
          const next = new Set(ids.map((id) => String(id)))
          businessIds = businessIds
            ? new Set(Array.from(businessIds).filter((id) => next.has(id)))
            : next
        }
        if (mccmncListRaw) {
          const tokens = mccmncListRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
          const next = new Set()
          for (const token of tokens) {
            const ids = await collectByMccMncToken(token)
            for (const id of ids) next.add(String(id))
          }
          businessIds = businessIds
            ? new Set(Array.from(businessIds).filter((id) => next.has(id)))
            : next
        }
        const businessList = businessIds ? Array.from(businessIds) : []
        if (!businessList.length) return []
        const inList = businessList.map((id) => encodeURIComponent(id)).join(',')
        const operatorRows = await supabase.select(
          'operators',
          `select=operator_id&business_operator_id=in.(${inList})`
        )
        return Array.from(new Set((Array.isArray(operatorRows) ? operatorRows : []).map((r) => String(r.operator_id))))
      }
      const businessFilteredOperatorIds = await resolveOperatorIdsByBusinessFilters()
      if (businessFilteredOperatorIds) {
        if (!businessFilteredOperatorIds.length) {
          return res.json({ items: [], total: 0 })
        }
        const inList = businessFilteredOperatorIds.map((id) => encodeURIComponent(id)).join(',')
        filters.push(`operator_id=in.(${inList})`)
      }
      if (apnLike) filters.push(`apn=ilike.${encodeURIComponent('%' + apnLike + '%')}`)
      const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrderRaw = req.query.sortOrder ? String(req.query.sortOrder) : null
      const sortMap = { createdAt: 'created_at', effectiveFrom: 'effective_from', status: 'status' }
      const sortCol = sortByRaw && sortMap[sortByRaw] ? sortMap[sortByRaw] : 'created_at'
      const sortDir = (sortOrderRaw && (sortOrderRaw === 'asc' || sortOrderRaw === 'desc')) ? sortOrderRaw : 'desc'
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data, total } = await supabase.selectWithCount(
        'package_versions',
        `select=package_version_id,package_id,operator_id,status,effective_from,service_type,apn,price_plan_version_id&order=${encodeURIComponent(sortCol)}.${encodeURIComponent(sortDir)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const nameMap = packageList.reduce((m, p) => { m[String(p.package_id)] = p.name; return m }, {})
      const operatorIds = Array.isArray(data) ? Array.from(new Set(data.map((r) => r.operator_id).filter(Boolean).map((id) => String(id)))) : []
      const operatorMap = {}
      if (operatorIds.length) {
        const oidList = operatorIds.map((id) => encodeURIComponent(String(id))).join(',')
        const operators = await supabase.select('operators', `select=operator_id,name,business_operators(name,mcc,mnc)&operator_id=in.(${oidList})`)
        if (Array.isArray(operators)) {
          operators.forEach((op) => {
            const business = op.business_operators ?? null
            operatorMap[String(op.operator_id)] = {
              name: business?.name ?? op.name ?? null,
              mcc: business?.mcc ?? null,
              mnc: business?.mnc ?? null,
            }
          })
        }
      }
      const items = Array.isArray(data) ? data.map((r) => ({
        packageVersionId: r.package_version_id,
        packageId: r.package_id,
        packageName: nameMap[String(r.package_id)] ?? null,
        carrierId: r.operator_id ?? null,
        carrierName: r.operator_id ? (operatorMap[String(r.operator_id)]?.name ?? null) : null,
        mcc: r.operator_id ? (operatorMap[String(r.operator_id)]?.mcc ?? null) : null,
        mnc: r.operator_id ? (operatorMap[String(r.operator_id)]?.mnc ?? null) : null,
        status: r.status,
        effectiveFrom: r.effective_from ?? null,
        serviceType: r.service_type ?? null,
        apn: r.apn ?? null,
      })) : []
      const filterPairs = []
      if (q) filterPairs.push(`q=${q}`)
      if (filterPackageId) filterPairs.push(`packageId=${filterPackageId}`)
      if (status) filterPairs.push(`status=${status}`)
      if (serviceType) filterPairs.push(`serviceType=${serviceType}`)
      if (effStart) filterPairs.push(`effectiveFromStart=${effStart}`)
      if (effEnd) filterPairs.push(`effectiveFromEnd=${effEnd}`)
      if (carrierId) filterPairs.push(`carrierId=${carrierId}`)
      if (req.query.operatorId) filterPairs.push(`operatorId=${String(req.query.operatorId)}`)
      if (mcc) filterPairs.push(`mcc=${mcc}`)
      if (mnc) filterPairs.push(`mnc=${mnc}`)
      if (mccmncRaw) filterPairs.push(`mccmnc=${mccmncRaw}`)
      if (mccmncListRaw) filterPairs.push(`mccmncList=${mccmncListRaw}`)
      if (carrierName) filterPairs.push(`carrierName=${carrierName}`)
      if (carrierNameLike) filterPairs.push(`carrierNameLike=${carrierNameLike}`)
      if (apnLike) filterPairs.push(`apnLike=${apnLike}`)
      if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
      if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
      filterPairs.push(`limit=${limit}`)
      filterPairs.push(`page=${page}`)
      const filterStr = filterPairs.join(';')
      setXFilters(res, filterStr)
      res.json({
        items,
        total: typeof total === 'number' ? total : items.length,
      })
    })
    app.get(`${prefix}/package-versions:csv`, async (req, res) => {
      const enterpriseId = getEnterpriseIdFromReq(req)
      if (!enterpriseId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const limit = req.query.limit ? Number(req.query.limit) : 1000
      const page = req.query.page ? Number(req.query.page) : 1
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      const pkgs = await supabase.select('packages', `select=package_id,name&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      let packageList = Array.isArray(pkgs) ? pkgs : []
      const q = req.query.q ? String(req.query.q).toLowerCase() : null
      if (q) {
        packageList = packageList.filter((p) => {
          const n = p?.name ? String(p.name).toLowerCase() : ''
          return n.includes(q)
        })
      }
      let pkgIds = packageList.map((p) => p.package_id)
      const filterPackageId = req.query.packageId ? String(req.query.packageId) : null
      if (filterPackageId) {
        pkgIds = pkgIds.filter((id) => String(id) === filterPackageId)
      }
      if (!pkgIds.length) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', 'attachment; filename="package_versions.csv"')
        return res.send('packageVersionId,packageId,packageName,carrierId,carrierName,mcc,mnc,status,effectiveFrom,serviceType,apn\n')
      }
      const idList = pkgIds.map((id) => encodeURIComponent(String(id))).join(',')
      const filters = [`package_id=in.(${idList})`]
      const status = req.query.status ? String(req.query.status) : null
      const serviceType = req.query.serviceType ? String(req.query.serviceType) : null
      const effStart = req.query.effectiveFromStart ? toIsoDateTime(String(req.query.effectiveFromStart)) : null
      const effEnd = req.query.effectiveFromEnd ? toIsoDateTime(String(req.query.effectiveFromEnd)) : null
      const carrierId = req.query.carrierId ? String(req.query.carrierId) : null
      const mcc = req.query.mcc ? String(req.query.mcc) : null
      const mnc = req.query.mnc ? String(req.query.mnc) : null
      const apnLike = req.query.apnLike ? String(req.query.apnLike) : null
      const carrierNameLike = req.query.carrierNameLike ? String(req.query.carrierNameLike) : null
      const mccmncRaw = req.query.mccmnc ? String(req.query.mccmnc) : null
      const mccmncListRaw = req.query.mccmncList ? String(req.query.mccmncList) : null
      const carrierName = req.query.carrierName ? String(req.query.carrierName) : null
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (serviceType) filters.push(`service_type=eq.${encodeURIComponent(serviceType)}`)
      if (effStart) filters.push(`effective_from=gte.${encodeURIComponent(effStart)}`)
      if (effEnd) filters.push(`effective_from=lte.${encodeURIComponent(effEnd)}`)
      if (operatorId) filters.push(`operator_id=eq.${encodeURIComponent(operatorId)}`)
      const resolveOperatorIdsByBusinessFilters = async () => {
        const businessFilters = []
        if (mcc) businessFilters.push(`mcc=eq.${encodeURIComponent(mcc)}`)
        if (mnc) businessFilters.push(`mnc=eq.${encodeURIComponent(mnc)}`)
        if (carrierNameLike) businessFilters.push(`name=ilike.${encodeURIComponent('%' + carrierNameLike + '%')}`)
        if (carrierName) businessFilters.push(`name=eq.${encodeURIComponent(carrierName)}`)
        if (!businessFilters.length && !mccmncRaw && !mccmncListRaw) return null
        let businessIds = null
        if (businessFilters.length) {
          const rows = await supabase.select('business_operators', `select=operator_id&order=operator_id.asc&${businessFilters.join('&')}`)
          businessIds = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.operator_id)))
        }
        const collectByMccMncToken = async (token) => {
          const digits = String(token || '').replace(/[^0-9]/g, '')
          if (!(digits.length === 5 || digits.length === 6)) return []
          const mcc3 = digits.slice(0, 3)
          const mnc2 = digits.slice(3, 5)
          const rowsA = await supabase.select(
            'business_operators',
            `select=operator_id&order=operator_id.asc&mcc=eq.${encodeURIComponent(mcc3)}&mnc=eq.${encodeURIComponent(mnc2)}`
          )
          const ids = new Set((Array.isArray(rowsA) ? rowsA : []).map((r) => String(r.operator_id)))
          if (digits.length === 6) {
            const mnc3 = digits.slice(3, 6)
            const rowsB = await supabase.select(
              'business_operators',
              `select=operator_id&order=operator_id.asc&mcc=eq.${encodeURIComponent(mcc3)}&mnc=eq.${encodeURIComponent(mnc3)}`
            )
            for (const row of (Array.isArray(rowsB) ? rowsB : [])) ids.add(String(row.operator_id))
          }
          return Array.from(ids)
        }
        if (mccmncRaw) {
          const ids = await collectByMccMncToken(mccmncRaw)
          const next = new Set(ids.map((id) => String(id)))
          businessIds = businessIds ? new Set(Array.from(businessIds).filter((id) => next.has(id))) : next
        }
        if (mccmncListRaw) {
          const tokens = mccmncListRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
          const next = new Set()
          for (const token of tokens) {
            const ids = await collectByMccMncToken(token)
            for (const id of ids) next.add(String(id))
          }
          businessIds = businessIds ? new Set(Array.from(businessIds).filter((id) => next.has(id))) : next
        }
        const businessList = businessIds ? Array.from(businessIds) : []
        if (!businessList.length) return []
        const inList = businessList.map((id) => encodeURIComponent(id)).join(',')
        const operatorRows = await supabase.select('operators', `select=operator_id&business_operator_id=in.(${inList})`)
        return Array.from(new Set((Array.isArray(operatorRows) ? operatorRows : []).map((r) => String(r.operator_id))))
      }
      const businessFilteredOperatorIds = await resolveOperatorIdsByBusinessFilters()
      if (businessFilteredOperatorIds) {
        if (!businessFilteredOperatorIds.length) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8')
          res.setHeader('Content-Disposition', 'attachment; filename="package_versions.csv"')
          return res.send('packageVersionId,packageId,packageName,carrierId,carrierName,mcc,mnc,status,effectiveFrom,serviceType,apn\n')
        }
        const inList = businessFilteredOperatorIds.map((id) => encodeURIComponent(id)).join(',')
        filters.push(`operator_id=in.(${inList})`)
      }
      if (apnLike) filters.push(`apn=ilike.${encodeURIComponent('%' + apnLike + '%')}`)
      const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : null
      const sortOrderRaw = req.query.sortOrder ? String(req.query.sortOrder) : null
      const sortMap = { createdAt: 'created_at', effectiveFrom: 'effective_from', status: 'status' }
      const sortCol = sortByRaw && sortMap[sortByRaw] ? sortMap[sortByRaw] : 'created_at'
      const sortDir = (sortOrderRaw && (sortOrderRaw === 'asc' || sortOrderRaw === 'desc')) ? sortOrderRaw : 'desc'
      const filterQs = filters.length ? `&${filters.join('&')}` : ''
      const { data } = await supabase.selectWithCount(
        'package_versions',
        `select=package_version_id,package_id,operator_id,status,effective_from,service_type,apn,price_plan_version_id&order=${encodeURIComponent(sortCol)}.${encodeURIComponent(sortDir)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )
      const nameMap = packageList.reduce((m, p) => { m[String(p.package_id)] = p.name; return m }, {})
      const operatorIds = Array.isArray(data) ? Array.from(new Set(data.map((r) => r.operator_id).filter(Boolean).map((id) => String(id)))) : []
      const operatorMap = {}
      if (operatorIds.length) {
        const oidList = operatorIds.map((id) => encodeURIComponent(String(id))).join(',')
        const operators = await supabase.select('operators', `select=operator_id,name,business_operators(name,mcc,mnc)&operator_id=in.(${oidList})`)
        if (Array.isArray(operators)) {
          operators.forEach((op) => {
            const business = op.business_operators ?? null
            operatorMap[String(op.operator_id)] = { name: business?.name ?? op.name ?? null, mcc: business?.mcc ?? null, mnc: business?.mnc ?? null }
          })
        }
      }
      const rows = Array.isArray(data) ? data : []
      const headers = ['packageVersionId','packageId','packageName','carrierId','carrierName','mcc','mnc','status','effectiveFrom','serviceType','apn']
      const csvRows = [headers.map(escapeCsv).join(',')]
      for (const r of rows) {
        const pkgId = String(r.package_id)
        const pkgName = nameMap[pkgId] ?? ''
        const cm = r.operator_id ? (operatorMap[String(r.operator_id)] || {}) : {}
        csvRows.push([
          escapeCsv(r.package_version_id),
          escapeCsv(pkgId),
          escapeCsv(pkgName),
          escapeCsv(r.operator_id ?? ''),
          escapeCsv(cm.name ?? ''),
          escapeCsv(cm.mcc ?? ''),
          escapeCsv(cm.mnc ?? ''),
          escapeCsv(r.status),
          escapeCsv(r.effective_from ?? ''),
          escapeCsv(r.service_type ?? ''),
          escapeCsv(r.apn ?? ''),
        ].join(','))
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="package_versions.csv"')
      {
        const filterPairs = []
        if (q) filterPairs.push(`q=${q}`)
        if (filterPackageId) filterPairs.push(`packageId=${filterPackageId}`)
        if (status) filterPairs.push(`status=${status}`)
        if (serviceType) filterPairs.push(`serviceType=${serviceType}`)
        if (effStart) filterPairs.push(`effectiveFromStart=${effStart}`)
        if (effEnd) filterPairs.push(`effectiveFromEnd=${effEnd}`)
        if (carrierId) filterPairs.push(`carrierId=${carrierId}`)
        if (req.query.operatorId) filterPairs.push(`operatorId=${String(req.query.operatorId)}`)
        if (mcc) filterPairs.push(`mcc=${mcc}`)
        if (mnc) filterPairs.push(`mnc=${mnc}`)
        if (mccmncRaw) filterPairs.push(`mccmnc=${mccmncRaw}`)
        if (mccmncListRaw) filterPairs.push(`mccmncList=${mccmncListRaw}`)
        if (carrierName) filterPairs.push(`carrierName=${carrierName}`)
        if (carrierNameLike) filterPairs.push(`carrierNameLike=${carrierNameLike}`)
        if (apnLike) filterPairs.push(`apnLike=${apnLike}`)
        if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
        if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
        filterPairs.push(`limit=${limit}`)
        filterPairs.push(`page=${page}`)
        const filterStr = filterPairs.join(';')
        setXFilters(res, filterStr)
      }
      res.send(`${csvRows.join('\n')}\n`)
    })
  }
  app.post('/v1/wx/webhook/sim-online', async (req, res) => {
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
  app.post('/v1/wx/webhook/sim-status-changed', async (req, res) => {
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
  app.post('/v1/wx/webhook/traffic-alert', async (req, res) => {
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
  app.post('/v1/wx/webhook/product-order', async (req, res) => {
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
  mountBillsRoutes('')
  mountBillsRoutes('/v1')

  mountJobsRoutes('')
  mountJobsRoutes('/v1')

  mountSimsRoutes('')
  mountSimsRoutes('/v1')

  mountCatalogRoutes('')
  mountResellerRoutes('')
  mountResellerRoutes('/v1')
  mountSupplierRoutes('')
  mountSupplierRoutes('/v1')
  mountCatalogRoutes('/v1')
  mountAdminRoutes('')
  mountAdminRoutes('/v1')
  mountEnterpriseRoutes('')
  mountEnterpriseRoutes('/v1')
  mountDepartmentRoutes('')
  mountDepartmentRoutes('/v1')
  mountUserRoutes('')
  mountUserRoutes('/v1')
  mountBrandingRoutes('')
  mountBrandingRoutes('/v1')
  mountAuditLogRoutes('')
  mountAuditLogRoutes('/v1')


  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err)
    if (err?.type === 'entity.too.large') {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.')
    }
    if (err instanceof SyntaxError && err.message && err.message.toLowerCase().includes('json')) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body.')
    }
    if (err?.name === 'ClientError') {
      const status = Number(err.status) || 400
      const code = err.code || 'BAD_REQUEST'
      return sendError(res, status, code, err.message || 'Bad request.')
    }
    if (err?.name === 'UpstreamError') {
      const status = Number(err.status) || 502
      const type = String(err.upstreamType || 'UPSTREAM_ERROR')
      const msg = type === 'UPSTREAM_TIMEOUT' ? 'Upstream timeout.' :
        type === 'UPSTREAM_RATE_LIMITED' ? 'Upstream rate limited.' :
        type === 'UPSTREAM_CIRCUIT_OPEN' ? 'Upstream circuit open.' :
        type === 'UPSTREAM_SERVER_ERROR' ? 'Upstream server error.' :
        type === 'UPSTREAM_NETWORK_ERROR' ? 'Upstream network error.' :
        'Upstream bad response.'
      res.setHeader('X-Upstream-Type', type)
      if (err.retryAfter !== undefined && err.retryAfter !== null) {
        res.setHeader('Retry-After', String(err.retryAfter))
      }
      return sendError(res, status, 'UPSTREAM_ERROR', msg)
    }
    console.error('Unhandled route error:', err)
    return sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected error.')
  })
  return app
}
