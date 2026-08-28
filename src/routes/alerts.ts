import { acknowledgeAlert, getAlert, listAlerts } from '../services/alerting.js'
import { buildPaginationResponse, parsePagination } from '../utils/pagination.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  getRoleScope: (req: any) => string | null
  getEnterpriseIdFromReq: (req: any) => string | null
  isValidUuid: (value: string) => boolean
}

type AlertFilters = {
  resellerId: string | null
  enterpriseId: string | null
}

type AlertListQueryOptions = {
  defaultPageSize: number
  maxPageSize: number
}

function getAuth(req: any) {
  const auth = req?.cmpAuth ?? {}
  return {
    roleScope: auth.roleScope ? String(auth.roleScope) : null,
    role: auth.role ? String(auth.role) : null,
    resellerId: auth.resellerId ? String(auth.resellerId) : null,
    customerId: auth.customerId ? String(auth.customerId) : null,
    userId: auth.userId ? String(auth.userId) : null,
  }
}

async function loadTenant(supabase: any, tenantId: string, tenantType: 'RESELLER' | 'ENTERPRISE') {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(tenantId)}&tenant_type=eq.${tenantType}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] ?? null : null
}

async function resolveAlertFilters(req: any, res: any, deps: Deps, supabase: any): Promise<AlertFilters | null> {
  const query = req.query ?? {}
  const auth = getAuth(req)
  const roleScope = deps.getRoleScope(req) ?? auth.roleScope
  const queryResellerId = query.resellerId ? String(query.resellerId).trim() : null
  const queryEnterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null

  if (roleScope === 'platform' || auth.role === 'platform_admin') {
    let resellerId: string | null = null
    let enterpriseId: string | null = null
    if (queryResellerId) {
      if (!deps.isValidUuid(queryResellerId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      const reseller = await loadTenant(supabase, queryResellerId, 'RESELLER')
      if (!reseller) {
        deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${queryResellerId} not found.`)
        return null
      }
      resellerId = queryResellerId
    }
    if (queryEnterpriseId) {
      if (!deps.isValidUuid(queryEnterpriseId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const enterprise = await loadTenant(supabase, queryEnterpriseId, 'ENTERPRISE')
      if (!enterprise) {
        deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${queryEnterpriseId} not found.`)
        return null
      }
      if (resellerId && String(enterprise.parent_id ?? '') !== resellerId) {
        deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
        return null
      }
      enterpriseId = queryEnterpriseId
    }
    return { resellerId, enterpriseId }
  }

  if (roleScope === 'reseller') {
    if (!auth.resellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      return null
    }
    if (queryResellerId) {
      if (!deps.isValidUuid(queryResellerId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      const reseller = await loadTenant(supabase, queryResellerId, 'RESELLER')
      if (!reseller) {
        deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${queryResellerId} not found.`)
        return null
      }
      if (queryResellerId !== auth.resellerId) {
        deps.sendError(res, 403, 'FORBIDDEN', 'resellerId does not match token scope.')
        return null
      }
    }
    if (!queryEnterpriseId) return { resellerId: auth.resellerId, enterpriseId: null }
    if (!deps.isValidUuid(queryEnterpriseId)) {
      deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return null
    }
    const enterprise = await loadTenant(supabase, queryEnterpriseId, 'ENTERPRISE')
    if (!enterprise) {
      deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${queryEnterpriseId} not found.`)
      return null
    }
    if (String(enterprise.parent_id ?? '') !== auth.resellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
      return null
    }
    return { resellerId: auth.resellerId, enterpriseId: queryEnterpriseId }
  }

  if (roleScope === 'customer' || roleScope === 'department') {
    const enterpriseId = deps.getEnterpriseIdFromReq(req) ?? auth.customerId
    if (!enterpriseId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'Customer scope required.')
      return null
    }
    if (queryEnterpriseId) {
      if (!deps.isValidUuid(queryEnterpriseId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const enterprise = await loadTenant(supabase, queryEnterpriseId, 'ENTERPRISE')
      if (!enterprise) {
        deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${queryEnterpriseId} not found.`)
        return null
      }
      if (queryEnterpriseId !== enterpriseId) {
        deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId does not match token scope.')
        return null
      }
    }
    return { resellerId: null, enterpriseId }
  }

  deps.sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
  return null
}

function parseAcknowledged(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true as const, value: null }
  const normalized = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return { ok: true as const, value: true }
  if (['false', '0', 'no', 'n'].includes(normalized)) return { ok: true as const, value: false }
  return { ok: false as const, message: 'acknowledged must be true or false.' }
}

async function countAlerts(supabase: any, filters: string[]) {
  const { total } = await supabase.selectWithCount('alerts', `select=alert_id&limit=1${filters.length ? `&${filters.join('&')}` : ''}`)
  return typeof total === 'number' ? total : 0
}

function scopeFilters(scope: AlertFilters) {
  const filters: string[] = []
  if (scope.resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(scope.resellerId)}`)
  if (scope.enterpriseId) filters.push(`customer_id=eq.${encodeURIComponent(scope.enterpriseId)}`)
  return filters
}

function appendWindowOverlapFilters(filters: string[], from?: string | null, to?: string | null) {
  if (from) {
    const encodedFrom = encodeURIComponent(from)
    filters.push(`or=(window_end.gte.${encodedFrom},and(window_end.is.null,window_start.gte.${encodedFrom}))`)
  }
  if (to) filters.push(`window_start=lte.${encodeURIComponent(to)}`)
}

function parseIsoQuery(value: unknown, field: string) {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true as const, value: null }
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return { ok: false as const, message: `${field} must be a valid date-time.` }
  return { ok: true as const, value: d.toISOString() }
}

function escapeCsv(value: unknown) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function alertsToCsv(items: any[]) {
  const headers = [
    'alertId',
    'resellerId',
    'enterpriseId',
    'alertType',
    'severity',
    'status',
    'iccid',
    'threshold',
    'currentValue',
    'windowStart',
    'windowEnd',
    'acknowledgedAt',
    'message',
    'createdAt',
  ]
  const lines = [headers.map(escapeCsv).join(',')]
  for (const item of items) {
    lines.push([
      item.alertId,
      item.resellerId,
      item.enterpriseId,
      item.alertType,
      item.severity,
      item.status,
      item.iccid,
      item.threshold,
      item.currentValue,
      item.windowStart,
      item.windowEnd,
      item.acknowledgedAt,
      item.message,
      item.createdAt,
    ].map(escapeCsv).join(','))
  }
  return `${lines.join('\n')}\n`
}

function sendCsv(res: any, filename: string, csv: string) {
  if (typeof res.header === 'function') {
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send(csv)
  }
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  }
  return res.send(csv)
}

async function runAlertListQuery(req: any, res: any, deps: Deps, options: AlertListQueryOptions) {
  const query = req.query ?? {}
  const supabase = deps.createSupabaseRestClient({ useServiceRole: true, traceId: deps.getTraceId(res) })
  const scope = await resolveAlertFilters(req, res, deps, supabase)
  if (!scope) return null
  const acknowledged = parseAcknowledged(query.acknowledged)
  if (!acknowledged.ok) {
    deps.sendError(res, 400, 'BAD_REQUEST', acknowledged.message)
    return null
  }
  const { page, pageSize, offset } = parsePagination(query, {
    defaultPage: 1,
    defaultPageSize: options.defaultPageSize,
    maxPageSize: options.maxPageSize,
  })
  const result = await listAlerts({
    supabase,
    resellerId: scope.resellerId,
    enterpriseId: scope.enterpriseId,
    alertType: query.alertType ? String(query.alertType) : null,
    from: query.from ? String(query.from) : null,
    to: query.to ? String(query.to) : null,
    acknowledged: acknowledged.value,
    limit: pageSize,
    offset,
  })
  if (!result.ok) {
    deps.sendError(res, result.status, result.code, result.message)
    return null
  }
  return { result, page, pageSize }
}

export function registerAlertRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps

  app.get(`${prefix}/alerts`, async (req: any, res: any) => {
    const payload = await runAlertListQuery(req, res, deps, { defaultPageSize: 20, maxPageSize: 20 })
    if (!payload) return
    res.send(buildPaginationResponse(payload.result.value.items, payload.result.value.total, payload.page, payload.pageSize))
  })

  app.get(`${prefix}/alerts:csv`, async (req: any, res: any) => {
    const payload = await runAlertListQuery(req, res, deps, { defaultPageSize: 100, maxPageSize: 1000 })
    if (!payload) return
    return sendCsv(res, 'alerts.csv', alertsToCsv(payload.result.value.items))
  })

  app.get(`${prefix}/alerts/:alertId`, async (req: any, res: any) => {
    const alertId = String(req.params?.alertId ?? '').trim()
    if (!deps.isValidUuid(alertId)) return sendError(res, 400, 'BAD_REQUEST', 'alertId must be a valid uuid.')
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const scope = await resolveAlertFilters(req, res, deps, supabase)
    if (!scope) return
    const result = await getAlert({
      supabase,
      alertId,
      resellerId: scope.resellerId,
      enterpriseId: scope.enterpriseId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/alerts/:alertId/acknowledge`, async (req: any, res: any) => {
    const alertId = String(req.params?.alertId ?? '').trim()
    if (!deps.isValidUuid(alertId)) return sendError(res, 400, 'BAD_REQUEST', 'alertId must be a valid uuid.')
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const scope = await resolveAlertFilters(req, res, deps, supabase)
    if (!scope) return
    const result = await acknowledgeAlert({
      supabase,
      alertId,
      resellerId: scope.resellerId,
      enterpriseId: scope.enterpriseId,
      actorUserId: actorUserIdForDb(getAuth(req).userId),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/alerts/summary`, async (req: any, res: any) => {
    // Tenant filters: same resolveAlertFilters as GET /alerts (query resellerId / enterpriseId).
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const scope = await resolveAlertFilters(req, res, deps, supabase)
    if (!scope) return
    const filters = scopeFilters(scope)
    const from = parseIsoQuery(query.from, 'from')
    if (!from.ok) return sendError(res, 400, 'BAD_REQUEST', from.message)
    const to = parseIsoQuery(query.to, 'to')
    if (!to.ok) return sendError(res, 400, 'BAD_REQUEST', to.message)
    appendWindowOverlapFilters(filters, from.value, to.value)
    if (query.alertType) filters.push(`alert_type=eq.${encodeURIComponent(String(query.alertType).trim().toUpperCase())}`)
    if (query.severity) filters.push(`severity=eq.${encodeURIComponent(String(query.severity).trim().toUpperCase())}`)
    const statuses = ['OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED']
    const severities = ['P0', 'P1', 'P2', 'P3']
    const byStatus = await Promise.all(statuses.map(async (status) => ({ status, count: await countAlerts(supabase, [...filters, `status=eq.${status}`]) })))
    const bySeverity = await Promise.all(severities.map(async (severity) => ({ severity, count: await countAlerts(supabase, [...filters, `severity=eq.${severity}`]) })))
    const totalOpen = byStatus.find((s) => s.status === 'OPEN')?.count ?? 0
    res.send({ totalOpen, byStatus, bySeverity })
  })

  app.get(`${prefix}/alerts/trends`, async (req: any, res: any) => {
    // Tenant filters: same resolveAlertFilters as GET /alerts (query resellerId / enterpriseId).
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const scope = await resolveAlertFilters(req, res, deps, supabase)
    if (!scope) return
    const from = parseIsoQuery(query.from, 'from')
    if (!from.ok) return sendError(res, 400, 'BAD_REQUEST', from.message)
    const to = parseIsoQuery(query.to, 'to')
    if (!to.ok) return sendError(res, 400, 'BAD_REQUEST', to.message)
    const days = Math.min(90, Math.max(1, Number(query.days) || 7))
    const baseFilters = scopeFilters(scope)
    if (query.alertType) baseFilters.push(`alert_type=eq.${encodeURIComponent(String(query.alertType).trim().toUpperCase())}`)
    if (query.severity) baseFilters.push(`severity=eq.${encodeURIComponent(String(query.severity).trim().toUpperCase())}`)
    const now = to.value ? new Date(to.value) : new Date()
    now.setUTCHours(0, 0, 0, 0)
    const rangeStart = from.value ? new Date(from.value) : null
    if (rangeStart) rangeStart.setUTCHours(0, 0, 0, 0)
    const trends = []
    const bucketCount = rangeStart
      ? Math.min(90, Math.max(1, Math.floor((now.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)) + 1))
      : days
    for (let i = bucketCount - 1; i >= 0; i -= 1) {
      const start = new Date(now)
      start.setUTCDate(start.getUTCDate() - i)
      start.setUTCHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setUTCDate(end.getUTCDate() + 1)
      const date = start.toISOString().slice(0, 10)
      const bucketFilters = [...baseFilters]
      appendWindowOverlapFilters(bucketFilters, start.toISOString(), end.toISOString())
      const count = await countAlerts(supabase, bucketFilters)
      trends.push({ date, count })
    }
    res.send({ days: bucketCount, trends })
  })
}
