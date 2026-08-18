import { buildPaginationResponse, parsePagination } from '../utils/pagination.js'
import { listEventCategoryCatalog, resolveEventTypeFilter } from '../utils/eventTypeCatalog.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  getRoleScope: (req: any) => string | null
  getEnterpriseIdFromReq: (req: any) => string | null
  resolveEnterpriseForReseller: (req: any, res: any, supabase: any, enterpriseId: string | null) => Promise<string | null>
  isValidUuid: (value: string) => boolean
}

type ScopeContext =
  | { scope: 'platform' }
  | { scope: 'reseller'; resellerId: string }
  | { scope: 'customer'; customerId: string }

type EventListFilters = {
  enterpriseId?: string | null
  resellerId?: string | null
}

const ICCID_RE = /^[0-9]{18,20}$/

function escapeCsv(value: unknown) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`
  }
  return s
}

function getAuth(req: any) {
  const auth = req?.cmpAuth ?? {}
  return {
    roleScope: auth.roleScope ? String(auth.roleScope) : null,
    role: auth.role ? String(auth.role) : null,
    resellerId: auth.resellerId ? String(auth.resellerId) : null,
    customerId: auth.customerId ? String(auth.customerId) : null,
  }
}

function resolveScope(req: any, res: any, deps: Deps): ScopeContext | null {
  const auth = getAuth(req)
  const roleScope = deps.getRoleScope(req) ?? auth.roleScope
  if (!roleScope && !auth.role) {
    deps.sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    return null
  }
  if (roleScope === 'platform' || auth.role === 'platform_admin') {
    return { scope: 'platform' }
  }
  if (roleScope === 'reseller' && auth.role === 'reseller_admin') {
    if (!auth.resellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      return null
    }
    return { scope: 'reseller', resellerId: auth.resellerId }
  }
  if (roleScope === 'customer' && auth.role === 'customer_admin') {
    const enterpriseId = deps.getEnterpriseIdFromReq(req) ?? auth.customerId
    if (!enterpriseId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'Customer scope required.')
      return null
    }
    return { scope: 'customer', customerId: enterpriseId }
  }
  deps.sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

function toIsoDateTime(value: unknown) {
  if (!value) return null
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

async function loadTenantByType(supabase: any, tenantId: string, tenantType: 'ENTERPRISE' | 'RESELLER') {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(tenantId)}&tenant_type=eq.${tenantType}&limit=1`,
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, any> | undefined) ?? null : null
}

async function loadEnterpriseScopeOrError({
  enterpriseId,
  supabase,
  res,
  deps,
}: {
  enterpriseId: string
  supabase: any
  res: any
  deps: Deps
}) {
  if (!deps.isValidUuid(enterpriseId)) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    return undefined
  }
  const enterprise = await loadTenantByType(supabase, enterpriseId, 'ENTERPRISE')
  if (!enterprise) {
    deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
    return undefined
  }
  return enterprise
}

async function loadResellerScopeOrError({
  resellerId,
  supabase,
  res,
  deps,
}: {
  resellerId: string
  supabase: any
  res: any
  deps: Deps
}) {
  if (!deps.isValidUuid(resellerId)) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    return undefined
  }
  const reseller = await loadTenantByType(supabase, resellerId, 'RESELLER')
  if (!reseller) {
    deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
    return undefined
  }
  return reseller
}

async function validateIccidFilter({
  iccid,
  supabase,
  scope,
  res,
  deps,
}: {
  iccid: string | null
  supabase: any
  scope: ScopeContext
  res: any
  deps: Deps
}): Promise<boolean> {
  if (!iccid) return true
  if (!ICCID_RE.test(iccid)) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'iccid must be 18-20 digits.')
    return false
  }
  const rows = await supabase.select(
    'sims',
    `select=sim_id,iccid,enterprise_id,reseller_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`,
  )
  const sim = Array.isArray(rows) ? rows[0] : null
  if (!sim) {
    deps.sendError(res, 404, 'SIM_NOT_FOUND', `sim ${iccid} not found.`)
    return false
  }
  if (scope.scope === 'reseller' && String(sim.reseller_id || '') !== scope.resellerId) {
    deps.sendError(res, 403, 'FORBIDDEN', 'SIM does not belong to your reseller.')
    return false
  }
  if (scope.scope === 'customer' && String(sim.enterprise_id || '') !== scope.customerId) {
    deps.sendError(res, 403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
    return false
  }
  return true
}

