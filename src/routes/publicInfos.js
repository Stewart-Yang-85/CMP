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
    ensurePlatformAdmin,
    isValidUuid,
  } = deps

  // T148: GET /v1/public-infos (read-only, all authenticated users)
  // No auth guard beyond the global authGuard — any authenticated user can read.
  app.get(`${prefix}/public-infos`, async (req, res) => {
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const query = req.query ?? {}
    const name = query.name ? String(query.name).trim() : null
    const mcc = query.mcc ? String(query.mcc).trim() : null
    const mnc = query.mnc ? String(query.mnc).trim() : null
    const page = query.page ?? null
    const pageSize = query.pageSize ?? null

    const result = await listPublicInfos({ supabase, name, mcc, mnc, page, pageSize })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  // T149: POST /v1/admin/public-infos (platform_admin only)
  app.post(`${prefix}/admin/public-infos`, async (req, res) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createPublicInfo({ supabase, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
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
    res.json(result.value)
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
    res.json(result.value)
  })
}
