import {
  createApnProfile,
  createRoamingProfile,
  createApnProfileVersion,
  createRoamingProfileVersion,
  deriveRoamingProfileVersion,
  listApnProfiles,
  listRoamingProfileEntries,
  listRoamingProfiles,
  patchRoamingProfileEntries,
  getApnProfileDetail,
  getRoamingProfileDetail,
  publishApnProfile,
  publishRoamingProfile,
  rollbackProfileVersion,
} from '../services/networkProfile.js'

export function registerNetworkProfileRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerAdmin,
    ensureResellerSales,
    isValidUuid,
  } = deps

  app.post(`${prefix}/apn-profiles`, async (req, res) => {
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
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.post(`${prefix}/roaming-profiles`, async (req, res) => {
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
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.get(`${prefix}/apn-profiles`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { supplierId, operatorId, status, page, pageSize } = req.query ?? {}
    if (!supplierId && !operatorId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId or operatorId is required.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listApnProfiles({ supabase, supplierId, operatorId, status, page, pageSize })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/roaming-profiles`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { supplierId, operatorId: operatorIdRaw, carrierId, status, page, pageSize } = req.query ?? {}
    const operatorId = operatorIdRaw ?? carrierId ?? null
    if (!supplierId && !operatorId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId or operatorId is required.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listRoamingProfiles({ supabase, supplierId, operatorId, status, page, pageSize })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/apn-profiles/:apnProfileId`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    if (!isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getApnProfileDetail({ supabase, apnProfileId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/roaming-profiles/:roamingProfileId`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    if (!isValidUuid(roamingProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getRoamingProfileDetail({ supabase, roamingProfileId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId/versions`, async (req, res) => {
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
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/versions`, async (req, res) => {
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
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/versions\\:derive`, async (req, res) => {
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
    const result = await deriveRoamingProfileVersion({ supabase, roamingProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.get(`${prefix}/roaming-profiles/:roamingProfileId/versions/:profileVersionId/entries`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    const profileVersionId = String(req.params.profileVersionId || '').trim()
    const { includeDeleted, page, pageSize } = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listRoamingProfileEntries({
      supabase,
      roamingProfileId,
      profileVersionId,
      includeDeleted,
      page,
      pageSize,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/versions/:profileVersionId\\:patch-entries`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    const profileVersionId = String(req.params.profileVersionId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await patchRoamingProfileEntries({
      supabase,
      roamingProfileId,
      profileVersionId,
      payload: req.body ?? {},
      audit,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId\\:publish`, async (req, res) => {
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
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId\\:publish`, async (req, res) => {
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
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/profile-versions/:profileVersionId\\:rollback`, async (req, res) => {
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
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })
}
