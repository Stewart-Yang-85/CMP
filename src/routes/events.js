function getAuth(req) {
  const auth = req?.cmpAuth ?? {}
  return {
    roleScope: auth.roleScope ? String(auth.roleScope) : null,
    role: auth.role ? String(auth.role) : null,
    resellerId: auth.resellerId ? String(auth.resellerId) : null,
    customerId: auth.customerId ? String(auth.customerId) : null,
  }
}

function resolveScope(req, res, deps) {
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

function toIsoDateTime(value) {
  if (!value) return null
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

async function loadEnterpriseIdsForReseller(supabase, resellerId) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE`
  )
  const ids = Array.isArray(rows) ? rows.map((row) => String(row.tenant_id)) : []
  return ids.filter(Boolean)
}

async function resolveTenantIds({ req, res, deps, supabase, scope }) {
  const query = req.query ?? {}
  const enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
  const resellerId = query.resellerId ? String(query.resellerId).trim() : null
  if (scope.scope === 'platform') {
    if (enterpriseId) {
      if (!deps.isValidUuid(enterpriseId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      return [enterpriseId]
    }
    if (resellerId) {
      if (!deps.isValidUuid(resellerId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      return await loadEnterpriseIdsForReseller(supabase, resellerId)
    }
    return []
  }
  if (scope.scope === 'reseller') {
    if (enterpriseId) {
      if (!deps.isValidUuid(enterpriseId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const resolved = await deps.resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!resolved) return null
      return [resolved]
    }
    return await loadEnterpriseIdsForReseller(supabase, scope.resellerId)
  }
  return [scope.customerId]
}

export function registerEventRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getRoleScope,
    getEnterpriseIdFromReq,
    resolveEnterpriseForReseller,
    isValidUuid,
  } = deps

  app.get(`${prefix}/events`, async (req, res) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const tenantIds = await resolveTenantIds({ req, res, deps, supabase, scope })
    if (tenantIds === null) return
    const query = req.query ?? {}
    const eventType = query.eventType ? String(query.eventType).trim().toUpperCase() : null
    const fromIso = toIsoDateTime(query.from)
    const toIso = toIsoDateTime(query.to)
    const simId = query.simId ? String(query.simId).trim() : null
    const p = normalizePage(query.page, 1)
    const ps = normalizePageSize(query.pageSize, 20)
    const offset = (p - 1) * ps
    const filters = []
    if (eventType) filters.push(`event_type=eq.${encodeURIComponent(eventType)}`)
    if (fromIso) filters.push(`occurred_at=gte.${encodeURIComponent(fromIso)}`)
    if (toIso) filters.push(`occurred_at=lte.${encodeURIComponent(toIso)}`)
    if (tenantIds && tenantIds.length) {
      if (tenantIds.length === 1) {
        filters.push(`tenant_id=eq.${encodeURIComponent(tenantIds[0])}`)
      } else {
        const inList = tenantIds.map((id) => encodeURIComponent(id)).join(',')
        filters.push(`tenant_id=in.(${inList})`)
      }
    }
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const simFilter = simId
      ? `&or=(payload->>simId.eq.${encodeURIComponent(simId)},payload->>iccid.eq.${encodeURIComponent(simId)})`
      : ''
    const { data, total } = await supabase.selectWithCount(
      'events',
      `select=event_id,event_type,occurred_at,tenant_id,actor_user_id,request_id,job_id,payload&order=occurred_at.desc&limit=${ps}&offset=${offset}${filterQs}${simFilter}`
    )
    const rows = Array.isArray(data) ? data : []
    const items = rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      tenantId: row.tenant_id ?? null,
      actorUserId: row.actor_user_id ?? null,
      requestId: row.request_id ?? null,
      jobId: row.job_id ?? null,
      payload: row.payload ?? {},
    }))
    res.json({ items, total: total ?? items.length })
  })
}
