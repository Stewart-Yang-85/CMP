import {
  createUpstreamIntegration,
  deleteUpstreamIntegration,
  getUpstreamIntegration,
  listUpstreamIntegrations,
  updateUpstreamIntegration,
} from '../services/upstreamIntegration.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  ensurePlatformAdmin: (req: any, res: any) => any
  isValidUuid: (value: string) => boolean
  buildBaseUrl: (req: any) => string
}

export function registerUpstreamIntegrationRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const { createSupabaseRestClient, getTraceId, sendError, ensurePlatformAdmin, isValidUuid, buildBaseUrl } =
    deps

  app.get(`${prefix}/upstream-integrations`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listUpstreamIntegrations({
      supabase,
      resellerId: query.resellerId ? String(query.resellerId).trim() : null,
      supplierId: query.supplierId ? String(query.supplierId).trim() : null,
      operatorId: query.operatorId ? String(query.operatorId).trim() : null,
      status: query.status,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/upstream-integrations`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createUpstreamIntegration({
      supabase,
      payload: req.body ?? {},
      baseUrl: buildBaseUrl(req),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.get(`${prefix}/upstream-integrations/:integrationId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const integrationId = req.params?.integrationId ? String(req.params.integrationId).trim() : ''
    if (!integrationId || !isValidUuid(integrationId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'integrationId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getUpstreamIntegration({
      supabase,
      integrationId,
      baseUrl: buildBaseUrl(req),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.patch(`${prefix}/upstream-integrations/:integrationId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const integrationId = req.params?.integrationId ? String(req.params.integrationId).trim() : ''
    if (!integrationId || !isValidUuid(integrationId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'integrationId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updateUpstreamIntegration({
      supabase,
      integrationId,
      payload: req.body ?? {},
      baseUrl: buildBaseUrl(req),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.delete(`${prefix}/upstream-integrations/:integrationId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const integrationId = req.params?.integrationId ? String(req.params.integrationId).trim() : ''
    if (!integrationId || !isValidUuid(integrationId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'integrationId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await deleteUpstreamIntegration({
      supabase,
      integrationId,
      payload: req.body ?? {},
      actorId: auth.userId ?? null,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })
}
