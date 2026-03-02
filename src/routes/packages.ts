import { createPackage, updatePackage, publishPackage, listPackages, getPackageDetail } from '../services/package.js'

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

  app.post(`${prefix}/enterprises/:enterpriseId/packages`, async (req: any, res: any) => {
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
    let enterpriseId: string | null = enterpriseIdParam
    if (auth.scope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam)
      if (!enterpriseId) return
    }
    const result = await createPackage({ supabase, enterpriseId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.status(201).json((result as any).value)
  })

  app.put(`${prefix}/packages/:packageId`, async (req: any, res: any) => {
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
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.post(`${prefix}/packages/:packageId\\:publish`, async (req: any, res: any) => {
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
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.get(`${prefix}/enterprises/:enterpriseId/packages`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const enterpriseIdParam = String(req.params.enterpriseId || '').trim()
    if (!isValidUuid(enterpriseIdParam)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId: string | null = enterpriseIdParam
    if (auth.scope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam)
      if (!enterpriseId) return
    }
    const { status, page, pageSize } = req.query ?? {}
    const result = await listPackages({ supabase, enterpriseId, status, page, pageSize })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.get(`${prefix}/packages/:packageId`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const packageId = String(req.params.packageId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getPackageDetail({ supabase, packageId })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })
}
