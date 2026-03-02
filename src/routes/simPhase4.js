import { runSimImport } from '../services/simImport.js'
import { parseSimIdentifier, fetchSimStateHistory, changeSimStatus, batchDeactivateSims } from '../services/simLifecycle.js'

export function registerSimPhase4Routes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getRoleScope,
    getEnterpriseIdFromReq,
    getDepartmentIdFromReq,
    buildSimTenantFilter,
    ensureResellerAdmin,
    ensureResellerSales,
    resolveEnterpriseForReseller,
    resolveDepartmentForEnterprise,
    normalizeIccid,
    isValidIccid,
    isValidUuid,
    readRequestBody,
    parseMultipartFormData,
    toIsoDateTime,
    pushSimStatusToUpstream,
  } = deps
  const resellerSalesRoles = new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director'])
  const ensureSimReadAccess = (req, res) => {
    const roleScope = getRoleScope(req)
    const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
    if (!roleScope && !role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (roleScope === 'platform' || role === 'platform_admin') return { scope: 'platform' }
    if (roleScope === 'reseller' && role && resellerSalesRoles.has(role)) return { scope: 'reseller' }
    if (roleScope === 'customer') return { scope: 'customer' }
    if (roleScope === 'department') return { scope: 'department' }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  app.post(`${prefix}/sims/import-jobs`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return sendError(res, 400, 'BAD_REQUEST', 'multipart/form-data is required.')
    }
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i)
    if (!boundaryMatch) {
      return sendError(res, 400, 'BAD_REQUEST', 'multipart boundary is required.')
    }
    let bodyBuffer
    try {
      bodyBuffer = await readRequestBody(req, 50 * 1024 * 1024)
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
    }
    const { fields, files } = parseMultipartFormData(bodyBuffer, boundaryMatch[1])
    const supplierId = fields.supplierId ? String(fields.supplierId).trim() : null
    const enterpriseIdRaw = fields.enterpriseId ? String(fields.enterpriseId).trim() : null
    const batchId = fields.batchId ? String(fields.batchId).trim() : null
    if (!supplierId || !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
    }
    if (enterpriseIdRaw && !isValidUuid(enterpriseIdRaw)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const file = files.file
    if (!file || !file.content) {
      return sendError(res, 400, 'INVALID_FORMAT', 'file is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = enterpriseIdRaw
    if (auth.scope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdRaw)
      if (!enterpriseId && enterpriseIdRaw) return
    }
    const csvText = String(file.content ?? '')
    const result = await runSimImport({
      supabase,
      csvText,
      supplierId,
      enterpriseId,
      batchId,
      traceId: getTraceId(res),
      actorUserId: auth.userId ?? null,
      actorRole: auth.role ?? null,
      resellerId: auth.resellerId ?? null,
      sourceIp: req.ip,
    })
    if (!result.ok) {
      return sendError(res, result.status, result.code, result.message)
    }
    res.status(202).json({
      jobId: result.jobId,
      status: result.status,
      totalRows: result.totalRows,
      createdAt: result.createdAt,
    })
  })

  app.post(`${prefix}/sims`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const {
      iccid: iccidRaw,
      imsi,
      secondaryImsi1,
      secondaryImsi2,
      secondaryImsi3,
      msisdn,
      apn,
      supplierId,
      operatorId,
      enterpriseId: enterpriseIdBody,
      formFactor,
      activationCode,
      imei,
      imeiLockEnabled,
    } = req.body ?? {}
    const iccid = normalizeIccid(iccidRaw)
    if (!iccid || !isValidIccid(iccid)) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
    }
    const imsiValue = String(imsi ?? '').trim()
    if (!imsiValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'imsi is required.')
    }
    const apnValue = String(apn ?? '').trim()
    if (!apnValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'apn is required.')
    }
    const supplierIdValue = supplierId ? String(supplierId).trim() : null
    const operatorIdValue = operatorId ? String(operatorId).trim() : null
    if (!supplierIdValue || !isValidUuid(supplierIdValue)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
    }
    if (!operatorIdValue || !isValidUuid(operatorIdValue)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
    }
    if (enterpriseIdBody && !isValidUuid(enterpriseIdBody)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const formFactorRaw = formFactor ? String(formFactor).trim() : ''
    const allowedFormFactors = new Set(['consumer_removable', 'industrial_removable', 'consumer_embedded', 'industrial_embedded'])
    if (formFactorRaw && !allowedFormFactors.has(formFactorRaw)) {
      return sendError(res, 400, 'BAD_REQUEST', 'formFactor is invalid.')
    }
    const imeiValue = imei ? String(imei).trim() : ''
    if (imeiValue && !/^\d{15}$/.test(imeiValue)) {
      return sendError(res, 400, 'BAD_REQUEST', 'imei must be 15 digits.')
    }
    if (imeiLockEnabled === true && !imeiValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'imei is required when imeiLockEnabled is true.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = enterpriseIdBody ? String(enterpriseIdBody).trim() : null
    if (auth.scope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    }
    const carrierRows = await supabase.select('supplier_carriers', `select=carrier_id&supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
    const allowedCarrierIds = new Set((Array.isArray(carrierRows) ? carrierRows : []).map((r) => String(r.carrier_id)))
    if (allowedCarrierIds.size > 0 && !allowedCarrierIds.has(operatorIdValue)) {
      return sendError(res, 400, 'INVALID_OPERATOR', 'Operator is not linked to supplier.')
    }
    const existingRows = await supabase.select('sims', `select=sim_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
    const existing = Array.isArray(existingRows) ? existingRows[0] : null
    if (existing) {
      return sendError(res, 409, 'DUPLICATE_ICCID', 'ICCID already exists.')
    }
    const insertPayload = {
      iccid,
      primary_imsi: imsiValue,
      imsi_secondary_1: secondaryImsi1 ? String(secondaryImsi1).trim() : null,
      imsi_secondary_2: secondaryImsi2 ? String(secondaryImsi2).trim() : null,
      imsi_secondary_3: secondaryImsi3 ? String(secondaryImsi3).trim() : null,
      msisdn: msisdn ? String(msisdn).trim() : null,
      supplier_id: supplierIdValue,
      carrier_id: operatorIdValue,
      enterprise_id: enterpriseId ?? null,
      status: 'INVENTORY',
      apn: apnValue,
      bound_imei: imeiValue || null,
      activation_code: activationCode ? String(activationCode).trim() : null,
      last_status_change_at: new Date().toISOString(),
    }
    if (formFactorRaw) {
      insertPayload.form_factor = formFactorRaw
    }
    const rows = await supabase.insert('sims', insertPayload)
    const sim = Array.isArray(rows) ? rows[0] : null
    res.status(201).json({
      simId: sim?.sim_id ?? null,
      iccid,
      status: sim?.status ?? 'INVENTORY',
      createdAt: sim?.created_at ?? new Date().toISOString(),
    })
  })

  app.get(`${prefix}/sims`, async (req, res) => {
    const auth = ensureSimReadAccess(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const roleScope = getRoleScope(req)
    const iccidRaw = req.query.iccid ? normalizeIccid(req.query.iccid) : null
    const msisdn = req.query.msisdn ? String(req.query.msisdn) : null
    const status = req.query.status ? String(req.query.status) : null
    const supplierId = req.query.supplierId ? String(req.query.supplierId) : null
    const operatorId = req.query.operatorId ? String(req.query.operatorId) : null
    const enterpriseIdQuery = req.query.enterpriseId ? String(req.query.enterpriseId) : null
    const departmentIdQuery = req.query.departmentId ? String(req.query.departmentId) : null
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : (req.query.limit ? Number(req.query.limit) : 20)
    const page = req.query.page ? Number(req.query.page) : 1
    const limit = Math.min(100, Math.max(1, pageSize))
    const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
    if (iccidRaw && !/^\d{1,20}$/.test(iccidRaw)) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
    }
    if (supplierId && !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    let enterpriseId = getEnterpriseIdFromReq(req)
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdQuery)
      if (!enterpriseId) return
    } else if (roleScope === 'platform') {
      if (enterpriseIdQuery) enterpriseId = enterpriseIdQuery
    }
    const departmentId = roleScope === 'department' ? getDepartmentIdFromReq(req) : await resolveDepartmentForEnterprise(req, res, supabase, enterpriseId, departmentIdQuery)
    if (departmentIdQuery && roleScope !== 'department' && departmentIdQuery && !departmentId) return

    const filters = []
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
    if (iccidRaw) {
      if (iccidRaw.length >= 18) {
        filters.push(`iccid=eq.${encodeURIComponent(iccidRaw)}`)
      } else {
        filters.push(`iccid=ilike.${encodeURIComponent(iccidRaw + '%')}`)
      }
    }
    if (msisdn) filters.push(`msisdn=eq.${encodeURIComponent(msisdn)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
    if (operatorId) filters.push(`carrier_id=eq.${encodeURIComponent(operatorId)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const { data, total } = await supabase.selectWithCount(
      'sims',
      `select=sim_id,iccid,primary_imsi,msisdn,status,apn,activation_date,bound_imei,supplier_id,carrier_id,enterprise_id,department_id,created_at,suppliers(name),carriers(name,mcc,mnc)&order=iccid.asc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )

    const rows = Array.isArray(data) ? data : []
    const enterpriseIds = Array.from(new Set(rows.map((r) => r.enterprise_id).filter(Boolean).map((v) => String(v))))
    const departmentIds = Array.from(new Set(rows.map((r) => r.department_id).filter(Boolean).map((v) => String(v))))
    const tenantIds = Array.from(new Set([...enterpriseIds, ...departmentIds]))
    let tenantNameMap = new Map()
    if (tenantIds.length) {
      const tRows = await supabase.select('tenants', `select=tenant_id,name&tenant_id=in.(${tenantIds.map((id) => encodeURIComponent(id)).join(',')})`)
      tenantNameMap = new Map((Array.isArray(tRows) ? tRows : []).map((t) => [String(t.tenant_id), t.name ?? null]))
    }

    const items = rows.map((r) => ({
      simId: r.sim_id,
      iccid: r.iccid,
      imsi: r.primary_imsi,
      msisdn: r.msisdn,
      status: r.status,
      lifecycleSubStatus: null,
      upstreamStatus: r.upstream_status ?? null,
      upstreamStatusUpdatedAt: r.upstream_status_updated_at ?? null,
      formFactor: r.form_factor ?? null,
      supplierId: r.supplier_id,
      supplierName: r.suppliers?.name ?? null,
      operatorId: r.carrier_id,
      operatorName: r.carriers?.name ?? null,
      mcc: r.carriers?.mcc ?? null,
      mnc: r.carriers?.mnc ?? null,
      enterpriseId: r.enterprise_id ?? null,
      enterpriseName: r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? null : null,
      departmentId: r.department_id ?? null,
      departmentName: r.department_id ? tenantNameMap.get(String(r.department_id)) ?? null : null,
      apn: r.apn,
      activationDate: toIsoDateTime(r.activation_date),
      totalUsageBytes: null,
      imei: r.bound_imei ?? null,
    }))

    {
      const filterPairs = []
      if (iccidRaw) filterPairs.push(`iccid=${iccidRaw}`)
      if (msisdn) filterPairs.push(`msisdn=${msisdn}`)
      if (status) filterPairs.push(`status=${status}`)
      if (supplierId) filterPairs.push(`supplierId=${supplierId}`)
      if (operatorId) filterPairs.push(`operatorId=${operatorId}`)
      if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
      if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
      filterPairs.push(`pageSize=${limit}`)
      filterPairs.push(`page=${page}`)
      res.setHeader('X-Filters', filterPairs.join(';'))
    }
    res.json({
      items,
      total: typeof total === 'number' ? total : items.length,
      page,
      pageSize: limit,
    })
  })

  app.get(`${prefix}/sims/:simId/state-history`, async (req, res) => {
    const auth = ensureSimReadAccess(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const simId = parseSimIdentifier(req.params.simId)
    if (!simId.ok) {
      return sendError(res, simId.status, simId.code, simId.message)
    }
    const roleScope = getRoleScope(req)
    const enterpriseIdInput = req.query.enterpriseId ? String(req.query.enterpriseId) : null
    let enterpriseId = getEnterpriseIdFromReq(req)
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdInput)
      if (!enterpriseId) return
    } else if (roleScope === 'platform' && enterpriseIdInput) {
      enterpriseId = enterpriseIdInput
    }
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : (req.query.limit ? Number(req.query.limit) : 20)
    const page = req.query.page ? Number(req.query.page) : 1
    const limit = Math.min(100, Math.max(1, pageSize))
    const tenantQs = buildSimTenantFilter(req, enterpriseId)
    const result = await fetchSimStateHistory({
      supabase,
      simIdentifier: simId,
      tenantQs,
      page,
      limit,
    })
    if (!result.ok) {
      return sendError(res, result.status, result.code, result.message)
    }
    res.json({
      simId: result.sim.sim_id,
      iccid: result.sim.iccid,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      items: result.items,
    })
  })

  const handleSimStatusChange = async ({ req, res, action, newStatus, allowedFrom, requireReason, auth, commitmentExempt }) => {
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const simId = parseSimIdentifier(req.params.simId)
    if (!simId.ok) {
      sendError(res, simId.status, simId.code, simId.message)
      return
    }
    const { reason, idempotencyKey, enterpriseId: enterpriseIdBody } = req.body ?? {}
    if (requireReason && !reason) {
      sendError(res, 400, 'BAD_REQUEST', 'reason is required.')
      return
    }
    const roleScope = getRoleScope(req)
    let enterpriseId = getEnterpriseIdFromReq(req)
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdBody ? String(enterpriseIdBody) : null)
      if (!enterpriseId) return
    } else if (roleScope === 'platform' && enterpriseIdBody) {
      enterpriseId = String(enterpriseIdBody)
    }
    const tenantQs = buildSimTenantFilter(req, enterpriseId)
    const result = await changeSimStatus({
      supabase,
      simIdentifier: simId,
      tenantQs,
      action,
      newStatus,
      allowedFrom,
      reason: reason ?? null,
      idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      actor: auth,
      traceId: getTraceId(res),
      sourceIp: req.ip,
      pushSimStatusToUpstream,
      commitmentExempt: !!commitmentExempt,
    })
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message)
      return
    }
    if (result.idempotent) {
      res.status(200).json({
        jobId: result.jobId,
        status: result.status,
        progress: result.progress,
      })
      return
    }
    res.status(202).json({
      jobId: result.jobId,
      status: result.status,
    })
  }

  app.post(`${prefix}/sims/:simId\\:activate`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    await handleSimStatusChange({
      req,
      res,
      action: 'SIM_ACTIVATE',
      newStatus: 'ACTIVATED',
      allowedFrom: new Set(['INVENTORY', 'TEST_READY', 'DEACTIVATED']),
      requireReason: false,
      auth,
    })
  })

  app.post(`${prefix}/sims/:simId\\:deactivate`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    await handleSimStatusChange({
      req,
      res,
      action: 'SIM_DEACTIVATE',
      newStatus: 'DEACTIVATED',
      allowedFrom: new Set(['ACTIVATED', 'TEST_READY']),
      requireReason: true,
      auth,
    })
  })

  app.post(`${prefix}/sims/:simId\\:reactivate`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    await handleSimStatusChange({
      req,
      res,
      action: 'SIM_REACTIVATE',
      newStatus: 'ACTIVATED',
      allowedFrom: new Set(['DEACTIVATED']),
      requireReason: false,
      auth,
    })
  })

  app.post(`${prefix}/sims/:simId\\:retire`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const { confirm, commitmentExempt } = req.body ?? {}
    if (confirm !== true) {
      return sendError(res, 400, 'BAD_REQUEST', 'confirm must be true.')
    }
    await handleSimStatusChange({
      req,
      res,
      action: 'SIM_RETIRE',
      newStatus: 'RETIRED',
      allowedFrom: new Set(['DEACTIVATED']),
      requireReason: true,
      auth,
      commitmentExempt: !!commitmentExempt,
    })
  })

  app.post(`${prefix}/sims:batch-deactivate`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { reason, idempotencyKey, enterpriseId: enterpriseIdBody } = req.body ?? {}
    const roleScope = getRoleScope(req)
    let enterpriseId = getEnterpriseIdFromReq(req)
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdBody ? String(enterpriseIdBody) : null)
      if (!enterpriseId) return
    } else if (roleScope === 'platform' && enterpriseIdBody) {
      enterpriseId = String(enterpriseIdBody)
    }
    if (!enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    }
    const result = await batchDeactivateSims({
      supabase,
      enterpriseId,
      reason: reason ?? null,
      idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      actor: auth,
      traceId: getTraceId(res),
      sourceIp: req.ip,
      pushSimStatusToUpstream,
    })
    if (!result.ok) {
      return sendError(res, result.status, result.code, result.message)
    }
    if (result.idempotent) {
      return res.status(200).json({
        jobId: result.jobId,
        status: result.status,
        progress: result.progress,
      })
    }
    res.status(202).json({
      jobId: result.jobId,
      status: result.status,
      totalRows: result.totalRows,
    })
  })
}
