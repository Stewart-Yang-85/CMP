import {
  createCarrierService,
  createCommercialTerms,
  createControlPolicy,
  cloneCommercialTerms,
  cloneControlPolicy,
  deprecateCarrierService,
  deprecateCommercialTerms,
  deprecateControlPolicy,
  getCarrierServiceDetail,
  getCommercialTermsDetail,
  getControlPolicyDetail,
  listCarrierServices,
  listCommercialTerms,
  listControlPolicies,
  publishCarrierService,
  publishCommercialTerms,
  publishControlPolicy,
  updateCarrierService,
  updateCommercialTerms,
  updateControlPolicy,
  validateCarrierServiceModule,
  validateCommercialTermsModule,
  validateControlPolicyModule,
  formatCarrierServiceValidationResponseForApi,
} from '../services/package.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'

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
    actorUserId: actorUserIdForDb(req?.cmpAuth?.userId),
    actorRole: req?.cmpAuth?.role ?? null,
    requestId: req.requestId ?? null,
    sourceIp: req.ip ?? null,
  })

  /** `null` = platform; `undefined` = already sent 403. */
  function carrierAuthResellerTenantId(req: any, res: any, auth: { scope?: string | null }): string | null | undefined {
    if (auth.scope !== 'reseller') return null
    const rid = String(req?.cmpAuth?.resellerId || '').trim()
    if (!rid || !isValidUuid(rid)) {
      sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      return undefined
    }
    return rid
  }

  app.post(`${prefix}/commercial-terms:validate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const result = validateCommercialTermsModule(req.body ?? {})
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/commercial-terms`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const body = req.body ?? {}
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const result = await createCommercialTerms({
      supabase,
      payload: body,
      audit: buildAudit(req, auth),
      auth: {
        scope: auth.scope as 'platform' | 'reseller',
        resellerTenantId: auth.scope === 'reseller' ? authResellerTenantId : null,
      },
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.put(`${prefix}/commercial-terms/:commercialTermsId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updateCommercialTerms({
      supabase,
      commercialTermsId: req.params?.commercialTermsId,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/commercial-terms/:commercialTermsId/publish`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const commercialTermsId = String(req.params.commercialTermsId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await publishCommercialTerms({
      supabase,
      commercialTermsId,
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/commercial-terms/:commercialTermsId/deprecate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const commercialTermsId = String(req.params.commercialTermsId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await deprecateCommercialTerms({
      supabase,
      commercialTermsId,
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/commercial-terms/:commercialTermsId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getCommercialTermsDetail({
      supabase,
      commercialTermsId: req.params?.commercialTermsId,
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/commercial-terms`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const q = req.query ?? {}
    const {
      status,
      page,
      pageSize,
    } = q
    const resellerIdRaw = q.resellerId ?? q.reseller_id
    const resellerIdQuery =
      resellerIdRaw !== undefined && resellerIdRaw !== null && String(resellerIdRaw).trim() !== ''
        ? String(resellerIdRaw).trim()
        : null
    if (resellerIdQuery && !isValidUuid(resellerIdQuery)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let resellerIdForList: string | null = null
    if (auth.scope === 'reseller') {
      const authResellerListCt = carrierAuthResellerTenantId(req, res, auth)
      if (authResellerListCt === undefined) return
      if (resellerIdQuery && resellerIdQuery !== authResellerListCt) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
      }
      resellerIdForList = authResellerListCt
    } else {
      resellerIdForList = resellerIdQuery
    }
    const result = await listCommercialTerms({
      supabase,
      status,
      page,
      pageSize,
      resellerId: resellerIdForList,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/commercial-terms/:commercialTermsId/clone`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const commercialTermsId = String(req.params.commercialTermsId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await cloneCommercialTerms({
      supabase,
      commercialTermsId,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.post(`${prefix}/control-policies:validate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await validateControlPolicyModule({ supabase, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/control-policies`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const body = req.body ?? {}
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const result = await createControlPolicy({
      supabase,
      payload: body,
      audit: buildAudit(req, auth),
      auth: {
        scope: auth.scope as 'platform' | 'reseller',
        resellerTenantId: auth.scope === 'reseller' ? authResellerTenantId : null,
      },
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.put(`${prefix}/control-policies/:controlPolicyId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updateControlPolicy({
      supabase,
      controlPolicyId: req.params?.controlPolicyId,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/control-policies/:controlPolicyId/publish`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const controlPolicyId = String(req.params.controlPolicyId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await publishControlPolicy({
      supabase,
      controlPolicyId,
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/control-policies/:controlPolicyId/deprecate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const controlPolicyId = String(req.params.controlPolicyId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await deprecateControlPolicy({
      supabase,
      controlPolicyId,
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/control-policies/:controlPolicyId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getControlPolicyDetail({
      supabase,
      controlPolicyId: req.params?.controlPolicyId,
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/control-policies`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const qCp = req.query ?? {}
    const {
      status,
      page,
      pageSize,
    } = qCp
    const resellerIdRawCp = qCp.resellerId ?? qCp.reseller_id
    const resellerIdQueryCp =
      resellerIdRawCp !== undefined && resellerIdRawCp !== null && String(resellerIdRawCp).trim() !== ''
        ? String(resellerIdRawCp).trim()
        : null
    if (resellerIdQueryCp && !isValidUuid(resellerIdQueryCp)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let resellerIdForList: string | null = null
    if (auth.scope === 'reseller') {
      const authResellerListCp = carrierAuthResellerTenantId(req, res, auth)
      if (authResellerListCp === undefined) return
      if (resellerIdQueryCp && resellerIdQueryCp !== authResellerListCp) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
      }
      resellerIdForList = authResellerListCp
    } else {
      resellerIdForList = resellerIdQueryCp
    }
    const result = await listControlPolicies({
      supabase,
      status,
      page,
      pageSize,
      resellerId: resellerIdForList,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/control-policies/:controlPolicyId/clone`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const controlPolicyId = String(req.params.controlPolicyId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await cloneControlPolicy({
      supabase,
      controlPolicyId,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.post(`${prefix}/carrier-services:validate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await validateCarrierServiceModule({ supabase, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    const formatted = await formatCarrierServiceValidationResponseForApi(supabase, result.value)
    res.send(formatted)
  })

  app.post(`${prefix}/carrier-services`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createCarrierService({
      supabase,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
      auth: {
        scope: auth.scope as 'platform' | 'reseller',
        resellerTenantId: (req as { cmpAuth?: { resellerId?: string | null } }).cmpAuth?.resellerId ?? null,
      },
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.put(`${prefix}/carrier-services/:carrierServiceId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updateCarrierService({
      supabase,
      carrierServiceId: req.params?.carrierServiceId,
      payload: req.body ?? {},
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/carrier-services/:carrierServiceId/publish`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const carrierServiceId = String(req.params.carrierServiceId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await publishCarrierService({
      supabase,
      carrierServiceId,
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/carrier-services/:carrierServiceId/deprecate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const carrierServiceId = String(req.params.carrierServiceId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await deprecateCarrierService({
      supabase,
      carrierServiceId,
      audit: buildAudit(req, auth),
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/carrier-services/:carrierServiceId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const authResellerTenantId = carrierAuthResellerTenantId(req, res, auth)
    if (authResellerTenantId === undefined) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getCarrierServiceDetail({
      supabase,
      carrierServiceId: req.params?.carrierServiceId,
      authResellerTenantId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/carrier-services`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const {
      apnProfileId,
      roamingProfileId,
      status,
      page,
      pageSize,
      resellerId: resellerIdQueryRaw,
      supplierId: supplierIdRaw,
      operatorId: operatorIdRaw,
      carrierId: carrierIdRaw,
      enterpriseId: enterpriseIdQueryRaw,
    } = req.query ?? {}
    if (
      enterpriseIdQueryRaw !== undefined &&
      enterpriseIdQueryRaw !== null &&
      String(enterpriseIdQueryRaw).trim() !== ''
    ) {
      return sendError(
        res,
        400,
        'BAD_REQUEST',
        'enterpriseId is not supported for carrier service list; catalog modules are reseller-scoped (enterprise is expressed on Package / Price Plan).'
      )
    }
    const operatorIdQuery = operatorIdRaw ?? carrierIdRaw ?? null
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const resellerIdQuery =
      resellerIdQueryRaw !== undefined && resellerIdQueryRaw !== null && String(resellerIdQueryRaw).trim() !== ''
        ? String(resellerIdQueryRaw).trim()
        : null
    if (resellerIdQuery && !isValidUuid(resellerIdQuery)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    let resellerId: string | null = null
    if (auth.scope === 'reseller') {
      const authResellerId = String(req?.cmpAuth?.resellerId || '').trim()
      if (!authResellerId || !isValidUuid(authResellerId)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      }
      if (resellerIdQuery && resellerIdQuery !== authResellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
      }
      resellerId = authResellerId
    } else if (auth.scope === 'platform') {
      resellerId = resellerIdQuery || null
    } else {
      if (resellerIdQuery) {
        return sendError(res, 400, 'BAD_REQUEST', 'resellerId is only supported for platform or reseller credentials.')
      }
    }
    const result = await listCarrierServices({
      supabase,
      apnProfileId,
      roamingProfileId,
      status,
      page,
      pageSize,
      resellerId,
      supplierId: supplierIdRaw ?? null,
      operatorId: operatorIdQuery,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })
}
