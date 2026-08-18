import {
  createPackage,
  updatePackage,
  publishPackage,
  deprecatePackage,
  listPackages,
  listPackagesByModuleRefs,
  listPackagesByScope,
  getPackageDetail,
  validateResellerAccessToUpdatePackage,
  validateResellerAccessToPackage,
  validateResellerOwnsEnterprise,
} from '../services/package.js'

const PLATFORM_LIST_ALL_PATH_ENTERPRISE = '00000000-0000-0000-0000-000000000000'

function escapeCsvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Flatten `PackageListItem`-shaped rows for download (same data source as `GET .../packages`). */
function packageListItemsToCsv(items: unknown[]): string {
  const headers = [
    'packageId',
    'enterpriseId',
    'resellerId',
    'name',
    'description',
    'status',
    'effectiveFrom',
    'publishedAt',
    'deprecatedAt',
    'createdAt',
    'updatedAt',
    'carrierServiceId',
    'apnProfileId',
    'roamingProfileId',
    'controlPolicyId',
    'commercialTermsId',
    'pricePlanId',
    'coveredNetworkProfileId',
  ]
  const lines = [headers.join(',')]
  for (const raw of items) {
    const it = raw as Record<string, unknown>
    const mod =
      it.moduleRef && typeof it.moduleRef === 'object' && !Array.isArray(it.moduleRef)
        ? (it.moduleRef as Record<string, unknown>)
        : {}
    lines.push(
      [
        escapeCsvCell(it.packageId),
        escapeCsvCell(it.enterpriseId),
        escapeCsvCell(it.resellerId),
        escapeCsvCell(it.name),
        escapeCsvCell(it.description),
        escapeCsvCell(it.status),
        escapeCsvCell(it.effectiveFrom),
        escapeCsvCell(it.publishedAt),
        escapeCsvCell(it.deprecatedAt),
        escapeCsvCell(it.createdAt),
        escapeCsvCell(it.updatedAt),
        escapeCsvCell(mod.carrierServiceId),
        escapeCsvCell(mod.apnProfileId),
        escapeCsvCell(mod.roamingProfileId),
        escapeCsvCell(mod.controlPolicyId),
        escapeCsvCell(mod.commercialTermsId),
        escapeCsvCell(mod.pricePlanId),
        escapeCsvCell(mod.coveredNetworkProfileId),
      ].join(',')
    )
  }
  return `${lines.join('\n')}\n`
}

type Deps = {
  createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => {
    select: (table: string, queryString: string) => Promise<unknown>
    selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
    insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
    update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  }
  getTraceId: (reply: any) => string | null
  sendError: (reply: any, status: number, code: string, message: string) => void
  ensureResellerAdmin: (req: any, reply: any) => { scope?: string | null } | null
  ensureResellerSales: (req: any, reply: any) => { scope?: string | null } | null
  resolveEnterpriseForReseller: (req: any, reply: any, supabase: any, enterpriseId: string | null) => Promise<string | null>
  isValidUuid: (value: unknown) => boolean
  getEnterpriseIdFromReq: (req: any) => string | null
  toIsoDateTime: (value: unknown) => string | null
}