async function resolveEventListFilters({
  req,
  res,
  deps,
  supabase,
  scope,
}: {
  req: any
  res: any
  deps: Deps
  supabase: any
  scope: ScopeContext
}): Promise<EventListFilters | null | undefined> {
  const query = req.query ?? {}
  const queryEnterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
  const queryResellerId = query.resellerId ? String(query.resellerId).trim() : null

  if (scope.scope === 'platform') {
    let reseller: Record<string, any> | undefined
    if (queryResellerId) {
      reseller = await loadResellerScopeOrError({ resellerId: queryResellerId, supabase, res, deps })
      if (reseller === undefined) return undefined
    }
    let enterprise: Record<string, any> | undefined
    if (queryEnterpriseId) {
      enterprise = await loadEnterpriseScopeOrError({ enterpriseId: queryEnterpriseId, supabase, res, deps })
      if (enterprise === undefined) return undefined
    }
    if (enterprise && reseller && String(enterprise.parent_id || '') !== queryResellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
      return undefined
    }
    return {
      enterpriseId: enterprise ? queryEnterpriseId : null,
      resellerId: reseller ? queryResellerId : null,
    }
  }

  if (scope.scope === 'reseller') {
    if (queryResellerId) {
      if (!deps.isValidUuid(queryResellerId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return undefined
      }
      if (queryResellerId !== scope.resellerId) {
        deps.sendError(res, 403, 'FORBIDDEN', 'resellerId is out of token scope.')
        return undefined
      }
      const reseller = await loadResellerScopeOrError({ resellerId: queryResellerId, supabase, res, deps })
      if (reseller === undefined) return undefined
    }
    if (queryEnterpriseId) {
      const enterprise = await loadEnterpriseScopeOrError({ enterpriseId: queryEnterpriseId, supabase, res, deps })
      if (enterprise === undefined) return undefined
      if (String(enterprise.parent_id || '') !== scope.resellerId) {
        deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
        return undefined
      }
      return { enterpriseId: queryEnterpriseId, resellerId: queryResellerId ?? null }
    }
    return { enterpriseId: null, resellerId: scope.resellerId }
  }

  if (queryEnterpriseId) {
    if (!deps.isValidUuid(queryEnterpriseId)) {
      deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return undefined
    }
    const enterprise = await loadEnterpriseScopeOrError({ enterpriseId: queryEnterpriseId, supabase, res, deps })
    if (enterprise === undefined) return undefined
    if (queryEnterpriseId !== scope.customerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of token scope.')
      return undefined
    }
  }
  return { enterpriseId: scope.customerId, resellerId: null }
}

export function registerEventRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps

  app.get(`${prefix}/events/catalog`, async (req: any, res: any) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    res.send({ categories: listEventCategoryCatalog() })
  })

  async function queryEvents(req: any, res: any, pagination: { defaultPageSize: number; maxPageSize: number }) {
    const scope = resolveScope(req, res, deps)
    if (!scope) return null
    const query = req.query ?? {}
    const { page, pageSize, offset } = parsePagination(query, {
      defaultPage: 1,
      defaultPageSize: pagination.defaultPageSize,
      maxPageSize: pagination.maxPageSize,
    })
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const listFilters = await resolveEventListFilters({ req, res, deps, supabase, scope })
    if (listFilters === undefined) return null

    const typeFilter = resolveEventTypeFilter({
      eventCategory: query.eventCategory,
      eventType: query.eventType,
    })
    if (!typeFilter.ok) {
      sendError(res, 400, 'BAD_REQUEST', typeFilter.message)
      return null
    }

    const fromIso = toIsoDateTime(query.from)
    const toIso = toIsoDateTime(query.to)
    const iccid = query.iccid ? String(query.iccid).trim() : null
    const iccidAllowed = await validateIccidFilter({ iccid, supabase, scope, res, deps })
    if (!iccidAllowed) return null
    const filters: string[] = []
    if (typeFilter.filter) filters.push(typeFilter.filter)
    if (fromIso) filters.push(`occurred_at=gte.${encodeURIComponent(fromIso)}`)
    if (toIso) filters.push(`occurred_at=lte.${encodeURIComponent(toIso)}`)
    if (listFilters?.enterpriseId) {
      filters.push(`enterprise_id=eq.${encodeURIComponent(listFilters.enterpriseId)}`)
    }
    if (listFilters?.resellerId) {
      filters.push(`reseller_id=eq.${encodeURIComponent(listFilters.resellerId)}`)
    }
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const iccidFilter = iccid
      ? `&payload->>iccid=eq.${encodeURIComponent(iccid)}`
      : ''
    const { data, total } = await supabase.selectWithCount(
      'events',
      `select=event_id,event_type,occurred_at,enterprise_id,reseller_id,actor_user_id,request_id,job_id,payload&order=occurred_at.desc${filterQs}${iccidFilter}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`,
    )
    const rows = Array.isArray(data) ? data : []
    const items = rows.map((row: any) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      enterpriseId: row.enterprise_id ?? null,
      resellerId: row.reseller_id ?? null,
      actorUserId: row.actor_user_id ?? null,
      requestId: row.request_id ?? null,
      jobId: row.job_id ?? null,
      payload: row.payload ?? {},
    }))
    return buildPaginationResponse(items, typeof total === 'number' ? total : items.length, page, pageSize)
  }

  app.get(`${prefix}/events`, async (req: any, res: any) => {
    const result = await queryEvents(req, res, { defaultPageSize: 20, maxPageSize: 20 })
    if (!result) return
    res.send(result)
  })

  app.get(`${prefix}/events::csv`, async (req: any, res: any) => {
    const result = await queryEvents(req, res, { defaultPageSize: 100, maxPageSize: 1000 })
    if (!result) return
    const headers = [
      'eventId',
      'occurredAt',
      'eventType',
      'enterpriseId',
      'resellerId',
      'actorUserId',
      'requestId',
      'jobId',
      'iccid',
      'payload',
    ]
    const csvRows = [headers.map(escapeCsv).join(',')]
    for (const item of result.items) {
      csvRows.push([
        item.eventId,
        item.occurredAt,
        item.eventType,
        item.enterpriseId ?? '',
        item.resellerId ?? '',
        item.actorUserId ?? '',
        item.requestId ?? '',
        item.jobId ?? '',
        item.payload?.iccid ?? '',
        JSON.stringify(item.payload ?? {}),
      ].map(escapeCsv).join(','))
    }
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', 'attachment; filename="events.csv"')
    res.send(`\uFEFF${csvRows.join('\n')}\n`)
  })
}
