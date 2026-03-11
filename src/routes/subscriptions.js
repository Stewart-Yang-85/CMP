import { createSubscription, switchSubscription, cancelSubscription, listSimSubscriptions } from '../services/subscription.js'
import { parseSimIdentifier } from '../services/simLifecycle.js'

export function registerSubscriptionRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerSales,
    resolveEnterpriseForReseller,
    getRoleScope,
    getEnterpriseIdFromReq,
    buildSimTenantFilter,
    isValidUuid,
  } = deps
  const resellerSalesRoles = new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director'])
  const ensureSubscriptionAccess = (req, res) => {
    const roleScope = getRoleScope(req)
    const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
    if (!roleScope && !role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (roleScope === 'platform' || role === 'platform_admin' || role === 'admin') return { scope: 'platform' }
    if (roleScope === 'reseller' && role && resellerSalesRoles.has(role)) return { scope: 'reseller' }
    if (roleScope === 'customer') return { scope: 'customer' }
    if (roleScope === 'department') return { scope: 'department' }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  app.post(`${prefix}/subscriptions`, async (req, res) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const body = req.body ?? {}
    const roleScope = getRoleScope(req)
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = body.enterpriseId ? String(body.enterpriseId).trim() : null
    if (roleScope === 'reseller') {
      if (!enterpriseId) {
        return sendError(res, 404, 'SIM_NOT_FOUND', `sim ${parsed.value} not found.`)
      }
      if (!isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (roleScope === 'platform') {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
      if (!enterpriseId) {
        return sendError(res, 404, 'SIM_NOT_FOUND', `sim ${parsed.value} not found.`)
      }
      if (!isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
    } else {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = fromReq ? String(fromReq) : null
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
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
      audit,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.post(`${prefix}/subscriptions:switch`, async (req, res) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const body = req.body ?? {}
    const roleScope = getRoleScope(req)
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
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
    }
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: body.iccid,
      newPackageVersionId: body.newPackageVersionId,
      effectiveStrategy: body.effectiveStrategy,
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
      audit,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/subscriptions/:subscriptionId:cancel`, async (req, res) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const roleScope = getRoleScope(req)
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
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
    }
    const result = await cancelSubscription({
      supabase,
      enterpriseId,
      subscriptionId: req.params.subscriptionId,
      immediate: query.immediate,
      audit,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/sims/:simId/subscriptions`, async (req, res) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const parsed = parseSimIdentifier(req.params.simId)
    if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
    const roleScope = getRoleScope(req)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const query = req.query ?? {}
    let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
    if (!enterpriseId && (roleScope === 'platform' || roleScope === 'reseller')) {
      const selectQuery = `select=enterprise_id&${parsed.field}=eq.${encodeURIComponent(parsed.value)}&limit=1`
      console.log(`[DEBUG] resolving enterprise for ${parsed.field}=${parsed.value}, query=${selectQuery}`)
      const sim = await supabase.select('sims', selectQuery)
      console.log(`[DEBUG] sim lookup result:`, JSON.stringify(sim))
      const found = Array.isArray(sim) ? sim[0] : null
      if (found && found.enterprise_id) {
        enterpriseId = found.enterprise_id
      }
      if (!enterpriseId && parsed.field === 'iccid') {
        const iccidValue = String(parsed.value || '').trim()
        const fuzzyQuery = `select=enterprise_id,iccid&iccid=ilike.${encodeURIComponent(`%${iccidValue}%`)}&limit=20`
        const fallback = await supabase.select('sims', fuzzyQuery)
        const candidates = Array.isArray(fallback) ? fallback : []
        const normalizeDigits = (value) => String(value || '').replace(/\D/g, '')
        const target = normalizeDigits(iccidValue)
        const match = candidates.find((row) => normalizeDigits(row.iccid) === target)
        if (match && match.enterprise_id) {
          enterpriseId = match.enterprise_id
        }
      }
    }
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
    res.json(result.value)
  })
}
