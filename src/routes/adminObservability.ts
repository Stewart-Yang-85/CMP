import { parsePagination } from '../utils/pagination.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  requireAdminAccess: (req: any, res: any) => boolean
  isValidUuid: (value: unknown) => boolean
}

function escapeCsv(value: unknown) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`
  }
  return s
}

function normalizeIccid(value: unknown) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isValidIccid(value: unknown) {
  return /^\d{18,20}$/.test(normalizeIccid(value))
}

/** Payload keys used for "previous / before" status across event types. */
const PAYLOAD_PREVIOUS_STATUS_PATHS = [
  'payload->>beforeStatus',
  'payload->>previousStatus',
  'payload->>fromStatus',
  'payload->>beforeState',
  'payload->beforeData->>beforeStatus',
]

/**
 * Payload keys used for "resulting / after" status across event types.
 * Intentionally excludes targetStatus (intended transition, not always the result).
 */
const PAYLOAD_RESULTING_STATUS_PATHS = [
  'payload->>afterStatus',
  'payload->>resultStatus',
  'payload->>status',
  'payload->>toStatus',
  'payload->>afterState',
  'payload->afterData->>afterStatus',
]

function buildPayloadStatusOrFilter(paths: string[], value: string) {
  const encoded = encodeURIComponent(value)
  return `or=(${paths.map((path) => `${path}.eq.${encoded}`).join(',')})`
}

/** True when input is calendar date only (YYYY-MM-DD), not a date-time. */
function isDateOnlyInput(raw: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
}

/**
 * Parse inclusive start/end bounds for admin list/export filters.
 * Date-only values are treated as inclusive UTC calendar days:
 * - start YYYY-MM-DD → 00:00:00.000Z that day
 * - end YYYY-MM-DD → 23:59:59.999Z that day
 * Full date-time values are used as provided.
 */
function parseInclusiveTimeBound(raw: unknown, role: 'start' | 'end'): Date | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const text = String(raw).trim()
  if (isDateOnlyInput(text)) {
    const [y, m, d] = text.split('-').map((p) => Number(p))
    if (!y || !m || !d) return null
    if (role === 'start') return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
    return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999))
  }
  const dt = new Date(text)
  if (Number.isNaN(dt.getTime())) return null
  return dt
}

function sortJobsRows(rows: any[], orderField: string, orderDir: string) {
  const direction = orderDir === 'asc' ? 1 : -1
  const resolveValue = (row: any) => {
    const primary = row?.[orderField]
    const candidates = [primary, row?.started_at, row?.created_at, row?.finished_at]
    for (const candidate of candidates) {
      if (!candidate) continue
      const time = new Date(candidate).getTime()
      if (!Number.isNaN(time)) return time
    }
    return 0
  }
  return rows.slice().sort((a, b) => {
    const av = resolveValue(a)
    const bv = resolveValue(b)
    if (av === bv) return 0
    return av > bv ? direction : -direction
  })
}

export function registerAdminObservabilityRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const { createSupabaseRestClient, getTraceId, sendError, requireAdminAccess, isValidUuid } = deps

  async function resolveAuditQuery(req: any, res: any, paginationOptions: { defaultPageSize: number; maxPageSize: number }) {
    const tenantId = req.query?.tenantId ? String(req.query.tenantId).trim() : null
    const action = req.query?.action ? String(req.query.action) : null
    const targetType = req.query?.targetType ? String(req.query.targetType) : null
    const targetId = req.query?.targetId ? String(req.query.targetId) : null
    const requestId = req.query?.requestId ? String(req.query.requestId) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const startRaw = req.query?.start
    const endRaw = req.query?.end
    const start =
      startRaw !== undefined && startRaw !== null && String(startRaw).trim() !== ''
        ? parseInclusiveTimeBound(startRaw, 'start')
        : null
    const end =
      endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== ''
        ? parseInclusiveTimeBound(endRaw, 'end')
        : null
    if (startRaw !== undefined && startRaw !== null && String(startRaw).trim() !== '' && !start) {
      sendError(res, 400, 'VALIDATION_ERROR', 'start must be a valid date (YYYY-MM-DD) or date-time.')
      return null
    }
    if (endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== '' && !end) {
      sendError(res, 400, 'VALIDATION_ERROR', 'end must be a valid date (YYYY-MM-DD) or date-time.')
      return null
    }
    if (start && end && start.getTime() > end.getTime()) {
      sendError(res, 400, 'VALIDATION_ERROR', 'start must be before or equal to end.')
      return null
    }
    const { page, pageSize, offset } = parsePagination(
      { page: req.query?.page, pageSize: req.query?.pageSize },
      { defaultPage: 1, defaultPageSize: paginationOptions.defaultPageSize, maxPageSize: paginationOptions.maxPageSize }
    )

    if (tenantId) {
      if (!isValidUuid(tenantId)) {
        sendError(res, 400, 'VALIDATION_ERROR', 'tenantId must be a valid uuid.')
        return null
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const tenantRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(tenantId)}&limit=1`
      )
      const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null
      if (!tenant) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `tenant ${tenantId} not found.`)
        return null
      }
    }

    const filters: string[] = []
    if (tenantId) filters.push(`tenant_id=eq.${encodeURIComponent(tenantId)}`)
    if (action) filters.push(`action=eq.${encodeURIComponent(action)}`)
    if (targetType) filters.push(`target_type=eq.${encodeURIComponent(targetType)}`)
    if (targetId) filters.push(`target_id=eq.${encodeURIComponent(targetId)}`)
    if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
    if (start) filters.push(`created_at=gte.${encodeURIComponent(start.toISOString())}`)
    if (end) filters.push(`created_at=lte.${encodeURIComponent(end.toISOString())}`)
    const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
    const orderQs = `&order=created_at.${orderDir}`
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const filterPairs: string[] = []
    if (tenantId) filterPairs.push(`tenantId=${tenantId}`)
    if (action) filterPairs.push(`action=${action}`)
    if (targetType) filterPairs.push(`targetType=${targetType}`)
    if (targetId) filterPairs.push(`targetId=${targetId}`)
    if (requestId) filterPairs.push(`requestId=${requestId}`)
    if (start) filterPairs.push(`start=${start.toISOString()}`)
    if (end) filterPairs.push(`end=${end.toISOString()}`)
    if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
    if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
    filterPairs.push(`pageSize=${pageSize}`)
    filterPairs.push(`page=${page}`)

    return { page, pageSize, offset, orderQs, filterQs, filterPairs }
  }

  app.get(`${prefix}/admin/audits`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const query = await resolveAuditQuery(req, res, { defaultPageSize: 50, maxPageSize: 100 })
    if (!query) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { page, pageSize, offset, orderQs, filterQs, filterPairs } = query
    const { data, total } = await supabase.selectWithCount(
      'audit_logs',
      `select=audit_id,actor_user_id,actor_role,tenant_id,action,target_type,target_id,request_id,created_at,before_data,after_data${orderQs}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    res.header('X-Filters', filterPairs.join(';'))
    res.send({
      items: rows.map((r: any) => ({
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
      page,
      pageSize,
    })
  })

  // Fastify find-my-way: register `::csv` so OpenAPI path `.../audits:csv` matches (same as admin/api-clients).
  app.get(`${prefix}/admin/audits::csv`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const query = await resolveAuditQuery(req, res, { defaultPageSize: 1000, maxPageSize: 1000 })
    if (!query) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { pageSize, offset, orderQs, filterQs, filterPairs } = query
    const { data } = await supabase.selectWithCount(
      'audit_logs',
      `select=audit_id,actor_user_id,actor_role,tenant_id,action,target_type,target_id,request_id,created_at,before_data,after_data${orderQs}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const headers = [
      'auditId',
      'actorUserId',
      'actorRole',
      'tenantId',
      'action',
      'targetType',
      'targetId',
      'requestId',
      'createdAt',
      'beforeData',
      'afterData',
    ]
    const csvRows = [headers.map(escapeCsv).join(',')]
    for (const r of rows) {
      csvRows.push(
        [
          escapeCsv(r.audit_id),
          escapeCsv(r.actor_user_id ?? ''),
          escapeCsv(r.actor_role ?? ''),
          escapeCsv(r.tenant_id ?? ''),
          escapeCsv(r.action),
          escapeCsv(r.target_type),
          escapeCsv(r.target_id),
          escapeCsv(r.request_id ?? ''),
          escapeCsv(r.created_at ?? ''),
          escapeCsv(r.before_data == null ? '' : JSON.stringify(r.before_data)),
          escapeCsv(r.after_data == null ? '' : JSON.stringify(r.after_data)),
        ].join(',')
      )
    }
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', 'attachment; filename="audits.csv"')
    res.header('X-Filters', filterPairs.join(';'))
    res.send(`${csvRows.join('\n')}\n`)
  })

  async function resolveEventQuery(req: any, res: any, paginationOptions: { defaultPageSize: number; maxPageSize: number }) {
    const eventType = req.query?.eventType ? String(req.query.eventType) : null
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId).trim() : null
    const resellerId = req.query?.resellerId ? String(req.query.resellerId).trim() : null
    const requestId = req.query?.requestId ? String(req.query.requestId) : null
    const iccid = req.query?.iccid ? normalizeIccid(req.query.iccid) : null
    if (iccid && !isValidIccid(iccid)) {
      sendError(res, 400, 'BAD_REQUEST', 'iccid must be 18-20 digits.')
      return null
    }
    if (iccid) {
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const simRows = await supabase.select(
        'sims',
        `select=sim_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
      const sim = Array.isArray(simRows) ? simRows[0] : null
      if (!sim) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
        return null
      }
    }
    const previousStatus = req.query?.previousStatus ? String(req.query.previousStatus) : null
    const resultingStatus = req.query?.resultingStatus ? String(req.query.resultingStatus) : null
    const reason = req.query?.reason ? String(req.query.reason) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const startRaw = req.query?.start
    const endRaw = req.query?.end
    const start =
      startRaw !== undefined && startRaw !== null && String(startRaw).trim() !== ''
        ? parseInclusiveTimeBound(startRaw, 'start')
        : null
    const end =
      endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== ''
        ? parseInclusiveTimeBound(endRaw, 'end')
        : null
    if (startRaw !== undefined && startRaw !== null && String(startRaw).trim() !== '' && !start) {
      sendError(res, 400, 'VALIDATION_ERROR', 'start must be a valid date (YYYY-MM-DD) or date-time.')
      return null
    }
    if (endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== '' && !end) {
      sendError(res, 400, 'VALIDATION_ERROR', 'end must be a valid date (YYYY-MM-DD) or date-time.')
      return null
    }
    if (start && end && start.getTime() > end.getTime()) {
      sendError(res, 400, 'VALIDATION_ERROR', 'start must be before or equal to end.')
      return null
    }
    const { page, pageSize, offset } = parsePagination(
      { page: req.query?.page, pageSize: req.query?.pageSize },
      { defaultPage: 1, defaultPageSize: paginationOptions.defaultPageSize, maxPageSize: paginationOptions.maxPageSize }
    )

    let enterpriseParentId: string | null = null
    if (enterpriseId) {
      if (!isValidUuid(enterpriseId)) {
        sendError(res, 400, 'VALIDATION_ERROR', 'enterpriseId must be a valid uuid.')
        return null
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
        return null
      }
      enterpriseParentId = enterprise.parent_id ? String(enterprise.parent_id) : null
    }

    if (resellerId) {
      if (!isValidUuid(resellerId)) {
        sendError(res, 400, 'VALIDATION_ERROR', 'resellerId must be a valid uuid.')
        return null
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const resellerRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
      )
      const reseller = Array.isArray(resellerRows) ? resellerRows[0] : null
      if (!reseller) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
        return null
      }
    }

    if (enterpriseId && resellerId && enterpriseParentId !== resellerId) {
      sendError(res, 400, 'VALIDATION_ERROR', 'enterpriseId does not belong to the given resellerId.')
      return null
    }

    const filters: string[] = []
    if (eventType) filters.push(`event_type=eq.${encodeURIComponent(eventType)}`)
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
    if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
    if (iccid) filters.push(`payload->>iccid=eq.${encodeURIComponent(iccid)}`)
    if (previousStatus) filters.push(buildPayloadStatusOrFilter(PAYLOAD_PREVIOUS_STATUS_PATHS, previousStatus))
    if (resultingStatus) filters.push(buildPayloadStatusOrFilter(PAYLOAD_RESULTING_STATUS_PATHS, resultingStatus))
    if (reason) filters.push(`payload->>reason=eq.${encodeURIComponent(reason)}`)
    if (start) filters.push(`occurred_at=gte.${encodeURIComponent(start.toISOString())}`)
    if (end) filters.push(`occurred_at=lte.${encodeURIComponent(end.toISOString())}`)
    const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
    const orderQs = `&order=occurred_at.${orderDir}`
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const filterPairs: string[] = []
    if (eventType) filterPairs.push(`eventType=${eventType}`)
    if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
    if (resellerId) filterPairs.push(`resellerId=${resellerId}`)
    if (requestId) filterPairs.push(`requestId=${requestId}`)
    if (iccid) filterPairs.push(`iccid=${iccid}`)
    if (previousStatus) filterPairs.push(`previousStatus=${previousStatus}`)
    if (resultingStatus) filterPairs.push(`resultingStatus=${resultingStatus}`)
    if (reason) filterPairs.push(`reason=${reason}`)
    if (start) filterPairs.push(`start=${start.toISOString()}`)
    if (end) filterPairs.push(`end=${end.toISOString()}`)
    if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
    if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
    filterPairs.push(`pageSize=${pageSize}`)
    filterPairs.push(`page=${page}`)

    return { page, pageSize, offset, orderQs, filterQs, filterPairs }
  }

  app.get(`${prefix}/admin/events`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const query = await resolveEventQuery(req, res, { defaultPageSize: 50, maxPageSize: 100 })
    if (!query) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { page, pageSize, offset, orderQs, filterQs, filterPairs } = query
    const { data, total } = await supabase.selectWithCount(
      'events',
      `select=event_id,event_type,occurred_at,enterprise_id,reseller_id,actor_user_id,request_id,job_id,payload${orderQs}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    res.header('X-Filters', filterPairs.join(';'))
    res.send({
      items: rows.map((r: any) => ({
        eventId: r.event_id,
        eventType: r.event_type,
        occurredAt: r.occurred_at,
        enterpriseId: r.enterprise_id ?? null,
        resellerId: r.reseller_id ?? null,
        actorUserId: r.actor_user_id ?? null,
        requestId: r.request_id ?? null,
        jobId: r.job_id ?? null,
        payload: r.payload ?? null,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  // Fastify find-my-way: register `::csv` so OpenAPI path `.../events:csv` matches (same as admin/api-clients).
  app.get(`${prefix}/admin/events::csv`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const query = await resolveEventQuery(req, res, { defaultPageSize: 1000, maxPageSize: 1000 })
    if (!query) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { pageSize, offset, orderQs, filterQs, filterPairs } = query
    const { data } = await supabase.selectWithCount(
      'events',
      `select=event_id,event_type,occurred_at,enterprise_id,reseller_id,actor_user_id,request_id,job_id,payload${orderQs}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const headers = [
      'eventId',
      'eventType',
      'occurredAt',
      'enterpriseId',
      'resellerId',
      'actorUserId',
      'requestId',
      'jobId',
      'payload',
    ]
    const csvRows = [headers.map(escapeCsv).join(',')]
    for (const r of rows) {
      csvRows.push(
        [
          escapeCsv(r.event_id),
          escapeCsv(r.event_type),
          escapeCsv(r.occurred_at ?? ''),
          escapeCsv(r.enterprise_id ?? ''),
          escapeCsv(r.reseller_id ?? ''),
          escapeCsv(r.actor_user_id ?? ''),
          escapeCsv(r.request_id ?? ''),
          escapeCsv(r.job_id ?? ''),
          escapeCsv(r.payload == null ? '' : typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload)),
        ].join(',')
      )
    }
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', 'attachment; filename="events.csv"')
    res.header('X-Filters', filterPairs.join(';'))
    res.send(`${csvRows.join('\n')}\n`)
  })

  async function resolveJobQuery(req: any, res: any, paginationOptions: { defaultPageSize: number; maxPageSize: number }) {
    const jobId = req.query?.jobId ? String(req.query.jobId).trim() : null
    const jobType = req.query?.jobType ? String(req.query.jobType) : null
    const status = req.query?.status ? String(req.query.status) : null
    const enterpriseId = req.query?.enterpriseId ? String(req.query.enterpriseId).trim() : null
    const resellerId = req.query?.resellerId ? String(req.query.resellerId).trim() : null
    const startRaw = req.query?.start
    const endRaw = req.query?.end
    const start =
      startRaw !== undefined && startRaw !== null && String(startRaw).trim() !== ''
        ? parseInclusiveTimeBound(startRaw, 'start')
        : null
    const end =
      endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== ''
        ? parseInclusiveTimeBound(endRaw, 'end')
        : null
    if (startRaw !== undefined && startRaw !== null && String(startRaw).trim() !== '' && !start) {
      sendError(res, 400, 'VALIDATION_ERROR', 'start must be a valid date (YYYY-MM-DD) or date-time.')
      return null
    }
    if (endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== '' && !end) {
      sendError(res, 400, 'VALIDATION_ERROR', 'end must be a valid date (YYYY-MM-DD) or date-time.')
      return null
    }
    if (start && end && start.getTime() > end.getTime()) {
      sendError(res, 400, 'VALIDATION_ERROR', 'start must be before or equal to end.')
      return null
    }
    const requestId = req.query?.requestId ? String(req.query.requestId) : null
    const sortBy = req.query?.sortBy ? String(req.query.sortBy) : null
    const sortOrder = req.query?.sortOrder ? String(req.query.sortOrder) : null
    const { page, pageSize, offset } = parsePagination(
      { page: req.query?.page, pageSize: req.query?.pageSize },
      { defaultPage: 1, defaultPageSize: paginationOptions.defaultPageSize, maxPageSize: paginationOptions.maxPageSize }
    )

    if (jobId && !isValidUuid(jobId)) {
      sendError(res, 400, 'VALIDATION_ERROR', 'jobId must be a valid uuid.')
      return null
    }

    let enterpriseParentId: string | null = null
    if (enterpriseId) {
      if (!isValidUuid(enterpriseId)) {
        sendError(res, 400, 'VALIDATION_ERROR', 'enterpriseId must be a valid uuid.')
        return null
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
      if (!enterprise) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
        return null
      }
      enterpriseParentId = enterprise.parent_id ? String(enterprise.parent_id) : null
    }

    if (resellerId) {
      if (!isValidUuid(resellerId)) {
        sendError(res, 400, 'VALIDATION_ERROR', 'resellerId must be a valid uuid.')
        return null
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const resellerRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
      )
      const reseller = Array.isArray(resellerRows) ? resellerRows[0] : null
      if (!reseller) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
        return null
      }
    }

    if (enterpriseId && resellerId && enterpriseParentId !== resellerId) {
      sendError(res, 400, 'VALIDATION_ERROR', 'enterpriseId does not belong to the given resellerId.')
      return null
    }

    const filters: string[] = []
    if (jobId) filters.push(`job_id=eq.${encodeURIComponent(jobId)}`)
    if (jobType) filters.push(`job_type=eq.${encodeURIComponent(jobType)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
    if (requestId) filters.push(`request_id=eq.${encodeURIComponent(requestId)}`)
    if (start) filters.push(`started_at=gte.${encodeURIComponent(start.toISOString())}`)
    if (end) filters.push(`started_at=lte.${encodeURIComponent(end.toISOString())}`)
    const orderField = (() => {
      const s = sortBy ? sortBy.toLowerCase() : ''
      if (s === 'startedat' || s === 'started_at') return 'started_at'
      if (s === 'finishedat' || s === 'finished_at') return 'finished_at'
      return 'started_at'
    })()
    const orderDir = sortOrder && sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc'
    const orderQs = `&order=${orderField}.${orderDir}`
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const filterPairs: string[] = []
    if (jobId) filterPairs.push(`jobId=${jobId}`)
    if (jobType) filterPairs.push(`jobType=${jobType}`)
    if (status) filterPairs.push(`status=${status}`)
    if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
    if (resellerId) filterPairs.push(`resellerId=${resellerId}`)
    if (requestId) filterPairs.push(`requestId=${requestId}`)
    if (start) filterPairs.push(`start=${start.toISOString()}`)
    if (end) filterPairs.push(`end=${end.toISOString()}`)
    if (sortBy) filterPairs.push(`sortBy=${sortBy}`)
    if (sortOrder) filterPairs.push(`sortOrder=${sortOrder}`)
    filterPairs.push(`pageSize=${pageSize}`)
    filterPairs.push(`page=${page}`)

    return { page, pageSize, offset, orderField, orderDir, orderQs, filterQs, filterPairs }
  }

  const JOBS_SELECT =
    'job_id,job_type,status,progress_processed,progress_total,error_summary,request_id,actor_user_id,actor_role,payload,reseller_id,enterprise_id,idempotency_key,file_hash,created_at,started_at,finished_at'

  function mapJobRow(r: any) {
    const progressProcessed = Number(r.progress_processed ?? 0)
    const progressTotal = Number(r.progress_total ?? 0)
    return {
      jobId: r.job_id,
      jobType: r.job_type,
      status: r.status,
      progress: {
        processed: progressProcessed,
        total: progressTotal,
      },
      progressProcessed,
      progressTotal,
      errorSummary: r.error_summary ?? null,
      requestId: r.request_id ?? null,
      actorUserId: r.actor_user_id ?? null,
      actorRole: r.actor_role ?? null,
      payload: r.payload ?? null,
      resellerId: r.reseller_id ?? null,
      enterpriseId: r.enterprise_id ?? null,
      idempotencyKey: r.idempotency_key ?? null,
      fileHash: r.file_hash ?? null,
      createdAt: r.created_at ?? null,
      startedAt: r.started_at ?? null,
      finishedAt: r.finished_at ?? null,
    }
  }

  app.get(`${prefix}/admin/jobs`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const query = await resolveJobQuery(req, res, { defaultPageSize: 50, maxPageSize: 100 })
    if (!query) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { page, pageSize, offset, orderField, orderDir, orderQs, filterQs, filterPairs } = query
    const { data, total } = await supabase.selectWithCount(
      'jobs',
      `select=${JOBS_SELECT}${orderQs}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = sortJobsRows(Array.isArray(data) ? data : [], orderField, orderDir)
    res.header('X-Filters', filterPairs.join(';'))
    res.send({
      items: rows.map(mapJobRow),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  // Fastify find-my-way: register `::csv` so OpenAPI path `.../jobs:csv` matches (same as admin/api-clients).
  app.get(`${prefix}/admin/jobs::csv`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const query = await resolveJobQuery(req, res, { defaultPageSize: 1000, maxPageSize: 1000 })
    if (!query) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { pageSize, offset, orderField, orderDir, orderQs, filterQs, filterPairs } = query
    const { data } = await supabase.selectWithCount(
      'jobs',
      `select=${JOBS_SELECT}${orderQs}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = sortJobsRows(Array.isArray(data) ? data : [], orderField, orderDir)
    const headers = [
      'jobId',
      'jobType',
      'status',
      'progressProcessed',
      'progressTotal',
      'errorSummary',
      'requestId',
      'actorUserId',
      'actorRole',
      'payload',
      'resellerId',
      'enterpriseId',
      'idempotencyKey',
      'fileHash',
      'createdAt',
      'startedAt',
      'finishedAt',
    ]
    const csvRows = [headers.map(escapeCsv).join(',')]
    for (const r of rows) {
      const item = mapJobRow(r)
      csvRows.push(
        [
          escapeCsv(item.jobId),
          escapeCsv(item.jobType),
          escapeCsv(item.status),
          escapeCsv(item.progressProcessed),
          escapeCsv(item.progressTotal),
          escapeCsv(item.errorSummary ?? ''),
          escapeCsv(item.requestId ?? ''),
          escapeCsv(item.actorUserId ?? ''),
          escapeCsv(item.actorRole ?? ''),
          escapeCsv(item.payload != null ? JSON.stringify(item.payload) : ''),
          escapeCsv(item.resellerId ?? ''),
          escapeCsv(item.enterpriseId ?? ''),
          escapeCsv(item.idempotencyKey ?? ''),
          escapeCsv(item.fileHash ?? ''),
          escapeCsv(item.createdAt ?? ''),
          escapeCsv(item.startedAt ?? ''),
          escapeCsv(item.finishedAt ?? ''),
        ].join(',')
      )
    }
    res.header('Content-Type', 'text/csv; charset=utf-8')
    res.header('Content-Disposition', 'attachment; filename="jobs.csv"')
    res.header('X-Filters', filterPairs.join(';'))
    res.send(`${csvRows.join('\n')}\n`)
  })
}
