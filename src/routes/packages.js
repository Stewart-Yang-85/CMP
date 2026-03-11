import {
  createPackage,
  updatePackage,
  publishPackage,
  listPackages,
  listPackagesByModuleRefs,
  getPackageDetail,
} from '../services/package.js'

export function registerPackageRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerAdmin,
    ensureResellerSales,
    resolveEnterpriseForReseller,
    isValidUuid,
  } = deps

  app.post(`${prefix}/enterprises/:enterpriseId/packages`, async (req, res) => {
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
    const result = await createPackage({ supabase, enterpriseId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.put(`${prefix}/packages/:packageId`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const packageId = String(req.params.packageId || '').trim()
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updatePackage({ supabase, packageId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/packages/:packageId\\:publish`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const packageId = String(req.params.packageId || '').trim()
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await publishPackage({ supabase, packageId, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/enterprises/:enterpriseId/packages`, async (req, res) => {
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
    const { status, page, pageSize } = req.query ?? {}
    const result = await listPackages({ supabase, enterpriseId, status, page, pageSize })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/packages/:packageId`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const packageId = String(req.params.packageId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getPackageDetail({ supabase, packageId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/packages`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { pricePlanId, commercialTermsId, controlPolicyId, enterpriseId: enterpriseIdRaw, status, page, pageSize } = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = enterpriseIdRaw ? String(enterpriseIdRaw).trim() : null
    if (auth.scope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (enterpriseId && !isValidUuid(enterpriseId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const result = await listPackagesByModuleRefs({
      supabase,
      enterpriseId,
      pricePlanId,
      commercialTermsId,
      controlPolicyId,
      status,
      page,
      pageSize,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })
}
