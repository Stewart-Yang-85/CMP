import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { rbac } from '../middleware/rbac.js'
import { runSimImport } from '../services/simImport.js'
import { parseSimIdentifier, fetchSimStateHistory, changeSimStatus, batchDeactivateSims } from '../services/simLifecycle.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string> }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  delete: (table: string, matchQueryString: string) => Promise<unknown>
}

type AuthResult = {
  scope: 'platform' | 'reseller'
  roleScope?: string | null
  role?: string | null
  resellerId?: string | null
  customerId?: string | null
  userId?: string | null
}

type RouteDeps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => SupabaseClient
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  getRoleScope: (req: FastifyRequest) => string | null
  getEnterpriseIdFromReq: (req: FastifyRequest) => string | null
  getDepartmentIdFromReq: (req: FastifyRequest) => string | null
  buildSimTenantFilter: (req: FastifyRequest, enterpriseId: string | null) => string
  ensureResellerAdmin: (req: FastifyRequest, reply: FastifyReply) => AuthResult | null
  ensureResellerSales: (req: FastifyRequest, reply: FastifyReply) => AuthResult | null
  resolveEnterpriseForReseller: (req: FastifyRequest, reply: FastifyReply, supabase: SupabaseClient, enterpriseId: string | null) => Promise<string | null>
  resolveDepartmentForEnterprise: (req: FastifyRequest, reply: FastifyReply, supabase: SupabaseClient, enterpriseId: string | null, departmentId: string | null) => Promise<string | null>
  normalizeIccid: (value: unknown) => string
  isValidIccid: (value: unknown) => boolean
  isValidUuid: (value: unknown) => boolean
  readRequestBody: (req: FastifyRequest, maxBytes: number) => Promise<Buffer>
  parseMultipartFormData: (buffer: Buffer, boundary: string) => { fields: Record<string, unknown>; files: Record<string, { filename: string; content: string }> }
  toIsoDateTime: (value: unknown) => string | null
  pushSimStatusToUpstream?: (input: { iccid: string; status: string; traceId?: string | null; supplierId?: string | null }) => Promise<unknown>
}

