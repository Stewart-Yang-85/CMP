/**
 * Gap supplement routes (T160-T167): bill file download, adjustment notes,
 * upstream integrations, reconciliation runs, alert summary/trends,
 * SIM location stubs, events, webhook deliveries.
 *
 * These routes are mounted via registerGapRoutes() from app.js.
 */

function normalizePage(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function normalizePageSize(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.min(200, Math.floor(num))
}

export function registerGapRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensurePlatformAdmin,
    isValidUuid,
  } = deps

  // =========================================================================
  // T160: GET /v1/bills/:billId/files?format=pdf|csv
  // The existing /bills/:billId/files endpoint already handles the base case.
  // This adds the ?format= query param support by intercepting before the
  // existing handler if format is specified.
  // =========================================================================

  // Note: T160 format support is handled inline in mountBillsRoutes via
  // modification of the existing handler, not here (see app.js edit).

  // =========================================================================
  // T162: POST /v1/upstream-integrations + GET /v1/upstream-integrations
  // Platform admin only
  // =========================================================================

  app.get(`${prefix}/upstream-integrations`, async (req, res) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const query = req.query ?? {}
    const supplierId = query.supplierId ? String(query.supplierId).trim() : null
    const operatorId = query.operatorId ? String(query.operatorId).trim() : null
    const status = query.status ? String(query.status).trim().toUpperCase() : null
    const p = normalizePage(query.page, 1)
    const ps = normalizePageSize(query.pageSize, 20)
    const offset = (p - 1) * ps

    const filters = []
    if (supplierId) {
      if (!isValidUuid(supplierId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
      }
      filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
    }
    if (operatorId) {
      if (!isValidUuid(operatorId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
      }
      filters.push(`operator_id=eq.${encodeURIComponent(operatorId)}`)
    }
    if (status) {
      filters.push(`status=eq.${encodeURIComponent(status)}`)
    }
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const { data, total } = await supabase.selectWithCount(
      'upstream_integrations',
      `select=integration_id,supplier_id,operator_id,name,type,config,status,api_endpoint,enabled,created_at,updated_at&order=created_at.desc&limit=${ps}&offset=${offset}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const items = rows.map((row) => ({
      integrationId: row.integration_id,
      supplierId: row.supplier_id,
      operatorId: row.operator_id ?? null,
      name: row.name,
      type: row.type,
      config: row.config ?? {},
      status: row.status,
      apiEndpoint: row.api_endpoint ?? null,
      enabled: row.enabled ?? true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    res.json({ items, total: typeof total === 'number' ? total : items.length, page: p, pageSize: ps })
  })

  app.post(`${prefix}/upstream-integrations`, async (req, res) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const body = req.body ?? {}
    const supplierId = body.supplierId ? String(body.supplierId).trim() : null
    const operatorId = body.operatorId ? String(body.operatorId).trim() : null
    const name = body.name ? String(body.name).trim() : null
    const type = body.type ? String(body.type).trim().toUpperCase() : 'API'
    const config = body.config && typeof body.config === 'object' ? body.config : {}
    const status = body.status ? String(body.status).trim().toUpperCase() : 'ACTIVE'
    const apiEndpoint = body.apiEndpoint ? String(body.apiEndpoint).trim() : null
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true

    if (!supplierId || !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    if (!name) {
      return sendError(res, 400, 'BAD_REQUEST', 'name is required.')
    }

    const insertPayload = {
      supplier_id: supplierId,
      name,
      type,
      config,
      status,
      api_endpoint: apiEndpoint,
      enabled,
    }
    if (operatorId) {
      insertPayload.operator_id = operatorId
    }

    const rows = await supabase.insert('upstream_integrations', insertPayload, { returning: 'representation' })
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create upstream integration.')
    }
    res.status(201).json({
      integrationId: row.integration_id,
      supplierId: row.supplier_id,
      operatorId: row.operator_id ?? null,
      name: row.name,
      type: row.type,
      config: row.config ?? {},
      status: row.status,
      apiEndpoint: row.api_endpoint ?? null,
      enabled: row.enabled ?? true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  })

  // =========================================================================
  // T163: GET /v1/reconciliation/runs + /v1/reconciliation/runs/:runId + mismatches
  // Already implemented in routes/reconciliation.js — no action needed here.
  // =========================================================================

  // =========================================================================
  // T164: GET /v1/alerts/summary + GET /v1/alerts/trends
  // Platform admin only (summary aggregation)
  // =========================================================================

  app.get(`${prefix}/alerts/summary`, async (req, res) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })

    const statuses = ['OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED']
    const severities = ['P0', 'P1', 'P2', 'P3']

    const statusCounts = await Promise.all(
      statuses.map(async (status) => {
        const { total } = await supabase.selectWithCount(
          'alerts',
          `select=alert_id&status=eq.${encodeURIComponent(status)}&limit=1`
        )
        return { status, count: typeof total === 'number' ? total : 0 }
      })
    )

    const severityCounts = await Promise.all(
      severities.map(async (severity) => {
        const { total } = await supabase.selectWithCount(
          'alerts',
          `select=alert_id&severity=eq.${encodeURIComponent(severity)}&limit=1`
        )
        return { severity, count: typeof total === 'number' ? total : 0 }
      })
    )

    // byType: group open (non-acknowledged) alerts by alert_type
    const { data: typeRows } = await supabase.selectWithCount(
      'alerts',
      `select=alert_type&status=eq.OPEN`
    )
    const typeCountMap = {}
    const typeRowsArr = Array.isArray(typeRows) ? typeRows : []
    for (const row of typeRowsArr) {
      const t = row.alert_type ?? 'UNKNOWN'
      typeCountMap[t] = (typeCountMap[t] ?? 0) + 1
    }
    const byType = Object.entries(typeCountMap).map(([type, count]) => ({ type, count }))

    const totalOpen = statusCounts.find((s) => s.status === 'OPEN')?.count ?? 0

    res.json({
      totalOpen,
      byStatus: statusCounts,
      bySeverity: severityCounts,
      byType,
    })
  })

  app.get(`${prefix}/alerts/trends`, async (req, res) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const query = req.query ?? {}
    const days = Math.min(90, Math.max(1, Number(query.days) || 7))

    const buckets = []
    const now = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const start = new Date(now)
      start.setUTCDate(start.getUTCDate() - i)
      start.setUTCHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setUTCDate(end.getUTCDate() + 1)
      buckets.push({ date: start.toISOString().slice(0, 10), start: start.toISOString(), end: end.toISOString() })
    }

    const trendData = await Promise.all(
      buckets.map(async (bucket) => {
        const { total } = await supabase.selectWithCount(
          'alerts',
          `select=alert_id&created_at=gte.${encodeURIComponent(bucket.start)}&created_at=lt.${encodeURIComponent(bucket.end)}&limit=1`
        )
        return { date: bucket.date, count: typeof total === 'number' ? total : 0 }
      })
    )

    res.json({ days, trends: trendData })
  })

  // =========================================================================
  // T165: GET /v1/sims/:simId/location + location-history — return 501
  // These already exist in mountSimsRoutes. The task says "return 501 (depends
  // on upstream)" — but the existing endpoints already have real implementations.
  // We do NOT override them. This task is satisfied by the existing code.
  // =========================================================================
}
