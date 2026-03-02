import {
  createApnProfile,
  createRoamingProfile,
  createApnProfileVersion,
  createRoamingProfileVersion,
  listApnProfiles,
  listRoamingProfiles,
  getApnProfileDetail,
  getRoamingProfileDetail,
  publishApnProfile,
  publishRoamingProfile,
  rollbackProfileVersion,
} from '../services/networkProfile.js'

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
  isValidUuid: (value: unknown) => boolean
}

export function registerNetworkProfileRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerAdmin,
    ensureResellerSales,
    isValidUuid,
  } = deps

  app.post(`${prefix}/apn-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createApnProfile({ supabase, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.status(201).json((result as any).value)
  })

  app.post(`${prefix}/roaming-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createRoamingProfile({ supabase, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.status(201).json((result as any).value)
  })

  app.get(`${prefix}/apn-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { supplierId, carrierId, status, page, pageSize } = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listApnProfiles({ supabase, supplierId, carrierId, status, page, pageSize })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.get(`${prefix}/roaming-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { supplierId, carrierId, status, page, pageSize } = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listRoamingProfiles({ supabase, supplierId, carrierId, status, page, pageSize })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.get(`${prefix}/apn-profiles/:apnProfileId`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    if (!isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getApnProfileDetail({ supabase, apnProfileId })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.get(`${prefix}/roaming-profiles/:roamingProfileId`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    if (!isValidUuid(roamingProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getRoamingProfileDetail({ supabase, roamingProfileId })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId/versions`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createApnProfileVersion({ supabase, apnProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.status(201).json((result as any).value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/versions`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createRoamingProfileVersion({ supabase, roamingProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.status(201).json((result as any).value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId\\:publish`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await publishApnProfile({ supabase, apnProfileId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId\\:publish`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await publishRoamingProfile({ supabase, roamingProfileId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })

  app.post(`${prefix}/profile-versions/:profileVersionId\\:rollback`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const profileVersionId = String(req.params.profileVersionId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await rollbackProfileVersion({ supabase, profileVersionId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.json((result as any).value)
  })
}
