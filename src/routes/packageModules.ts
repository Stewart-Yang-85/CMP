import {
  createCarrierService,
  createCommercialTerms,
  createControlPolicy,
  getCarrierServiceDetail,
  getCommercialTermsDetail,
  getControlPolicyDetail,
  listCarrierServices,
  updateCarrierService,
  updateCommercialTerms,
  updateControlPolicy,
  validateCarrierServiceModule,
  validateCommercialTermsModule,
  validateControlPolicyModule,
} from '../services/package.js'

type Deps = {
  createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => {
    select: (table: string, queryString: string) => Promise<unknown>
    insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
    update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  }
  getTraceId: (reply: any) => string | null
  sendError: (reply: any, status: number, code: string, message: string) => void
  ensureResellerAdmin: (req: any, reply: any) => { scope?: string | null } | null
  ensureResellerSales: (req: any, reply: any) => { scope?: string | null } | null
  resolveEnterpriseForReseller: (req: any, reply: any, supabase: any, enterpriseId: string | null) => Promise<string | null>
  isValidUuid: (value: unknown) => boolean
}

export function registerPackageModuleRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerAdmin,
    ensureResellerSales,
    resolveEnterpriseForReseller,
    isValidUuid,
  } = deps
  const buildAudit = (req: any, auth: { scope?: string | null } | null) => ({
    actorUserId: req.cmpAuth?.userId ?? null,
    actorRole: auth?.scope ?? null,
    requestId: req.requestId ?? null,
    sourceIp: req.ip ?? null,
  })

  app.post(`${prefix}/commercial-terms:validate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const result = validateCommercialTermsModule(req.body ?? {})
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/commercial-terms`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createCommercialTerms({ supabase, payload: req.body ?? {}, audit: buildAudit(req, auth) })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.put(`${prefix}/commercial-terms/:commercialTermsId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updateCommercialTerms({
      supabase,
      commercialTermsId: req.params?.commercialTermsId,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/commercial-terms/:commercialTermsId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getCommercialTermsDetail({ supabase, commercialTermsId: req.params?.commercialTermsId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/control-policies:validate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await validateControlPolicyModule({ supabase, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/control-policies`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createControlPolicy({ supabase, payload: req.body ?? {}, audit: buildAudit(req, auth) })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.put(`${prefix}/control-policies/:controlPolicyId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updateControlPolicy({
      supabase,
      controlPolicyId: req.params?.controlPolicyId,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/control-policies/:controlPolicyId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getControlPolicyDetail({ supabase, controlPolicyId: req.params?.controlPolicyId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/carrier-services:validate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await validateCarrierServiceModule({ supabase, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/carrier-services`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createCarrierService({ supabase, payload: req.body ?? {}, audit: buildAudit(req, auth) })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.put(`${prefix}/carrier-services/:carrierServiceId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updateCarrierService({
      supabase,
      carrierServiceId: req.params?.carrierServiceId,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/carrier-services/:carrierServiceId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getCarrierServiceDetail({ supabase, carrierServiceId: req.params?.carrierServiceId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/carrier-services`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { apnProfileId, roamingProfileId, status, page, pageSize, enterpriseId: enterpriseIdRaw } = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId: string | null = enterpriseIdRaw ? String(enterpriseIdRaw).trim() : null
    if (auth.scope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (enterpriseId && !isValidUuid(enterpriseId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const result = await listCarrierServices({
      supabase,
      apnProfileId,
      roamingProfileId,
      status,
      page,
      pageSize,
      enterpriseId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })
}
