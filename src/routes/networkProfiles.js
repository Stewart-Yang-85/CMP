import {
  createApnProfile,
  deprecateApnProfile,
  createRoamingProfile,
  deprecateRoamingProfile,
  createCoveredNetworkProfile,
  deprecateCoveredNetworkProfile,
  cloneApnProfile,
  cloneRoamingProfile,
  listApnProfiles,
  listRoamingProfiles,
  listCoveredNetworkProfiles,
  getApnProfileDetail,
  getRoamingProfileDetail,
  getCoveredNetworkProfileDetail,
  publishApnProfile,
  publishRoamingProfile,
  publishCoveredNetworkProfile,
  patchCoveredNetworkProfile,
  rollbackProfileVersion,
  updateApnProfile,
  updateRoamingProfile,
} from '../services/networkProfile.js'
import { getAuthContext, checkPermissions } from '../middleware/rbac.js'

export function registerNetworkProfileRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerAdmin,
    ensureResellerSales,
    isValidUuid,
  } = deps

  async function supplierIdExists(supabase, supplierId) {
    const rows = await supabase.select(
      "suppliers",
      `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return Boolean(row?.supplier_id);
  }

  async function assertResellerSupplierScope(req, res, supabase, auth, supplierId) {
    if (auth.scope !== 'reseller') return true
    const resellerId = String(req?.cmpAuth?.resellerId || '').trim()
    if (!resellerId || !isValidUuid(resellerId)) {
      sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      return false
    }
    const rows = await supabase.select(
      'reseller_suppliers',
      `select=reseller_id,supplier_id&reseller_id=eq.${encodeURIComponent(resellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row?.supplier_id) {
      sendError(res, 403, 'FORBIDDEN', 'supplierId is outside reseller scope.')
      return false
    }
    return true
  }

  async function requireCoveredCatalogPerm(req, res, codes) {
    const auth = getAuthContext(req)
    if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return true
    if (!(await checkPermissions(auth, codes))) {
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return false
    }
    return true
  }

  async function loadApnProfileSupplierId(supabase, apnProfileId) {
    const rows = await supabase.select(
      'apn_profiles',
      `select=apn_profile_id,supplier_id&apn_profile_id=eq.${encodeURIComponent(apnProfileId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row?.supplier_id ? String(row.supplier_id) : null
  }

  async function loadRoamingProfileSupplierId(supabase, roamingProfileId) {
    const rows = await supabase.select(
      'roaming_profiles',
      `select=roaming_profile_id,supplier_id&roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row?.supplier_id ? String(row.supplier_id) : null
  }

  async function loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId) {
    const rows = await supabase.select(
      'covered_network_profiles',
      `select=covered_network_profile_id,supplier_id&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row?.supplier_id ? String(row.supplier_id) : null
  }

  async function loadOperatorSupplierId(supabase, operatorId) {
    const byOperatorIdRows = await supabase.select(
      'operators',
      `select=operator_id,supplier_id&operator_id=eq.${encodeURIComponent(operatorId)}&limit=1`
    )
    const byOperatorId = Array.isArray(byOperatorIdRows) ? byOperatorIdRows[0] : null
    if (byOperatorId?.supplier_id) return String(byOperatorId.supplier_id)
    const byBusinessOperatorIdRows = await supabase.select(
      'operators',
      `select=operator_id,supplier_id&business_operator_id=eq.${encodeURIComponent(operatorId)}&limit=1`
    )
    const byBusinessOperatorId = Array.isArray(byBusinessOperatorIdRows) ? byBusinessOperatorIdRows[0] : null
    return byBusinessOperatorId?.supplier_id ? String(byBusinessOperatorId.supplier_id) : null
  }

  app.post(`${prefix}/apn-profiles`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supplierId = String(req?.body?.supplierId || '').trim()
    if (!isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (!(await supplierIdExists(supabase, supplierId))) {
      return sendError(res, 400, "BAD_REQUEST", "supplierId is not found.");
    }
    const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
    if (!allowed) return
    const result = await createApnProfile({ supabase, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code().send(result.value)
  })

  app.post(`${prefix}/roaming-profiles`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supplierId = String(req?.body?.supplierId || '').trim()
    if (!isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (!(await supplierIdExists(supabase, supplierId))) {
      return sendError(res, 400, "BAD_REQUEST", "supplierId is not found.");
    }
    const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
    if (!allowed) return
    const result = await createRoamingProfile({ supabase, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code().send(result.value)
  })

  app.post(`${prefix}/covered-network-profiles`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.write']))) return
    const supplierId = String(req?.body?.supplierId || '').trim()
    if (!isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (!(await supplierIdExists(supabase, supplierId))) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
    }
    const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
    if (!allowed) return
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {}
    const tokenResellerId = String(req?.cmpAuth?.resellerId || '').trim()
    const bodyResellerRaw = payload.resellerId
    const bodyReseller =
      bodyResellerRaw === null || bodyResellerRaw === undefined ? '' : String(bodyResellerRaw).trim()
    if (auth.scope === 'platform') {
      if (!bodyReseller) {
        return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
      }
      if (!isValidUuid(bodyReseller)) {
        return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      }
    }
    if (auth.scope === 'reseller') {
      if (!bodyReseller) {
        if (!tokenResellerId || !isValidUuid(tokenResellerId)) {
          return sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
        }
        payload.resellerId = tokenResellerId
      }
      else {
        if (!isValidUuid(bodyReseller)) {
          return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        }
        if (bodyReseller !== tokenResellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'resellerId must match the authenticated reseller.')
        }
      }
    }
    const result = await createCoveredNetworkProfile({ supabase, payload, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code().send(result.value)
  })

  app.get(`${prefix}/apn-profiles`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { supplierId, operatorId, apnProfileId, status, page, pageSize } = req.query ?? {}
    if (!supplierId && !operatorId && !apnProfileId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId, operatorId, or apnProfileId is required.')
    }
    if (apnProfileId && !isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (auth.scope === 'reseller') {
      if (!supplierId) {
        return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required for reseller scope.')
      }
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, String(supplierId))
      if (!allowed) return
    }
    const result = await listApnProfiles({ supabase, supplierId, operatorId, apnProfileId, status, page, pageSize })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
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
    let supplierIdForList = supplierId
    if (supplierIdForList && !(await supplierIdExists(supabase, String(supplierIdForList)))) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
    }
    if (auth.scope === 'reseller') {
      if (!supplierIdForList && operatorId) {
        const supplierIdFromOperator = await loadOperatorSupplierId(supabase, String(operatorId))
        if (!supplierIdFromOperator) {
          return sendError(res, 400, 'BAD_REQUEST', 'operatorId is not found.')
        }
        supplierIdForList = supplierIdFromOperator
      }
      if (!supplierIdForList) {
        return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required for reseller scope.')
      }
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, String(supplierIdForList))
      if (!allowed) return
    }
    const result = await listRoamingProfiles({
      supabase,
      supplierId: supplierIdForList,
      operatorId,
      status,
      page,
      pageSize
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/covered-network-profiles`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.list']))) return
    const {
      supplierId,
      operatorId: operatorIdRaw,
      carrierId,
      resellerId,
      coveredNetworkProfileId,
      status,
      page,
      pageSize,
    } = req.query ?? {}
    const operatorId = operatorIdRaw ?? carrierId ?? null
    if (!supplierId && !operatorId && !coveredNetworkProfileId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId, operatorId, or coveredNetworkProfileId is required.')
    }
    if (coveredNetworkProfileId && !isValidUuid(coveredNetworkProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    if (resellerId && !isValidUuid(resellerId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let supplierIdForList = supplierId
    if (supplierIdForList && !(await supplierIdExists(supabase, String(supplierIdForList)))) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
    }
    if (auth.scope === 'reseller') {
      if (!supplierIdForList && operatorId) {
        const supplierIdFromOperator = await loadOperatorSupplierId(supabase, String(operatorId))
        if (!supplierIdFromOperator) {
          return sendError(res, 400, 'BAD_REQUEST', 'operatorId is not found.')
        }
        supplierIdForList = supplierIdFromOperator
      }
      if (!supplierIdForList) {
        return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required for reseller scope.')
      }
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, String(supplierIdForList))
      if (!allowed) return
    }
    const result = await listCoveredNetworkProfiles({
      supabase,
      supplierId: supplierIdForList,
      operatorId,
      resellerId,
      coveredNetworkProfileId,
      status,
      page,
      pageSize,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/apn-profiles/:apnProfileId`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    if (!isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadApnProfileSupplierId(supabase, apnProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await getApnProfileDetail({ supabase, apnProfileId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/roaming-profiles/:roamingProfileId`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    if (!isValidUuid(roamingProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await getRoamingProfileDetail({ supabase, roamingProfileId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/covered-network-profiles/:coveredNetworkProfileId`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.read']))) return
    const coveredNetworkProfileId = String(req.params.coveredNetworkProfileId || '').trim()
    if (!isValidUuid(coveredNetworkProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await getCoveredNetworkProfileDetail({ supabase, coveredNetworkProfileId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.patch(`${prefix}/covered-network-profiles/:coveredNetworkProfileId`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.write']))) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const coveredNetworkProfileId = String(req.params.coveredNetworkProfileId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await patchCoveredNetworkProfile({
      supabase,
      coveredNetworkProfileId,
      payload: req.body ?? {},
      audit,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.put(`${prefix}/apn-profiles/:apnProfileId`, async (req, res) => {
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
    const supplierId = await loadApnProfileSupplierId(supabase, apnProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await updateApnProfile({ supabase, apnProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.put(`${prefix}/roaming-profiles/:roamingProfileId`, async (req, res) => {
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
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await updateRoamingProfile({ supabase, roamingProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId/clone`, async (req, res) => {
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
    const result = await cloneApnProfile({ supabase, apnProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code().send(result.value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/clone`, async (req, res) => {
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
    const result = await cloneRoamingProfile({ supabase, roamingProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code().send(result.value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId/publish`, async (req, res) => {
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
    const supplierId = await loadApnProfileSupplierId(supabase, apnProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await publishApnProfile({ supabase, apnProfileId, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId/deprecate`, async (req, res) => {
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
    const supplierId = await loadApnProfileSupplierId(supabase, apnProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await deprecateApnProfile({ supabase, apnProfileId, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/publish`, async (req, res) => {
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
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await publishRoamingProfile({ supabase, roamingProfileId, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/covered-network-profiles/:coveredNetworkProfileId/publish`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.publish']))) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const coveredNetworkProfileId = String(req.params.coveredNetworkProfileId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await publishCoveredNetworkProfile({ supabase, coveredNetworkProfileId, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/covered-network-profiles/:coveredNetworkProfileId/deprecate`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.deprecate']))) return
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const coveredNetworkProfileId = String(req.params.coveredNetworkProfileId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await deprecateCoveredNetworkProfile({ supabase, coveredNetworkProfileId, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/deprecate`, async (req, res) => {
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
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await deprecateRoamingProfile({ supabase, roamingProfileId, audit })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/profile-versions/:profileVersionId/rollback`, async (req, res) => {
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
    res.send(result.value)
  })
}