export function registerSimPhase4Routes({ app, prefix, deps }: { app: FastifyInstance; prefix: string; deps: RouteDeps }) {
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
  const ensureSimReadAccess = (req: FastifyRequest, reply: FastifyReply) => {
    const roleScope = getRoleScope(req)
    const role = (req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role
      ? String((req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role)
      : null
    if (!roleScope && !role) {
      sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (roleScope === 'platform' || role === 'platform_admin') return { scope: 'platform' }
    if (roleScope === 'reseller' && role && resellerSalesRoles.has(role)) return { scope: 'reseller' }
    if (roleScope === 'customer') return { scope: 'customer' }
    if (roleScope === 'department') return { scope: 'department' }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  app.post(
    `${prefix}/sims/import-jobs`,
    { preHandler: rbac(['sims.import'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      const auth = ensureResellerAdmin(req, reply)
      if (!auth) return
      const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return sendError(reply, 400, 'BAD_REQUEST', 'multipart/form-data is required.')
      }
      const boundaryMatch = contentType.match(/boundary=([^;]+)/i)
      if (!boundaryMatch) {
        return sendError(reply, 400, 'BAD_REQUEST', 'multipart boundary is required.')
      }
      let bodyBuffer: Buffer
      try {
        bodyBuffer = await readRequestBody(req, 50 * 1024 * 1024)
      } catch {
        return sendError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
      }
      const { fields, files } = parseMultipartFormData(bodyBuffer, boundaryMatch[1])
      const supplierId = fields.supplierId ? String(fields.supplierId).trim() : null
      const enterpriseIdRaw = fields.enterpriseId ? String(fields.enterpriseId).trim() : null
      const batchId = fields.batchId ? String(fields.batchId).trim() : null
      if (!supplierId || !isValidUuid(supplierId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
      }
      if (enterpriseIdRaw && !isValidUuid(enterpriseIdRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      const file = files.file
      if (!file || !file.content) {
        return sendError(reply, 400, 'INVALID_FORMAT', 'file is required.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      let enterpriseId = enterpriseIdRaw
      if (auth.scope === 'reseller') {
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdRaw)
        if (!enterpriseId && enterpriseIdRaw) return
      }
      const csvText = String(file.content ?? '')
      const result = await runSimImport({
        supabase,
        csvText,
        supplierId,
        enterpriseId,
        batchId,
        traceId: getTraceId(reply),
        actorUserId: auth.userId ?? null,
        actorRole: auth.role ?? null,
        resellerId: auth.resellerId ?? null,
        sourceIp: req.ip,
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      reply.status(202).send({
        jobId: result.jobId,
        status: result.status,
        totalRows: result.totalRows,
        createdAt: result.createdAt,
      })
    }
  )

  app.post(
    `${prefix}/sims`,
    { preHandler: rbac(['sims.create'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      const auth = ensureResellerAdmin(req, reply)
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
      } = (req.body ?? {}) as Record<string, unknown>
      const iccid = normalizeIccid(iccidRaw)
      if (!iccid || !isValidIccid(iccid)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
      }
      const imsiValue = String(imsi ?? '').trim()
      if (!imsiValue) {
        return sendError(reply, 400, 'BAD_REQUEST', 'imsi is required.')
      }
      const apnValue = String(apn ?? '').trim()
      if (!apnValue) {
        return sendError(reply, 400, 'BAD_REQUEST', 'apn is required.')
      }
      const supplierIdValue = supplierId ? String(supplierId).trim() : null
      const operatorIdValue = operatorId ? String(operatorId).trim() : null
      if (!supplierIdValue || !isValidUuid(supplierIdValue)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
      }
      if (!operatorIdValue || !isValidUuid(operatorIdValue)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
      }
      if (enterpriseIdBody && !isValidUuid(enterpriseIdBody)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      const formFactorRaw = formFactor ? String(formFactor).trim() : ''
      const allowedFormFactors = new Set(['consumer_removable', 'industrial_removable', 'consumer_embedded', 'industrial_embedded'])
      if (formFactorRaw && !allowedFormFactors.has(formFactorRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'formFactor is invalid.')
      }
      const imeiValue = imei ? String(imei).trim() : ''
      if (imeiValue && !/^\d{15}$/.test(imeiValue)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'imei must be 15 digits.')
      }
      if (imeiLockEnabled === true && !imeiValue) {
        return sendError(reply, 400, 'BAD_REQUEST', 'imei is required when imeiLockEnabled is true.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      let enterpriseId = enterpriseIdBody ? String(enterpriseIdBody).trim() : null
      if (auth.scope === 'reseller') {
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseId)
        if (!enterpriseId) return
      }
      const carrierRows = await supabase.select('supplier_carriers', `select=carrier_id&supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
      const allowedCarrierIds = new Set((Array.isArray(carrierRows) ? carrierRows : []).map((r: any) => String(r.carrier_id)))
      if (allowedCarrierIds.size > 0 && !allowedCarrierIds.has(operatorIdValue)) {
        return sendError(reply, 400, 'INVALID_OPERATOR', 'Operator is not linked to supplier.')
      }
      const existingRows = await supabase.select('sims', `select=sim_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
      const existing = Array.isArray(existingRows) ? existingRows[0] : null
      if (existing) {
        return sendError(reply, 409, 'DUPLICATE_ICCID', 'ICCID already exists.')
      }
      const insertPayload: Record<string, unknown> = {
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
      reply.status(201).send({
        simId: sim?.sim_id ?? null,
        iccid,
        status: sim?.status ?? 'INVENTORY',
        createdAt: sim?.created_at ?? new Date().toISOString(),
      })
    }
  )

  app.get(
    `${prefix}/sims`,
    { preHandler: rbac(['sims.list']) },
    async (req, reply) => {
      const auth = ensureSimReadAccess(req, reply)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const roleScope = getRoleScope(req)
      const query = req.query as Record<string, unknown>
      const iccidRaw = query.iccid ? normalizeIccid(query.iccid) : null
      const msisdn = query.msisdn ? String(query.msisdn) : null
      const status = query.status ? String(query.status) : null
      const supplierId = query.supplierId ? String(query.supplierId) : null
      const operatorId = query.operatorId ? String(query.operatorId) : null
      const enterpriseIdQuery = query.enterpriseId ? String(query.enterpriseId) : null
      const departmentIdQuery = query.departmentId ? String(query.departmentId) : null
      const pageSize = query.pageSize ? Number(query.pageSize) : (query.limit ? Number(query.limit) : 20)
      const page = query.page ? Number(query.page) : 1
      const limit = Math.min(100, Math.max(1, pageSize))
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
      if (iccidRaw && !/^\d{1,20}$/.test(iccidRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
      }
      if (supplierId && !isValidUuid(supplierId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
      }
      if (operatorId && !isValidUuid(operatorId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
      }
      let enterpriseId = getEnterpriseIdFromReq(req)
      if (roleScope === 'reseller') {
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdQuery)
        if (!enterpriseId) return
      } else if (roleScope === 'platform') {
        if (enterpriseIdQuery) enterpriseId = enterpriseIdQuery
      }
      const departmentId = roleScope === 'department'
        ? getDepartmentIdFromReq(req)
        : await resolveDepartmentForEnterprise(req, reply, supabase, enterpriseId, departmentIdQuery)
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
      const enterpriseIds = Array.from(new Set(rows.map((r: any) => r.enterprise_id).filter(Boolean).map((v: any) => String(v))))
      const departmentIds = Array.from(new Set(rows.map((r: any) => r.department_id).filter(Boolean).map((v: any) => String(v))))
      const tenantIds = Array.from(new Set([...enterpriseIds, ...departmentIds]))
      let tenantNameMap = new Map<string, string | null>()
      if (tenantIds.length) {
        const tRows = await supabase.select('tenants', `select=tenant_id,name&tenant_id=in.(${tenantIds.map((id) => encodeURIComponent(id)).join(',')})`)
        tenantNameMap = new Map((Array.isArray(tRows) ? tRows : []).map((t: any) => [String(t.tenant_id), t.name ?? null]))
      }

      const items = rows.map((r: any) => ({
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
        reply.header('X-Filters', filterPairs.join(';'))
      }
      reply.send({
        items,
        total: typeof total === 'number' ? total : items.length,
        page,
        pageSize: limit,
      })
    }
  )

  app.get(
    `${prefix}/sims/:simId/state-history`,
    { preHandler: rbac(['sims.read']) },
    async (req, reply) => {
      const auth = ensureSimReadAccess(req, reply)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const simId = parseSimIdentifier((req.params as Record<string, unknown>).simId)
      if (!simId.ok) {
        return sendError(reply, simId.status, simId.code, simId.message)
      }
      const roleScope = getRoleScope(req)
      const query = req.query as Record<string, unknown>
      const enterpriseIdInput = query.enterpriseId ? String(query.enterpriseId) : null
      let enterpriseId = getEnterpriseIdFromReq(req)
      if (roleScope === 'reseller') {
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdInput)
        if (!enterpriseId) return
      } else if (roleScope === 'platform' && enterpriseIdInput) {
        enterpriseId = enterpriseIdInput
      }
      const pageSize = query.pageSize ? Number(query.pageSize) : (query.limit ? Number(query.limit) : 20)
      const page = query.page ? Number(query.page) : 1
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
        return sendError(reply, result.status, result.code, result.message)
      }
      reply.send({
        simId: result.sim.sim_id,
        iccid: result.sim.iccid,
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        items: result.items,
      })
    }
  )

  const handleSimStatusChange = async ({
    req,
    reply,
    action,
    newStatus,
    allowedFrom,
    requireReason,
    auth,
    commitmentExempt,
  }: {
    req: FastifyRequest
    reply: FastifyReply
    action: string
    newStatus: string
    allowedFrom: Set<string>
    requireReason: boolean
    auth: AuthResult
    commitmentExempt?: boolean
  }) => {
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
    const simId = parseSimIdentifier((req.params as Record<string, unknown>).simId)
    if (!simId.ok) {
      sendError(reply, simId.status, simId.code, simId.message)
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const { reason, idempotencyKey, enterpriseId: enterpriseIdBody } = body
    if (requireReason && !reason) {
      sendError(reply, 400, 'BAD_REQUEST', 'reason is required.')
      return
    }
    const roleScope = getRoleScope(req)
    let enterpriseId = getEnterpriseIdFromReq(req)
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdBody ? String(enterpriseIdBody) : null)
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
      reason: reason ? String(reason) : null,
      idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      actor: auth,
      traceId: getTraceId(reply),
      sourceIp: req.ip,
      pushSimStatusToUpstream,
      commitmentExempt: !!commitmentExempt,
    })
    if (!result.ok) {
      sendError(reply, result.status, result.code, result.message)
      return
    }
    if (result.idempotent) {
      reply.status(200).send({
        jobId: result.jobId,
        status: result.status,
        progress: result.progress,
      })
      return
    }
    reply.status(202).send({
      jobId: result.jobId,
      status: result.status,
    })
  }

  app.post(
    `${prefix}/sims/:simId:activate`,
    { preHandler: rbac(['sims.activate'], { roles: ['reseller_admin', 'reseller_sales', 'reseller_sales_director'] }) },
    async (req, reply) => {
      const auth = ensureResellerSales(req, reply)
      if (!auth) return
      await handleSimStatusChange({
        req,
        reply,
        action: 'SIM_ACTIVATE',
        newStatus: 'ACTIVATED',
        allowedFrom: new Set(['INVENTORY', 'TEST_READY', 'DEACTIVATED']),
        requireReason: false,
        auth,
      })
    }
  )

  app.post(
    `${prefix}/sims/:simId:deactivate`,
    { preHandler: rbac(['sims.deactivate'], { roles: ['reseller_admin', 'reseller_sales', 'reseller_sales_director'] }) },
    async (req, reply) => {
      const auth = ensureResellerSales(req, reply)
      if (!auth) return
      await handleSimStatusChange({
        req,
        reply,
        action: 'SIM_DEACTIVATE',
        newStatus: 'DEACTIVATED',
        allowedFrom: new Set(['ACTIVATED', 'TEST_READY']),
        requireReason: true,
        auth,
      })
    }
  )

  app.post(
    `${prefix}/sims/:simId:reactivate`,
    { preHandler: rbac(['sims.reactivate'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      const auth = ensureResellerAdmin(req, reply)
      if (!auth) return
      await handleSimStatusChange({
        req,
        reply,
        action: 'SIM_REACTIVATE',
        newStatus: 'ACTIVATED',
        allowedFrom: new Set(['DEACTIVATED']),
        requireReason: false,
        auth,
      })
    }
  )

  app.post(
    `${prefix}/sims/:simId:retire`,
    { preHandler: rbac(['sims.retire'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      const auth = ensureResellerAdmin(req, reply)
      if (!auth) return
      const { confirm, commitmentExempt } = (req.body ?? {}) as Record<string, unknown>
      if (confirm !== true) {
        return sendError(reply, 400, 'BAD_REQUEST', 'confirm must be true.')
      }
      await handleSimStatusChange({
        req,
        reply,
        action: 'SIM_RETIRE',
        newStatus: 'RETIRED',
        allowedFrom: new Set(['DEACTIVATED']),
        requireReason: true,
        auth,
        commitmentExempt: !!commitmentExempt,
      })
    }
  )

  app.post(
    `${prefix}/sims:batch-deactivate`,
    { preHandler: rbac(['sims.batch_deactivate'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      const auth = ensureResellerAdmin(req, reply)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const { reason, idempotencyKey, enterpriseId: enterpriseIdBody } = (req.body ?? {}) as Record<string, unknown>
      const roleScope = getRoleScope(req)
      let enterpriseId = getEnterpriseIdFromReq(req)
      if (roleScope === 'reseller') {
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdBody ? String(enterpriseIdBody) : null)
        if (!enterpriseId) return
      } else if (roleScope === 'platform' && enterpriseIdBody) {
        enterpriseId = String(enterpriseIdBody)
      }
      if (!enterpriseId) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required.')
      }
      const result = await batchDeactivateSims({
        supabase,
        enterpriseId,
        reason: reason ? String(reason) : null,
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
        actor: auth,
        traceId: getTraceId(reply),
        sourceIp: req.ip,
        pushSimStatusToUpstream,
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      if (result.idempotent) {
        return reply.status(200).send({
          jobId: result.jobId,
          status: result.status,
          progress: result.progress,
        })
      }
      reply.status(202).send({
        jobId: result.jobId,
        status: result.status,
        totalRows: result.totalRows,
      })
    }
  )
}
