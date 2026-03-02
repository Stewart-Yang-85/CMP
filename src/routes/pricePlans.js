import { createPricePlan, listPricePlans, getPricePlanDetail, createPricePlanVersion } from '../services/pricePlan.js'

export function registerPricePlanRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerAdmin,
    ensureResellerSales,
    resolveEnterpriseForReseller,
    isValidUuid,
  } = deps

  app.post(`${prefix}/enterprises/:enterpriseId/price-plans`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const enterpriseIdParam = String(req.params.enterpriseId || '').trim()
    if (!isValidUuid(enterpriseIdParam)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = enterpriseIdParam
    if (auth.scope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam)
      if (!enterpriseId) return
    }
    const result = await createPricePlan({ supabase, enterpriseId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.get(`${prefix}/enterprises/:enterpriseId/price-plans`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const enterpriseIdParam = String(req.params.enterpriseId || '').trim()
    if (!isValidUuid(enterpriseIdParam)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = enterpriseIdParam
    if (auth.scope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam)
      if (!enterpriseId) return
    }
    const { type, status, page, pageSize } = req.query ?? {}
    const result = await listPricePlans({ supabase, enterpriseId, type, status, page, pageSize })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/price-plans/:pricePlanId`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const pricePlanId = String(req.params.pricePlanId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getPricePlanDetail({ supabase, pricePlanId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/price-plans/:pricePlanId/versions`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const pricePlanId = String(req.params.pricePlanId || '').trim()
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createPricePlanVersion({ supabase, pricePlanId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })
}
