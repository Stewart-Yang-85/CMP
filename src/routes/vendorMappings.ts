import {
  createVendorProductMapping,
  listVendorProductMappings,
  getVendorProductMapping,
  updateVendorProductMapping,
  deleteVendorProductMapping,
} from '../services/vendorMapping.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  ensurePlatformAdmin: (req: any, res: any) => any
  isValidUuid: (value: string) => boolean
}

export function registerVendorMappingRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const { createSupabaseRestClient, getTraceId, sendError, ensurePlatformAdmin, isValidUuid } = deps

  app.post(`${prefix}/vendor-product-mappings`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createVendorProductMapping({ supabase, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.get(`${prefix}/vendor-product-mappings`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listVendorProductMappings({
      supabase,
      supplierId: query.supplierId ? String(query.supplierId).trim() : null,
      packageVersionId: query.packageVersionId ? String(query.packageVersionId).trim() : null,
      page: query.page,
      pageSize: query.pageSize,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/vendor-product-mappings/:mappingId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const mappingId = req.params?.mappingId ? String(req.params.mappingId).trim() : ''
    if (!mappingId || !isValidUuid(mappingId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'mappingId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getVendorProductMapping({ supabase, mappingId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.patch(`${prefix}/vendor-product-mappings/:mappingId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const mappingId = req.params?.mappingId ? String(req.params.mappingId).trim() : ''
    if (!mappingId || !isValidUuid(mappingId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'mappingId must be a valid uuid.')
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await updateVendorProductMapping({ supabase, mappingId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.delete(`${prefix}/vendor-product-mappings/:mappingId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const mappingId = req.params?.mappingId ? String(req.params.mappingId).trim() : ''
    if (!mappingId || !isValidUuid(mappingId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'mappingId must be a valid uuid.')
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await deleteVendorProductMapping({ supabase, mappingId, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })
}
