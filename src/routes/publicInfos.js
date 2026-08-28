import {
  listPublicInfos,
  createPublicInfo,
  updatePublicInfo,
  deletePublicInfo,
} from '../services/publicInfo.js'

export function registerPublicInfoRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getAuthContext,
    ensurePlatformAdmin,
    isValidUuid,
  } = deps

  // GET /v1/public-infos — any authenticated system user
  app.get(`${prefix}/public-infos`, async (req, res) => {
    const auth = typeof getAuthContext === 'function' ? getAuthContext(req) : {}
    if (!auth?.roleScope && !auth?.role) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const query = req.query ?? {}
    const name = query.name ? String(query.name).trim() : null
    const country = query.country ? String(query.country).trim() : null
    const mcc = query.mcc ? String(query.mcc).trim() : null
    const mnc = query.mnc ? String(query.mnc).trim() : null
    const page = query.page ?? null
    const pageSize = query.pageSize ?? null

    const result = await listPublicInfos({ supabase, name, country, mcc, mnc, page, pageSize })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  // POST /v1/admin/public-infos (platform_admin only; duplicate mcc+mnc → 409)
  app.post(`${prefix}/admin/public-infos`, async (req, res) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createPublicInfo({ supabase, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  // T149: PATCH /v1/admin/public-infos/:publicInfoId (platform_admin only)
  app.patch(`${prefix}/admin/public-infos/:publicInfoId`, async (req, res) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const publicInfoId = String(req.params.publicInfoId || '').trim()
    if (!publicInfoId || !isValidUuid(publicInfoId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'publicInfoId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updatePublicInfo({ supabase, publicInfoId, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  // T149: DELETE /v1/admin/public-infos/:publicInfoId (platform_admin only)
  app.delete(`${prefix}/admin/public-infos/:publicInfoId`, async (req, res) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const publicInfoId = String(req.params.publicInfoId || '').trim()
    if (!publicInfoId || !isValidUuid(publicInfoId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'publicInfoId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await deletePublicInfo({ supabase, publicInfoId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })
}