export function registerPackageRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerAdmin,
    ensureResellerSales,
    resolveEnterpriseForReseller,
    isValidUuid,
  } = deps

  /**
   * Same as Price Plan routes: **platform** MUST pass `resellerId` query; **reseller** may omit (uses token).
   */
  function resolveResellerIdForPackageListRoute(
    req: any,
    res: any,
    auth: { scope?: string | null },
    queryResellerId: string | null
  ): string | null {
    const q = String(queryResellerId ?? '').trim()
    if (auth.scope === 'platform') {
      if (!q || !isValidUuid(q)) {
        sendError(
          res,
          400,
          'BAD_REQUEST',
          'resellerId query parameter is required and must be a valid uuid.'
        )
        return null
      }
      return q
    }
    if (auth.scope === 'reseller') {
      const tokenR = String(req?.cmpAuth?.resellerId ?? '').trim()
      if (!tokenR) {
        sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
        return null
      }
      if (q && q !== tokenR) {
        sendError(res, 403, 'FORBIDDEN', 'resellerId does not match the authenticated reseller.')
        return null
      }
      return q || tokenR
    }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  app.post(`${prefix}/enterprises/:enterpriseId/packages`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const enterpriseIdParam = String(req.params.enterpriseId || '').trim()
    if (!isValidUuid(enterpriseIdParam)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const bodyRaw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {}
    const resellerIdRaw = bodyRaw.resellerId ?? bodyRaw.reseller_id
    const resellerIdBody =
      resellerIdRaw !== undefined && resellerIdRaw !== null && String(resellerIdRaw).trim() !== ''
        ? String(resellerIdRaw).trim()
        : null
    if (resellerIdBody && !isValidUuid(resellerIdBody)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId: string | null = enterpriseIdParam
    let effectiveResellerId: string
    if (auth.scope === 'reseller') {
      const authRid = String(req?.cmpAuth?.resellerId || '').trim()
      if (!authRid || !isValidUuid(authRid)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      }
      if (resellerIdBody && resellerIdBody !== authRid) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam)
      if (!enterpriseId) return
      effectiveResellerId = authRid
    } else {
      if (!resellerIdBody) {
        return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required for platform access.')
      }
      const v = await validateResellerOwnsEnterprise(supabase, resellerIdBody, enterpriseIdParam)
      if (!v.ok) return sendError(res, (v as any).status, (v as any).code, (v as any).message)
      effectiveResellerId = resellerIdBody
    }
    const packagePayload: Record<string, unknown> = { ...bodyRaw }
    delete packagePayload.resellerId
    delete packagePayload.reseller_id
    const result = await createPackage({
      supabase,
      enterpriseId,
      payload: { ...packagePayload, resellerId: effectiveResellerId },
      audit,
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.code(201).send((result as any).value)
  })

  app.put(`${prefix}/packages/:packageId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const packageId = String(req.params.packageId || '').trim()
    const bodyRaw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {}
    const resellerIdRaw = bodyRaw.resellerId ?? bodyRaw.reseller_id
    const resellerIdBody =
      resellerIdRaw !== undefined && resellerIdRaw !== null && String(resellerIdRaw).trim() !== ''
        ? String(resellerIdRaw).trim()
        : null
    if (resellerIdBody && !isValidUuid(resellerIdBody)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (auth.scope === 'reseller') {
      const authRid = String(req?.cmpAuth?.resellerId || '').trim()
      if (!authRid || !isValidUuid(authRid)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      }
      if (resellerIdBody && resellerIdBody !== authRid) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
      }
      const access = await validateResellerAccessToUpdatePackage(supabase, packageId, authRid)
      if (!access.ok) {
        return sendError(res, (access as any).status, (access as any).code, (access as any).message)
      }
    }
    const packagePayload: Record<string, unknown> = { ...bodyRaw }
    delete packagePayload.resellerId
    delete packagePayload.reseller_id
    const result = await updatePackage({
      supabase,
      packageId,
      payload:
        auth.scope === 'reseller'
          ? { ...packagePayload, resellerId: String(req?.cmpAuth?.resellerId || '').trim() }
          : { ...packagePayload },
      audit,
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/packages/:packageId/publish`, async (req: any, res: any) => {
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
    if (auth.scope === 'reseller') {
      const authRid = String(req?.cmpAuth?.resellerId || '').trim()
      if (!authRid || !isValidUuid(authRid)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      }
      const access = await validateResellerAccessToPackage(supabase, packageId, authRid)
      if (!access.ok) {
        return sendError(res, (access as any).status, (access as any).code, (access as any).message)
      }
    }
    const result = await publishPackage({
      supabase,
      packageId,
      audit,
      publishInput: {
        externalProductId: req.body?.externalProductId,
        provisioningParameters: req.body?.provisioningParameters,
      },
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/packages/:packageId/deprecate`, async (req: any, res: any) => {
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
    if (auth.scope === 'reseller') {
      const authRid = String(req?.cmpAuth?.resellerId || '').trim()
      if (!authRid || !isValidUuid(authRid)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      }
      const access = await validateResellerAccessToPackage(supabase, packageId, authRid)
      if (!access.ok) {
        return sendError(res, (access as any).status, (access as any).code, (access as any).message)
      }
    }
    const result = await deprecatePackage({ supabase, packageId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  async function fetchEnterprisePackagesListPayload(
    req: any,
    res: any,
    auth: { scope?: string | null },
    pathEnterpriseId: string
  ): Promise<{ items: unknown[]; total: number; page: number; pageSize: number } | null> {
    if (!isValidUuid(pathEnterpriseId)) {
      sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return null
    }
    const q = req.query ?? {}
    const resellerIdRaw = q.resellerId ?? q.reseller_id
    const enterpriseIdRawQ = q.enterpriseId ?? q.enterprise_id
    const resellerIdQuery =
      resellerIdRaw !== undefined && resellerIdRaw !== null && String(resellerIdRaw).trim() !== ''
        ? String(resellerIdRaw).trim()
        : null
    const enterpriseIdQuery =
      enterpriseIdRawQ !== undefined && enterpriseIdRawQ !== null && String(enterpriseIdRawQ).trim() !== ''
        ? String(enterpriseIdRawQ).trim()
        : null
    if (resellerIdQuery && !isValidUuid(resellerIdQuery)) {
      sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      return null
    }
    if (enterpriseIdQuery && !isValidUuid(enterpriseIdQuery)) {
      sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid in query when provided.')
      return null
    }
    const { status, page, pageSize } = q
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })

    if (auth.scope === 'reseller') {
      const authRid = String(req?.cmpAuth?.resellerId || '').trim()
      if (!authRid || !isValidUuid(authRid)) {
        sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
        return null
      }
      if (resellerIdQuery && resellerIdQuery !== authRid) {
        sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
        return null
      }
      if (enterpriseIdQuery && enterpriseIdQuery !== pathEnterpriseId) {
        sendError(res, 400, 'BAD_REQUEST', 'query enterpriseId must match path enterpriseId.')
        return null
      }
      const enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, pathEnterpriseId)
      if (!enterpriseId) return null
      const result = await listPackages({ supabase, enterpriseId, status, page, pageSize })
      if (!result.ok) {
        sendError(res, (result as any).status, (result as any).code, (result as any).message)
        return null
      }
      return (result as any).value as { items: unknown[]; total: number; page: number; pageSize: number }
    }

    const pathIsListAll = pathEnterpriseId === PLATFORM_LIST_ALL_PATH_ENTERPRISE

    if (!pathIsListAll) {
      if (enterpriseIdQuery && enterpriseIdQuery !== pathEnterpriseId) {
        sendError(res, 400, 'BAD_REQUEST', 'Query enterpriseId must match path enterpriseId.')
        return null
      }
      if (!resellerIdQuery) {
        sendError(
          res,
          400,
          'BAD_REQUEST',
          'resellerId query parameter is required when listing packages for a specific enterprise.'
        )
        return null
      }
      const v = await validateResellerOwnsEnterprise(supabase, resellerIdQuery, pathEnterpriseId)
      if (!v.ok) {
        sendError(res, (v as any).status, (v as any).code, (v as any).message)
        return null
      }
      const result = await listPackages({ supabase, enterpriseId: pathEnterpriseId, status, page, pageSize })
      if (!result.ok) {
        sendError(res, (result as any).status, (result as any).code, (result as any).message)
        return null
      }
      return (result as any).value as { items: unknown[]; total: number; page: number; pageSize: number }
    }

    if (resellerIdQuery || enterpriseIdQuery) {
      sendError(
        res,
        400,
        'BAD_REQUEST',
        'When listing all packages, omit resellerId and enterpriseId query parameters. To list one enterprise, use path enterpriseId and resellerId in query.'
      )
      return null
    }
    const result = await listPackagesByScope({ supabase, mode: { type: 'all' }, status, page, pageSize })
    if (!result.ok) {
      sendError(res, (result as any).status, (result as any).code, (result as any).message)
      return null
    }
    return (result as any).value as { items: unknown[]; total: number; page: number; pageSize: number }
  }

  app.get(`${prefix}/enterprises/:enterpriseId/packages`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const pathEnterpriseId = String(req.params.enterpriseId || '').trim()
    const payload = await fetchEnterprisePackagesListPayload(req, res, auth, pathEnterpriseId)
    if (!payload) return
    res.send(payload)
  })

  app.get(`${prefix}/enterprises/:enterpriseId/packages:csv`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const pathEnterpriseId = String(req.params.enterpriseId || '').trim()
    const payload = await fetchEnterprisePackagesListPayload(req, res, auth, pathEnterpriseId)
    if (!payload) return
    res
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="packages.csv"')
      .send(packageListItemsToCsv(payload.items))
  })

  app.get(`${prefix}/packages/:packageId`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const packageId = String(req.params.packageId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getPackageDetail({ supabase, packageId })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    if (auth.scope === 'reseller') {
      const authRid = String(req?.cmpAuth?.resellerId || '').trim()
      if (!authRid || !isValidUuid(authRid)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      }
      const enterpriseId = String((result as any).value?.enterpriseId ?? '').trim()
      if (!enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Package is not accessible for this reseller.')
      }
      const v = await validateResellerOwnsEnterprise(supabase, authRid, enterpriseId)
      if (!v.ok) return sendError(res, (v as any).status, (v as any).code, (v as any).message)
    }
    res.send((result as any).value)
  })

  app.get(`${prefix}/packages`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const qPkg = req.query ?? {}
    const {
      pricePlanId,
      carrierServiceId,
      commercialTermsId,
      controlPolicyId,
      enterpriseId: enterpriseIdRaw,
      status,
      page,
      pageSize,
    } = qPkg
    const resellerIdRawPkg = qPkg.resellerId ?? qPkg.reseller_id
    const resellerIdQueryPkg =
      resellerIdRawPkg !== undefined && resellerIdRawPkg !== null && String(resellerIdRawPkg).trim() !== ''
        ? String(resellerIdRawPkg).trim()
        : null
    if (resellerIdQueryPkg && !isValidUuid(resellerIdQueryPkg)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    const effectiveResellerId = resolveResellerIdForPackageListRoute(req, res, auth, resellerIdQueryPkg)
    if (effectiveResellerId === null) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId: string | null = enterpriseIdRaw ? String(enterpriseIdRaw).trim() : null
    if (auth.scope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else {
      if (enterpriseId && !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      if (enterpriseId && isValidUuid(enterpriseId)) {
        const v = await validateResellerOwnsEnterprise(supabase, effectiveResellerId, enterpriseId)
        if (!v.ok) {
          return sendError(res, (v as any).status, (v as any).code, (v as any).message)
        }
      }
    }
    const result = await listPackagesByModuleRefs({
      supabase,
      enterpriseId,
      pricePlanId,
      carrierServiceId,
      commercialTermsId,
      controlPolicyId,
      status,
      page,
      pageSize,
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })
}
