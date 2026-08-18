import {
  listPublicInfos,
  createPublicInfo,
  updatePublicInfo,
  deletePublicInfo,
} from '../services/publicInfo.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  getAuthContext: (req: any) => { roleScope?: string | null; role?: string | null }
  ensurePlatformAdmin: (req: any, res: any) => any
  isValidUuid: (value: string) => boolean
}

export function registerPublicInfoRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getAuthContext,
    ensurePlatformAdmin,
    isValidUuid,
  } = deps

  // GET /v1/public-infos — any authenticated system user (all roles / scopes)
  app.get(`${prefix}/public-infos`, async (req: any, res: any) => {
    const auth = getAuthContext(req)
    if (!auth.roleScope && !auth.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const query = req.query ?? {}
    const name = query.name ? String(query.name).trim() : null
    const mcc = query.mcc ? String(query.mcc).trim() : null
    const mnc = query.mnc ? String(query.mnc).trim() : null
    const page = query.page ?? null
    const pageSize = query.pageSize ?? null

    const result: any = await listPublicInfos({ supabase, name, mcc, mnc, page, pageSize })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/admin/public-infos`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result: any = await createPublicInfo({ supabase, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.patch(`${prefix}/admin/public-infos/:publicInfoId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const publicInfoId = String(req.params.publicInfoId || '').trim()
    if (!publicInfoId || !isValidUuid(publicInfoId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'publicInfoId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result: any = await updatePublicInfo({ supabase, publicInfoId, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.delete(`${prefix}/admin/public-infos/:publicInfoId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const publicInfoId = String(req.params.publicInfoId || '').trim()
    if (!publicInfoId || !isValidUuid(publicInfoId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'publicInfoId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result: any = await deletePublicInfo({ supabase, publicInfoId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })
}
